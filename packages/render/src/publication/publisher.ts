import { type AssetRegistry, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, Time, type World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { ChildOf, Children, readPresentationWorldMatrix } from '@forgeax/engine-scene';
import { type Asset, err, type Handle, ok, type Result } from '@forgeax/engine-types';
import { Visibility } from '../components';
import { stereoEyeCameras } from '../components/stereo-camera';
import { renderMaterialContext } from '../extract/material-context';
import { fullscreenRenderFeatureDeclaration } from '../features/fullscreen';
import type { RenderFeature } from '../features/types';
import { renderFeatureCameraView } from '../features/view';
import {
  internSharedRefFromGuid,
  type MaterialSnapshot,
  type MaterialSnapshotCachesByWorld,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  createGlobalTransformChangeQuery,
  createRenderSourceState,
  isRenderableMember,
} from '../scene/render-source';
import { registerRenderSourceSystems } from '../scene/source-systems';
import { getTransparentSortConfig } from '../systems/transparent-sort-config';
import { renderTargetMaterialSourceIdentity } from '../targets/material-source';
import { type CanvasTextureSource, isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import { type PublishedCanvasFrame, publicationCanvasFrames } from './canvas';
import {
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
  type RenderPublicationTemplate,
} from './contract';
import { publicationDependencies, publicationFrameDependencies } from './dependencies';
import { publicationTargetSources, type RenderPublicationTargetOwner } from './targets';
import {
  materialCanvasSources,
  materialVideoClips,
  projectTextureConsumers,
} from './texture-consumers';
import { publicationVideoFrames } from './video';

function publicationKeyValue(key: string, value: unknown): unknown {
  return value instanceof Map
    ? key === 'textureSources'
      ? [...value].map(([name, source]) => [
          name,
          isCanvasTextureSource(source)
            ? `canvas:${source.canvasTextureId}`
            : isExternalTextureSource(source)
              ? `external:${source.externalTextureId}`
              : renderTargetMaterialSourceIdentity(source),
        ])
      : [...value]
    : ArrayBuffer.isView(value)
      ? Array.from(value as unknown as ArrayLike<number>)
      : value;
}

function publicationAssetBrand(asset: Asset | undefined) {
  return asset?.kind === 'material'
    ? 'MaterialAsset'
    : asset?.kind === 'mesh'
      ? 'MeshAsset'
      : 'RenderFeatureAsset';
}

export interface RenderPublicationCandidate {
  readonly packet: RenderPublication;
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
) {
  const publishedFullscreenFeatures = new Map<string, object>();
  const pendingMeshContent = new Set<Handle<string, 'shared'>>();
  const releaseTransforms = registerRenderSourceSystems(world, assets, {
    updateMesh: (handle) => pendingMeshContent.add(handle),
  });
  const source = createRenderSourceState(world);
  const transforms = createGlobalTransformChangeQuery(world);
  const caches: MaterialSnapshotCachesByWorld = new WeakMap();
  const members = new Set<number>();
  const publishedPrograms = new Set<string>();
  const dependencies = new Map<number, readonly Handle<string, 'shared'>[]>();
  const consumers = new Map<Handle<string, 'shared'>, Set<number>>();
  const pending = new Set<number>();
  let canvasConsumers = new Map<number, readonly CanvasTextureSource[]>();
  let videoConsumers = new Map<number, readonly number[]>();
  // Two slots: the consuming frame and one sealed successor.
  const flights = new Map<
    number,
    {
      features: RenderPublication['features'];
      owners: readonly RenderFeature<unknown>[];
      submitted: boolean;
    }
  >();
  const jointsByEntity = new Map<number, readonly number[]>();
  const skinConsumers = new Map<number, Set<number>>();
  let frameDependencies = new Set<Handle<string, 'shared'>>();
  let catalogEpoch = -1,
    revision = 0,
    disposed = false,
    active = false;
  let lastScannedRows = 0,
    allocations = 0;
  let storage = [new ArrayBuffer(0), new ArrayBuffer(0), new ArrayBuffer(0), new ArrayBuffer(0)];
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

  return {
    identity,
    inspect: () => ({
      revision,
      members: members.size,
      assetCount: consumers.size,
      scannedRows: lastScannedRows,
      inFlight: flights.size > 0,
      inFlightCount: flights.size,
      allocations,
    }),
    prepare(
      sampleTimeSeconds: number,
      temporalReset = false,
    ): Result<RenderPublicationCandidate, RenderPublicationError> {
      if (disposed) return fail('disposed', 'publisher');
      if (active || flights.size === 2)
        return fail('in-flight', 'both publication slots are occupied');
      const baseline = revision === 0;
      const featureSources = [...features];
      const batch = source.projection.read();
      lastScannedRows = batch.scannedRows;
      const changed = new Set(pending),
        removed = new Set<number>();
      const invalidated = new Set<Handle<string, 'shared'>>(pendingMeshContent);
      const runtimeChanged =
        batch.membershipChanged ||
        batch.changedComponents.includes(source.runtimeMaterialValue) ||
        batch.changedComponents.includes(source.runtimeMeshVertices);
      for (const index of batch.indices) {
        const previous = source.entities.get(index),
          current = source.projection.entity(index);
        if (
          previous !== undefined &&
          members.has(previous) &&
          (current !== previous || !isRenderableMember(world, previous))
        )
          removed.add(previous);
        if (runtimeChanged) {
          const priorHandles = source.contentHandles.get(index);
          const material =
            current !== undefined && world.hasComponent(current, source.runtimeMaterialValue)
              ? world.get(current, source.runtimeMaterialValue).unwrap().asset
              : undefined;
          const mesh =
            current !== undefined && world.hasComponent(current, source.runtimeMeshVertices)
              ? world.get(current, source.runtimeMeshVertices).unwrap().asset
              : undefined;
          // A migration can change the table without changing runtime content.
          // Compare the existing owner handles and per-component write evidence,
          // rather than invalidating every content row in a changed batch.
          if (
            (priorHandles !== undefined || material !== undefined || mesh !== undefined) &&
            (previous !== current ||
              priorHandles?.some((handle) => handle !== material && handle !== mesh) ||
              (current !== undefined &&
                (source.projection.changed(current, source.runtimeMaterialValue) ||
                  source.projection.changed(current, source.runtimeMeshVertices))))
          ) {
            for (const handle of priorHandles ?? [])
              invalidated.add(handle as Handle<string, 'shared'>);
            if (material !== undefined) invalidated.add(material);
            if (mesh !== undefined) invalidated.add(mesh);
          }
        }
        if (previous !== undefined)
          for (const consumer of skinConsumers.get(previous) ?? []) changed.add(consumer);
        if (current === undefined) continue;
        if (
          isRenderableMember(world, current) &&
          (baseline ||
            !members.has(current) ||
            source.renderableComponents.some((component) =>
              source.projection.changed(current, component),
            ))
        )
          changed.add(current);
        if (
          batch.membershipChanged ||
          source.projection.changed(current, ChildOf) ||
          source.projection.changed(current, Visibility)
        ) {
          const queue = [current],
            visited = new Set<number>();
          while (queue.length) {
            const entity = queue.pop() as EntityHandle;
            if (visited.has(entity)) continue;
            visited.add(entity);
            if (isRenderableMember(world, entity)) changed.add(entity);
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
      if (baseline || catalogEpoch !== assets.catalogEpoch) {
        for (const entity of members) changed.add(entity);
        for (const entity of source.entities.values())
          if (isRenderableMember(world, entity)) changed.add(entity);
      }
      for (const handle of invalidated) {
        caches.get(world)?.delete(handle);
        for (const entity of consumers.get(handle) ?? []) changed.add(entity);
      }
      const matrixRows = new Map<number, ArrayLike<number>>();
      for (const span of transforms.spans().unwrap()) {
        for (let row = 0; row < span.entities.length; row++) {
          const entity = span.entities[row] as EntityHandle;
          for (const consumer of skinConsumers.get(entity) ?? []) changed.add(consumer);
          if (members.has(entity) && !removed.has(entity)) {
            const matrix = readPresentationWorldMatrix(world, entity);
            if (matrix !== undefined) matrixRows.set(entity, matrix);
            pending.add(entity);
          }
        }
      }
      for (const entity of changed) pending.add(entity);
      let canvasFrames: readonly PublishedCanvasFrame[] = [];
      let videoFrames: RenderPublication['videoFrames'] = [];
      try {
        const frame = extractFrames(
          [world],
          { cameraOwner: 0, resourceOwner: 0 },
          assets,
          undefined,
          caches,
          {
            ...(capabilities === undefined ? {} : renderMaterialContext(capabilities, limits)),
            cull: 'none',
            retainHidden: true,
            renderables: changed.size ? { kind: 'partial', entitiesByWorld: [changed] } : 'none',
          },
        );
        const meshCounts = new Map<number, number>();
        for (const row of frame.renderables)
          meshCounts.set(row.assetHandle, (meshCounts.get(row.assetHandle) ?? 0) + 1);
        const templates: RenderPublicationTemplate[] = [],
          templateIds = new Map<
            string,
            { index: number; dependencies: readonly Handle<string, 'shared'>[] }
          >();
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
        const nextDependencies = new Map<number, readonly Handle<string, 'shared'>[]>();
        const assetRows = new Map<Handle<string, 'shared'>, Asset>();
        const publishAsset = (handle: Handle<string, 'shared'>) => {
          if (assetRows.has(handle)) return;
          if (
            !baseline &&
            (consumers.has(handle) || frameDependencies.has(handle)) &&
            !invalidated.has(handle)
          ) {
            if (catalogEpoch === assets.catalogEpoch) return;
            // Catalog changes refresh resolved snapshots and GUID dependencies,
            // but do not change an independently owned World payload.
            const payload = world.sharedRefs.resolve<string, Asset>(handle);
            if (payload.ok && assets.guidOf(payload.value) === undefined) return;
          }
          const value = resolveAssetHandle(world, handle);
          if (!value.ok) throw value.error;
          assetRows.set(handle, value.value);
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
            const keys = new Set([
              ...Object.values(material.materialProgramKeys ?? {}),
              ...Object.values(material.materialSurfacePrograms ?? {}).map(
                (program) => program.programKey,
              ),
              ...Object.values(material.materialSceneIndexProgramKeys ?? {}).map(
                (program) => program.specializationKey,
              ),
              ...(material.materialShaderId === undefined ||
              material.materialShaderId.startsWith('forgeax::')
                ? []
                : [material.materialShaderId]),
            ]);
            for (const key of keys) publishProgram(key);
          }
        };
        for (let i = 0; i < frame.renderables.length; i++) {
          const row = frame.renderables[i] as RenderableSnapshot;
          if (row.skin) return fail('unsupported', 'source GPU skin receipt');
          if (
            row.materials.some((material) =>
              [...(material.textureSources?.values() ?? [])].some(isExternalTextureSource),
            )
          )
            return fail('unsupported', 'renderer-local external texture source');
          const { worldId: _world, entityKey, transform, ...snapshot } = row;
          const template = { snapshot, dispatch: byRenderable.get(i) ?? [] };
          // These payloads already contain the source entity identity. They
          // cannot share a template, regardless of equal pose/instance bytes.
          const entityOwned =
            snapshot.instances !== undefined ||
            snapshot.spriteInstances !== undefined ||
            snapshot.skinPose !== undefined ||
            snapshot.pointsLines !== undefined;
          const key =
            entityOwned || meshCounts.get(snapshot.assetHandle) === 1
              ? undefined
              : JSON.stringify(
                  {
                    snapshot: {
                      ...snapshot,
                      material: valueId(snapshot.material),
                      materials: snapshot.materials.map((material) => valueId(material)),
                    },
                    dispatch: template.dispatch,
                  },
                  keyValue,
                );
          let known = key === undefined ? undefined : templateIds.get(key);
          if (known === undefined) {
            const index = templates.length;
            templates.push(template);
            publishPrograms(row.materials);
            const handles = publicationDependencies(row);
            for (const lod of row.lods ?? []) {
              const handle = internSharedRefFromGuid(
                world,
                assets,
                AssetGuid.format(lod.mesh),
                'MeshAsset',
              );
              if (handle !== undefined) handles.push(handle);
            }
            known = { index, dependencies: handles };
            if (key !== undefined) templateIds.set(key, known);
            for (const handle of handles) publishAsset(handle);
          }
          upserts.push(entityKey, known.index);
          matrixRows.set(entityKey, transform.world);
          nextDependencies.set(entityKey, known.dependencies);
        }
        const featureRows = featureSources.map((feature) => {
          const data = feature
            .extract({
              worlds: [world],
              owner: 0,
              frameNumber: revision + 1,
              ...(capabilities === undefined
                ? {}
                : { caps: capabilities, ...(limits === undefined ? {} : { limits }) }),
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
              referenceAsset: (sourceWorldIndex, identity, captured) => {
                if (sourceWorldIndex !== 0) return undefined;
                const handle =
                  typeof identity === 'string'
                    ? internSharedRefFromGuid(
                        world,
                        assets,
                        identity,
                        publicationAssetBrand(captured),
                      )
                    : identity;
                if (handle === undefined) return undefined;
                const current = resolveAssetHandle(world, handle);
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
        const nextFrameDependencies = new Set(publicationFrameDependencies(frame));
        const pendingGuids = featureSources.flatMap((feature) => {
          const row = featureRows.find((row) => row.identity === feature.identity);
          return row === undefined ? [] : [...(feature.assetDependencies?.(row.data) ?? [])];
        });
        const seenGuids = new Set<string>();
        for (const guid of pendingGuids) {
          if (typeof guid !== 'string') {
            nextFrameDependencies.add(guid);
            continue;
          }
          const key = guid.toLowerCase();
          if (seenGuids.has(key)) continue;
          seenGuids.add(key);
          const asset = assets.lookup(key);
          // Dynamic asset content is keyed by the canonical World handle. Feature
          // dependencies must share the same identity as ordinary scene consumers.
          const handle = internSharedRefFromGuid(world, assets, key, publicationAssetBrand(asset));
          if (asset === undefined || handle === undefined)
            throw new Error(`Missing feature asset ${guid}`);
          nextFrameDependencies.add(handle);
          for (const ref of assets.assetCatalog.get(key)?.refs ?? []) pendingGuids.push(ref.guid);
          if (asset.kind === 'material') {
            const material = resolveMaterialSnapshot(
              handle,
              world,
              assets,
              undefined,
              undefined,
              capabilities === undefined
                ? undefined
                : renderMaterialContext(capabilities, limits).materialContext,
              undefined,
              undefined,
              // A feature dependency is not a Mesh binding. Retain its complete
              // program closure; the consuming feature admits the actual layout.
              true,
            );
            publishPrograms([material]);
            const source = world.sharedRefs.resolve<string, Asset>(handle).unwrap();
            const projection =
              source.kind === 'material'
                ? assets.getMaterialProjectionForPayload(source)
                : undefined;
            for (const pass of projection?.passes ?? [])
              for (const program of pass.programs) publishProgram(program.specializationKey);
            for (const dependency of publicationDependencies({
              assetHandle: handle,
              materials: [material],
            }))
              nextFrameDependencies.add(dependency);
          }
        }
        for (const handle of nextFrameDependencies) publishAsset(handle);
        const emitted = new Set(frame.renderables.map((row) => row.entityKey));
        for (const entity of changed)
          if (members.has(entity) && !emitted.has(entity)) removed.add(entity);
        for (const entity of removed) matrixRows.delete(entity);
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
          shadowCasterEntityKeys: _casters,
          shadowCasterDrawKeys: _draws,
          shadowCasterMembership: _membership,
          ...metadata
        } = frame;
        const retired = new Set<Handle<string, 'shared'>>();
        const removedConsumers = new Set([...removed, ...nextDependencies.keys()]);
        const nextHandles = new Set([...nextDependencies.values()].flat());
        const removedCounts = new Map<Handle<string, 'shared'>, number>();
        for (const entity of removedConsumers)
          for (const handle of dependencies.get(entity) ?? [])
            removedCounts.set(handle, (removedCounts.get(handle) ?? 0) + 1);
        for (const [handle, count] of removedCounts)
          if (
            count === consumers.get(handle)?.size &&
            !nextHandles.has(handle) &&
            !nextFrameDependencies.has(handle)
          )
            retired.add(handle);
        for (const handle of frameDependencies) {
          if (
            !nextFrameDependencies.has(handle) &&
            !nextHandles.has(handle) &&
            (consumers.get(handle)?.size ?? 0) === (removedCounts.get(handle) ?? 0)
          )
            retired.add(handle);
        }
        const upsertColumn = new Uint32Array(buffer(0, upserts.length * 4), 0, upserts.length);
        upsertColumn.set(upserts);
        const removedColumn = new Uint32Array(buffer(1, removed.size * 4), 0, removed.size);
        removedColumn.set([...removed]);
        const packet: RenderPublication = {
          ...identity,
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
          targetSources: publicationTargetSources(templates),
          features: featureRows,
          programs: [...programs.values()],
          upserts: upsertColumn,
          removed: removedColumn,
          transformEntities,
          transforms: matrices,
          assets: [...assetRows].map(([handle, value]) => {
            // Runtime content is a projection, so GUID identity stays with the
            // underlying catalogued payload rather than the projected object.
            const source = world.sharedRefs.resolve<string, Asset>(handle);
            const guid = assets.guidOf(source.ok ? source.value : value);
            const sourceKey = guid === undefined ? undefined : assets.sourceKeyOf(guid);
            return {
              handle,
              // Assets stay with their source owner. An admitted mesh owns a
              // detached packet copy so its large buffers can move to Render
              // without another receiver-side structured-clone allocation.
              value: value.kind === 'mesh' ? structuredClone(value) : value,
              ...(guid === undefined ? {} : { guid }),
              ...(sourceKey === undefined ? {} : { sourceKey }),
            };
          }),
          retiredAssets: [...retired],
          invalidatedAssets: [...invalidated],
        };
        batch.validate();
        active = true;
        let closed = false;
        return ok({
          packet,
          accept: () => {
            if (closed)
              throw new RenderPublicationError({ reason: 'revision', subject: 'closed candidate' });
            batch.accept();
            for (const row of featureRows) {
              if (row.fullscreen !== undefined)
                publishedFullscreenFeatures.set(row.identity, row.fullscreen);
            }
            for (const handle of invalidated) pendingMeshContent.delete(handle);
            for (const key of programs.keys()) publishedPrograms.add(key);
            closed = true;
            active = false;
            revision++;
            flights.set(revision, {
              features: featureRows,
              owners: featureSources,
              submitted: false,
            });
            storage = spareStorage.pop() ?? [
              new ArrayBuffer(0),
              new ArrayBuffer(0),
              new ArrayBuffer(0),
              new ArrayBuffer(0),
            ];
            for (const row of videoFrames) row.frame.close();
            for (const row of canvasFrames) row.frame?.close();
            videoConsumers = nextVideoConsumers;
            canvasConsumers = nextCanvasConsumers;
            frameDependencies = nextFrameDependencies;
            catalogEpoch = assets.catalogEpoch;
            for (const entity of removedConsumers) {
              for (const handle of dependencies.get(entity) ?? []) {
                consumers.get(handle)?.delete(entity);
                if (consumers.get(handle)?.size === 0) consumers.delete(handle);
              }
              dependencies.delete(entity);
            }
            for (const entity of removedConsumers) {
              for (const joint of jointsByEntity.get(entity) ?? []) {
                const users = skinConsumers.get(joint);
                users?.delete(entity);
                if (users?.size === 0) skinConsumers.delete(joint);
              }
              jointsByEntity.delete(entity);
            }
            for (const row of frame.renderables) {
              if (row.skinJointEntities === undefined) continue;
              jointsByEntity.set(row.entityKey, row.skinJointEntities);
              for (const joint of row.skinJointEntities) {
                let users = skinConsumers.get(joint);
                if (users === undefined) {
                  users = new Set();
                  skinConsumers.set(joint, users);
                }
                users.add(row.entityKey);
              }
            }
            for (const entity of removed) members.delete(entity);
            for (const [entity, handles] of nextDependencies) {
              members.add(entity);
              dependencies.set(entity, handles);
              for (const handle of handles) {
                let users = consumers.get(handle);
                if (!users) {
                  users = new Set();
                  consumers.set(handle, users);
                }
                users.add(entity);
              }
            }
            for (const entity of matrixRows.keys()) pending.delete(entity);
            for (const entity of removed) pending.delete(entity);
            for (const sourceIndex of batch.indices) {
              const entity = source.projection.entity(sourceIndex);
              if (entity === undefined) {
                source.entities.delete(sourceIndex);
                source.contentHandles.delete(sourceIndex);
              } else {
                source.entities.set(sourceIndex, entity);
                const handles: number[] = [];
                if (world.hasComponent(entity, source.runtimeMaterialValue))
                  handles.push(world.get(entity, source.runtimeMaterialValue).unwrap().asset);
                if (world.hasComponent(entity, source.runtimeMeshVertices))
                  handles.push(world.get(entity, source.runtimeMeshVertices).unwrap().asset);
                if (handles.length) source.contentHandles.set(sourceIndex, handles);
                else source.contentHandles.delete(sourceIndex);
              }
            }
          },
          discard: () => {
            if (!closed) {
              closed = true;
              active = false;
              for (const row of videoFrames) row.frame.close();
              for (const row of canvasFrames) row.frame?.close();
            }
          },
        });
      } catch (cause) {
        for (const row of videoFrames) row.frame.close();
        for (const row of canvasFrames) row.frame?.close();
        return fail('unsupported', cause instanceof Error ? cause.message : String(cause));
      }
    },
    acknowledgeFeatures(
      acceptedRevision: number,
      receipts: readonly { readonly identity: string; readonly feedback: unknown }[],
    ): Result<void, RenderPublicationError> {
      if (disposed) return fail('disposed', 'publisher');
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
      if (disposed) return fail('disposed', 'publisher');
      if (flights.keys().next().value !== acceptedRevision)
        return fail('revision', 'returned storage revision');
      if (buffers.length !== 4 || buffers.some((value) => !(value instanceof ArrayBuffer)))
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
      releaseTransforms();
      members.clear();
      dependencies.clear();
      consumers.clear();
      pending.clear();
      pendingMeshContent.clear();
      videoConsumers.clear();
      canvasConsumers.clear();
      flights.clear();
      spareStorage.length = 0;
      frameDependencies.clear();
      jointsByEntity.clear();
      skinConsumers.clear();
    },
  };
}
