import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import {
  bitsFloat,
  exactHardwareEndpoint,
  executeHardwareQueryControl,
  floatBits,
  HARDWARE_ENDPOINT_CASES,
  hardwareQuerySource,
  observedHardwareEndpointProgram,
  twoUlpOpaqueBroadening,
  unsafeOpaqueBroadening,
} from './world-acceleration-endpoints.fixture';

it.each(HARDWARE_ENDPOINT_CASES)('retains native query control for $name', (entry) => {
  const source = hardwareQuerySource();
  const actual = executeHardwareQueryControl(source, entry);
  expect(actual.state.x, entry.name).toBe(entry.expected);
  if (entry.expected === 1) {
    expect(actual.primitive, entry.name).toBe(exactHardwareEndpoint(entry)?.primitive);
  }
  expect(actual.proceeds, entry.name).toBeLessThanOrEqual(entry.steps ?? 128);
});

it('retains FORCE_OPAQUE fast admission and proves filtered recovery is necessary', () => {
  const source = hardwareQuerySource(),
    inside = HARDWARE_ENDPOINT_CASES[0],
    gap = HARDWARE_ENDPOINT_CASES[2],
    outside = HARDWARE_ENDPOINT_CASES[3];
  if (!inside || !gap || !outside) throw Error('Missing authored endpoint controls');
  expect(executeHardwareQueryControl(source, inside).flags).toEqual([1]);
  expect(executeHardwareQueryControl(source, gap).flags).toEqual([1, 0]);
  const mutant = unsafeOpaqueBroadening(source);
  expect(executeHardwareQueryControl(mutant, gap).primitive).not.toBe(
    exactHardwareEndpoint(gap)?.primitive,
  );
  expect(executeHardwareQueryControl(mutant, outside).state.x).toBe(1);
  expect(exactHardwareEndpoint(outside)).toBeUndefined();
});

it('distinguishes an outer-gap auto-commit from an actual in-range surface using exact authored planes', () => {
  const entry = HARDWARE_ENDPOINT_CASES[2];
  if (!entry) throw Error('Missing gap control');
  expect(exactHardwareEndpoint(entry)?.primitive).toBe(1);
  const low = bitsFloat(floatBits(entry.first) - 1);
  expect(entry.planes[0] / entry.direction).toBeGreaterThan(low);
  expect(entry.planes[0] / entry.direction).toBeLessThan(entry.first);
});

it('composes the actual Native World query with one shared Proceed loop for opaque recovery', () => {
  const source = worldTraversalWgsl('ray-query');
  expect(source.match(/rayQueryProceed\(&query\)/g)).toHaveLength(1);
  expect(source).toContain('forceOpaque=false;');
  for (const variant of ['production', 'two-ulp-recovery', 'two-ulp-without-guard'] as const) {
    const observed = observedHardwareEndpointProgram(source, variant);
    expect(observed).toContain('hits[gid.x]=traceWorld(');
    expect(observed).not.toContain('result.state.y=c.primitive_index');
    if (process.env.FORGEAX_WORLD_ENDPOINT_WGSL)
      writeFileSync(`${process.env.FORGEAX_WORLD_ENDPOINT_WGSL}.${variant}.wgsl`, observed);
  }
});

it('distinguishes rounded open-bound clipping from a forced recovery without changing the budget', () => {
  const entry = HARDWARE_ENDPOINT_CASES[8];
  if (!entry) throw Error('Missing shared-budget control');
  const source = hardwareQuerySource();
  const unexpanded = executeHardwareQueryControl(source, entry, 'reported-f32');
  expect(unexpanded).toMatchObject({
    state: { x: 1 },
    primitive: 1,
    time: 2,
    queries: 1,
    proceeds: 1,
  });
  const forced = twoUlpOpaqueBroadening(source);
  expect(executeHardwareQueryControl(forced, entry, 'reported-f32')).toMatchObject({
    state: { x: 4 },
    queries: 2,
    proceeds: 1,
    flags: [1, 0],
  });
  expect(
    executeHardwareQueryControl(unsafeOpaqueBroadening(forced), entry, 'reported-f32'),
  ).toMatchObject({
    state: { x: 1 },
    primitive: 0,
    queries: 1,
    proceeds: 1,
  });
});
