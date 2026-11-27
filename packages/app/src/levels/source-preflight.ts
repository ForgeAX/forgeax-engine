import type { AssetContentLease } from '@forgeax/engine-assets-runtime/internal';
import {
  type Component,
  Disabled,
  type EcsError,
  Entity,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import {
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
  ShadowParticipation,
  Visibility,
} from '@forgeax/engine-render';
import {
  resolveMeshMaterialBindings,
  type StreamingMaterialRejection,
  streamingMaterialRejection,
} from '@forgeax/engine-render/internal';
import {
  ChildOf,
  Children,
  GlobalTransform,
  Mobility,
  MobilityKindValue,
  Name,
  Transform,
  TransformInterpolation,
  TransformTreeChanged,
} from '@forgeax/engine-scene';
import {
  type Asset,
  type AssetError,
  err,
  type MaterialAsset,
  type MeshAsset,
  ok,
  type Result,
  type SceneAsset,
} from '@forgeax/engine-types';

/** App policy for the first static Scene lifecycle, not a second component registry. */
const authored = [
  Disabled,
  Name,
  Transform,
  ChildOf,
  Mobility,
  MeshFilter,
  MeshRenderer,
  Instances,
  Layer,
  ShadowParticipation,
  Visibility,
  Collider,
  RigidBody,
] as const;
const authoredSet = new Set<Component>(authored);
export const LEVEL_STREAMING_SOURCE_COMPONENTS: readonly Component[] = Object.freeze([
  ...authored,
  SceneInstance,
]);
const residentSet = new Set<Component>([
  ...authored,
  Entity,
  GlobalTransform,
  Children,
  SceneInstance,
  TransformInterpolation,
  TransformTreeChanged,
]);
const shapes = new Set<number>([
  ColliderShapeValue.cuboid,
  ColliderShapeValue.sphere,
  ColliderShapeValue.capsule,
  ColliderShapeValue.trimesh,
]);

export type LevelSourceRejection =
  | StreamingMaterialRejection
  | 'unsupported-component'
  | 'stale-input'
  | 'duplicate-member'
  | 'author-disabled-outside-roster'
  | 'enabled-member'
  | 'missing-transform'
  | 'movable-member'
  | 'dynamic-body'
  | 'sensor'
  | 'unsupported-shape'
  | 'mesh-collision-not-produced'
  | 'mesh-not-captured'
  | 'material-binding-invalid'
  | 'material-not-captured';

export class LevelSourceError extends Error {
  readonly code = 'level-source-invalid';
  readonly expected =
    'a fixed, wholly disabled static Scene roster using the supported lifecycle vocabulary';
  readonly hint = 'repair the named source content before preparing this level again';
  constructor(
    readonly detail: {
      readonly reason: LevelSourceRejection;
      readonly entity?: EntityHandle;
      readonly component?: string;
      readonly asset?: number;
    },
  ) {
    super(`Level source: ${detail.reason}`);
    this.name = 'LevelSourceError';
  }
}
type Failure = LevelSourceError | AssetError | EcsError;
type Outcome<T> = Result<T, Failure>;
function reject(
  reason: LevelSourceRejection,
  detail: Omit<LevelSourceError['detail'], 'reason'> = {},
): Outcome<never> {
  return err(new LevelSourceError({ reason, ...detail }));
}

function vocabularyComponents(
  world: World,
  components: SceneAsset['entities'][string]['components'],
): Outcome<void> {
  // Distinct names can match the closed authored vocabulary at most once.
  for (const name of Object.keys(components)) {
    const token = world.components.resolve(name);
    if (token === undefined || !authoredSet.has(token))
      return reject('unsupported-component', { component: name });
  }
  return ok(undefined);
}

/** Run before any materialization; component-add overrides use the same closed vocabulary. */
function* vocabularySteps(
  world: World,
  content: AssetContentLease,
): Generator<void, Outcome<void>> {
  for (const handle of content.handles) {
    const read = content.read<Asset>(handle);
    if (!read.ok) return read;
    if (read.value.kind !== 'scene') {
      yield;
      continue;
    }
    for (const node of Object.values((read.value as SceneAsset).entities)) {
      const own = vocabularyComponents(world, node.components);
      if (!own.ok) return own;
      yield;
      for (const override of node.instance?.overrides ?? []) {
        const overridden = vocabularyComponents(world, override.components);
        if (!overridden.ok) return overridden;
        yield;
      }
    }
  }
  return ok(undefined);
}

function* guardedSteps<T>(
  world: World,
  content: AssetContentLease,
  work: Generator<void, Outcome<T>>,
  isCurrent: () => boolean,
): Generator<void, Outcome<T>> {
  try {
    for (;;) {
      if (!isCurrent() || !content.matchesCurrent() || world.execution.health !== 'healthy')
        return reject('stale-input');
      const next = work.next();
      if (next.done) return next.value;
      yield;
    }
  } finally {
    work.return(reject('stale-input'));
  }
}

export interface LevelSourceSchemaGuard {
  isCurrent(): boolean;
  dispose(): void;
}

function captureSchemaGuard(world: World): LevelSourceSchemaGuard {
  let expected: readonly (readonly [string, Component | undefined])[] | undefined = [
    ...residentSet,
  ].map((component) => [component.name, world.components.resolve(component.name)] as const);
  let valid = true;
  return {
    isCurrent() {
      if (!valid || expected === undefined) return false;
      for (const [name, token] of expected) {
        if (world.components.resolve(name) !== token) {
          valid = false;
          break;
        }
      }
      return valid;
    },
    dispose() {
      valid = false;
      expected = undefined;
    },
  };
}

/** Run before materialization; retain this schema proof through compilation and acceptance. */
export function* preflightLevelVocabularySteps(
  world: World,
  content: AssetContentLease,
): Generator<void, Outcome<LevelSourceSchemaGuard>> {
  const schema = captureSchemaGuard(world);
  let transferred = false;
  try {
    const result = yield* guardedSteps(
      world,
      content,
      vocabularySteps(world, content),
      schema.isCurrent,
    );
    if (!result.ok) return result;
    transferred = true;
    return ok(schema);
  } finally {
    if (!transferred) schema.dispose();
  }
}

function readMesh(content: AssetContentLease, handle: number): Outcome<MeshAsset> {
  const value = content.read<Asset>(handle);
  return value.ok && value.value.kind === 'mesh'
    ? ok(value.value as MeshAsset)
    : reject('mesh-not-captured', { asset: handle });
}
function readMaterial(content: AssetContentLease, handle: number): Outcome<MaterialAsset> {
  const value = content.read<Asset>(handle);
  return value.ok && value.value.kind === 'material'
    ? ok(value.value as MaterialAsset)
    : reject('material-not-captured', { asset: handle });
}

function validatePhysics(
  world: World,
  content: AssetContentLease,
  entity: EntityHandle,
): Outcome<void> {
  if (world.hasComponent(entity, RigidBody)) {
    const body = world.get(entity, RigidBody);
    if (!body.ok) return body;
    if (body.value.type !== RigidBodyTypeValue.static) return reject('dynamic-body', { entity });
  }
  if (!world.hasComponent(entity, Collider)) return ok(undefined);
  const collider = world.get(entity, Collider);
  if (!collider.ok) return collider;
  if (collider.value.isSensor) return reject('sensor', { entity });
  if (!shapes.has(collider.value.shape)) return reject('unsupported-shape', { entity });
  if (collider.value.shape === ColliderShapeValue.trimesh) {
    const mesh = readMesh(content, collider.value.mesh);
    if (!mesh.ok) return mesh;
    if (mesh.value.collision === undefined)
      return reject('mesh-collision-not-produced', { entity, asset: collider.value.mesh });
  }
  return ok(undefined);
}

function* validateMeshBindings(
  content: AssetContentLease,
  root: number,
  overrides: ArrayLike<number>,
): Generator<void, Outcome<void>> {
  const mesh = readMesh(content, root);
  if (!mesh.ok) return mesh;
  const bindings = resolveMeshMaterialBindings(mesh.value, overrides, {
    isValidOverride: (material) => readMaterial(content, material).ok,
    resolveMeshDefault: (reference) =>
      typeof reference === 'number' && readMaterial(content, reference).ok ? reference : undefined,
  });
  if (!bindings.ok || bindings.diagnostics.length > 0)
    return reject('material-binding-invalid', { asset: root });
  yield;
  for (const binding of bindings.bindings) {
    if (binding.handle !== 0) {
      const material = readMaterial(content, binding.handle);
      if (!material.ok) return material;
      const reason = streamingMaterialRejection(material.value);
      if (reason !== undefined) return reject(reason, { asset: binding.handle });
    }
    yield;
  }
  // Renderer selects LOD geometry against the root's effective material table.
  // A lower-detail asset's independent default materials are not consumed here.
  for (const lod of mesh.value.lods ?? []) {
    if (typeof lod.mesh !== 'number') return reject('mesh-not-captured', { asset: root });
    const geometry = readMesh(content, lod.mesh);
    if (!geometry.ok) return geometry;
    yield;
  }
  return ok(undefined);
}

export interface LevelSourceRoster {
  readonly effectiveMembers: readonly EntityHandle[];
  readonly sourceComponents: readonly Component[];
}

interface RosterInput {
  readonly members: readonly EntityHandle[];
  readonly authorDisabled: ReadonlySet<EntityHandle>;
  readonly isCurrent: () => boolean;
}

function validateStaticPose(world: World, entity: EntityHandle): Outcome<void> {
  const spatial = [MeshFilter, MeshRenderer, Instances, Collider, RigidBody].some((component) =>
    world.hasComponent(entity, component),
  );
  if (spatial && !world.hasComponent(entity, Transform))
    return reject('missing-transform', { entity });
  if (!world.hasComponent(entity, Mobility)) return ok(undefined);
  const mobility = world.get(entity, Mobility);
  if (!mobility.ok) return mobility;
  return mobility.value.kind === MobilityKindValue.static
    ? ok(undefined)
    : reject('movable-member', { entity });
}

function renderBindings(
  world: World,
  entity: EntityHandle,
): Outcome<{ mesh: number; overrides: readonly number[] }> {
  const filter = world.get(entity, MeshFilter);
  if (!filter.ok) return filter;
  const renderer = world.hasComponent(entity, MeshRenderer)
    ? world.get(entity, MeshRenderer)
    : undefined;
  if (renderer !== undefined && !renderer.ok) return renderer;
  return ok({
    mesh: filter.value.assetHandle,
    overrides: renderer?.ok ? Array.from(renderer.value.materials) : [],
  });
}

function* rosterSteps(
  world: World,
  content: AssetContentLease,
  input: RosterInput,
): Generator<void, Outcome<LevelSourceRoster>> {
  const roster = new Set<EntityHandle>(),
    effective: EntityHandle[] = [];
  // One roster uses one fixed content lease. Only exact Mesh and ordered
  // override tuples share a successful binding qualification.
  const validatedBindings = new Set<string>();
  for (const entity of input.members) {
    if (roster.has(entity)) return reject('duplicate-member', { entity });
    roster.add(entity);
    if (!world.hasComponent(entity, Disabled)) return reject('enabled-member', { entity });
    const components = world.componentsOf(entity);
    if (!components.ok) return components;
    // An entity has unique component tokens. The first unsupported token ends the check.
    for (const component of components.value) {
      if (!residentSet.has(component))
        return reject('unsupported-component', { entity, component: component.name });
    }
    const participates = !input.authorDisabled.has(entity);
    if (participates) effective.push(entity);
    const pose = validateStaticPose(world, entity);
    if (!pose.ok) return pose;
    const physics = validatePhysics(world, content, entity);
    if (!physics.ok) return physics;
    if (world.hasComponent(entity, MeshFilter)) {
      const source = renderBindings(world, entity);
      if (!source.ok) return source;
      const { mesh, overrides } = source.value;
      const key = `${mesh}:${overrides.join(',')}`;
      if (!validatedBindings.has(key)) {
        const bindings = yield* validateMeshBindings(content, mesh, overrides);
        if (!bindings.ok) return bindings;
        validatedBindings.add(key);
      }
    }
    yield;
  }
  for (const entity of input.authorDisabled) {
    if (!roster.has(entity)) return reject('author-disabled-outside-roster', { entity });
    yield;
  }
  return ok({
    effectiveMembers: Object.freeze(effective),
    sourceComponents: LEVEL_STREAMING_SOURCE_COMPONENTS,
  });
}

/** After every nested override; this grants source eligibility, not domain readiness. */
export function preflightLevelRosterSteps(
  world: World,
  content: AssetContentLease,
  input: RosterInput,
): Generator<void, Outcome<LevelSourceRoster>> {
  return guardedSteps(world, content, rosterSteps(world, content, input), input.isCurrent);
}
