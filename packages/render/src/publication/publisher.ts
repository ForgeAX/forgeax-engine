import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  runtimeAssetReference,
  runtimeAssetSource,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import { type EntityHandle, Time, type World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { Children, GlobalTransform, readPresentationWorldMatrix } from '@forgeax/engine-scene';
import { type Asset, err, ok, type Result } from '@forgeax/engine-types';
import { stereoEyeCameras } from '../components/stereo-camera';
import { renderMaterialContext } from '../extract/material-context';
import { fullscreenRenderFeatureDeclaration } from '../features/fullscreen';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import { renderFeatureCameraView } from '../features/view';
import { MaterialResource } from '../material-resource';
import {
  type MaterialSnapshot,
  type MaterialSnapshotCachesByWorld,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
  resolveRuntimeAssetReference,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  acceptRenderSourceEntities,
  captureRenderSourceEntities,
  createGlobalTransformChangeQuery,
  createRenderSourceState,
  isRenderableMember,
  renderSourceHierarchyChanged,
} from '../scene/render-source';
import { registerRenderSourceSystems } from '../scene/source-systems';
import { getTransparentSortConfig } from '../systems/transparent-sort-config';
import { renderTargetMaterialSourceIdentity } from '../targets/material-source';
import { type CanvasTextureSource, isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import { renderTextureSourceKey } from '../textures/source-token';
import { PublishedAssetClosure } from './asset-closure';
import { type PublishedCanvasFrame, publicationCanvasFrames } from './canvas';
import {
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
  type RenderPublicationTemplate,
} from './contract';
import { publicationFrameDependencies, renderableAssetRoots } from './dependencies';
import { beginSourcePreparation, type SourcePreparationObservation } from './observation';
import { publicationMaterialProgramKeys } from './programs';
import { worldRenderResources } from './resource-scope';
import { SkinJointReferences } from './skin-joints';
import { publicationTargetSources, type RenderPublicationTargetOwner } from './targets';
import {
  materialCanvasSources,
  materialVideoClips,
  projectTextureConsumers,
} from './texture-consumers';
import { publicationVideoFrames } from './video';

const EMPTY_ASSET_ROWS: readonly (readonly [number, Asset, number])[] = Object.freeze([]);
const EMPTY_IDENTITIES: readonly number[] = Object.freeze([]);
const EMPTY_MATERIAL_ROWS: RenderPublication['materials'] = Object.freeze([]);

function publicationKeyValue(key: string, value: unknown): unknown {
  return value instanceof Map
    ? key === 'textureSources'
      ? [...value].map(([name, source]) => [
          name,
          isCanvasTextureSource(source)
            ? renderTextureSourceKey(source)
            : isExternalTextureSource(source)
              ? renderTextureSourceKey(source)
              : renderTargetMaterialSourceIdentity(source),
        ])
      : [...value]
    : ArrayBuffer.isView(value)
      ? Array.from(value as unknown as ArrayLike<number>)
      : value;
}

function publicationAssetBrand(asset: Asset | undefined) {
  return asset?.kind === 'material'
    ? 'material'
    : asset?.kind === 'mesh'
      ? 'mesh'
      : 'RenderFeatureAsset';
}

export interface RenderPublicationCandidate {
  readonly packet: RenderPublication;
  /** Source-local diagnostic; never serialized with the packet. */
  readonly observation?: SourcePreparationObservation;
  /** Call synchronously after successful postMessage; never wait for remote ACK. */
  accept(): void;
  discard(): void;
}

/** Source indices and asset dependencies only; the receiver owns the RenderScene. */
export function createRenderPublisher(
  world: World,
  assets: AssetRegistry,
  identity: RenderPublicationIdentity,
  capabilities?: RhiCaps,
  features: readonly RenderFeature<unknown>[] = [],
  targetOwner?: RenderPublicationTargetOwner,
  limits?: Readonly<Record<string, number>>,
  maxInFlight: 2 | 3 | 4 = 2,
  /**
   * True when the receiver already holds this exact mesh revision from a ready
   * residency preparation that stays until this publication is adopted.
   */
  preparedMesh?: (handle: number, revision: number) => boolean,
) {
  world.bindAssets(assets).unwrap();
  const assetObserver = assets.observe().unwrap();
  const assetClosure = new PublishedAssetClosure();
  const materialIds = new WeakMap<MaterialResource, number>();
  const materialRecords = new Map<
    number,
    {
      readonly resource: MaterialResource;
      readonly snapshot: MaterialSnapshot;
      readonly holds: number;
    }
  >();
  const materialsByEntity = new Map<number, readonly number[]>();
  const materialRows = new Map<number, MaterialSnapshot>();
  const materialSources = new Map<number, MaterialResource>();
  const nextMaterialDependencies = new Map<number, readonly number[]>();
  const materialHolds = new Map<number, number>();
  let nextMaterialId = 1;
  if (maxInFlight !== 2 && maxInFlight !== 3 && maxInFlight !== 4)
    throw new RenderPublicationError({ reason: 'shape', subject: 'publication capacity' });
  let activeObservation: SourcePreparationObservation | undefined;
  const publishedFullscreenFeatures = new Map<string, object>();
  const releaseTransforms = registerRenderSourceSystems(world);
  const source = createRenderSourceState(world);
  const transforms = createGlobalTransformChangeQuery(world);
  const caches: MaterialSnapshotCachesByWorld = new WeakMap();
  const members = new Set<number>();
  const publishedPrograms = new Set<string>();
  const publishedMaterialProjections = new Map<
    number,
    ReturnType<AssetRegistry['getMaterialProjectionForPayload']>
  >();
  // An accepted projection is an immutable program contract: a reload installs
  // a new object, which is also what the omission check above compares. One
  // frozen detached copy serves every row and packet, so copied materials do
  // not clone shared program rows and ABIs again, and a Worker structured clone
  // carries each shared projection once per packet.
  const detachedMaterialProjections = new WeakMap<object, object>();
  const detachMaterialProjection = <T extends object>(projection: T | undefined): T | null => {
    if (projection === undefined) return null;
    const known = detachedMaterialProjections.get(projection) as T | undefined;
    if (known !== undefined) return known;
    const owned = ownRenderFeatureProgramData(projection);
    if (!isOwnedRenderFeatureProgramData(owned)) return structuredClone(projection);
    detachedMaterialProjections.set(projection, owned);
    return owned;
  };
  let assetVersions = new Map<
    string,
    { readonly handle: number; readonly revision: number; readonly value: Asset }
  >();
  const dependencies = new Map<number, readonly number[]>();
  const pending = new Set<number>();
  let canvasConsumers = new Map<number, readonly CanvasTextureSource[]>();
  let videoConsumers = new Map<number, readonly number[]>();
  // One consuming frame and a bounded number of sealed successors.
  const flights = new Map<
    number,
    {
      features: RenderPublication['features'];
      owners: readonly RenderFeature<unknown>[];
      submitted: boolean;
    }
  >();
  const skinJoints = new SkinJointReferences();
  let frameDependencies = new Set<number>();
  let revision = 0,
    disposed = false,
    failed = false,
    active = false;
  let lastScannedRows = 0,
    allocations = 0;
  let storage = Array.from({ length: 5 }, () => new ArrayBuffer(0));
  const spareStorage: ArrayBuffer[][] = [];
  const buffer = (index: number, bytes: number): ArrayBuffer => {
    let value = storage[index] as ArrayBuffer;
    if (value.byteLength < bytes) {
      let capacity = Math.max(16, value.byteLength);
      while (capacity < bytes) capacity *= 2;
      value = new ArrayBuffer(capacity);
      storage[index] = value;
      allocations++;
    }
    return value;
  };

  const fail = (reason: RenderPublicationError['detail']['reason'], subject: string) =>
    err(new RenderPublicationError({ reason, subject }));
  const acknowledgePrograms = (programs: RenderPublication['programs']): void => {
    if (disposed || failed) return;
    for (const program of programs) publishedPrograms.add(program.key);
  };

  return {
    identity,
    /** A successful candidate preparation ACK proves these programs reached this receiver. */
    acknowledgePrograms,
    unpublishedPrograms: (programs: RenderPublication['programs']) =>
      programs.filter((program) => !publishedPrograms.has(program.key)),
    inspect: () => ({
      revision,
      failed,
      members: members.size,
      assetCount: assetClosure.size,
      scannedRows: lastScannedRows,
      inFlight: flights.size > 0,
      inFlightCount: flights.size,
      allocations,
    }),
    prepare(
      sampleTimeSeconds: number,
      temporalReset = false,
      execution?: { readonly frameId: number },
    ): Result<RenderPublicationCandidate, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      if (active || flights.size >= maxInFlight)
        return fail('in-flight', 'publication slots are occupied');
      materialRows.clear();
      materialSources.clear();
      nextMaterialDependencies.clear();
      materialHolds.clear();
      const baseline = revision === 0;
      const observation = beginSourcePreparation(
        world,
        identity.source,
        identity.epoch,
        revision + 1,
        execution?.frameId,
        baseline,
      );
      activeObservation = observation;
      const featureSources = [...features];
      const batch = source.projection.read();
      const sourceRows = captureRenderSourceEntities(world, source, batch);
      lastScannedRows = batch.scannedRows;
      observation?.fact('scannedRows', batch.scannedRows);
      observation?.fact('batchIndices', batch.indices.length);
      observation?.fact('changedComponentKinds', batch.changedComponents.length);
      observation?.fact('membershipChanged', batch.membershipChanged);
      observation?.fact('pending', pending.size);
      const changed = new Set(pending),
        removed = new Set<number>();
      const invalidated = new Set<number>();
      const assetBatch = assetObserver.read().unwrap();
      observation?.fact('assetChanges', assetBatch.changes.length);
      for (const change of assetBatch.changes)
        if (!change.removed) invalidated.add(change.handle as unknown as number);
      let sourceCursor = 0;
      for (const index of batch.indices) {
        const currentSource = sourceRows[sourceCursor++];
        const previous = source.entities.get(index)?.entity,
          current = currentSource?.entity;
        if (
          previous !== undefined &&
          members.has(previous) &&
          (current !== previous || !isRenderableMember(world, previous))
        )
          removed.add(previous);
        if (
          previous !== undefined &&
          skinJoints.has(previous) &&
          (current !== previous || !world.hasComponent(previous as EntityHandle, GlobalTransform))
        )
          skinJoints.mark(previous);
        if (current === undefined) continue;
        if (
          isRenderableMember(world, current) &&
          (baseline ||
            batch.hasStructuralChange(index) ||
            !members.has(current) ||
            source.renderableComponents.some((component) => {
              const dirty = source.projection.changed(current, component);
              if (dirty && observation !== undefined && component.name === 'MeshFilter')
                observation.count('mesh-filter-write');
              return dirty;
            }))
        ) {
          const size = observation === undefined ? 0 : changed.size;
          changed.add(current);
          observation?.count('renderable-component-or-new', changed.size !== size);
        }
        if (
          currentSource !== undefined &&
          renderSourceHierarchyChanged(source, index, currentSource)
        ) {
          const queue = [current],
            visited = new Set<number>();
          while (queue.length) {
            const entity = queue.pop() as EntityHandle;
            if (visited.has(entity)) continue;
            visited.add(entity);
            if (isRenderableMember(world, entity)) {
              const size = observation === undefined ? 0 : changed.size;
              changed.add(entity);
              observation?.count('hierarchy', changed.size !== size);
            }
            if (world.hasComponent(entity, Children))
              queue.push(
                ...Array.from(
                  world.get(entity, Children).unwrap().entities,
                  (child) => child as EntityHandle,
                ),
              );
          }
        }
      }
      if (baseline) {
        for (const entity of members) changed.add(entity);
        for (const { entity } of source.entities.values())
          if (isRenderableMember(world, entity)) {
            const size = observation === undefined ? 0 : changed.size;
            changed.add(entity);
            observation?.count('catalog-source', changed.size !== size);
          }
      }
      const matrixRows = new Map<number, ArrayLike<number>>();
      for (const span of transforms.spans().unwrap()) {
        for (let row = 0; row < span.entities.length; row++) {
          const entity = span.entities[row] as EntityHandle;
          skinJoints.mark(entity);
          if (members.has(entity) && !removed.has(entity)) {
            const matrix = readPresentationWorldMatrix(world, entity);
            if (matrix !== undefined) matrixRows.set(entity, matrix);
            pending.add(entity);
          }
        }
      }
      observation?.fact('changed', changed.size);
      observation?.fact('removed', removed.size);
      observation?.fact('invalidated', invalidated.size);
      observation?.fact('matrixRows', matrixRows.size);
      for (const entity of changed) pending.add(entity);
      let canvasFrames: readonly PublishedCanvasFrame[] = [];
      let videoFrames: RenderPublication['videoFrames'] = [];
      try {
        observation?.phase('extract');
        const frame = extractFrames([world], { cameraOwner: 0, resourceOwner: 0 }, assets, caches, {
          ...(capabilities === undefined ? {} : renderMaterialContext(capabilities, limits)),
          cull: 'none',
          retainHidden: true,
          renderables: changed.size ? { kind: 'partial', entitiesByWorld: [changed] } : 'none',
        });
        observation?.phase('templates');
        observation?.fact('renderables', frame.renderables.length);
        const meshCounts = new Map<number, number>();
        for (const row of frame.renderables)
          if (row.assetHandle !== undefined)
            meshCounts.set(row.assetHandle, (meshCounts.get(row.assetHandle) ?? 0) + 1);
        const templates: RenderPublicationTemplate[] = [],
          templateIds = new Map<string, { index: number; dependencies: readonly number[] }>();
        // Dispatch entries share their material's parameter snapshot. Intern
        // both so each pass/entity does not serialize that same payload again.
        // The value table lives only for this preparation.
        const valueIds = new Map<object, number>();
        const values = new Map<string, number>();
        const keyValue = (key: string, value: unknown): unknown =>
          key === 'paramSnapshot' && value !== null && typeof value === 'object'
            ? valueId(value, true)
            : publicationKeyValue(key, value);
        const valueId = (object: object, parameters = false): number => {
          const cached = valueIds.get(object);
          if (cached !== undefined) return cached;
          const value = JSON.stringify(object, parameters ? publicationKeyValue : keyValue);
          let id = values.get(value);
          if (id === undefined) {
            id = values.size;
            values.set(value, id);
          }
          valueIds.set(object, id);
          return id;
        };
        const upserts: number[] = [];
        const programs = new Map<string, RenderPublication['programs'][number]>();
        const programMaterials = new Set<MaterialSnapshot>();
        const nextDependencies = new Map<number, readonly number[]>();
        let closure: ReturnType<PublishedAssetClosure['begin']> | undefined;
        const publicationClosure = () => (closure ??= assetClosure.begin(assets));
        const publishMaterial = (resource: MaterialResource): number => {
          let id = materialIds.get(resource);
          if (id === undefined) {
            if (nextMaterialId > 0xffffffff)
              throw new Error('material publication identity capacity exhausted');
            id = nextMaterialId++;
            materialIds.set(resource, id);
          }
          materialSources.set(id, resource);
          if (materialRecords.get(id)?.snapshot !== resource.snapshot)
            materialRows.set(id, resource.snapshot);
          return id;
        };
        const byRenderable = new Map<number, RenderPublicationTemplate['dispatch'][number][]>();
        for (const { entityIndex: _entity, renderableIndex, ...dispatch } of frame.dispatch) {
          const rows = byRenderable.get(renderableIndex) ?? [];
          rows.push(dispatch);
          byRenderable.set(renderableIndex, rows);
        }
        const publishProgram = (key: string) => {
          if (publishedPrograms.has(key) || programs.has(key)) return;
          const shader = assets.shaderRegistry.findMaterialArtifact(key);
          if (!shader.ok) throw shader.error;
          const artifact = assets.getMaterialArtifact(key);
          programs.set(key, {
            key,
            shader: {
              source: shader.value.source,
              ...(shader.value.program.entryPoints === undefined
                ? {}
                : { entryPoints: shader.value.program.entryPoints }),
              paramSchema: shader.value.paramSchema,
              ...(shader.value.receipt === undefined ? {} : { receipt: shader.value.receipt }),
            },
            ...(artifact === undefined ? {} : { artifact }),
          });
        };
        const publishPrograms = (materials: readonly MaterialSnapshot[]) => {
          for (const material of materials) {
            if (programMaterials.has(material)) continue;
            programMaterials.add(material);
            for (const key of publicationMaterialProgramKeys(material)) publishProgram(key);
          }
        };
        for (const handle of invalidated) {
          for (const { cache, geometry, vertexColor } of caches
            .get(worldRenderResources(world))
            ?.values() ?? []) {
            if (!cache.has(handle)) continue;
            const context =
              capabilities === undefined
                ? undefined
                : renderMaterialContext(capabilities, limits).materialContext;
            const snapshot = resolveMaterialSnapshot(
              handle,
              worldRenderResources(world),
              assets,
              undefined,
              cache,
              context === undefined ? undefined : { ...context, geometry },
              undefined,
              vertexColor,
            );
            const resource = MaterialResource.from(snapshot);
            const id = materialIds.get(resource);
            if (id !== undefined && materialRecords.has(id)) {
              publishMaterial(resource);
              publishPrograms([snapshot]);
            }
          }
        }
        for (let i = 0; i < frame.renderables.length; i++) {
          const row = frame.renderables.at(i) as RenderableSnapshot;
          if ('skin' in row && row.skin !== undefined)
            return fail('unsupported', 'source GPU skin receipt');
          if (
            [...row.materials, ...(row.materialOverrides ?? [])].some((material) =>
              [...(material?.snapshot.textureSources?.values() ?? [])].some(
                isExternalTextureSource,
              ),
            )
          )
            return fail('unsupported', 'renderer-local external texture source');
          const {
            worldId: _world,
            entityKey,
            transform,
            material,
            materials,
            materialOverrides,
            ...content
          } = row;
          const materialReferences = materials.map(publishMaterial);
          const overrides = materialOverrides?.map((resource) =>
            resource === undefined ? 0 : publishMaterial(resource),
          );
          nextMaterialDependencies.set(entityKey, [
            ...materialReferences,
            ...(overrides ?? []).filter((id) => id !== 0),
          ]);
          const snapshot = {
            ...content,
            material: publishMaterial(material),
            materials: materialReferences,
            ...(overrides === undefined ? {} : { materialOverrides: overrides }),
          };
          const template = { snapshot, dispatch: byRenderable.get(i) ?? [] };
          // These payloads already contain the source entity identity. They
          // cannot share a template, regardless of equal pose/instance bytes.
          const entityOwned =
            snapshot.instances !== undefined ||
            snapshot.spriteInstances !== undefined ||
            snapshot.skinBinding !== undefined ||
            snapshot.pointsLines !== undefined;
          const key =
            entityOwned ||
            (snapshot.assetHandle !== undefined && meshCounts.get(snapshot.assetHandle) === 1)
              ? undefined
              : JSON.stringify(
                  {
                    snapshot: {
                      ...snapshot,
                      material: snapshot.material,
                      materials: snapshot.materials,
                    },
                    dispatch: template.dispatch,
                  },
                  keyValue,
                );
          let known = key === undefined ? undefined : templateIds.get(key);
          if (known === undefined) {
            const index = templates.length;
            templates.push(template);
            publishPrograms(
              [
                ...row.materials,
                ...(materialOverrides ?? []).filter((resource) => resource !== undefined),
              ].map((material) => material.snapshot),
            );
            const handles = renderableAssetRoots(row);
            known = { index, dependencies: handles };
            if (key !== undefined) templateIds.set(key, known);
          }
          upserts.push(entityKey, known.index);
          matrixRows.set(entityKey, transform.world);
          nextDependencies.set(entityKey, known.dependencies);
        }
        observation?.phase('feature');
        const nextAssetVersions = new Map<
          string,
          { readonly handle: number; readonly revision: number; readonly value: Asset }
        >();
        const featureRows = featureSources.map((feature) => {
          const data = feature
            .extract({
              worlds: [world],
              owner: 0,
              frameNumber: revision + 1,
              ...(capabilities === undefined
                ? {}
                : {
                    caps: capabilities,
                    ...(limits === undefined ? {} : { limits }),
                    ...renderMaterialContext(capabilities, limits),
                  }),
              views: frame.cameras
                .filter((camera) => camera.view?.enabled !== false)
                .flatMap(stereoEyeCameras)
                .map((camera) => ({
                  ...renderFeatureCameraView(camera),
                  ...(frame.cloudLayer === undefined
                    ? {}
                    : { frame: { cloudLayer: frame.cloudLayer } }),
                })),
              visibilitySnapshots: frame.featureVisibilitySnapshots,
              referenceAssetVersion: (sourceWorldIndex, version) => {
                if (sourceWorldIndex !== 0)
                  throw new TypeError('fixed asset source World mismatch');
                const key = `${version.handle}:${version.revision}`;
                const prior = nextAssetVersions.get(key) ?? assetVersions.get(key);
                nextAssetVersions.set(key, prior ?? version);
              },
              referenceAsset: (sourceWorldIndex, identity, captured) => {
                if (sourceWorldIndex !== 0) return undefined;
                const handle =
                  typeof identity === 'string'
                    ? resolveRuntimeAssetReference(
                        worldRenderResources(world),
                        identity,
                        publicationAssetBrand(captured),
                      )
                    : identity;
                if (handle === undefined) return undefined;
                const current = runtimeAssets(world.assets).resolveAsset(handle);
                return current.ok && current.value === captured ? handle : undefined;
              },
            })
            .unwrap();
          const fullscreen = fullscreenRenderFeatureDeclaration(feature);
          return {
            identity: feature.identity,
            data,
            ...(fullscreen === undefined ||
            publishedFullscreenFeatures.get(feature.identity) === fullscreen
              ? {}
              : { fullscreen }),
          };
        });
        observation?.phase('packet');
        const nextFrameDependencies = new Set(publicationFrameDependencies(frame));
        for (const feature of featureSources) {
          const row = featureRows.find((row) => row.identity === feature.identity);
          if (row === undefined) continue;
          for (const identity of feature.assetDependencies?.(row.data) ?? []) {
            const handle =
              typeof identity === 'string' ? runtimeAssetReference(assets, identity) : identity;
            if (handle === undefined || !assets.validate(handle).ok)
              throw new Error(`Missing feature asset ${identity}`);
            // The accepted runtime record holds its complete dependency closure.
            // Publication residency acquires it once; source Catalog rows are not
            // another dependency or current-content authority.
            nextFrameDependencies.add(handle);
          }
        }
        const emitted = new Set(frame.renderables.map((row) => row.entityKey));
        for (const entity of changed)
          if (members.has(entity) && !emitted.has(entity)) removed.add(entity);
        for (const entity of removed) matrixRows.delete(entity);
        // Reference changes are static Binding edits, never a joint-to-consumer fanout.
        let referenceEdits: Map<number, readonly number[] | undefined> | undefined;
        for (const entity of removed)
          if (skinJoints.hasBinding(entity)) {
            referenceEdits ??= new Map();
            referenceEdits.set(entity, undefined);
          }
        for (const row of frame.renderables)
          if (row.skinBinding !== undefined || skinJoints.hasBinding(row.entityKey)) {
            referenceEdits ??= new Map();
            referenceEdits.set(row.entityKey, row.skinBinding?.joints);
          }
        const references =
          referenceEdits === undefined ? undefined : skinJoints.prepare(referenceEdits);
        const jointChanges =
          skinJoints.changes.size > 0 || (references?.first.size ?? 0) > 0
            ? new Set(skinJoints.changes)
            : undefined;
        for (const joint of references?.first ?? EMPTY_IDENTITIES) jointChanges?.add(joint);
        let retiredJoints =
          (references?.retired.size ?? 0) > 0 ? new Set(references?.retired) : undefined;
        for (const joint of jointChanges ?? EMPTY_IDENTITIES) {
          if (!(references?.has(joint) ?? skinJoints.has(joint))) continue;
          const matrix =
            matrixRows.get(joint) ?? readPresentationWorldMatrix(world, joint as EntityHandle);
          if (matrix === undefined) {
            retiredJoints ??= new Set();
            retiredJoints.add(joint);
          } else matrixRows.set(joint, matrix);
        }
        observation?.fact('jointUpdates', jointChanges?.size ?? 0);
        observation?.fact('retiredJoints', retiredJoints?.size ?? 0);
        const nextVideoConsumers = projectTextureConsumers(
          videoConsumers,
          removed,
          frame.renderables,
          materialVideoClips,
        );
        videoFrames = publicationVideoFrames(world, nextVideoConsumers);
        const nextCanvasConsumers = projectTextureConsumers(
          canvasConsumers,
          removed,
          frame.renderables,
          materialCanvasSources,
        );
        canvasFrames = publicationCanvasFrames(nextCanvasConsumers);

        const transformEntities = new Uint32Array(
            buffer(2, matrixRows.size * 4),
            0,
            matrixRows.size,
          ),
          matrices = new Float32Array(buffer(3, matrixRows.size * 64), 0, matrixRows.size * 16);
        let index = 0;
        for (const [entity, matrix] of matrixRows) {
          transformEntities[index] = entity;
          matrices.set(matrix, index * 16);
          index++;
        }
        const {
          renderables: _rows,
          dispatch: _dispatch,
          visibilitySnapshots: _visibility,
          featureVisibilitySnapshots: _features,
          hiddenEntityReports: _hidden,
          ...metadata
        } = frame;
        const removedConsumers = new Set([...removed, ...nextDependencies.keys()]);
        // New holds precede old releases so a rebinding keeps shared closure members resident.
        for (const handles of nextDependencies.values())
          for (const handle of handles) publicationClosure().acquire(handle);
        for (const entity of removedConsumers)
          for (const handle of dependencies.get(entity) ?? []) publicationClosure().release(handle);
        for (const handle of nextFrameDependencies)
          if (!frameDependencies.has(handle)) publicationClosure().acquire(handle);
        for (const handle of frameDependencies)
          if (!nextFrameDependencies.has(handle)) publicationClosure().release(handle);
        for (const change of assetBatch.changes)
          if (!change.removed) publicationClosure().update(change.handle, change);
        const assetRows = closure?.rows() ?? EMPTY_ASSET_ROWS;
        const retired = closure?.retired() ?? EMPTY_IDENTITIES;
        const materialProjections = new Map<
          number,
          ReturnType<AssetRegistry['getMaterialProjectionForPayload']>
        >();
        // New dependency materials need their immutable program closure even
        // when a Mesh or Terrain edit produces no entity upsert.
        for (const [handle, value] of assetRows) {
          if (value.kind !== 'material') continue;
          const source = runtimeAssets(world.assets).resolveAsset(handle).unwrap();
          const projection =
            source.kind === 'material' ? assets.getMaterialProjectionForPayload(source) : undefined;
          materialProjections.set(handle, projection);
          if (projection !== undefined) {
            for (const pass of projection.passes)
              for (const program of pass.programs) publishProgram(program.specializationKey);
          } else {
            const snapshot = resolveMaterialSnapshot(
              handle,
              worldRenderResources(world),
              assets,
              undefined,
              undefined,
              capabilities === undefined
                ? undefined
                : renderMaterialContext(capabilities, limits).materialContext,
            );
            publishPrograms([snapshot]);
          }
        }
        const holdMaterial = (id: number, delta: number) =>
          materialHolds.set(
            id,
            (materialHolds.get(id) ?? materialRecords.get(id)?.holds ?? 0) + delta,
          );
        for (const ids of nextMaterialDependencies.values())
          for (const id of ids) holdMaterial(id, 1);
        for (const entity of new Set([...removed, ...nextMaterialDependencies.keys()]))
          for (const id of materialsByEntity.get(entity) ?? []) holdMaterial(id, -1);
        const retiredMaterials =
          materialHolds.size === 0
            ? EMPTY_IDENTITIES
            : [...materialHolds].flatMap(([id, count]) => (count === 0 ? [id] : []));
        const publishedMaterials =
          materialRows.size === 0
            ? EMPTY_MATERIAL_ROWS
            : [...materialRows]
                .filter(
                  ([id]) => (materialHolds.get(id) ?? materialRecords.get(id)?.holds ?? 0) > 0,
                )
                .map(([id, value]) => ({ id, value }));
        // A mesh revision the receiver already holds from a ready preparation
        // crosses once: send its identity, not a second cloned payload.
        const preparedRows: {
          handle: number;
          revision: number;
          guid?: string;
          sourceKey?: string;
        }[] = [];
        const sentAssetRows =
          preparedMesh === undefined
            ? [...assetRows]
            : [...assetRows].filter(([handle, value, revision]) => {
                if (value.kind !== 'mesh' || !preparedMesh(handle as number, revision)) return true;
                const guid = runtimeAssetSource(assets, handle);
                const sourceKey = guid === undefined ? undefined : assets.sourceKeyOf(guid);
                preparedRows.push({
                  handle: handle as number,
                  revision,
                  ...(guid === undefined ? {} : { guid }),
                  ...(sourceKey === undefined ? {} : { sourceKey }),
                });
                return false;
              });
        observation?.fact('preparedAssets', preparedRows.length);
        const upsertColumn = new Uint32Array(buffer(0, upserts.length * 4), 0, upserts.length);
        upsertColumn.set(upserts);
        const removedColumn = new Uint32Array(buffer(1, removed.size * 4), 0, removed.size);
        removedColumn.set([...removed]);
        observation?.phase('packet');
        const retiredJointCount = retiredJoints?.size ?? 0;
        const retiredJointColumn = new Uint32Array(
          buffer(4, retiredJointCount * 4),
          0,
          retiredJointCount,
        );
        let jointIndex = 0;
        for (const joint of retiredJoints ?? EMPTY_IDENTITIES)
          retiredJointColumn[jointIndex++] = joint;
        const packet: RenderPublication = {
          ...identity,
          protocol: 3,
          materials: publishedMaterials,
          retiredMaterials,
          revision: revision + 1,
          base: revision,
          baseline,
          time: { ...world.getResource(Time) },
          sampleTimeSeconds,
          temporalReset,
          transparentSort: getTransparentSortConfig(world),
          metadata,
          templates,
          videoFrames,
          ...(canvasFrames.length > 0 ? { canvasFrames } : {}),
          targets: targetOwner?.snapshot() ?? [],
          targetSources: publicationTargetSources(publishedMaterials),
          features: featureRows,
          assetVersions: [...nextAssetVersions].flatMap(([key, version]) =>
            assetVersions.has(key) ? [] : [{ ...version, value: structuredClone(version.value) }],
          ),
          retiredAssetVersions: [...assetVersions].flatMap(([key, { handle, revision }]) =>
            nextAssetVersions.has(key) ? [] : [{ handle, revision }],
          ),
          programs: [...programs.values()],
          upserts: upsertColumn,
          removed: removedColumn,
          transformEntities,
          transforms: matrices,
          retiredJoints: retiredJointColumn,
          ...(preparedRows.length === 0 ? {} : { preparedAssets: preparedRows }),
          assets: sentAssetRows.map(([handle, value, revision]) => {
            // Runtime content is a projection, so GUID identity stays with the
            // underlying catalogued payload rather than the projected object.
            const guid = runtimeAssetSource(assets, handle);
            const sourceKey = guid === undefined ? undefined : assets.sourceKeyOf(guid);
            const isMesh = value.kind === 'mesh';
            if (isMesh) observation?.phase('clone');
            const packetValue = structuredClone(value);
            if (isMesh) {
              observation?.phase('packet');
              observation?.mesh(handle, guid === undefined, packetValue);
            }
            return {
              handle: handle as number,
              revision,
              // Assets stay with their source owner. An admitted mesh owns a
              // detached packet copy so its large buffers can move to Render
              // without another receiver-side structured-clone allocation.
              value: packetValue,
              ...(value.kind !== 'material' ||
              (publishedMaterialProjections.has(handle) &&
                publishedMaterialProjections.get(handle) === materialProjections.get(handle))
                ? {}
                : {
                    materialProjection: detachMaterialProjection(materialProjections.get(handle)),
                  }),
              ...(guid === undefined ? {} : { guid }),
              ...(sourceKey === undefined ? {} : { sourceKey }),
            };
          }),
          retiredAssets: retired as number[],
          assetPatches: closure?.patches() ?? [],
        };
        observation?.fact('assets', packet.assets.length);
        observation?.fact('templates', templates.length);
        observation?.fact('upsertRows', upserts.length / 2);
        observation?.phase('candidate');
        batch.validate();
        active = true;
        let closed = false;
        return ok({
          packet,
          ...(observation === undefined ? {} : { observation }),
          accept: () => {
            if (closed || disposed || failed)
              throw new RenderPublicationError({ reason: 'revision', subject: 'closed candidate' });
            try {
              observation?.phase('accept');
              batch.accept();
              assetBatch.accept();
              assetVersions = nextAssetVersions;
              for (const handle of retired) publishedMaterialProjections.delete(handle);
              for (const [handle, projection] of materialProjections)
                publishedMaterialProjections.set(handle, projection);
              closure?.commit();
              for (const [id, holds] of materialHolds) {
                const resource = materialSources.get(id) ?? materialRecords.get(id)?.resource;
                if (holds === 0) materialRecords.delete(id);
                else if (resource !== undefined)
                  materialRecords.set(id, { resource, holds, snapshot: resource.snapshot });
              }
              for (const { id, value } of publishedMaterials) {
                const previous = materialRecords.get(id);
                if (previous !== undefined)
                  materialRecords.set(id, { ...previous, snapshot: value });
              }
              for (const entity of removed) materialsByEntity.delete(entity);
              for (const [entity, ids] of nextMaterialDependencies)
                materialsByEntity.set(entity, ids);
              for (const row of featureRows) {
                if (row.fullscreen !== undefined)
                  publishedFullscreenFeatures.set(row.identity, row.fullscreen);
              }
              for (const key of programs.keys()) publishedPrograms.add(key);
              closed = true;
              active = false;
              revision++;
              flights.set(revision, {
                features: featureRows,
                owners: featureSources,
                submitted: false,
              });
              storage = spareStorage.pop() ?? Array.from({ length: 5 }, () => new ArrayBuffer(0));
              for (const row of videoFrames) row.frame.close();
              for (const row of canvasFrames) row.frame?.close();
              videoConsumers = nextVideoConsumers;
              canvasConsumers = nextCanvasConsumers;
              frameDependencies = nextFrameDependencies;
              for (const entity of removedConsumers) dependencies.delete(entity);
              references?.commit();
              if (jointChanges !== undefined) skinJoints.acknowledged(jointChanges);
              for (const entity of removed) members.delete(entity);
              for (const [entity, handles] of nextDependencies) {
                members.add(entity);
                dependencies.set(entity, handles);
              }
              for (const entity of matrixRows.keys()) pending.delete(entity);
              for (const entity of removed) pending.delete(entity);
              acceptRenderSourceEntities(source, batch.indices, sourceRows);
              observation?.finish('accepted');
              activeObservation = undefined;
            } catch (cause) {
              failed = true;
              closed = true;
              active = false;
              const errors = [cause];
              for (const row of videoFrames) {
                try {
                  row.frame.close();
                } catch (cleanup) {
                  errors.push(cleanup);
                }
              }
              for (const row of canvasFrames) {
                try {
                  row.frame?.close();
                } catch (cleanup) {
                  errors.push(cleanup);
                }
              }
              observation?.finish('prepare-error');
              activeObservation = undefined;
              throw new AggregateError(
                errors,
                'Render publication acceptance failed; start a new source epoch',
                { cause },
              );
            }
          },
          discard: () => {
            if (!closed) {
              closed = true;
              active = false;
              for (const row of videoFrames) row.frame.close();
              for (const row of canvasFrames) row.frame?.close();
              observation?.finish('discarded');
              activeObservation = undefined;
            }
          },
        });
      } catch (cause) {
        observation?.finish('prepare-error');
        activeObservation = undefined;
        for (const row of videoFrames) row.frame.close();
        for (const row of canvasFrames) row.frame?.close();
        return fail('unsupported', cause instanceof Error ? cause.message : String(cause));
      }
    },
    acknowledgeFeatures(
      acceptedRevision: number,
      receipts: readonly { readonly identity: string; readonly feedback: unknown }[],
    ): Result<void, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      const flight = flights.get(acceptedRevision);
      if (flight === undefined || flight.submitted)
        return fail('revision', 'feature acknowledgment');
      const identities = new Set<string>();
      for (const receipt of receipts) {
        if (identities.has(receipt.identity))
          return fail('revision', 'duplicate feature acknowledgment');
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        if (row === undefined || feature === undefined)
          return fail('shape', 'unknown feature acknowledgment');
        identities.add(receipt.identity);
      }
      flight.submitted = true;
      for (const receipt of receipts) {
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        feature?.onSourceFrameSubmitted?.(row?.data, receipt.feedback);
      }
      return ok(undefined);
    },
    recycle(
      acceptedRevision: number,
      buffers: readonly ArrayBuffer[],
    ): Result<void, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      if (flights.keys().next().value !== acceptedRevision)
        return fail('revision', 'returned storage revision');
      if (buffers.length !== 5 || buffers.some((value) => !(value instanceof ArrayBuffer)))
        return fail('shape', 'returned storage');
      if (active || storage.some((buffer) => buffer.byteLength > 0))
        spareStorage.push([...buffers]);
      else storage = [...buffers];
      flights.delete(acceptedRevision);
      return ok(undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeObservation?.finish('retired');
      activeObservation = undefined;
      releaseTransforms();
      members.clear();
      dependencies.clear();
      assetObserver.dispose();
      assetClosure.clear();
      assetVersions.clear();
      publishedMaterialProjections.clear();
      materialRecords.clear();
      materialsByEntity.clear();
      pending.clear();
      videoConsumers.clear();
      canvasConsumers.clear();
      flights.clear();
      spareStorage.length = 0;
      frameDependencies.clear();
      skinJoints.clear();
    },
  };
}
