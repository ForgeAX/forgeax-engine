import { type EntityHandle, FixedUpdate, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChangeEpochExhaustedError } from '../../../ecs/src/errors';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '../index';
import {
  beginTransformPropagationTrace,
  endTransformPropagationTrace,
  registerPropagateTransforms,
} from '../systems/propagate-transforms';
import { setMalformedParentEdge } from './fixtures/malformed-hierarchy-edge';

const WORLD_INTERNAL_KEY: unique symbol = Symbol.for(
  'forgeax.ecs.worldInternal',
) as unknown as typeof WORLD_INTERNAL_KEY;

interface RangePublicationInjection {
  readonly nextMutationEpoch: (...args: never[]) => void;
}

interface WorldWithRangePublicationInjection {
  readonly [WORLD_INTERNAL_KEY]: RangePublicationInjection;
}

function spawnTransform(world: World, pos: number[], parent?: EntityHandle) {
  const components = [{ component: Transform, data: { pos } }];
  if (parent === undefined) return world.spawn(...components).unwrap();
  return world.spawn(...components, { component: ChildOf, data: { parent } }).unwrap();
}

describe('scene propagation', () => {
  it('materializes the derived world component from Transform at the ECS boundary', () => {
    const world = new World();
    const entity = world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();

    expect(world.get(entity, GlobalTransform).ok).toBe(true);
  });

  it('materializes the transform pair when a hierarchy edge is the only authored component', () => {
    const world = new World();
    const parent = world.spawn({ component: Transform, data: { pos: [4, 0, 0] } }).unwrap();
    const child = world.spawn({ component: ChildOf, data: { parent } }).unwrap();

    expect(world.get(child, Transform).ok).toBe(true);
    expect(world.get(child, GlobalTransform).ok).toBe(true);
    expect(propagateTransforms(world).ok).toBe(true);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(4);
  });

  it('rejects a Transform-only entity with a structured pair error', () => {
    const world = new World();
    const entity = world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
    world.removeComponent(entity, GlobalTransform).unwrap();

    const result = propagateTransforms(world);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('hierarchy-broken');
      expect(result.error.expected).toContain('GlobalTransform pair');
      expect(result.error.detail?.entity).toBe(entity);
    }
  });

  it('rejects a GlobalTransform-only entity with a structured pair error', () => {
    const world = new World();
    const entity = world.spawn({ component: GlobalTransform, data: {} }).unwrap();

    const result = propagateTransforms(world);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('hierarchy-broken');
      expect(result.error.expected).toContain('Transform pair');
      expect(result.error.detail?.entity).toBe(entity);
    }
  });

  it('preserves the ECS range-publication error in flat propagation diagnostics', () => {
    const world = new World();
    spawnTransform(world, [2, 0, 0]);
    const internal = (world as unknown as WorldWithRangePublicationInjection)[WORLD_INTERNAL_KEY];
    const originalNextEpoch = internal.nextMutationEpoch;
    Object.defineProperty(internal, 'nextMutationEpoch', {
      configurable: true,
      value: () => {
        throw new ChangeEpochExhaustedError(Number.MAX_SAFE_INTEGER);
      },
    });
    try {
      const result = propagateTransforms(world);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('hierarchy-broken');
        expect(result.error.detail?.kind).toBe('derived-write');
        if (result.error.detail?.kind === 'derived-write') {
          expect(result.error.detail.cause.code).toBe('change-epoch-exhausted');
          expect(result.error.detail.cause.expected).toBe(
            'mutationEpoch < Number.MAX_SAFE_INTEGER',
          );
          expect(result.error.detail.cause.hint).toContain('Rebuild the World');
          expect(result.error.detail.cause.detail).toEqual({ epoch: Number.MAX_SAFE_INTEGER });
        }
      }
    } finally {
      Object.defineProperty(internal, 'nextMutationEpoch', {
        configurable: true,
        value: originalNextEpoch,
      });
    }
  });

  it('registers the TransformPropagation owner in Update and FixedUpdate', () => {
    const world = new World();
    registerPropagateTransforms(world);
    expect(
      world
        .inspect()
        .schedules.find((entry) => entry.schedule === Update)
        ?.systems.map((s) => s.name),
    ).toContain('propagateTransforms');
    expect(
      world
        .inspect()
        .schedules.find((entry) => entry.schedule === FixedUpdate)
        ?.systems.map((s) => s.name),
    ).toContain('propagateTransformsFixed');
  });

  it('propagates a root and child into GlobalTransform', () => {
    const world = new World();
    registerPropagateTransforms(world);
    const root = spawnTransform(world, [2, 0, 0]);
    const child = spawnTransform(world, [3, 0, 0], root);
    expect(world.update(1 / 60).ok).toBe(true);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(5);
  });

  it('cascades linked children when a parent is despawned', () => {
    const world = new World();
    registerPropagateTransforms(world);
    const parent = spawnTransform(world, [0, 0, 0]);
    const child = spawnTransform(world, [1, 0, 0], parent);

    world.despawn(parent).unwrap();

    expect(world.update(1 / 60).ok).toBe(true);
    expect(world.get(child, Transform).ok).toBe(false);
  });

  it('keeps equal entity handles isolated across Worlds', () => {
    const first = new World();
    const second = new World();
    const firstRoot = spawnTransform(first, [3, 0, 0]);
    const secondRoot = spawnTransform(second, [7, 0, 0]);
    expect(firstRoot).toBe(secondRoot);
    expect(propagateTransforms(first).ok).toBe(true);
    expect(propagateTransforms(second).ok).toBe(true);
    expect(first.get(firstRoot, GlobalTransform).unwrap().world[12]).toBeCloseTo(3);
    expect(second.get(secondRoot, GlobalTransform).unwrap().world[12]).toBeCloseTo(7);
  });

  it('executes repeated propagation and preserves stable world semantics', () => {
    const world = new World();
    const root = spawnTransform(world, [2, 0, 0]);
    const child = spawnTransform(world, [3, 0, 0], root);

    const first = propagateTransforms(world);
    const second = propagateTransforms(world);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(5);

    const corruptedWorld = new Float32Array(16);
    corruptedWorld[12] = -100;
    world.set(child, GlobalTransform, { world: corruptedWorld }).unwrap();
    const repaired = propagateTransforms(world);
    expect(repaired.ok).toBe(true);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(5);

    world.set(root, Transform, { pos: [7, 0, 0] }).unwrap();
    const third = propagateTransforms(world);
    expect(third.ok).toBe(true);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(10);
  });

  it('recomputes the edited transform and its descendants', () => {
    const world = new World();
    const root = spawnTransform(world, [2, 0, 0]);
    const child = spawnTransform(world, [3, 0, 0], root);
    const grandchild = spawnTransform(world, [4, 0, 0], child);
    const sibling = spawnTransform(world, [20, 0, 0]);
    propagateTransforms(world).unwrap();
    world.set(child, Transform, { pos: [8, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    expect(world.get(root, GlobalTransform).unwrap().world[12]).toBeCloseTo(2);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(10);
    expect(world.get(grandchild, GlobalTransform).unwrap().world[12]).toBeCloseTo(14);
    expect(world.get(sibling, GlobalTransform).unwrap().world[12]).toBeCloseTo(20);
  });

  it('recomputes a child after reparenting to a different live parent', () => {
    const world = new World();
    const firstParent = spawnTransform(world, [10, 0, 0]);
    const secondParent = spawnTransform(world, [100, 0, 0]);
    const child = spawnTransform(world, [1, 0, 0], firstParent);
    propagateTransforms(world).unwrap();
    world.set(child, ChildOf, { parent: secondParent }).unwrap();
    propagateTransforms(world).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(101);
  });

  it('recomputes a detached ChildOf entity as a flat root even when local data is unchanged', () => {
    const world = new World();
    const parent = spawnTransform(world, [10, 0, 0]);
    const child = spawnTransform(world, [1, 0, 0], parent);
    propagateTransforms(world).unwrap();

    world.removeComponent(child, ChildOf).unwrap();
    const result = propagateTransforms(world);

    expect(result.ok).toBe(true);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(1);
  });

  it('reuses one hierarchy root cursor and reports linear traversal counters', () => {
    const world = new World();
    for (let index = 0; index < 32; index += 1) {
      const root = spawnTransform(world, [index, 0, 0]);
      spawnTransform(world, [1, 0, 0], root);
    }
    propagateTransforms(world).unwrap();

    for (const row of world.query({ write: [Transform] }).unwrap()) {
      const pos = row.mut(Transform).pos;
      pos[0] = (pos[0] ?? 0) + 1;
    }
    beginTransformPropagationTrace();
    propagateTransforms(world).unwrap();
    const trace = endTransformPropagationTrace();

    expect(trace.hierarchyRootInvocations).toBeGreaterThan(0);
    expect(trace.hierarchyRootCursorReuses).toBe(trace.hierarchyRootInvocations);
    expect(trace.hierarchyRootCursorAllocations).toBe(0);
    expect(trace.hierarchyRowsEvaluated).toBeGreaterThanOrEqual(32);
    expect(trace.hierarchyEdgesVisited).toBeGreaterThanOrEqual(32);
    expect(trace.hierarchyResidualParentProbes).toBe(0);
  });

  it('publishes a local fallback before returning a stale-parent error', () => {
    const world = new World();
    const parent = spawnTransform(world, [10, 0, 0]);
    const child = spawnTransform(world, [1, 0, 0], parent);
    propagateTransforms(world).unwrap();
    const baseline = new Float32Array(world.get(child, GlobalTransform).unwrap().world);

    const staleParent = spawnTransform(world, [50, 0, 0]);
    world.despawn(staleParent).unwrap();
    // Public relationship writes reject stale targets before changing either
    // side. Corrupt the source only through the test-owned internal fixture
    // to exercise propagation's explicit malformed-input fallback.
    setMalformedParentEdge(world, child, staleParent);
    const fault = propagateTransforms(world);

    expect(fault.ok).toBe(false);
    if (!fault.ok) expect(fault.error.code).toBe('hierarchy-broken');
    const fallback = world.get(child, GlobalTransform).unwrap().world;
    expect(fallback[12]).toBeCloseTo(1);
    expect(fallback[12]).not.toBeCloseTo(baseline[12] ?? Number.NaN);
  });

  it('cuts every member of a cycle to a finite local root fallback', () => {
    const world = new World();
    const root = spawnTransform(world, [0, 0, 0]);
    const first = spawnTransform(world, [1, 0, 0], root);
    const second = spawnTransform(world, [2, 0, 0], first);
    setMalformedParentEdge(world, first, second);

    const result = propagateTransforms(world);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('hierarchy-cycle');
    for (const entity of [first, second]) {
      const matrix = world.get(entity, GlobalTransform).unwrap().world;
      expect([...matrix].every(Number.isFinite)).toBe(true);
    }
  });

  it('bounds rootless-cycle parent probes to one residual pass', () => {
    const world = new World();
    const root = spawnTransform(world, [0, 0, 0]);
    const nodes: EntityHandle[] = [];
    let parent = root;
    for (let index = 0; index < 48; index += 1) {
      const node = spawnTransform(world, [1, 0, 0], parent);
      nodes.push(node);
      parent = node;
    }
    propagateTransforms(world).unwrap();
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (first === undefined || last === undefined) throw new Error('expected cycle nodes');
    setMalformedParentEdge(world, first, last);

    beginTransformPropagationTrace();
    const result = propagateTransforms(world);
    const trace = endTransformPropagationTrace();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('hierarchy-cycle');
    expect(trace.hierarchyResidualParentProbes).toBeGreaterThan(0);
    expect(trace.hierarchyResidualParentProbes).toBeLessThanOrEqual(nodes.length + 1);
    expect(trace.hierarchyEdgesVisited).toBeLessThanOrEqual(nodes.length + 1);
  });

  it('expands a generic ChildOf mutation and updates descendants', () => {
    const world = new World();
    const firstParent = spawnTransform(world, [10, 0, 0]);
    const secondParent = spawnTransform(world, [100, 0, 0]);
    const child = spawnTransform(world, [1, 0, 0], firstParent);
    const grandchild = spawnTransform(world, [2, 0, 0], child);

    propagateTransforms(world).unwrap();
    world.set(child, ChildOf, { parent: secondParent }).unwrap();
    propagateTransforms(world).unwrap();

    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(101);
    expect(world.get(grandchild, GlobalTransform).unwrap().world[12]).toBeCloseTo(103);
  });

  it('returns a structured error for a parent cycle', () => {
    const world = new World();
    const root = spawnTransform(world, [1, 0, 0]);
    const child = spawnTransform(world, [2, 0, 0], root);
    const result = world.addComponent(root, { component: ChildOf, data: { parent: child } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('relationship-self-cycle');
      expect(result.error.hint).toContain('descendant');
    }
  });

  it('publishes local writes before the same-tick world read', () => {
    const world = new World();
    registerPropagateTransforms(world);
    const root = spawnTransform(world, [2, 0, 0]);
    const child = spawnTransform(world, [3, 0, 0], root);
    world
      .addSystem(Update, {
        name: 'late-pose',
        queries: [],
        before: ['propagateTransforms'],
        fn: () => world.set(child, Transform, { pos: [8, 0, 0] }),
      })
      .unwrap();
    world.update(0).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(10);
  });
});
