import {
  defineComponent,
  ENTITY_NULL_RAW,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  Time,
  type World,
} from '@forgeax/engine-ecs';
import {
  createStateProjection,
  readMutationEpoch,
  readRenderArrayView,
  type StateProjection,
} from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { type Mat4, mat4, quat } from '@forgeax/engine-math';
import { ChildOf } from './components/child-of';
import { Children } from './components/children';
import { GlobalTransform, Transform } from './components/transform';

/** Fixed-step local TRS whose presentation is sampled between the last two ticks. */
export const TransformInterpolation = defineComponent(
  'TransformInterpolation',
  {},
  { transient: true },
);

interface Pose {
  pos: Float32Array;
  rotation: Float32Array;
  scale: Float32Array;
}
interface History {
  previous: Pose;
  current: Pose;
  parent: number | undefined;
  tick: number;
}
interface CachedPose {
  matrix: Mat4;
  local: Mat4;
  version: number;
}
interface Presentation {
  history: Map<EntityHandle, History>;
  cache: Map<EntityHandle, CachedPose>;
  source: StateProjection;
  members: Map<number, EntityHandle>;
  moving: Set<EntityHandle>;
  captures: Set<number>;
  active: Set<EntityHandle>;
  next: Set<EntityHandle>;
  pending: Set<EntityHandle>;
  path: EntityHandle[];
  visited: Set<EntityHandle>;
  position: Float32Array;
  rotation: ReturnType<typeof quat.create>;
  scale: Float32Array;
  version: number;
  prepared: number;
  time: number;
  epoch: number;
  structure: number;
  dropped: number;
}
const presentations = new WeakMap<World, Presentation>();

function pose(): Pose {
  return { pos: new Float32Array(3), rotation: new Float32Array(4), scale: new Float32Array(3) };
}
function readPose(world: World, entity: EntityHandle, target: Pose): boolean {
  const position = readRenderArrayView(world, entity, Transform, 'pos');
  const rotation = readRenderArrayView(world, entity, Transform, 'quat');
  const scale = readRenderArrayView(world, entity, Transform, 'scale');
  if (position === undefined || rotation === undefined || scale === undefined) return false;
  target.pos.set(position);
  target.rotation.set(rotation);
  target.scale.set(scale);
  return true;
}
function copyPose(from: Pose, to: Pose): void {
  to.pos.set(from.pos);
  to.rotation.set(from.rotation);
  to.scale.set(from.scale);
}
function equal(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
function samePose(a: Pose, b: Pose): boolean {
  return equal(a.pos, b.pos) && equal(a.rotation, b.rotation) && equal(a.scale, b.scale);
}
function parent(world: World, entity: EntityHandle): number | undefined {
  const value = world[worldRead].getFieldValue(entity, ChildOf, 'parent');
  return value === ENTITY_NULL_RAW ? undefined : value;
}
function validHistory(world: World, entity: EntityHandle, history: History): boolean {
  if (
    !world.hasComponent(entity, Transform) ||
    history.tick !== world.getResource(FixedTime).tick ||
    history.parent !== parent(world, entity)
  )
    return false;
  const position = readRenderArrayView(world, entity, Transform, 'pos');
  const rotation = readRenderArrayView(world, entity, Transform, 'quat');
  const scale = readRenderArrayView(world, entity, Transform, 'scale');
  return (
    position !== undefined &&
    rotation !== undefined &&
    scale !== undefined &&
    equal(history.current.pos, position) &&
    equal(history.current.rotation, rotation) &&
    equal(history.current.scale, scale)
  );
}

function refresh(world: World, state: Presentation): void {
  const time = world.getResource(Time).elapsed;
  const epoch = readMutationEpoch(world);
  const structure = world.getStructureEpoch();
  if (state.time === time && state.epoch === epoch && state.structure === structure) return;
  if (state.structure !== structure) {
    for (const entity of state.cache.keys())
      if (!world.hasComponent(entity, Transform)) state.cache.delete(entity);
  }
  state.time = time;
  state.epoch = epoch;
  state.structure = structure;
  state.version += 1;
  const dropped = world.getResource(FixedTime).droppedUpdates;
  if (state.dropped !== dropped) {
    for (const history of state.history.values()) {
      history.previous.pos.set(history.current.pos);
      history.previous.rotation.set(history.current.rotation);
      history.previous.scale.set(history.current.scale);
    }
    state.dropped = dropped;
  }
}

function sample(world: World, entity: EntityHandle, state: Presentation): Mat4 | undefined {
  const { path, visited } = state;
  path.length = 0;
  visited.clear();
  let cursor: EntityHandle | undefined = entity;
  let resolved: Mat4 | undefined;
  while (cursor !== undefined) {
    if (visited.has(cursor) || !world.hasComponent(cursor, Transform)) return undefined;
    visited.add(cursor);
    const cached = state.cache.get(cursor);
    if (cached?.version === state.version) {
      resolved = cached.matrix;
      break;
    }
    path.push(cursor);
    cursor = parent(world, cursor) as EntityHandle | undefined;
  }
  const fixed = world.getResource(FixedTime);
  const alpha = Math.max(0, Math.min(1, fixed.overstep / fixed.delta));
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const node = path[index];
    if (node === undefined) continue;
    let cached = state.cache.get(node);
    if (cached === undefined) {
      cached = { matrix: mat4.create(), local: mat4.create(), version: -1 };
      state.cache.set(node, cached);
    }
    const history = state.history.get(node);
    if (
      history !== undefined &&
      world.hasComponent(node, TransformInterpolation) &&
      validHistory(world, node, history)
    ) {
      for (let axis = 0; axis < 3; axis += 1) {
        state.position[axis] =
          (history.previous.pos[axis] ?? 0) +
          ((history.current.pos[axis] ?? 0) - (history.previous.pos[axis] ?? 0)) * alpha;
        state.scale[axis] =
          (history.previous.scale[axis] ?? 1) +
          ((history.current.scale[axis] ?? 1) - (history.previous.scale[axis] ?? 1)) * alpha;
      }
      quat.slerp(state.rotation, history.previous.rotation, history.current.rotation, alpha);
      mat4.compose(cached.local, state.position, state.rotation, state.scale);
    } else {
      const position = readRenderArrayView(world, node, Transform, 'pos');
      const rotation = readRenderArrayView(world, node, Transform, 'quat');
      const scale = readRenderArrayView(world, node, Transform, 'scale');
      if (position !== undefined && rotation !== undefined && scale !== undefined) {
        mat4.compose(cached.local, position, rotation, scale);
      } else {
        const local = world.get(node, Transform).unwrap();
        mat4.compose(cached.local, local.pos, local.quat, local.scale);
      }
    }
    if (resolved === undefined) cached.matrix.set(cached.local);
    else mat4.multiply(cached.matrix, resolved, cached.local);
    cached.version = state.version;
    resolved = cached.matrix;
  }
  return resolved;
}

/** Borrowed presentation matrix; consume it before the next World mutation. */
export function readPresentationWorldMatrix(
  world: World,
  entity: EntityHandle,
): ArrayLike<number> | undefined {
  const state = presentations.get(world);
  if (state === undefined) return readRenderArrayView(world, entity, GlobalTransform, 'world');
  refresh(world, state);
  if (state.prepared === state.version)
    return readRenderArrayView(
      world,
      entity,
      GlobalTransform,
      state.active.has(entity) ? 'presentation' : 'world',
    );
  if (state.history.size === 0 && !world.hasComponent(entity, TransformInterpolation))
    return readRenderArrayView(world, entity, GlobalTransform, 'world');
  return sample(world, entity, state);
}

/** Explicit discontinuity: the next sampled pose starts at the new author value. */
export function resetTransformInterpolation(world: World, entity: EntityHandle): void {
  const state = presentations.get(world);
  if (state === undefined) return;
  state.history.delete(entity);
  state.moving.delete(entity);
  state.source.invalidate();
  state.version += 1;
}

function capture(world: World, state: Presentation, before: boolean): void {
  const tick = world.getResource(FixedTime).tick;
  if (before) {
    // A stopped writer still owes one final settlement of its previous pose.
    for (const entity of state.moving) {
      const history = state.history.get(entity);
      if (history !== undefined) copyPose(history.current, history.previous);
    }
    state.moving.clear();
    state.captures.clear();
  }
  const batch = state.source.read();
  for (const index of batch.indices) state.captures.add(index);
  for (const index of before ? batch.indices : state.captures) {
    const entity = state.source.entity(index);
    const previous = state.members.get(index);
    if (previous !== undefined && previous !== entity) {
      state.history.delete(previous);
      state.moving.delete(previous);
      state.members.delete(index);
    }
    if (entity === undefined) continue;
    if (
      !world.hasComponent(entity, TransformInterpolation) ||
      !world.hasComponent(entity, Transform)
    ) {
      state.history.delete(entity);
      state.moving.delete(entity);
      state.members.delete(index);
      continue;
    }
    let history = state.history.get(entity);
    const fresh = history === undefined;
    history ??= { previous: pose(), current: pose(), parent: undefined, tick };
    if (!before && !fresh) copyPose(history.current, history.previous);
    if (before || fresh || state.source.changed(entity, Transform))
      readPose(world, entity, history.current);
    const nextParent = parent(world, entity);
    // Writes between fixed ticks and reparenting are author discontinuities,
    // not a blend from an obsolete local frame. New fixed writers retain the
    // accepted prior pose even after many entirely stationary ticks.
    if (before || fresh || nextParent !== history.parent)
      copyPose(history.current, history.previous);
    if (!before || fresh) history.parent = nextParent;
    history.tick = tick;
    state.history.set(entity, history);
    state.members.set(index, entity);
    if (!before && !samePose(history.previous, history.current)) state.moving.add(entity);
  }
  batch.accept();
  if (!before) state.captures.clear();
  state.version += 1;
}

/** Called by the existing Update propagation owner, after simulation matrices settle. */
export function publishPresentationTransforms(world: World): void {
  const state = presentations.get(world);
  if (state === undefined) return;
  refresh(world, state);
  const { pending, next } = state;
  pending.clear();
  next.clear();
  for (const entity of state.active) pending.add(entity);
  for (const entity of state.moving) {
    const history = state.history.get(entity);
    if (
      history === undefined ||
      !world.hasComponent(entity, TransformInterpolation) ||
      samePose(history.previous, history.current) ||
      !validHistory(world, entity, history)
    )
      continue;
    state.path.length = 0;
    state.path.push(entity);
    while (state.path.length > 0) {
      const node = state.path.pop();
      if (node === undefined) break;
      if (next.has(node)) continue;
      next.add(node);
      pending.add(node);
      const children = readRenderArrayView(world, node, Children, 'entities');
      if (children !== undefined)
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index];
          if (child !== undefined) state.path.push(child as EntityHandle);
        }
    }
  }
  for (const entity of pending) {
    const current = readRenderArrayView(world, entity, GlobalTransform, 'presentation');
    if (current === undefined) continue;
    const candidate = next.has(entity)
      ? sample(world, entity, state)
      : readRenderArrayView(world, entity, GlobalTransform, 'world');
    if (candidate !== undefined && !equal(current, candidate))
      world.setArrayRange(entity, GlobalTransform, 'presentation', 0, candidate).unwrap();
  }
  const previous = state.active;
  state.active = next;
  state.next = previous;
  state.epoch = readMutationEpoch(world);
  state.prepared = state.version;
}

export function registerTransformInterpolation(world: World): () => void {
  const state: Presentation = {
    history: new Map(),
    cache: new Map(),
    source: createStateProjection(
      world,
      [Transform, ChildOf, TransformInterpolation],
      [TransformInterpolation],
    ),
    members: new Map(),
    moving: new Set(),
    captures: new Set(),
    active: new Set(),
    next: new Set(),
    pending: new Set(),
    path: [],
    visited: new Set(),
    position: new Float32Array(3),
    rotation: quat.create(),
    scale: new Float32Array(3),
    version: 0,
    prepared: -1,
    time: -1,
    epoch: -1,
    structure: -1,
    dropped: 0,
  };
  presentations.set(world, state);
  world
    .addSystem(FixedUpdate, {
      name: 'captureTransformPrevious',
      before: [FixedUpdate],
      queries: [],
      fn: () => capture(world, state, true),
    })
    .unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'captureTransformCurrent',
      after: [FixedUpdate],
      queries: [],
      fn: () => capture(world, state, false),
    })
    .unwrap();
  return () => {
    world.removeSystem(FixedUpdate, 'captureTransformPrevious').unwrap();
    world.removeSystem(FixedUpdate, 'captureTransformCurrent').unwrap();
    presentations.delete(world);
  };
}
