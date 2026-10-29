import { createBoxGeometry } from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry';

const mesh = createBoxGeometry(1, 1, 1).unwrap();
const input = (world: object, entity = 0) => ({ world, entity, mesh, revision: 1 });
const inputs = (world: object, length = 33, offset = 0) =>
  Array.from({ length }, (_, index) => input(world, offset + index));

describe('declared dynamic geometry preparation batches', () => {
  it('admits a complete 33-member preparation in one transaction and rejects its subsets', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const candidates = lifecycle.prepareCandidates(inputs(world), 1).unwrap();
    expect(lifecycle.inspect()).toMatchObject({ prepared: 33, accepted: 0 });
    expect(lifecycle.acceptCandidates(candidates.slice(0, 32), { world, fixedStep: 1 }).ok).toBe(
      false,
    );
    const first = candidates[0];
    if (first === undefined) throw new Error('prepared batch is empty');
    expect(lifecycle.accept(first, { world, fixedStep: 1 }).ok).toBe(false);
    expect(lifecycle.inspect()).toMatchObject({ prepared: 33, accepted: 0 });
    expect(lifecycle.acceptCandidates(candidates, { world, fixedStep: 1 }).unwrap()).toHaveLength(
      33,
    );
    expect(lifecycle.inspect()).toMatchObject({ prepared: 0, accepted: 33 });
    lifecycle.dispose();
  });

  it('retains the original 32 independent preparation bound', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    for (const input of inputs(world, 32)) lifecycle.prepare(input, 1).unwrap();
    expect(lifecycle.prepareCandidates(inputs(world, 33, 100), 1)).toMatchObject({
      ok: false,
      error: {
        code: 'dynamic-geometry-budget-exceeded',
        detail: { reason: 'retained-count', limit: 32 },
      },
    });
    expect(lifecycle.inspect().prepared).toBe(32);
    lifecycle.dispose();
  });

  it('admits the maximum declared roster in the last transaction slot', () => {
    const lifecycle = createDynamicGeometryLifecycle(1);
    const world = {};
    const candidates = lifecycle.prepareCandidates(inputs(world, 4096), 1).unwrap();
    expect(candidates).toHaveLength(4096);
    expect(lifecycle.prepare(input(world, 4096), 1)).toMatchObject({
      ok: false,
      error: {
        code: 'dynamic-geometry-budget-exceeded',
        detail: { reason: 'retained-count', used: 1, limit: 1 },
      },
    });
    for (const candidate of candidates) lifecycle.cancel(candidate).unwrap();
    expect(lifecycle.inspect()).toMatchObject({ prepared: 0, meshBytes: 0 });
    lifecycle.prepare(input(world, 4096), 1).unwrap();
    lifecycle.dispose();
  });

  it('counts one declared batch as one retained transaction, never accepting partial membership', () => {
    const lifecycle = createDynamicGeometryLifecycle(2);
    const world = {};
    const first = lifecycle.prepareCandidates(inputs(world), 1).unwrap();
    const second = lifecycle.prepareCandidates(inputs(world, 33, 100), 1).unwrap();
    expect(lifecycle.prepare(input(world, 200), 1).ok).toBe(false);
    expect(
      lifecycle.acceptCandidates([...first, ...second.slice(1)], { world, fixedStep: 1 }).ok,
    ).toBe(false);
    expect(lifecycle.inspect()).toMatchObject({ prepared: 66, accepted: 0 });
    for (const candidate of first) lifecycle.cancel(candidate).unwrap();
    lifecycle.prepare(input(world, 200), 1).unwrap();
    lifecycle.dispose();
  });

  it('accepts a union of complete declared batches atomically', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const first = lifecycle.prepareCandidates(inputs(world, 3), 1).unwrap();
    const second = lifecycle.prepareCandidates(inputs(world, 2, 10), 1).unwrap();
    const third = lifecycle.prepareCandidates(inputs(world, 33, 20), 1).unwrap();
    const union = [...second, ...first, ...third];
    expect(lifecycle.acceptCandidates(union, { world, fixedStep: 1 }).unwrap()).toHaveLength(38);
    expect(lifecycle.inspect()).toMatchObject({ prepared: 0, accepted: 38 });
    lifecycle.dispose();
  });

  it('refuses the whole union when one member batch is partial, mixed, duplicated or failed', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const first = lifecycle.prepareCandidates(inputs(world, 3), 1).unwrap();
    const second = lifecycle.prepareCandidates(inputs(world, 2, 10), 1).unwrap();
    const single = lifecycle.prepare(input(world, 30), 1).unwrap();
    const ordering = { world, fixedStep: 1 };
    const refused = (candidates: readonly unknown[]) => {
      expect(lifecycle.acceptCandidates(candidates as typeof first, ordering).ok).toBe(false);
      expect(lifecycle.inspect()).toMatchObject({ accepted: 0 });
    };
    refused([...first, ...second.slice(0, 1)]);
    refused([...first, ...second, single]);
    refused([...first, ...second, first[0]]);
    refused([...first, ...second.slice(0, 1), second[0]]);
    refused([...first, ...second.map((candidate) => ({ ...candidate, revision: 9 }))]);
    // A member batch whose preparation failed afterwards (cancelled) cannot be admitted.
    for (const candidate of second) lifecycle.cancel(candidate).unwrap();
    refused([...first, ...second]);
    expect(lifecycle.inspect()).toMatchObject({ prepared: 4, accepted: 0 });
    // A wrong World ordering refuses every batch of the union.
    const third = lifecycle.prepareCandidates(inputs(world, 2, 40), 1).unwrap();
    expect(lifecycle.acceptCandidates([...first, ...third], { world: {}, fixedStep: 1 }).ok).toBe(
      false,
    );
    expect(lifecycle.acceptCandidates([...first, ...third], ordering).unwrap()).toHaveLength(5);
    expect(lifecycle.inspect()).toMatchObject({ prepared: 1, accepted: 5 });
    lifecycle.dispose();
  });

  it('restores its budget when any member is invalid, and preserves the total byte limit', () => {
    const lifecycle = createDynamicGeometryLifecycle(32, 1024);
    const world = {};
    const before = lifecycle.inspect();
    expect(lifecycle.prepareCandidates(inputs(world), 1)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-budget-exceeded', detail: { reason: 'mesh-bytes' } },
    });
    expect(lifecycle.inspect()).toEqual(before);
    const invalid = [input(world), { ...input(world, 1), revision: -1 }];
    expect(lifecycle.prepareCandidates(invalid, 1).ok).toBe(false);
    expect(lifecycle.inspect()).toEqual(before);
    lifecycle.dispose();
  });

  it('rejects duplicate entities, foreign Worlds, and an unbounded declared roster', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const duplicate = [input(world), input(world)];
    expect(lifecycle.prepareCandidates(duplicate, 1).ok).toBe(false);
    expect(lifecycle.prepareCandidates([input(world), input({}, 1)], 1).ok).toBe(false);
    expect(lifecycle.prepareCandidates(inputs(world, 4097), 1).ok).toBe(false);
    expect(lifecycle.inspect().prepared).toBe(0);
    lifecycle.dispose();
  });
});
