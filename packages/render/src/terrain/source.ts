import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { walkMaterialPassesOverSharedRefs } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import { GlobalTransform, readPresentationWorldMatrix, Transform } from '@forgeax/engine-scene';
import {
  Terrain,
  terrainAxisEndpoint,
  terrainHeightBounds,
  terrainTranslationValid,
} from '@forgeax/engine-terrain';
import type {
  Asset,
  Handle,
  MaterialPass,
  TerrainAsset,
  TerrainError,
} from '@forgeax/engine-types';
import { Layer } from '../components/layer.js';
import { ShadowParticipation } from '../components/shadow-participation.js';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  internSharedRefFromGuid,
  type MaterialSnapshot,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
} from '../render-system-extract.js';

/** Detached source facts retained by the existing scene publication, independent of a camera. */
export interface TerrainRenderSource {
  readonly handle: Handle<'TerrainAsset', 'shared'>;
  readonly asset: TerrainAsset;
  readonly grids: readonly Handle<'MeshAsset', 'shared'>[];
  readonly heightTextures: readonly Handle<'TextureAsset', 'shared'>[];
  readonly weightTextures: readonly Handle<'TextureAsset', 'shared'>[];
  readonly passes: readonly (readonly MaterialPass[])[];
  readonly lod0Diameter: number;
  readonly forcedLod: number;
  readonly layer: number;
}

export function terrainSourceError(
  code: TerrainError['code'],
  field: string,
  expected: string,
): never {
  throw {
    code,
    expected,
    hint: 'repair the terrain source or load its complete closure before rendering',
    detail: { field },
  } satisfies TerrainError;
}

/** One real ECS identity; section draw expansion belongs to the view projection. */
export function extractTerrainSources(
  world: World,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  worldId: number,
  renderables: RenderableSnapshot[],
  dispatch: DispatchEntry[],
  selected?: ReadonlySet<number>,
  visibility?: { effective(entity: number): string },
  retainHidden = false,
  hidden?: Set<number>,
): void {
  if (world.components.resolve('Terrain') === undefined) return;
  const query = world
    .query({ read: [Terrain, Transform, GlobalTransform], optional: [Layer, ShadowParticipation] })
    .unwrap();
  const filter = selected === undefined ? undefined : selected;
  for (const row of query) {
    if (filter && !filter.has(row.entity)) continue;
    const authorVisible = visibility?.effective(row.entity) !== 'hidden';
    if (!authorVisible) {
      hidden?.add(row.entity);
      if (!retainHidden) continue;
    }
    const terrain = row.get(Terrain),
      transform = readPresentationWorldMatrix(world, row.entity);
    if (transform === undefined) continue;
    const layer = row.has(Layer) ? (row.get(Layer)?.value ?? 0) : 0;
    const shadow = row.has(ShadowParticipation) ? row.get(ShadowParticipation) : undefined;
    const value = world.sharedRefs.resolve<'TerrainAsset', Asset>(terrain.asset);
    if (!value.ok || value.value.kind !== 'terrain')
      terrainSourceError('terrain-query-unavailable', 'asset', 'one loaded TerrainAsset');
    const asset = value.value as TerrainAsset;
    const guid = assets.guidOf(asset);
    if (guid === undefined)
      terrainSourceError(
        'terrain-query-unavailable',
        'asset revision',
        'a catalogued terrain root with a validated derived closure',
      );
    // Catalog HMR invalidates the old publication before asynchronous loading completes.
    // Isolate this source until its coherent replacement binds; ordinary frame work must
    // continue so Physics and the completed-frame gameplay gate can adopt that replacement.
    if (assets.lookup(guid) !== asset || !assets.terrainClosureCurrent(asset)) continue;
    const matrix = transform;
    if (!terrainTranslationValid(asset, matrix))
      terrainSourceError(
        'terrain-pose-unsupported',
        'Transform',
        'finite GPU world bounds, translation with exact identity rotation and unit scale',
      );
    if (
      !Number.isFinite(terrain.lod0Diameter) ||
      terrain.lod0Diameter <= 0 ||
      !Number.isFinite(terrain.forcedLod) ||
      terrain.forcedLod > Math.log2(asset.subsectionVertices) - 1
    )
      terrainSourceError(
        'terrain-input-invalid',
        'LOD',
        'finite positive LOD0 diameter and a forced LOD within resident range',
      );
    const handle = <T extends 'MeshAsset' | 'TextureAsset' | 'MaterialAsset'>(
      guid: string,
      kind: Asset['kind'],
      tag: T,
    ): Handle<T, 'shared'> => {
      const payload = assets.lookup(guid);
      if (!payload || payload.kind !== kind)
        terrainSourceError(
          'terrain-query-unavailable',
          guid,
          `loaded ${kind} dependency at the same adopted source revision`,
        );
      const handle = internSharedRefFromGuid(world, assets, guid, tag);
      if (handle === undefined)
        terrainSourceError('terrain-query-unavailable', guid, 'retained dependency');
      return handle;
    };
    const grids = asset.grids.map((g) => handle(g, 'mesh', 'MeshAsset'));
    const heightTextures = asset.sections.map((s) =>
      handle(s.heightTexture, 'texture', 'TextureAsset'),
    );
    const weightTextures = asset.sections.map((s) =>
      handle(s.weightTexture, 'texture', 'TextureAsset'),
    );
    const passes: (readonly MaterialPass[])[] = [];
    const materials: MaterialSnapshot[] = asset.sections.map((s, sectionIndex) => {
      const materialHandle = handle(s.material, 'material', 'MaterialAsset');
      const resolved = walkMaterialPassesOverSharedRefs(world, materialHandle, assets);
      if (!resolved.ok) throw resolved.error;
      passes.push(
        shadow?.cast === false
          ? resolved.value.passes.filter(
              (pass) =>
                (pass.renderState?.tags as Record<string, string> | undefined)?.LightMode !==
                  'ShadowCaster' && pass.name !== 'shadow-caster',
            )
          : resolved.value.passes,
      );
      const snapshot = resolveMaterialSnapshot(
        Number(materialHandle),
        world,
        assets,
        undefined,
        undefined,
        context === undefined ? undefined : { ...context, geometry: 'terrain' },
      );
      if (
        snapshot.textureHandles?.get('terrainHeightTexture') !== heightTextures[sectionIndex] ||
        snapshot.textureHandles?.get('terrainWeightTexture') !== weightTextures[sectionIndex]
      )
        terrainSourceError(
          'terrain-query-unavailable',
          'material terrain bindings',
          'the GPU height/control bindings from this admitted terrain closure',
        );
      return snapshot;
    });
    const material = materials[0];
    if (!material || !grids[0])
      terrainSourceError('terrain-input-invalid', 'sections', 'at least one complete subsection');
    const index = renderables.length;
    let min = Infinity,
      max = -Infinity;
    for (const section of asset.sections) {
      min = Math.min(min, section.minHeight);
      max = Math.max(max, section.maxHeight);
    }
    const [minHeight, maxHeight] = terrainHeightBounds(min, max, asset.heightRange);
    renderables.push({
      assetHandle: Number(grids[0]),
      transform: { world: new Float32Array(matrix) },
      material,
      materials,
      materialBindingSources: materials.map(() => 'mesh-default'),
      worldId,
      entityKey: row.entity,
      ...(authorVisible ? {} : { authorVisible: false }),
      ...(shadow?.receive === false ? { shadowReceiver: false } : {}),
      localAabb: new Float32Array([
        0,
        minHeight,
        0,
        terrainAxisEndpoint(
          (asset.columns - asset.subsectionVertices) * asset.spacing,
          (asset.subsectionVertices - 1) * asset.spacing,
        ),
        maxHeight,
        terrainAxisEndpoint(
          (asset.rows - asset.subsectionVertices) * asset.spacing,
          (asset.subsectionVertices - 1) * asset.spacing,
        ),
      ]),
      terrain: {
        handle: terrain.asset,
        asset,
        grids,
        heightTextures,
        weightTextures,
        passes,
        lod0Diameter: terrain.lod0Diameter,
        forcedLod: terrain.forcedLod,
        layer,
      },
    });
    if (authorVisible)
      appendMaterialDispatchEntries(
        dispatch,
        passes[0] ?? [],
        row.entity,
        material.materialHandle ?? 0,
        index,
        layer,
        material.paramSnapshot,
        0,
        material.materialProgramKeys,
      );
  }
}
