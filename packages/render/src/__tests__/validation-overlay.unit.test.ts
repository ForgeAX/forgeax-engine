import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { handleSlot } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { GpuDrivenMaterialProgramProjection } from '../gpu-driven/material-artifacts';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { captureDispatchOverlays } from '../record/dispatch-overlays';
import { validateRenderables } from '../record/fold-buckets';
import type { RenderFrameState } from '../record/frame-snapshot';
import { variantSetFromDefines } from '../record/helpers';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import { mesh, preparedSnapshot } from './gpu-driven-production-fixture';

// Real World assets and RhiNull buffers exercise the record owner. This gate
// asserts captured dispatch metadata and map work, not GPU pixel output.
it.each([
  false,
  true,
  'mismatch',
] as const)('captures the last dispatch overlay before residency callbacks (retained: %s)', async (retained) => {
  const world = new World();
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const slot = handleSlot(HANDLE_CUBE),
    index = 42;
  const rows = Array<RenderableSnapshot>(index + 1);
  rows[index] = preparedSnapshot(1, slot);
  const entry = (passIndex: number, stencilReference: number): DispatchEntry => ({
    entityIndex: 0,
    renderableIndex: index,
    materialHandle: -1,
    passIndex,
    queue: 2000,
    layer: 0,
    tags: { LightMode: 'Forward' },
    renderState: { cullMode: passIndex === 0 ? 'none' : 'back' },
    stencilReference,
    defines: { VERTEX_COLOR_AVAILABLE: String(passIndex) },
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: undefined,
    paramSnapshot: undefined,
  });
  const lastDispatch = entry(1, 11);
  const dispatch = [entry(0, 7), lastDispatch];
  const expectedVariant = variantSetFromDefines(lastDispatch.defines);
  const internals = {
    gpuStore: new GpuResidencyCache(),
    errorRegistry: new RhiErrorListenerRegistry(),
  } as RenderSystemInternals;
  const pipeline = { meshes: new Map([[slot, mesh(device)]]) } as unknown as PipelineState;
  const overlays = retained
    ? new GpuDrivenMaterialProgramProjection().project(
        retained === 'mismatch' ? [...dispatch] : dispatch,
      ).overlays
    : undefined;
  const writes = vi.spyOn(Map.prototype, 'set');
  try {
    const validated = validateRenderables(
      internals,
      world,
      [world],
      pipeline,
      {} as RenderFrameState,
      rows,
      dispatch,
      undefined,
      undefined,
      (_phase, action) => {
        Object.assign(lastDispatch, { stencilReference: 99, defines: { LATER_MUTATION: '1' } });
        return action();
      },
      overlays,
    );
    const overlayWrites = writes.mock.calls.filter(([key]) => key === index).length;
    expect(overlayWrites).toBe(retained === true ? 0 : 2);
    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatchObject({
      renderableIndex: index,
      renderState: { cullMode: 'back' },
      stencilReference: 11,
      variantSet: expectedVariant,
    });
  } finally {
    writes.mockRestore();
  }
});

it('retains undefined last-dispatch fields instead of earlier pass values', () => {
  const last: DispatchEntry = {
    entityIndex: 0,
    materialHandle: -1,
    renderableIndex: 3,
    passIndex: 1,
    queue: 2000,
    layer: 0,
    tags: {},
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: undefined,
    paramSnapshot: undefined,
  };
  const first: DispatchEntry = {
    ...last,
    passIndex: 0,
    renderState: { cullMode: 'back' },
    stencilReference: 8,
    defines: { FEATURE: '1' },
  };
  const overlay = captureDispatchOverlays([first, last]).values.get(3);
  expect(overlay).toEqual({
    renderState: undefined,
    stencilReference: undefined,
    variantSet: undefined,
  });
});
