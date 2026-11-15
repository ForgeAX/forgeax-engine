import type { EntityHandle } from '@forgeax/engine-ecs';
import type { MeshAsset } from '@forgeax/engine-types';
import { MaterialResource } from './material-resource';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  type ExtractedFrame,
  type RenderableSnapshot,
  sortDispatchByQueue,
} from './render-system-extract';
import type { MaterialFrame } from './scene/material-dispatch';
import {
  offsetWaterMeshAdmissionDraw,
  ownWaterMaterialAdmissionSource,
  ownWaterMaterialOwner,
  projectWaterMeshAdmissionTiles,
} from './water/mesh-source-admission';

const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type WaterMeshSource = NonNullable<RenderableSnapshot['waterMeshSource']>;

function hasOrdinaryGeometry(source: RenderableSnapshot): boolean {
  return (
    source.assetHandle !== undefined ||
    source.generatedMesh !== undefined ||
    source.glyph !== undefined ||
    source.tilemap !== undefined ||
    source.terrain !== undefined ||
    source.terrainSection !== undefined ||
    source.nativeDraw !== undefined
  );
}

function offsetWaterMeshSource(source: WaterMeshSource, offset: number): WaterMeshSource {
  if (offset === 0) return source;
  return Object.freeze({
    ...source,
    materialStartIndex: source.materialStartIndex + offset,
    views: Object.freeze(
      source.views.map((view) =>
        Object.freeze({
          ...view,
          draws: Object.freeze(
            view.draws.map((draw) => offsetWaterMeshAdmissionDraw(draw, offset)),
          ),
        }),
      ),
    ),
  });
}

function withoutWaterMeshSource(source: RenderableSnapshot): RenderableSnapshot {
  const waterMesh = source.waterMeshSource;
  if (waterMesh === undefined) return source;
  const { waterMeshSource: _waterMeshSource, ...ordinary } = source;
  return ownWaterMaterialAdmissionSource({
    ...ordinary,
    materials: source.materials.slice(0, waterMesh.materialStartIndex),
    materialBindingSources: source.materialBindingSources.slice(0, waterMesh.materialStartIndex),
  });
}

function mergeWaterMeshOwnerRow(
  ordinarySource: RenderableSnapshot,
  publishedSource: RenderableSnapshot,
): RenderableSnapshot {
  const waterMesh = publishedSource.waterMeshSource;
  if (waterMesh === undefined) return ordinarySource;
  const ordinary = withoutWaterMeshSource(ordinarySource);
  const waterMaterialStart = waterMesh.materialStartIndex;
  const offset = ordinary.materials.length - waterMaterialStart;
  return {
    ...ordinary,
    materials: [...ordinary.materials, ...publishedSource.materials.slice(waterMaterialStart)],
    materialBindingSources: [
      ...ordinary.materialBindingSources,
      ...publishedSource.materialBindingSources.slice(waterMaterialStart),
    ],
    waterMeshSource: offsetWaterMeshSource(waterMesh, offset),
  };
}

function currentWaterMeshOwnerRows(
  frame: ExtractedFrame,
  publishedRows: Iterable<RenderableSnapshot>,
): Pick<ExtractedFrame, 'renderables' | 'dispatch'> {
  const current = new Map<string, RenderableSnapshot>();
  for (const row of publishedRows) {
    if (row.waterMeshSource !== undefined) current.set(`${row.entityKey}`, row);
  }
  // With no current or retained Water owner, ordinary rows and their Pass
  // query already have the exact frame addresses. Preserve their identities.
  if (current.size === 0 && !frame.renderables.some((row) => row.waterMeshSource !== undefined))
    return { renderables: frame.renderables, dispatch: frame.dispatch };

  const result: RenderableSnapshot[] = [];
  const indices = new Map<number, number>();
  const consumed = new Set<string>();
  for (const [index, row] of frame.renderables.entries()) {
    const key = `${row.entityKey}`;
    const published = current.get(key);
    if (published !== undefined) {
      indices.set(index, result.length);
      result.push(mergeWaterMeshOwnerRow(row, published));
      consumed.add(key);
    } else {
      if (row.waterMeshSource !== undefined && !hasOrdinaryGeometry(row)) continue;
      indices.set(index, result.length);
      result.push(withoutWaterMeshSource(row));
    }
  }
  for (const [key, published] of current) {
    if (!consumed.has(key)) result.push(mergeWaterMeshOwnerRow(published, published));
  }
  const dispatch: DispatchEntry[] = [];
  for (const entry of frame.dispatch) {
    if (entry.renderableIndex === undefined) {
      dispatch.push(entry);
      continue;
    }
    const renderableIndex = indices.get(entry.renderableIndex);
    if (renderableIndex !== undefined)
      dispatch.push(
        renderableIndex === entry.renderableIndex ? entry : { ...entry, renderableIndex },
      );
  }
  return { renderables: result, dispatch };
}

/** Turn one accepted WaterBody source row into its view's actual native draws. */
export function projectWaterMeshView(
  frame: ExtractedFrame,
  materials: MaterialFrame,
  viewIdentity: string | undefined,
  publishedOwnerRows?: Iterable<RenderableSnapshot>,
): { frame: ExtractedFrame; materials: MaterialFrame } {
  if (publishedOwnerRows !== undefined) {
    frame = {
      ...frame,
      ...currentWaterMeshOwnerRows(frame, publishedOwnerRows),
    };
  }
  if (!frame.renderables.some((source) => source.waterMeshSource !== undefined))
    return { frame, materials };
  const renderables: RenderableSnapshot[] = [];
  const dispatch: DispatchEntry[] = [];
  const dispatchBySource = new Map<number, DispatchEntry[]>();
  for (const entry of frame.dispatch) {
    const entries = dispatchBySource.get(entry.renderableIndex) ?? [];
    entries.push(entry);
    dispatchBySource.set(entry.renderableIndex, entries);
  }
  for (const [sourceIndex, snapshot] of frame.renderables.entries()) {
    const source = snapshot.waterMeshSource;
    if (source === undefined) {
      const renderableIndex = renderables.length;
      renderables.push(snapshot);
      for (const entry of dispatchBySource.get(sourceIndex) ?? [])
        dispatch.push({ ...entry, renderableIndex });
      continue;
    }
    const { waterMeshSource: _waterMeshSource, ...owner } = snapshot;
    const ordinaryMaterialCount = source.materialStartIndex;
    const ordinaryOwner = ownWaterMaterialAdmissionSource({
      ...owner,
      materials: owner.materials.slice(0, ordinaryMaterialCount),
      materialBindingSources: owner.materialBindingSources.slice(0, ordinaryMaterialCount),
    });
    const {
      assetHandle: _assetHandle,
      generatedMesh: _generatedMesh,
      localAabb: _localAabb,
      lods: _lods,
      lodHysteresis: _lodHysteresis,
      gpuDrivenDraws: _gpuDrivenDraws,
      instances: _instances,
      spriteInstances: _spriteInstances,
      skinBinding: _skinBinding,
      morph: _morph,
      pointsLines: _pointsLines,
      glyph: _glyph,
      tilemap: _tilemap,
      terrain: _terrain,
      terrainSection: _terrainSection,
      nativeDraw: _nativeDraw,
      materialOverrides: _materialOverrides,
      pipelinePreparation: _pipelinePreparation,
      temporal: _temporal,
      ...waterDrawOwner
    } = owner;
    if (hasOrdinaryGeometry(snapshot)) {
      const renderableIndex = renderables.length;
      renderables.push(ordinaryOwner);
      for (const entry of dispatchBySource.get(sourceIndex) ?? [])
        dispatch.push({ ...entry, renderableIndex });
    }
    const view = source.views.find((candidate) => candidate.viewIdentity === viewIdentity);
    if (snapshot.authorVisible === false || view === undefined) continue;
    for (const draw of view.draws) {
      const material = snapshot.materials[draw.materialIndex];
      if (!(material instanceof MaterialResource))
        throw new Error('WaterMesh draw references a missing accepted material');
      materials = materials.with(material);
      const mesh: MeshAsset = Object.freeze({ ...draw.mesh, aabb: draw.localAabb });
      const renderableIndex = renderables.length;
      const layer = snapshot.layer ?? 0;
      const transforms = new Float32Array(draw.instanceCount * 16);
      const initializeInstanceTransforms = () => {
        for (let index = 0; index < draw.instanceCount; index++) {
          const offset = index * 16;
          transforms[offset] =
            transforms[offset + 5] =
            transforms[offset + 10] =
            transforms[offset + 15] =
              1;
        }
      };
      initializeInstanceTransforms();
      renderables.push(
        ownWaterMaterialAdmissionSource({
          ...waterDrawOwner,
          generatedMesh: mesh,
          localAabb: draw.localAabb,
          nativeDraw: { key: draw.drawKey },
          layer,
          shadowCaster: false,
          authorVisible: true,
          instances: Object.freeze({
            transforms,
            instanceCount: draw.instanceCount,
            cacheKey: snapshot.entityKey,
            cacheIdentity: draw.drawKey,
            archVersion: draw.instanceCount,
          }),
          transform: { world: IDENTITY_MATRIX },
          material,
          materials: [material],
          materialOverrides: [],
          materialBindingSources: ['mesh-default'],
          materialBindingDiagnostics: [],
          waterOwner: ownWaterMaterialOwner({
            guid: source.guid,
            generation: source.generation,
            worldIdentity: source.worldIdentity,
            zoneGuid: source.zoneGuid,
            zoneGeneration: source.zoneGeneration,
            targetFormat: source.targetFormat,
            viewIdentity: view.viewIdentity,
            ...(draw.gpu === undefined ? { drawKey: draw.drawKey } : {}),
          }),
          ...(draw.gpu === undefined
            ? {
                waterMeshTiles: projectWaterMeshAdmissionTiles(
                  {
                    drawKey: draw.drawKey,
                    bodyGuid: source.guid,
                    bodyGeneration: source.generation,
                    worldIdentity: source.worldIdentity,
                    zoneGeneration: source.zoneGeneration,
                    viewIdentity: view.viewIdentity,
                    bytes: draw.bytes,
                    coverageBytes: draw.coverageBytes,
                    layout: draw.layout,
                    transitionTargets: draw.transitionTargets,
                  },
                  draw,
                ),
              }
            : { waterGpuMesh: draw.gpu }),
        }),
      );
      appendMaterialDispatchEntries(
        dispatch,
        material.snapshot.passes,
        snapshot.entityKey as EntityHandle,
        material.snapshot.materialHandle ?? 0,
        renderableIndex,
        layer,
        0,
        material.snapshot.materialProgramKeys,
      );
    }
  }
  return {
    frame: { ...frame, renderables, dispatch: sortDispatchByQueue(dispatch) },
    materials,
  };
}
