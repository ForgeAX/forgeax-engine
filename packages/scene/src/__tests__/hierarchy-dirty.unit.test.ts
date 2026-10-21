import { FixedUpdate, World } from '@forgeax/engine-ecs';
import { expect, it, vi } from 'vitest';
import { ChildOf } from '../components/child-of';
import { GlobalTransform, Transform } from '../components/transform';
import {
  beginTransformPropagationTrace,
  endTransformPropagationTrace,
  propagateTransforms,
  registerPropagateTransforms,
} from '../systems/propagate-transforms';

it('skips clean hierarchies and evaluates only the highest dirty subtrees', () => {
  const world = new World();
  const root = world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();
  const child = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  const leaf = world
    .spawn(
      { component: Transform, data: { pos: [3, 0, 0] } },
      { component: ChildOf, data: { parent: child } },
    )
    .unwrap();
  const sibling = world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: root } })
    .unwrap();
  propagateTransforms(world).unwrap();
  beginTransformPropagationTrace();
  propagateTransforms(world).unwrap();
  expect(endTransformPropagationTrace().hierarchyEntityLookups).toBe(0);
  world.set(child, Transform, { pos: [4, 0, 0] }).unwrap();
  world.set(leaf, Transform, { pos: [5, 0, 0] }).unwrap();
  beginTransformPropagationTrace();
  propagateTransforms(world).unwrap();
  expect(endTransformPropagationTrace().hierarchyRowsEvaluated).toBe(2);
  expect(world.get(leaf, GlobalTransform).unwrap().world[12]).toBe(10);
  world.set(child, ChildOf, { parent: sibling }).unwrap();
  propagateTransforms(world).unwrap();
  expect(world.get(leaf, GlobalTransform).unwrap().world[12]).toBe(10);
});

it('does not repeat FixedUpdate propagation in Update without another local write', () => {
  const world = new World({ time: { fixedDeltaSeconds: 1 / 60 } });
  const root = world.spawn({ component: Transform, data: {} }).unwrap();
  const child = world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: root } })
    .unwrap();
  registerPropagateTransforms(world);
  world.update(0).unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'write-local',
      queries: [],
      before: ['propagateTransformsFixed'],
      fn: () => {
        world.set(root, Transform, { pos: [3, 0, 0] }).unwrap();
      },
    })
    .unwrap();
  beginTransformPropagationTrace();
  world.update(1 / 60).unwrap();
  const trace = endTransformPropagationTrace();
  expect(trace.hierarchyRowsEvaluated).toBe(1);
  expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(3);
});

it('updates one leaf without clearing whole hierarchy state or changed masks', () => {
  const world = new World();
  const root = world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();
  let leaf = root;
  for (let i = 0; i < 1000; i++)
    leaf = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
  propagateTransforms(world).unwrap();
  world.set(leaf, Transform, { pos: [9, 0, 0] }).unwrap();
  const fill = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(() => {
    throw new Error('incremental propagation cleared a whole byte mask');
  });
  beginTransformPropagationTrace();
  try {
    propagateTransforms(world).unwrap();
  } finally {
    fill.mockRestore();
  }
  const trace = endTransformPropagationTrace();
  expect(trace.hierarchyRowsEvaluated).toBe(1);
  expect(trace.hierarchyPublishedRows).toBe(1);
  expect(trace.hierarchyPublishedRuns).toBe(1);
  expect(world.get(leaf, GlobalTransform).unwrap().world[12]).toBe(10);
});

it('recovers a planning allocation failure after private dirty cursors accepted discovery', () => {
  const world = new World();
  const root = world.spawn({ component: Transform, data: {} }).unwrap();
  const child = world
    .spawn(
      { component: Transform, data: { pos: [1, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  world.set(child, Transform, { pos: [3, 0, 0] }).unwrap();
  const push = Array.prototype.push;
  let inspecting = false;
  Array.prototype.push = function (this: unknown[], ...items: unknown[]): number {
    if (inspecting) return Reflect.apply(push, this, items);
    inspecting = true;
    try {
      if (new Error().stack?.includes('highestDirtyEntities'))
        throw new Error('planning allocation fault');
    } finally {
      inspecting = false;
    }
    return Reflect.apply(push, this, items);
  };
  try {
    expect(() => propagateTransforms(world)).toThrow('planning allocation fault');
  } finally {
    Array.prototype.push = push;
  }
  expect(world.execution.health).toBe('healthy');
  propagateTransforms(world).unwrap();
  expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(3);
});
