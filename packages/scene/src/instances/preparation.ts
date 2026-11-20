import {
  Disabled,
  type EcsError,
  ENTITY_NULL_RAW,
  Entity,
  type EntityHandle,
  type QueryCreationError,
  type World,
} from '@forgeax/engine-ecs';
import { type DerivedRangeWriter, getDerivedWriter } from '@forgeax/engine-ecs/internal';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { type Mat4, mat4 } from '@forgeax/engine-math';
import { err, ok, type Result } from '@forgeax/engine-types';
import { ChildOf } from '../components/child-of';
import { GlobalTransform, Transform } from '../components/transform';

export type ScenePreparationReason =
  | 'duplicate-member'
  | 'missing-member'
  | 'enabled-member'
  | 'incomplete-transform'
  | 'parent-outside-instance'
  | 'disabled-ancestor'
  | 'hierarchy-cycle'
  | 'nonfinite-transform'
  | 'stale-input';

/** Engine-internal preparation failure, before this instance may participate. */
export class ScenePreparationError extends Error {
  readonly code = 'scene-preparation-invalid';
  readonly expected =
    'a current, wholly disabled Scene roster with a valid owned Transform hierarchy';
  readonly hint =
    'retire the candidate and prepare the current source again before accepting participation';
  constructor(
    readonly detail: { readonly reason: ScenePreparationReason; readonly entity: EntityHandle },
  ) {
    super(`Scene preparation: ${detail.reason}`);
    this.name = 'ScenePreparationError';
  }
}

export interface SceneTransformPreparation {
  /** Complete instance ownership, including synthetic roots and nested carriers. */
  readonly members: readonly EntityHandle[];
  /** Original author intent after nested overrides, separate from temporary Disabled. */
  readonly authorDisabled: ReadonlySet<EntityHandle>;
  /** Owner validates fixed content, schemas, instance structure and source writes. */
  readonly isCurrent: () => boolean;
}

type WriterPreparationError = Extract<
  ReturnType<typeof getDerivedWriter>,
  { readonly ok: false }
>['error'];

type PreparationResult<T> = Result<
  T,
  ScenePreparationError | EcsError | QueryCreationError | WriterPreparationError
>;
interface TransformPlan {
  readonly order: readonly EntityHandle[];
  readonly parents: ReadonlyMap<EntityHandle, EntityHandle>;
  readonly spatial: ReadonlySet<EntityHandle>;
}

function invalid(reason: ScenePreparationReason, entity: EntityHandle): PreparationResult<never> {
  return err(new ScenePreparationError({ reason, entity }));
}

/** No ordinary propagation query, arena view or numeric borrow spans a yield. */
export function* prepareSceneTransformsSteps(
  world: World,
  input: SceneTransformPreparation,
): Generator<void, PreparationResult<number>, void> {
  const work = prepareTransforms(world, input);
  try {
    for (;;) {
      if (!input.isCurrent())
        return invalid('stale-input', input.members[0] ?? (0 as EntityHandle));
      const next = work.next();
      if (next.done) return next.value;
      yield;
    }
  } finally {
    work.return(invalid('stale-input', input.members[0] ?? (0 as EntityHandle)));
  }
}

function validateMember(world: World, entity: EntityHandle): PreparationResult<boolean> {
  const read = world[worldRead];
  if (read.getFieldValue(entity, Entity, 'self') === undefined)
    return invalid('missing-member', entity);
  if (!world.hasComponent(entity, Disabled)) return invalid('enabled-member', entity);
  const spatial = world.hasComponent(entity, Transform);
  if (spatial !== world.hasComponent(entity, GlobalTransform))
    return invalid('incomplete-transform', entity);
  return ok(spatial);
}

function* planTransforms(
  world: World,
  input: SceneTransformPreparation,
): Generator<void, PreparationResult<TransformPlan>, void> {
  const members = new Set<EntityHandle>();
  const spatial = new Set<EntityHandle>();
  const parents = new Map<EntityHandle, EntityHandle>();
  const children = new Map<EntityHandle, EntityHandle[]>();
  const roots: EntityHandle[] = [];
  for (const entity of input.members) {
    yield;
    if (members.has(entity)) return invalid('duplicate-member', entity);
    members.add(entity);
    const valid = validateMember(world, entity);
    if (!valid.ok) return valid;
    if (valid.value) spatial.add(entity);
  }
  for (const entity of input.authorDisabled) {
    yield;
    if (!members.has(entity)) return invalid('missing-member', entity);
  }
  for (const entity of input.members) {
    yield;
    const parent = world[worldRead].getFieldValue(entity, ChildOf, 'parent');
    if (parent === undefined || parent === ENTITY_NULL_RAW) {
      roots.push(entity);
      continue;
    }
    const handle = parent as EntityHandle;
    if (!members.has(handle) || !spatial.has(handle) || !spatial.has(entity))
      return invalid('parent-outside-instance', entity);
    parents.set(entity, handle);
    const siblings = children.get(handle);
    if (siblings === undefined) children.set(handle, [entity]);
    else siblings.push(entity);
  }
  const ordered = yield* orderTransforms(input, roots, children, parents);
  if (!ordered.ok) return ordered;
  return ok({ order: ordered.value, parents, spatial });
}

function* orderTransforms(
  input: SceneTransformPreparation,
  roots: EntityHandle[],
  children: ReadonlyMap<EntityHandle, readonly EntityHandle[]>,
  parents: ReadonlyMap<EntityHandle, EntityHandle>,
): Generator<void, PreparationResult<readonly EntityHandle[]>, void> {
  const blocked = new Set<EntityHandle>();
  const visited = new Set<EntityHandle>();
  for (let cursor = 0; cursor < roots.length; cursor++) {
    yield;
    const entity = roots[cursor] as EntityHandle;
    visited.add(entity);
    const parent = parents.get(entity);
    const inherited = parent !== undefined && blocked.has(parent);
    const authored = input.authorDisabled.has(entity);
    if (inherited && !authored) return invalid('disabled-ancestor', entity);
    if (inherited || authored) blocked.add(entity);
    for (const child of children.get(entity) ?? []) {
      yield;
      roots.push(child);
    }
  }
  if (roots.length !== input.members.length) {
    for (const entity of input.members) {
      yield;
      if (!visited.has(entity)) return invalid('hierarchy-cycle', entity);
    }
  }
  return ok(roots);
}

type TransformWriter = DerivedRangeWriter<typeof Transform, typeof GlobalTransform>;
interface PreparationScratch {
  readonly position: Float32Array;
  readonly rotation: Float32Array;
  readonly scale: Float32Array;
  readonly parent: Mat4;
  readonly local: Mat4;
  readonly candidate: Mat4;
  readonly cursor: { bindingIndex: number; row: number };
}

function composeMember(
  world: World,
  entity: EntityHandle,
  parent: EntityHandle | undefined,
  scratch: PreparationScratch,
): PreparationResult<void> {
  const read = world[worldRead];
  if (
    read.copyArray(entity, Transform, 'pos', scratch.position) !== 3 ||
    read.copyArray(entity, Transform, 'quat', scratch.rotation) !== 4 ||
    read.copyArray(entity, Transform, 'scale', scratch.scale) !== 3
  )
    return invalid('incomplete-transform', entity);
  mat4.compose(scratch.local, scratch.position, scratch.rotation, scratch.scale);
  if (parent === undefined) scratch.candidate.set(scratch.local);
  else {
    if (read.copyArray(parent, GlobalTransform, 'world', scratch.parent) !== 16)
      return invalid('incomplete-transform', parent);
    mat4.multiply(scratch.candidate, scratch.parent, scratch.local);
  }
  return scratch.candidate.every(Number.isFinite)
    ? ok(undefined)
    : invalid('nonfinite-transform', entity);
}

function publishMember(
  world: World,
  writer: TransformWriter,
  entity: EntityHandle,
  parent: EntityHandle | undefined,
  scratch: PreparationScratch,
): PreparationResult<void> {
  const composed = composeMember(world, entity, parent, scratch);
  if (!composed.ok) return composed;
  if (!writer.locateEntity(entity, scratch.cursor)) return invalid('missing-member', entity);
  return writer.writeRange(
    scratch.cursor.bindingIndex,
    scratch.cursor.row,
    0,
    1,
    (binding, base) => {
      const columns = binding.write.world as Float32Array;
      columns.set(scratch.candidate, base * 16);
    },
    undefined,
  );
}

function* prepareTransforms(
  world: World,
  input: SceneTransformPreparation,
): Generator<void, PreparationResult<number>, void> {
  const plan = yield* planTransforms(world, input);
  if (!plan.ok) return plan;
  const query = world.query({ read: [Transform], write: [GlobalTransform], with: [Disabled] });
  if (!query.ok) return query;
  const writer = getDerivedWriter(query.value, GlobalTransform);
  if (!writer.ok) return writer;
  const scratch: PreparationScratch = {
    position: new Float32Array(3),
    rotation: new Float32Array(4),
    scale: new Float32Array(3),
    parent: mat4.create(),
    local: mat4.create(),
    candidate: mat4.create(),
    cursor: { bindingIndex: -1, row: -1 },
  };
  let prepared = 0;
  for (const entity of plan.value.order) {
    yield;
    if (!plan.value.spatial.has(entity)) continue;
    const valid = validateMember(world, entity);
    if (!valid.ok) return valid;
    const published = publishMember(
      world,
      writer.value,
      entity,
      plan.value.parents.get(entity),
      scratch,
    );
    if (!published.ok) return published;
    prepared++;
  }
  return ok(prepared);
}
