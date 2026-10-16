import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { type Mat4, mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '../index';
import {
  beginTransformPropagationTrace,
  endTransformPropagationTrace,
} from '../systems/propagate-transforms';
import { setMalformedParentEdge } from './fixtures/malformed-hierarchy-edge';

const Tag = defineComponent('StructuralDirtyPropagationTag', { value: 'i32' });
const FLAT_COUNT = 4096;
const HIERARCHY_COUNT = 64;
const BLOCK_ROWS = 256;

function spawnAt(world: World, pos: number[], parent?: EntityHandle): EntityHandle {
  const transform = {
    component: Transform,
    data: { pos, quat: [0, 0.6, 0, 0.8], scale: [2, 1, 1] },
  };
  if (parent === undefined) return world.spawn(transform).unwrap();
  return world.spawn(transform, { component: ChildOf, data: { parent } }).unwrap();
}

function createWorld(): World {
  const world = new World();
  world.components.register(Tag).unwrap();
  return world;
}

function populate(world: World): { flats: EntityHandle[]; roots: EntityHandle[] } {
  const flats: EntityHandle[] = [];
  const roots: EntityHandle[] = [];
  for (let index = 0; index < FLAT_COUNT; index += 1) flats.push(spawnAt(world, [index, 0, 0]));
  for (let index = 0; index < HIERARCHY_COUNT; index += 1) {
    const root = spawnAt(world, [0, index, 0]);
    const child = spawnAt(world, [1, 0, 0], root);
    spawnAt(world, [0, 0, 1], child);
    roots.push(root);
  }
  return { flats, roots };
}

function localMatrix(world: World, entity: EntityHandle): Mat4 {
  const local = world.get(entity, Transform).unwrap();
  const out = mat4.create();
  mat4.compose(out, local.pos, local.quat, local.scale);
  return out;
}

function expectedWorld(world: World, entity: EntityHandle, depth = 0): Mat4 {
  const local = localMatrix(world, entity);
  const edge = world.get(entity, ChildOf);
  if (!edge.ok || depth > 1024) return local;
  const parentWorld = expectedWorld(world, edge.value.parent as EntityHandle, depth + 1);
  const out = mat4.create();
  mat4.multiply(out, parentWorld, local);
  return out;
}

function liveTransforms(world: World): EntityHandle[] {
  const entities: EntityHandle[] = [];
  for (const row of world.query({ read: [Transform] }).unwrap()) entities.push(row.entity);
  return entities;
}

function expectOracle(world: World): void {
  const mismatches: EntityHandle[] = [];
  for (const entity of liveTransforms(world)) {
    const actual = world.get(entity, GlobalTransform).unwrap().world;
    const expected = expectedWorld(world, entity);
    for (let index = 0; index < 16; index += 1) {
      if (Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)) > 1e-4) {
        mismatches.push(entity);
        break;
      }
    }
  }
  expect(mismatches).toEqual([]);
}

function traced(world: World) {
  beginTransformPropagationTrace();
  const result = propagateTransforms(world);
  const trace = endTransformPropagationTrace();
  return { result, trace };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe('structural transform propagation', () => {
  it('bounds work for an unrelated spawn by the touched storage blocks, not the population', () => {
    const world = createWorld();
    populate(world);
    propagateTransforms(world).unwrap();

    const spawned = spawnAt(world, [7, 0, 0]);
    const { result, trace } = traced(world);

    expect(result.ok).toBe(true);
    expect(trace.flatStructuralRootRows).toBeLessThanOrEqual(2 * BLOCK_ROWS);
    expect(trace.hierarchyRootInvocations).toBeLessThanOrEqual(2 * BLOCK_ROWS);
    expect(trace.hierarchyRowsEvaluated).toBe(0);
    expect(world.get(spawned, GlobalTransform).unwrap().world[12]).toBeCloseTo(7);
    expectOracle(world);
  });

  it('bounds work for an unrelated despawn by the touched storage blocks', () => {
    const world = createWorld();
    const { flats } = populate(world);
    propagateTransforms(world).unwrap();

    world.despawn(flats[FLAT_COUNT / 2] as EntityHandle).unwrap();
    const { result, trace } = traced(world);

    expect(result.ok).toBe(true);
    expect(trace.flatStructuralRootRows).toBeLessThanOrEqual(2 * BLOCK_ROWS);
    expect(trace.hierarchyRootInvocations).toBeLessThanOrEqual(2 * BLOCK_ROWS);
    expect(trace.hierarchyRowsEvaluated).toBe(0);
    expectOracle(world);
  });

  it('re-evaluates only the migrated subtree when a parent changes archetype', () => {
    const world = createWorld();
    const { roots } = populate(world);
    propagateTransforms(world).unwrap();

    const root = roots[3] as EntityHandle;
    world.addComponent(root, { component: Tag, data: { value: 1 } }).unwrap();
    world.set(root, Transform, { pos: [9, 9, 9] }).unwrap();
    const { result, trace } = traced(world);

    expect(result.ok).toBe(true);
    expect(trace.hierarchyRowsEvaluated).toBeLessThanOrEqual(2 * BLOCK_ROWS);
    expect(trace.hierarchyRootInvocations).toBeLessThanOrEqual(4 * BLOCK_ROWS);
    expectOracle(world);
  });

  it('keeps detach, attach and reparent results identical to a full evaluation', () => {
    const world = createWorld();
    const { flats, roots } = populate(world);
    propagateTransforms(world).unwrap();

    const child = liveTransforms(world).find((entity) => {
      const edge = world.get(entity, ChildOf);
      return edge.ok && edge.value.parent === roots[2];
    }) as EntityHandle;
    world.removeComponent(child, ChildOf).unwrap();
    propagateTransforms(world).unwrap();
    expectOracle(world);

    world
      .addComponent(flats[10] as EntityHandle, {
        component: ChildOf,
        data: { parent: roots[4] as EntityHandle },
      })
      .unwrap();
    propagateTransforms(world).unwrap();
    expectOracle(world);

    world.set(flats[10] as EntityHandle, ChildOf, { parent: child }).unwrap();
    propagateTransforms(world).unwrap();
    expectOracle(world);

    world
      .addComponent(child, { component: ChildOf, data: { parent: flats[20] as EntityHandle } })
      .unwrap();
    propagateTransforms(world).unwrap();
    expectOracle(world);

    world.despawn(roots[5] as EntityHandle).unwrap();
    propagateTransforms(world).unwrap();
    expectOracle(world);
  });

  it('reports a broken edge when a parent loses its transform pair', () => {
    const world = createWorld();
    const { roots } = populate(world);
    propagateTransforms(world).unwrap();

    const root = roots[6] as EntityHandle;
    world.removeComponent(root, Transform).unwrap();
    world.removeComponent(root, GlobalTransform).unwrap();
    const result = propagateTransforms(world);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('hierarchy-broken');
  });

  it('still reports malformed edges written after a successful pass', () => {
    const world = createWorld();
    const a = spawnAt(world, [1, 0, 0], spawnAt(world, [0, 0, 0]));
    const b = spawnAt(world, [2, 0, 0], spawnAt(world, [0, 0, 0]));
    propagateTransforms(world).unwrap();

    setMalformedParentEdge(world, a, b);
    setMalformedParentEdge(world, b, a);
    const result = propagateTransforms(world);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('hierarchy-cycle');
  });

  it('repairs an external GlobalTransform write on a flat root and its descendants', () => {
    const world = createWorld();
    const root = spawnAt(world, [3, 0, 0]);
    const child = spawnAt(world, [1, 0, 0], root);
    propagateTransforms(world).unwrap();

    const corrupted = new Float32Array(16);
    world.set(root, GlobalTransform, { world: corrupted }).unwrap();
    world.set(child, GlobalTransform, { world: corrupted }).unwrap();
    propagateTransforms(world).unwrap();

    expectOracle(world);
  });

  it('matches a full evaluation through randomized structural edits', () => {
    const world = createWorld();
    const random = mulberry32(0x5eed);
    const live: EntityHandle[] = [];
    for (let index = 0; index < 300; index += 1) {
      const parent =
        index > 0 && random() < 0.5 ? live[Math.floor(random() * live.length)] : undefined;
      live.push(spawnAt(world, [random(), random(), random()], parent));
    }
    propagateTransforms(world).unwrap();
    expectOracle(world);

    for (let frame = 0; frame < 60; frame += 1) {
      for (let edit = 0; edit < 4; edit += 1) {
        const pick = live[Math.floor(random() * live.length)] as EntityHandle;
        const other = live[Math.floor(random() * live.length)] as EntityHandle;
        const roll = random();
        if (!world.get(pick, Transform).ok) continue;
        if (roll < 0.15) {
          live.push(
            spawnAt(world, [random(), 0, 0], world.get(other, Transform).ok ? other : undefined),
          );
        } else if (roll < 0.25) {
          world.despawn(pick);
        } else if (roll < 0.4) {
          world.removeComponent(pick, ChildOf);
        } else if (roll < 0.55) {
          if (world.get(other, Transform).ok && other !== pick) {
            if (world.get(pick, ChildOf).ok) world.set(pick, ChildOf, { parent: other });
            else world.addComponent(pick, { component: ChildOf, data: { parent: other } });
          }
        } else if (roll < 0.7) {
          if (world.get(pick, Tag).ok) world.removeComponent(pick, Tag);
          else world.addComponent(pick, { component: Tag, data: { value: frame } });
        } else {
          world.set(pick, Transform, { pos: [random(), random(), random()] }).unwrap();
        }
      }
      propagateTransforms(world).unwrap();
      expectOracle(world);
    }
  });
});
