import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import {
  meshDfBudgetControl,
  meshDfCardControl,
  meshDfFactoryControl,
  meshDfPolicy,
  meshDfReceiverEntryControl,
  meshDfWorldKernel,
} from './mesh-df-approx.fixture';
import { meshDfWorldGpuCode, packMeshDfWorldCases } from './mesh-df-world-gpu.fixture';

it('starts the admitted near-surface DF policy without forcing an exact query on every ray', () => {
  expect(meshDfReceiverEntryControl().exactCalls).toBe(0);
  expect(meshDfReceiverEntryControl().remaining).toBe(3);
  expect(meshDfReceiverEntryControl(false).result.state.x).toBe(4);
});

it('pays bounded candidate, row, tap and local-refinement work without resetting or refunding', () => {
  // Indexed single-row directory reserves 1 row + 1 node; a row costs one;
  // one trilinear sample fetches eight taps and derives its gradient from them.
  expect(meshDfBudgetControl(11, [2, 1, 8])).toEqual({
    accepted: [true, true, true],
    remaining: 0,
  });
  expect(meshDfBudgetControl(3, [2, 1, 8, 1])).toEqual({
    accepted: [true, true, false, false],
    remaining: 0,
  });
  expect(meshDfBudgetControl(0, [1, 8]).accepted).toEqual([false, false]);
  expect(meshDfBudgetControl(64, [2, 1, 8, 8, 5]).remaining).toBe(40);
});

it('selects the actual approximate World route without running full-range exact traversal', () => {
  expect(meshDfFactoryControl().calls).toEqual({ exact: 0, approximate: 1 });
  expect(meshDfFactoryControl({ approximate: false }).calls).toEqual({ exact: 1, approximate: 0 });
  expect(meshDfFactoryControl().result.state.y).toBe(0x60000000);
});

it('hands the near miss to an overlapping Global DF interval using only the remaining bank', () => {
  const policy = { nearDistance: 2, directionLength: 2, steps: 32, nearStatus: 0 };
  const observed = meshDfFactoryControl(policy);
  expect(observed.nearWindows).toEqual([[0, 1, 32]]);
  expect(observed.farWindows).toEqual([[0.875, 8, 31]]);
  expect(observed.result.state.z).toBe(9);
  expect(observed.result.state.y).toBe(0x20000000);
  expect(meshDfFactoryControl({ ...policy, last: 0.5 }).farWindows).toEqual([]);
  expect(meshDfFactoryControl({ ...policy, farStatus: 2 }).result.state.x).toBe(4);
  expect(meshDfFactoryControl({ ...policy, farStatus: 5 }).result.state.x).toBe(5);
  expect(meshDfFactoryControl({ ...policy, steps: 8 }).result.state.x).toBe(3);
  for (const nearStatus of [1, 3, 4]) {
    const terminal = meshDfFactoryControl({ ...policy, nearStatus });
    expect(terminal.farWindows).toEqual([]);
    expect(terminal.result.state.x).toBe(nearStatus);
  }
});

it('compiles the Screen World entry with both software intervals under the storage binding limit', async () => {
  const source = screenProbeWorldWgsl('global-sdf', false, { ...meshDfPolicy, nearDistance: 2 });
  const result = await compileShader(source, { computeEntry: 'traceWorldProbes' });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) return;
  const buffers = result.value.reflection.boundGlobals.filter(
    (row) => row.resourceKind === 'storage-buffer',
  );
  expect(buffers.length).toBeLessThanOrEqual(8);
  expect(buffers.some((row) => row.binding === 0)).toBe(true);
});

it('keeps source, invalid range and budget failure distinct instead of certifying a miss', () => {
  for (const input of [{ sourceReady: false }, { rayValid: false }, { first: -1 }]) {
    const actual = meshDfFactoryControl(input);
    expect(actual.calls).toEqual({ exact: 0, approximate: 0 });
    expect(actual.result.state.x).toBe(4);
  }
  expect(meshDfFactoryControl({ steps: 0 }).result.state.x).toBe(3);
  expect(meshDfFactoryControl({ mask: 0 }).result.state.x).toBe(0);
});

it('keeps approximate object identity separate from primitive exact and geometric backface authority', () => {
  const actual = meshDfCardControl();
  expect(actual.candidate.ids.x).toBe(7);
  expect(actual.candidate.state.x).toBe(1);
  expect(actual.backface).toBe(false);
  expect(meshDfCardControl(0x80000000).backface).toBe(true);
});

it('retains the approximation uncertainty at the actual Card projection consumer', () => {
  expect(meshDfCardControl().margins).toEqual([0.5]);
  expect(meshDfCardControl(0x60000000, 0.05, 0.1).margins).toEqual([0.1]);
  expect(meshDfCardControl(0x80000000, 0.5, 0.1).margins).toEqual([0.1]);
});

it('requires explicit finite approximation policy and preserves the hardware source', () => {
  for (const receiverBiasVoxels of [NaN, -1, 65])
    expect(() =>
      worldTraversalWgsl('global-sdf', false, false, false, {
        ...meshDfPolicy,
        receiverBiasVoxels,
      }),
    ).toThrow(RangeError);
  expect(worldTraversalWgsl('ray-query', false, false, false, meshDfPolicy)).toBe(
    worldTraversalWgsl('ray-query'),
  );
});

it('compiles the real World-to-Card closure for Screen and probe/prepared variants', async () => {
  for (const [receiver, prepared] of [
    [true, false],
    [false, false],
    [true, true],
  ]) {
    const result = await compileShader(meshDfWorldKernel(receiver, prepared), {
      id: `df-approx-${receiver}-${prepared}`,
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  }
});

it('prepares actual receiver intervals and non-unit ray parameters for the same-device World GPU fixture', async () => {
  const bytes = packMeshDfWorldCases([
    {
      ray: { origin: [1, 2, 3], direction: [0, 0, 2], tMin: 0, tMax: 4, mask: 255 },
      originHi: [1.0001, 2, 3],
      directionHi: [0, 0, 2.0001],
      contact: [0, 70001, 1],
      maxSteps: 64,
    },
  ]);
  const view = new DataView(bytes.buffer);
  expect(bytes.byteLength).toBe(112);
  expect(view.getFloat32(24, true)).toBe(2);
  expect(view.getFloat32(28, true)).toBe(4);
  expect(view.getUint32(84, true)).toBe(70001);
  expect(view.getUint32(96, true)).toBe(64);
  const compiled = await compileShader(meshDfWorldGpuCode(meshDfPolicy), {
    id: 'actual-df-world-gpu',
  });
  expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.error)).toBe(true);
});
