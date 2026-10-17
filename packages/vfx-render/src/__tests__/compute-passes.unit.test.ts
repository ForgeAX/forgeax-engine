import type { RenderFeatureWorkPlan } from '@forgeax/engine-render';
import { expect, it, vi } from 'vitest';
import { coalesceVfxComputePasses, coalesceVfxCopyPasses } from '../feature/compute-passes';

type Pass = RenderFeatureWorkPlan['passes'][number];
const programs = new Set(['program', 'other']);
const binding = (name: string) => ({
  kind: 'compute-bindings' as const,
  name,
  program: name.startsWith('other') ? 'other' : 'program',
  entries: [{ binding: 0, resource: name.endsWith('b') ? 'b' : 'a' }],
});
function compute(
  name: string,
  bindings: string,
  count = 1,
  enabled = true,
  entryPoint = 'add',
): Pass {
  return {
    kind: 'compute',
    name,
    program: binding(bindings).program,
    bindings,
    enabled,
    dispatches: [{ kind: 'direct', entryPoint, workgroups: [count] }],
  };
}
const copy = (source: string, destination: string): Pass => ({
  kind: 'copy',
  name: `copy-${source}-${destination}`,
  copies: [{ source, destination, size: 4 }],
});
const batch = (passes: readonly Pass[]) => coalesceVfxComputePasses(passes, programs, binding);
function execute(passes: readonly Pass[]) {
  const values = new Map([
    ['zero', 0],
    ['a', 1],
    ['b', 1],
  ]);
  const traces = new Map([
    ['a', [] as string[]],
    ['b', [] as string[]],
  ]);
  for (const pass of passes) {
    if (pass.enabled === false) continue;
    if (pass.kind === 'copy') {
      for (const item of pass.copies) {
        if (item.enabled === false) continue;
        values.set(item.destination, values.get(item.source) ?? 0);
        traces.get(item.destination)?.push(`copy:${item.source}`);
      }
    } else if (pass.kind === 'compute') {
      for (const dispatch of pass.dispatches) {
        if (dispatch.kind !== 'direct' || dispatch.workgroups[0] === 0) continue;
        const resource = binding(dispatch.bindings ?? pass.bindings).entries[0]?.resource;
        if (resource === undefined) throw new Error('Missing private storage');
        const old = values.get(resource) ?? 0;
        values.set(
          resource,
          dispatch.entryPoint === 'multiply' ? old * 2 : old + dispatch.workgroups[0],
        );
        traces.get(resource)?.push(`${dispatch.entryPoint}:${dispatch.workgroups[0]}`);
      }
    }
  }
  return { values, traces };
}

it('coalesces independent Players after their resets while retaining all per-Player commands', () => {
  const original = [copy('zero', 'a'), compute('a', 'a'), copy('zero', 'b'), compute('b', 'b', 3)];
  const optimized = batch(original);
  expect(optimized).toHaveLength(3);
  expect(optimized.filter((pass) => pass.kind === 'compute')).toHaveLength(1);
  expect(execute(optimized)).toEqual(execute(original));
});

it('preserves zero work and independent enablement without deleting a Player', () => {
  const original = [compute('a', 'a', 1, false), compute('b', 'b', 3)];
  const optimized = batch(original);
  expect(optimized).toHaveLength(1);
  expect(execute(optimized)).toEqual(execute(original));
  expect(
    optimized[0]?.kind === 'compute' &&
      optimized[0].dispatches.map((d) => d.kind === 'direct' && d.workgroups[0]),
  ).toEqual([0, 3]);
});

it.each([
  ['a', 'b'],
  ['zero', 'a'],
])('flushes pending work before copy %s-to-%s', (source, destination) => {
  const original = [
    compute('before', 'a'),
    copy(source, destination),
    compute('after', 'a'),
    compute('b', 'b'),
  ];
  const optimized = batch(original);
  expect(optimized[0]).toBe(original[0]);
  expect(execute(optimized)).toEqual(execute(original));
});

it('preserves shared-storage ordering between different programs', () => {
  const original = [
    compute('a1', 'a'),
    compute('other', 'other-a', 1, true, 'multiply'),
    compute('a2', 'a'),
  ];
  expect(execute(batch(original))).toEqual(execute(original));
  expect(batch(original)).toEqual(original);
});

it('keeps unproven programs and indirect commands as complete barriers', () => {
  const unknown = { ...compute('unknown', 'a'), program: 'custom' };
  const indirect: Pass = {
    kind: 'compute',
    name: 'indirect',
    program: 'program',
    bindings: 'a',
    dispatches: [{ kind: 'indirect', entryPoint: 'add', resource: 'args', offset: 0 }],
  };
  for (const barrier of [unknown, indirect]) {
    const original = [compute('a', 'a'), barrier, compute('b', 'b')];
    expect(batch(original)).toEqual(original);
  }
  const original = [compute('a', 'a'), compute('b', 'b')];
  expect(coalesceVfxComputePasses(original, new Set(), binding)).toBe(original);
});

it('coalesces adjacent resets without changing their per-copy gates or sequential data dependency', () => {
  for (const flags of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ]) {
    const original = [
      { ...copy('zero', 'a'), enabled: flags[0] },
      { ...copy('zero', 'b'), enabled: flags[1] },
    ];
    const optimized = coalesceVfxCopyPasses(original);
    expect(optimized).toHaveLength(1);
    expect(execute(optimized)).toEqual(execute(original));
  }
});
it('keeps compute and unknown work between reset batches', () => {
  const barrier = compute('between', 'a');
  const original = [copy('zero', 'a'), barrier, copy('a', 'b')];
  expect(coalesceVfxCopyPasses(original)).toEqual(original);
});

it('keeps shared copy read/write aliases in distinct graph usage scopes', () => {
  for (const original of [
    [copy('zero', 'a'), copy('a', 'b')],
    [copy('a', 'b'), copy('zero', 'a')],
  ]) {
    expect(coalesceVfxCopyPasses(original)).toEqual(original);
    expect(execute(coalesceVfxCopyPasses(original))).toEqual(execute(original));
  }
});

it('records one resource owner per pending batch instead of repeating it for each dispatch', () => {
  const set = Map.prototype.set;
  let writes = 0;
  const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    if (
      key === 'a' &&
      typeof value === 'object' &&
      value !== null &&
      'program' in value &&
      'passes' in value
    )
      writes++;
    return set.call(this, key, value);
  });
  try {
    batch([
      compute('a1', 'a'),
      compute('a2', 'a'),
      compute('a3', 'a'),
      copy('zero', 'a'),
      compute('a4', 'a'),
      compute('a5', 'a'),
      compute('a6', 'a'),
    ]);
  } finally {
    spy.mockRestore();
  }
  expect(writes).toBe(2);
});

it('preserves independent storage traces through changing programs, copies and per-dispatch gates', () => {
  let seed = 1234567;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let iteration = 0; iteration < 120; iteration++) {
    const original: Pass[] = [];
    for (let i = 0; i < 24; i++) {
      const choice = random() % 6;
      if (choice === 0) original.push(copy('zero', random() % 2 ? 'a' : 'b'));
      else if (choice === 1) original.push(copy('a', 'b'));
      else
        original.push(
          compute(
            `dynamic-${i}`,
            (choice === 2 ? 'other-' : '') + (random() % 2 ? 'a' : 'b'),
            random() % 4,
            random() % 4 !== 0,
            random() % 2 ? 'add' : 'multiply',
          ),
        );
    }
    expect(execute(batch(original))).toEqual(execute(original));
  }
});

it('retains duplicate-resource and getter observations through flush and reacquisition', () => {
  const observed: string[] = [];
  let resourceReads = 0;
  const resolve = (name: string) => ({
    kind: 'compute-bindings' as const,
    name,
    program: name.startsWith('other') ? 'other' : 'program',
    get entries() {
      observed.push(name);
      return ['a', 'a', 'b'].map((resource, binding) => ({
        binding,
        get resource() {
          resourceReads++;
          return resource;
        },
      }));
    },
  });
  const original = [
    compute('first', 'a'),
    compute('second', 'a', 2),
    copy('zero', 'a'),
    compute('other', 'other-a', 1, true, 'multiply'),
    compute('reacquired', 'a', 3),
  ];
  const optimized = coalesceVfxComputePasses(original, programs, resolve);
  expect(observed).toEqual(['a', 'a', 'other-a', 'a']);
  expect(resourceReads).toBe(24);
  expect(execute(optimized)).toEqual(execute(original));
  expect(optimized).toHaveLength(4);
});
