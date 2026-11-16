import type { EntityHandle } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import type {
  PhysicsBodyObbQuery,
  PhysicsColliderPrimitives,
  PhysicsFixedError,
  PhysicsWorld,
} from '@forgeax/engine-physics';
import { PhysicsWorldResource, RigidBody } from '@forgeax/engine-physics';
import { WaterDispersiveMotion, WaterShallowCollider } from '@forgeax/engine-scene';
import { err, isFiniteBounds3, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import type {
  WaterAdvancedError,
  WaterAdvancedFrame,
  WaterAdvancedRecipe,
} from '@forgeax/engine-water';
import { isGeometricCollisionField } from '../assembly/scene-sdf-projection';
import { MeshFilter } from '../components/mesh-filter';
import { captureFeatureSourceAssetVersion } from '../features/source';
import type { RenderFeatureExtractContext } from '../features/types';
import { SdfFieldUpload } from '../raytracing/sdf-field-storage';
import {
  packSdfScene,
  packSdfSceneWithStaticFields,
  type SdfMeshInstance,
  type SdfSceneFieldPayload,
} from '../raytracing/sdf-query';
import { identityOrdinal } from '../scene/generational-weak-map';

export const ADVANCED_COLLISION_FLOATS = 40;

type CollisionGeometry = Pick<
  PhysicsColliderPrimitives['elements'][number],
  'positionM' | 'rotation' | 'shape'
>;
type CollisionSource = Readonly<{ recipe: WaterAdvancedRecipe; generation: number }>;
type CollisionSettings = Exclude<
  WaterAdvancedFrame['recipe']['asset']['shallowStageConfig']['rigidMeshCollisions'],
  { readonly kind: 'disabled' }
>;
interface CollisionRequest extends CollisionSource {
  readonly originM: readonly [number, number, number];
  readonly settings: Pick<CollisionSettings, 'kind' | 'collisionGroups' | 'maxElements'>;
  readonly selection?: Pick<PhysicsBodyObbQuery, 'positionM' | 'fullExtentsM'>;
}
type CollisionIdentity =
  | Readonly<{
      kind: 'native-collider';
      colliderId: string;
      generation: number;
      elementIndex: number;
    }>
  | Readonly<{ kind: 'component-bounds'; handle: number; revision: number }>;

export interface AdvancedCollisionSnapshot {
  readonly originM: readonly [number, number, number];
  readonly nativeSourceIdentity?: number;
  readonly nativeSourceTimeSeconds?: number;
  readonly primitives: Float32Array;
  readonly sdfInstances: Uint8Array;
  readonly sdfFields: Uint8Array;
  readonly roster: readonly Readonly<{
    entity: number;
    bodyGeneration: number;
    completedStep: number;
    motionDiscontinuity: number;
    identity: CollisionIdentity;
    representation: 'sphere' | 'capsule' | 'box' | 'bounds' | 'distance-field';
    sourceMotion?: Readonly<{
      kind: 'surface-transport';
      velocityXZ: readonly [number, number];
    }>;
    mesh?: Readonly<{ handle: number; revision: number; contentRevision?: number }>;
  }>[];
}

export type AdvancedCollisionCapture =
  | Readonly<{ kind: 'ready'; value: AdvancedCollisionSnapshot }>
  | Readonly<{ kind: 'pending'; error: PhysicsFixedError }>
  | Readonly<{ kind: 'failed'; error: WaterAdvancedError }>;

/** Derive dynamic snapshot fields without observing lazy static SDF bytes. */
export function deriveAdvancedCollisionSnapshot(
  source: AdvancedCollisionSnapshot,
  overrides: Partial<Pick<AdvancedCollisionSnapshot, 'primitives' | 'roster'>>,
): AdvancedCollisionSnapshot {
  const derived = {
    originM: source.originM,
    ...(source.nativeSourceIdentity === undefined
      ? {}
      : { nativeSourceIdentity: source.nativeSourceIdentity }),
    ...(source.nativeSourceTimeSeconds === undefined
      ? {}
      : { nativeSourceTimeSeconds: source.nativeSourceTimeSeconds }),
    primitives: overrides.primitives ?? source.primitives,
    sdfInstances: source.sdfInstances,
  } as AdvancedCollisionSnapshot;
  const fieldBytes = Object.getOwnPropertyDescriptor(source, 'sdfFields');
  if (fieldBytes === undefined) throw new Error('A collision snapshot requires its SDF field view');
  Object.defineProperty(derived, 'sdfFields', fieldBytes);
  Object.defineProperty(derived, 'roster', {
    value: overrides.roster ?? source.roster,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return derived;
}

function captureFieldBytes(
  snapshot: AdvancedCollisionSnapshot,
  fields: Uint8Array | undefined,
  payload: SdfSceneFieldPayload | undefined,
): void {
  if (payload === undefined) {
    Object.defineProperty(snapshot, 'sdfFields', {
      value: fields ?? new Uint8Array(4),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  let bytes: Uint8Array | undefined;
  Object.defineProperty(snapshot, 'sdfFields', {
    enumerable: true,
    configurable: true,
    get() {
      if (bytes === undefined) {
        bytes = new Uint8Array(payload.initialization.byteLength);
        if (!payload.initialization.copyInto(bytes))
          throw new Error('The retained SDF field payload could not be materialized');
      }
      return bytes;
    },
  });
}

function collisionFailure(
  frame: CollisionSource,
  expected: string,
  cause?: unknown,
): WaterAdvancedError {
  return {
    code: 'water-advanced-stage-failed',
    expected,
    hint: 'repair the opted-in collider or recipe, then reset this simulation generation',
    detail: {
      recipeGuid: frame.recipe.guid,
      generation: frame.generation,
      ...(cause === undefined ? {} : { cause }),
    },
  };
}

type HeldCollisionMesh = Readonly<{
  handle: number;
  revision: number;
  contentRevision?: number;
  asset: MeshAsset;
}>;

interface PreparedCollisionMesh {
  readonly contentRevision: number;
  readonly upload: SdfFieldUpload;
  frame: number;
}

interface CachedSdfFieldPayload {
  readonly payload: SdfSceneFieldPayload;
  frame: number;
}

/** Static geometry stays with the Feature extraction owner; native poses remain frame inputs. */
export class AdvancedCollisionMeshOwner {
  private readonly worlds = new Map<
    RenderFeatureExtractContext['world'],
    Map<number, PreparedCollisionMesh>
  >();
  private readonly fieldLayouts = new Map<
    RenderFeatureExtractContext['world'],
    Map<string, CachedSdfFieldPayload>
  >();
  private readonly snapshotInitializations = new WeakMap<
    AdvancedCollisionSnapshot,
    SdfSceneFieldPayload['initialization']
  >();
  private frame = 0;

  beginFrame(): void {
    this.frame++;
  }

  read(
    world: RenderFeatureExtractContext['world'],
    handle: number,
    contentRevision: number,
  ): PreparedCollisionMesh | undefined {
    const entry = this.worlds.get(world)?.get(handle);
    if (entry !== undefined) entry.frame = this.frame;
    return entry?.contentRevision === contentRevision ? entry : undefined;
  }

  admit(
    world: RenderFeatureExtractContext['world'],
    handle: number,
    contentRevision: number,
    upload: SdfFieldUpload,
  ): void {
    let meshes = this.worlds.get(world);
    if (meshes === undefined) {
      meshes = new Map();
      this.worlds.set(world, meshes);
    }
    meshes.set(handle, { contentRevision, upload, frame: this.frame });
  }

  fieldPayload(
    world: RenderFeatureExtractContext['world'],
    source: readonly SdfMeshInstance[],
  ): SdfSceneFieldPayload | undefined {
    const unique: SdfFieldUpload[] = [];
    const seen = new Set<SdfFieldUpload>();
    for (const instance of source) {
      if ('missing' in instance.field) continue;
      const upload = instance.fieldUpload;
      if (!(upload instanceof SdfFieldUpload) || upload.field !== instance.field) return undefined;
      if (!seen.has(upload)) {
        seen.add(upload);
        unique.push(upload);
      }
    }
    if (unique.length === 0) return undefined;
    const uploadIds = unique.map(identityOrdinal),
      key = JSON.stringify(uploadIds);
    let layouts = this.fieldLayouts.get(world);
    if (layouts === undefined) {
      layouts = new Map();
      this.fieldLayouts.set(world, layouts);
    }
    let cached = layouts.get(key);
    if (cached === undefined) {
      const offsets = new Map<SdfFieldUpload, number>();
      let wordLength = 0;
      for (const upload of unique) {
        if (upload.length > 4_194_304 - wordLength) return undefined;
        offsets.set(upload, wordLength);
        wordLength += upload.length;
      }
      const byteLength = wordLength * 4;
      const initialization = Object.freeze({
        version: JSON.stringify([identityOrdinal(world), uploadIds, wordLength]),
        byteLength,
        copyInto(target: Uint8Array): boolean {
          if (target.byteLength !== byteLength) return false;
          const words = new Uint32Array(target.buffer, target.byteOffset, wordLength);
          for (const upload of unique) upload.copyInto(words, offsets.get(upload) ?? -1);
          return true;
        },
      });
      cached = {
        payload: Object.freeze({
          uploads: Object.freeze(unique),
          offsets,
          wordLength,
          initialization,
        }),
        frame: this.frame,
      };
      layouts.set(key, cached);
    }
    cached.frame = this.frame;
    return cached.payload;
  }

  rememberFieldInitialization(
    snapshot: AdvancedCollisionSnapshot,
    initialization: SdfSceneFieldPayload['initialization'],
  ): void {
    this.snapshotInitializations.set(snapshot, initialization);
  }

  fieldInitializationFor(
    snapshot: AdvancedCollisionSnapshot,
  ): SdfSceneFieldPayload['initialization'] | undefined {
    return this.snapshotInitializations.get(snapshot);
  }

  finishFrame(): void {
    for (const [world, meshes] of this.worlds) {
      for (const [handle, entry] of meshes) if (entry.frame !== this.frame) meshes.delete(handle);
      if (meshes.size === 0) this.worlds.delete(world);
    }
    for (const [world, layouts] of this.fieldLayouts) {
      for (const [key, entry] of layouts) if (entry.frame !== this.frame) layouts.delete(key);
      if (layouts.size === 0) this.fieldLayouts.delete(world);
    }
  }
}
type CapturedCollisionMesh = Readonly<{
  mesh: HeldCollisionMesh;
  field?: Pick<SdfMeshInstance, 'transform' | 'field' | 'fieldUpload'>;
}>;

function captureCollisionMesh(
  context: RenderFeatureExtractContext,
  _worldIndex: number,
  frame: CollisionSource,
  entity: EntityHandle,
  body: PhysicsColliderPrimitives,
  originM: readonly [number, number, number],
  requireField: boolean,
  meshOwner: AdvancedCollisionMeshOwner | undefined,
): Result<CapturedCollisionMesh | undefined, WaterAdvancedError> {
  const world = context.world;
  if (world === undefined)
    return err(collisionFailure(frame, 'an extracted World for held rigid collision geometry'));
  if (!world.hasComponent(entity, MeshFilter)) return ok(undefined);
  const handle = world.get(entity, MeshFilter).unwrap().assetHandle;
  if (handle === 0) return ok(undefined);
  const captureResolvedCollisionMesh = () => {
    const captured = captureFeatureSourceAssetVersion(context, handle);
    if (!captured?.ok || captured.value.value.kind !== 'mesh')
      return err(
        collisionFailure(
          frame,
          'an available held MeshAsset version for each bound rigid distance-field source',
          captured?.ok === false ? captured.error : undefined,
        ),
      );
    const asset: MeshAsset = captured.value.value;
    const mesh = {
      handle: captured.value.handle,
      revision: captured.value.revision,
      asset,
      ...(captured.value.contentRevision === undefined
        ? {}
        : { contentRevision: captured.value.contentRevision }),
    };
    if (!requireField || asset.distanceField === undefined) return ok({ mesh });
    const contentRevision = captured.value.contentRevision;
    const prepared =
      contentRevision === undefined
        ? undefined
        : meshOwner?.read(world, mesh.handle, contentRevision);
    if (prepared === undefined && !isGeometricCollisionField(asset.distanceField))
      return err(
        collisionFailure(frame, 'a geometric, artifact-verified accepted MeshAsset distance field'),
      );
    const field = prepared?.upload.field ?? asset.distanceField;
    if (asset.morphTargets !== undefined || asset.morphWeights !== undefined)
      return err(collisionFailure(frame, 'an undeformed rigid MeshAsset distance field'));
    let upload = prepared?.upload;
    if (meshOwner !== undefined && contentRevision !== undefined && upload === undefined) {
      const capturedUpload = SdfFieldUpload.capture(field);
      if (!capturedUpload.ok)
        return err(
          collisionFailure(
            frame,
            'a bounded accepted rigid distance-field upload',
            capturedUpload.error,
          ),
        );
      upload = capturedUpload.value;
      meshOwner.admit(world, mesh.handle, contentRevision, upload);
    }
    return ok({
      mesh,
      field: {
        transform: mat4.compose(
          mat4.create(),
          [
            body.positionM[0] - originM[0],
            body.positionM[1] - originM[1],
            body.positionM[2] - originM[2],
          ],
          body.rotation,
          body.scale,
        ),
        field,
        ...(upload === undefined ? {} : { fieldUpload: upload }),
      },
    });
  };
  return captureResolvedCollisionMesh();
}

function componentBounds(
  frame: CollisionSource,
  body: PhysicsColliderPrimitives,
  captured: CapturedCollisionMesh | undefined,
): Result<
  Readonly<{
    local: NonNullable<PhysicsBodyObbQuery['emptyAggregateLocalBounds']>;
    geometry: CollisionGeometry;
    identity: CollisionIdentity;
  }>,
  WaterAdvancedError
> {
  const bounds = captured?.mesh.asset.aabb;
  const minX = bounds?.[0],
    minY = bounds?.[1],
    minZ = bounds?.[2];
  const maxX = bounds?.[3],
    maxY = bounds?.[4],
    maxZ = bounds?.[5];
  if (
    !captured ||
    !isFiniteBounds3(bounds) ||
    minX === undefined ||
    minY === undefined ||
    minZ === undefined ||
    maxX === undefined ||
    maxY === undefined ||
    maxZ === undefined
  )
    return err(
      collisionFailure(
        frame,
        'finite held MeshAsset local bounds for an originally empty accepted aggregate',
      ),
    );
  const center: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  const half: [number, number, number] = [(maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2];
  const offset = quat.transformVec3(vec3.create(), body.rotation, [
    center[0] * body.scale[0],
    center[1] * body.scale[1],
    center[2] * body.scale[2],
  ]);
  const [offsetX, offsetY, offsetZ] = offset;
  if (offsetX === undefined || offsetY === undefined || offsetZ === undefined)
    return err(
      collisionFailure(frame, 'a three-component transformed held MeshAsset bounds center'),
    );
  return ok({
    local: { centerM: center, halfExtentsM: half },
    geometry: {
      positionM: [
        body.positionM[0] + offsetX,
        body.positionM[1] + offsetY,
        body.positionM[2] + offsetZ,
      ],
      rotation: body.rotation,
      shape: {
        kind: 'box',
        representation: 'bounds',
        halfExtentsM: [half[0] * body.scale[0], half[1] * body.scale[1], half[2] * body.scale[2]],
      },
    },
    identity: Object.freeze({
      kind: 'component-bounds',
      handle: captured.mesh.handle,
      revision: captured.mesh.contentRevision ?? captured.mesh.revision,
    }),
  });
}

type SelectedBody = Readonly<{
  body: PhysicsColliderPrimitives;
  elements: readonly Readonly<{ geometry: CollisionGeometry; identity: CollisionIdentity }>[];
  captured?: CapturedCollisionMesh;
}>;

function captureSelectedBody(
  context: RenderFeatureExtractContext,
  worldIndex: number,
  frame: CollisionRequest,
  physics: PhysicsWorld,
  entity: EntityHandle,
  originM: readonly [number, number, number],
  meshOwner: AdvancedCollisionMeshOwner | undefined,
): Result<
  SelectedBody | undefined,
  WaterAdvancedError | Extract<AdvancedCollisionCapture, { kind: 'pending' }>
> {
  const settings = frame.settings;
  if (
    physics.getCommittedColliderPrimitives === undefined ||
    (frame.selection !== undefined && physics.intersectsCommittedBodyObb === undefined)
  )
    return err(collisionFailure(frame, 'accepted native collider snapshots and body OBB queries'));
  const accepted = physics.getCommittedColliderPrimitives(entity, settings.collisionGroups);
  if (!accepted.ok) {
    if (
      accepted.error.code === 'fixed-body-missing' &&
      accepted.error.detail.recovery === 'await-native-sync' &&
      context.world?.hasComponent(entity, RigidBody)
    )
      return err({ kind: 'pending', error: accepted.error });
    return err(
      collisionFailure(
        frame,
        'a live accepted native body for each enabled WaterShallowCollider',
        accepted.error,
      ),
    );
  }
  const body = accepted.value;
  let captured: CapturedCollisionMesh | undefined;
  if (body.rawAggregateCount === 0) {
    const held = captureCollisionMesh(
      context,
      worldIndex,
      frame,
      entity,
      body,
      originM,
      settings.kind === 'distance-field',
      meshOwner,
    );
    if (!held.ok) return held;
    captured = held.value;
  }
  const bounds = body.rawAggregateCount === 0 ? componentBounds(frame, body, captured) : undefined;
  if (bounds?.ok === false) return bounds;
  const selected =
    frame.selection === undefined
      ? ok(true)
      : physics.intersectsCommittedBodyObb?.({
          entity,
          generation: body.generation,
          completedStep: body.completedStep,
          positionM: frame.selection.positionM,
          rotation: [0, 0, 0, 1],
          fullExtentsM: frame.selection.fullExtentsM,
          ...(bounds?.ok ? { emptyAggregateLocalBounds: bounds.value.local } : {}),
        });
  if (!selected?.ok)
    return err(
      collisionFailure(
        frame,
        'a same-generation completed-step native rigid OBB query',
        selected?.error,
      ),
    );
  if (!selected.value) return ok(undefined);
  const captureSelectedElements = () => {
    const elements = bounds?.ok
      ? [bounds.value]
      : body.elements.map((element) => ({
          geometry: element,
          identity: Object.freeze({
            kind: 'native-collider' as const,
            colliderId: element.colliderId,
            generation: element.generation,
            elementIndex: element.elementIndex,
          }),
        }));
    if (elements.length === 0) return ok(undefined);
    if (captured === undefined && settings.kind === 'distance-field') {
      const held = captureCollisionMesh(
        context,
        worldIndex,
        frame,
        entity,
        body,
        originM,
        true,
        meshOwner,
      );
      if (!held.ok) return held;
      captured = held.value;
    }
    return ok({ body, elements, ...(captured === undefined ? {} : { captured }) });
  };
  return captureSelectedElements();
}

function packCollisionPrimitive(
  element: CollisionGeometry,
  originM: readonly [number, number, number],
  fieldIndex: number,
): Readonly<{
  values: readonly number[];
  representation: AdvancedCollisionSnapshot['roster'][number]['representation'];
}> {
  const { shape } = element;
  const transform = mat4.compose(
    mat4.create(),
    [
      element.positionM[0] - originM[0],
      element.positionM[1] - originM[1],
      element.positionM[2] - originM[2],
    ],
    element.rotation,
    [1, 1, 1],
  );
  return {
    values: [
      ...mat4.invert(mat4.create(), transform),
      ...transform,
      ...(shape.kind === 'sphere'
        ? [0, shape.radiusM, 0, 0]
        : shape.kind === 'capsule'
          ? [1, shape.radiusM, shape.halfHeightM, 0]
          : [2, ...shape.halfExtentsM]),
      fieldIndex + 1,
      0,
      0,
      0,
    ],
    representation:
      fieldIndex >= 0
        ? 'distance-field'
        : shape.kind === 'box'
          ? shape.representation === 'bounds'
            ? 'bounds'
            : 'box'
          : shape.kind,
  };
}

/** Captures accepted native geometry and held mesh fields once for this extracted frame. */
export function captureAdvancedCollisions(
  context: RenderFeatureExtractContext,
  worldIndex: number,
  frame: WaterAdvancedFrame,
  meshOwner?: AdvancedCollisionMeshOwner,
): AdvancedCollisionCapture {
  const settings = frame.recipe.asset.shallowStageConfig.rigidMeshCollisions;
  const originM = [
    frame.transform.centerXZ[0],
    frame.transform.heightOriginM,
    frame.transform.centerXZ[1],
  ] as const;
  if (settings.kind === 'disabled') return emptyCollisionSnapshot(originM);
  const surface = frame.collisionSurface;
  if (surface.status !== 'ready')
    return {
      kind: 'failed',
      error: collisionFailure(
        frame,
        'a current WaterSystem CPU surface query for native rigid component selection',
      ),
    };
  const config = frame.recipe.asset.shallowStageConfig;
  return captureRigidCollisions(
    context,
    worldIndex,
    {
      recipe: frame.recipe,
      generation: frame.generation,
      originM,
      settings,
      selection: {
        positionM: [originM[0], surface.positionM[1], originM[2]],
        fullExtentsM: [
          frame.transform.extentM[0],
          (settings.overlapThicknessCells * frame.transform.extentM[0]) / config.gridResolution[0],
          frame.transform.extentM[1],
        ],
      },
    },
    meshOwner,
  );
}

function emptyCollisionSnapshot(
  originM: readonly [number, number, number],
): AdvancedCollisionCapture {
  const packed = packSdfScene([], 100);
  if (!packed.ok) throw new Error('An empty rigid field snapshot must be packable');
  return {
    kind: 'ready',
    value: {
      originM,
      primitives: new Float32Array(ADVANCED_COLLISION_FLOATS),
      sdfInstances: packed.value.instances,
      sdfFields: packed.value.fields,
      roster: [],
    },
  };
}

/** Full accepted roster: submerged sources never disappear through a surface-slab filter. */
export function captureDispersiveCollisions(
  context: RenderFeatureExtractContext,
  worldIndex: number,
  frame: CollisionSource,
  meshOwner?: AdvancedCollisionMeshOwner,
): AdvancedCollisionCapture {
  const config = frame.recipe.asset.oceanPatchConfig;
  if (config?.algorithm !== 'mode-projected-gravity/1')
    return {
      kind: 'failed',
      error: collisionFailure(frame, 'the explicit mode-projected gravity configuration'),
    };
  return captureRigidCollisions(
    context,
    worldIndex,
    {
      ...frame,
      originM: [config.centerXZ[0], config.baseHeightM, config.centerXZ[1]],
      settings: config.collisions,
    },
    meshOwner,
  );
}

function captureRigidCollisions(
  context: RenderFeatureExtractContext,
  worldIndex: number,
  frame: CollisionRequest,
  meshOwner: AdvancedCollisionMeshOwner | undefined,
): AdvancedCollisionCapture {
  const { settings, originM } = frame;
  const primitiveRows: number[] = [];
  const roster: AdvancedCollisionSnapshot['roster'][number][] = [];
  const fields: SdfMeshInstance[] = [];
  let pending: Extract<AdvancedCollisionCapture, { kind: 'pending' }> | undefined;
  let nativeSourceTimeSeconds: number | undefined;
  let nativeSourceIdentity: number | undefined;
  const fail = (expected: string, cause?: unknown): AdvancedCollisionCapture => ({
    kind: 'failed',
    error: collisionFailure(frame, expected, cause),
  });
  const captureSelectedRigidBodies = (): AdvancedCollisionCapture | undefined => {
    {
      const world = context.world;
      if (world === undefined || !world.hasResource(PhysicsWorldResource))
        return fail('an installed 3D PhysicsWorld with accepted collider snapshot support');
      const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
      nativeSourceIdentity = identityOrdinal(physics);
      nativeSourceTimeSeconds = physics.getSolverClock?.().simulationTimeSeconds;
      if (
        physics.getCommittedColliderPrimitives === undefined ||
        (frame.selection !== undefined && physics.intersectsCommittedBodyObb === undefined)
      )
        return fail(
          'PhysicsWorld accepted primitive snapshots and native OBB queries for an enabled rigid collision path',
        );
      const query = world.query({ read: [WaterShallowCollider] });
      if (!query.ok) return fail('registered saved WaterShallowCollider vocabulary', query.error);
      const batches = query.value.batches();
      if (!batches.ok) return fail('readable numeric WaterShallowCollider batches', batches.error);
      for (const batch of batches.value) {
        const entities = batch.entities;
        const enabled = batch.read(WaterShallowCollider, 'enabled');
        const motion = batch.read(WaterShallowCollider, 'dispersiveMotion');
        for (let index = 0; index < batch.count; index++) {
          const physicalRow =
            batch.kind === 'indexed' ? (batch.rows[index] as number) : batch.start + index;
          const entity = entities[physicalRow] as EntityHandle;
          if (enabled[physicalRow] === 0) continue;
          const surfaceTransport =
            frame.recipe.asset.oceanPatchConfig?.algorithm === 'mode-projected-gravity/1' &&
            motion[physicalRow] === WaterDispersiveMotion.surfaceTransport;
          const selected = captureSelectedBody(
            context,
            worldIndex,
            frame,
            physics,
            entity,
            originM,
            meshOwner,
          );
          if (!selected.ok) {
            if ('kind' in selected.error) {
              pending ??= selected.error;
              continue;
            }
            return { kind: 'failed', error: selected.error };
          }
          if (selected.value === undefined) continue;
          const appendSelectedRigidElements = (
            value: NonNullable<typeof selected.value>,
          ): AdvancedCollisionCapture | undefined => {
            const { body, elements, captured } = value;
            if (roster.length + elements.length > settings.maxElements)
              return fail(
                `at most ${settings.maxElements} accepted rigid elements across selected components (maximum 100)`,
              );
            let fieldIndex = -1;
            const meshIdentity =
              captured === undefined
                ? undefined
                : {
                    handle: captured.mesh.handle,
                    revision: captured.mesh.revision,
                    ...(captured.mesh.contentRevision === undefined
                      ? {}
                      : { contentRevision: captured.mesh.contentRevision }),
                  };
            if (captured?.field !== undefined) {
              fieldIndex = fields.length;
              fields.push({
                instanceId: fieldIndex,
                geometryId: fieldIndex,
                mask: 255,
                ...captured.field,
              });
            }
            for (const element of elements) {
              const packed = packCollisionPrimitive(element.geometry, originM, fieldIndex);
              primitiveRows.push(...packed.values);
              roster.push(
                Object.freeze({
                  entity: body.entity,
                  bodyGeneration: body.generation,
                  completedStep: body.completedStep,
                  motionDiscontinuity: body.motionDiscontinuity,
                  identity: element.identity,
                  representation: packed.representation,
                  ...(surfaceTransport
                    ? {
                        sourceMotion: {
                          kind: 'surface-transport' as const,
                          velocityXZ: [
                            body.linearVelocityMps[0],
                            body.linearVelocityMps[2],
                          ] as const,
                        },
                      }
                    : {}),
                  ...(meshIdentity === undefined ? {} : { mesh: meshIdentity }),
                }),
              );
            }
            return undefined;
          };
          const elementFailure = appendSelectedRigidElements(selected.value);
          if (elementFailure !== undefined) return elementFailure;
        }
      }
    }
    return undefined;
  };
  const captureFailure = captureSelectedRigidBodies();
  if (captureFailure !== undefined) return captureFailure;
  if (pending) return pending;
  const captureWorld = context.world;
  const fieldPayload =
    captureWorld === undefined ? undefined : meshOwner?.fieldPayload(captureWorld, fields);
  const packed =
    fieldPayload === undefined
      ? packSdfScene(fields, 100)
      : packSdfSceneWithStaticFields(fields, 100, fieldPayload);
  if (!packed.ok)
    return fail('a bounded, invertible accepted rigid distance-field snapshot', packed.error);
  const order = roster
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = primitiveRows[a.index * ADVANCED_COLLISION_FLOATS + 32];
      const right = primitiveRows[b.index * ADVANCED_COLLISION_FLOATS + 32];
      if (left === undefined || right === undefined)
        throw new Error('A captured collision roster row requires its packed primitive');
      return left - right;
    });
  const snapshot = {
    originM,
    ...(nativeSourceIdentity === undefined ? {} : { nativeSourceIdentity }),
    ...(nativeSourceTimeSeconds === undefined ? {} : { nativeSourceTimeSeconds }),
    primitives:
      primitiveRows.length === 0
        ? new Float32Array(ADVANCED_COLLISION_FLOATS)
        : new Float32Array(
            order.flatMap(({ index }) =>
              primitiveRows.slice(
                index * ADVANCED_COLLISION_FLOATS,
                (index + 1) * ADVANCED_COLLISION_FLOATS,
              ),
            ),
          ),
    sdfInstances: packed.value.instances,
  } as AdvancedCollisionSnapshot;
  captureFieldBytes(
    snapshot,
    'fields' in packed.value ? packed.value.fields : undefined,
    fieldPayload,
  );
  Object.defineProperty(snapshot, 'roster', {
    value: Object.freeze(order.map(({ row }) => row)),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  if (fieldPayload !== undefined)
    meshOwner?.rememberFieldInitialization(snapshot, fieldPayload.initialization);
  return { kind: 'ready', value: snapshot };
}

/** Previous poses advance only at the feature's accepted submission boundary. */
export function advancedCollisionHistory(
  current: AdvancedCollisionSnapshot,
  previous: AdvancedCollisionSnapshot | undefined,
): AdvancedCollisionSnapshot {
  if (previous === undefined || previous.nativeSourceIdentity !== current.nativeSourceIdentity)
    return current;
  const identity = (row: AdvancedCollisionSnapshot['roster'][number]) =>
    JSON.stringify([row.entity, row.bodyGeneration, row.identity]);
  const prior = new Map(previous.roster.map((row, index) => [identity(row), { row, index }]));
  const primitives = current.primitives.slice();
  for (const [index, row] of current.roster.entries()) {
    const old = prior.get(identity(row));
    if (old === undefined) continue;
    const oldRow = old.row;
    if (row.motionDiscontinuity !== oldRow.motionDiscontinuity) continue;
    if (
      row.mesh?.handle !== oldRow.mesh?.handle ||
      (row.mesh?.contentRevision ?? row.mesh?.revision) !==
        (oldRow.mesh?.contentRevision ?? oldRow.mesh?.revision)
    )
      continue;
    const offset = index * ADVANCED_COLLISION_FLOATS,
      oldOffset = old.index * ADVANCED_COLLISION_FLOATS;
    if (
      [0, 1, 2, 3].some(
        (lane) => primitives[offset + 32 + lane] !== previous.primitives[oldOffset + 32 + lane],
      )
    )
      continue;
    const transform = mat4.invert(
      mat4.create(),
      previous.primitives.subarray(oldOffset, oldOffset + 16),
    );
    for (const axis of [0, 1, 2] as const) {
      const translation = transform[12 + axis];
      if (translation === undefined)
        throw new Error('An inverted collision transform requires its translation components');
      transform[12 + axis] = translation + previous.originM[axis] - current.originM[axis];
    }
    primitives.set(transform, offset + 16);
  }
  return deriveAdvancedCollisionSnapshot(current, { primitives });
}
