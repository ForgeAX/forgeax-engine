import { expect, it, vi } from 'vitest';
import {
  cloneRenderFeaturePlanSignatureSnapshot,
  type RenderFeatureWorkPlan,
} from '../features/plan';

function plan(revision: number, changeAll: boolean): RenderFeatureWorkPlan {
  return {
    resources: [],
    passes: Array.from({ length: 64 }, (_, index) => ({
      kind: 'compute' as const,
      name: `tick-${index}`,
      program: 'program',
      bindings: 'bindings',
      dispatches: [
        {
          kind: 'direct' as const,
          // Entry points change graph topology; direct workgroup counts are frame data.
          entryPoint: `main${changeAll || index === 31 ? revision : 0}`,
          workgroups: [1] as [number],
        },
      ],
    })),
  };
}

it('allocates detached containers for changed branches while checking every dynamic branch', () => {
  const before = cloneRenderFeaturePlanSignatureSnapshot(plan(0, false));
  const freeze = vi.spyOn(Object, 'freeze');
  let narrow: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot>;
  let wide: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot>;
  let narrowContainers: number;
  let wideContainers: number;
  try {
    narrow = cloneRenderFeaturePlanSignatureSnapshot(plan(1, false), before);
    narrowContainers = freeze.mock.calls.filter(([value]) => Array.isArray(value)).length;
    freeze.mockClear();
    wide = cloneRenderFeaturePlanSignatureSnapshot(plan(1, true), before);
    wideContainers = freeze.mock.calls.filter(([value]) => Array.isArray(value)).length;
  } finally {
    freeze.mockRestore();
  }
  expect(narrowContainers).toBeLessThan(10);
  expect(wideContainers).toBeGreaterThanOrEqual(64);
  if (
    before.passes.kind !== 'array' ||
    narrow.passes.kind !== 'array' ||
    wide.passes.kind !== 'array'
  )
    throw new Error('Missing pass snapshots');
  for (let index = 0; index < 64; index += 1) {
    expect(narrow.passes.values[index] === before.passes.values[index]).toBe(index !== 31);
    expect(wide.passes.values[index]).not.toBe(before.passes.values[index]);
  }
  expect(before).toEqual(cloneRenderFeaturePlanSignatureSnapshot(plan(0, false)));
});

it('preserves observable array length reads while deferring container allocation', () => {
  const input = { resources: [], passes: plan(0, false).passes.slice(0, 2) };
  const previous = cloneRenderFeaturePlanSignatureSnapshot(input);
  const reads: string[] = [];
  const passes = new Proxy(input.passes, {
    get(target, key, receiver) {
      if (key === 'length' || key === '0' || key === '1') reads.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  expect(cloneRenderFeaturePlanSignatureSnapshot({ resources: [], passes }, previous)).toBe(
    previous,
  );
  expect(reads).toEqual(['length', 'length', 'length', '0', 'length', '1', 'length']);
});
