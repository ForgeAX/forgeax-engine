import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  terrainAxisEndpoint,
  terrainHeightBounds,
  terrainLod,
  terrainTranslationValid,
} from '@forgeax/engine-terrain';
import { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldEntityKey } from '../record/frame-snapshot.js';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  type ExtractedFrame,
  type RenderableSnapshot,
  sortDispatchByQueue,
} from '../render-system-extract.js';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { TerrainLayers } from './layers';
import { terrainShadowReceivers } from './shadow-family.js';
import { type TerrainSourceCache, terrainDrawSection, terrainSourceError } from './source';

export function terrainSectionKey(source: RenderableSnapshot, index: number): string {
  return `${source.worldId}:${source.entityKey}:${index}`;
}

/** A view-local draw roster derived from one retained entity, without synthetic ECS identities. */
export function projectTerrainView(
  frame: ExtractedFrame,
  accepted: ReadonlyMap<string, RenderableSnapshot>,
  materials: MaterialFrame,
  worlds: readonly RenderResourceScope[],
  sources: TerrainSourceCache,
  resolveMaterial: (world: RenderResourceScope, handle: number) => MaterialResource,
  layers?: TerrainLayers,
  hasSources = frame.renderables.some((source) => source.terrain !== undefined),
): { frame: ExtractedFrame; materials: MaterialFrame } {
  if (!hasSources) return { frame, materials };
  const camera = frame.cameras[0];
  if (camera === undefined) return { frame, materials };
  const renderables: RenderableSnapshot[] = [],
    dispatch: DispatchEntry[] = [];
  const shadowFamilies = new Map(
    terrainShadowReceivers(frame.renderables).map(
      (root, index) => [worldEntityKey(root.worldId, root.entityKey), index + 1] as const,
    ),
  );
  for (const [oldIndex, source] of frame.renderables.entries()) {
    const terrain = source.terrain;
    if (terrain === undefined) {
      const index = renderables.length;
      renderables.push(source);
      for (const entry of frame.dispatch)
        if (entry.renderableIndex === oldIndex) dispatch.push({ ...entry, renderableIndex: index });
      continue;
    }
    const world = worlds[source.worldId];
    if (world === undefined)
      terrainSourceError('terrain-query-unavailable', 'World', 'the Terrain resource scope');
    const content = sources.resolve(world, terrain.handle);
    const layerFrame = layers?.capture(world, content);
    const asset = content.asset,
      n = asset.subsectionVertices,
      width = (n - 1) * asset.spacing;
    const nx = (asset.columns - 1) / (n - 1),
      nz = (asset.rows - 1) / (n - 1),
      maxLod = content.grids.length - 1;
    if (!terrainTranslationValid(asset, source.transform.world) || terrain.forcedLod > maxLod)
      terrainSourceError(
        'terrain-pose-unsupported',
        'Transform/LOD',
        'finite supported placement and a resident Terrain LOD',
      );
    const lods = Array.from({ length: content.sectionCount }, (_, index) => {
      const section = terrainDrawSection(content, index).data;
      if (terrain.forcedLod >= 0) return Math.fround(Math.min(maxLod, terrain.forcedLod));
      const x = section.x + width / 2 + (source.transform.world[12] ?? 0),
        y = (section.minHeight + section.maxHeight) / 2 + (source.transform.world[13] ?? 0),
        z = section.z + width / 2 + (source.transform.world[14] ?? 0);
      const distance = Math.max(
        camera.near,
        Math.hypot(
          x - (camera.position[0] ?? 0),
          y - (camera.position[1] ?? 0),
          z - (camera.position[2] ?? 0),
        ),
      );
      const diameter =
        camera.projection === 'orthographic'
          ? width / Math.abs(camera.orthoTop - camera.orthoBottom)
          : width / (distance * Math.tan(camera.fov / 2));
      return Math.fround(terrainLod(diameter, terrain.lod0Diameter, maxLod));
    });
    for (let index = 0; index < content.sectionCount; index++) {
      const section = terrainDrawSection(content, index).data;
      const [minHeight, maxHeight] = terrainHeightBounds(section.minHeight, section.maxHeight);
      const lod = lods[index] ?? 0,
        grid = Math.floor(lod),
        x = index % nx,
        z = Math.floor(index / nx);
      const neighbors = [
        x > 0 ? (lods[index - 1] ?? lod) : lod,
        x < nx - 1 ? (lods[index + 1] ?? lod) : lod,
        z > 0 ? (lods[index - nx] ?? lod) : lod,
        z < nz - 1 ? (lods[index + nx] ?? lod) : lod,
      ];
      if (typeof section.material !== 'number')
        terrainSourceError(
          'terrain-query-unavailable',
          'material',
          'an admitted Material reference',
        );
      const resource = resolveMaterial(world, section.material);
      const base = resource.snapshot;
      if (
        base.textureHandles?.get('terrainHeightTexture') !== section.heightTexture ||
        base.textureHandles?.get('terrainWeightTexture') !== section.weightTexture
      )
        terrainSourceError(
          'terrain-query-unavailable',
          'material terrain bindings',
          'the admitted height/control closure',
        );
      const parameters = {
        ...base.paramSnapshot,
        terrainSection: [section.x, section.z, width, n],
        terrainLod: [grid, lod, nx, nz],
        terrainNeighbors: neighbors,
        terrainShadowFamily:
          shadowFamilies.get(worldEntityKey(source.worldId, source.entityKey)) ?? 0,
      };
      const material = MaterialResource.from({ ...base, paramSnapshot: parameters });
      if (layerFrame !== undefined) layers?.bind(material.snapshot, layerFrame);
      materials = materials.with(material);
      const prior = accepted.get(terrainSectionKey(source, index));
      const changed =
        prior?.terrainSection === undefined ||
        terrainDrawSection(prior.terrainSection.source, index).heights !==
          terrainDrawSection(content, index).heights ||
        prior.terrainSection.source.asset.spacing !== asset.spacing ||
        prior?.terrainSection?.source.grids[grid] !== content.grids[grid] ||
        prior?.terrainSection?.lod !== lod ||
        neighbors.some((v, i) => v !== prior?.terrainSection?.neighbors[i]);
      const temporal = source.temporal;
      const draw: RenderableSnapshot = {
        ...source,
        assetHandle: Number(content.grids[grid]),
        material,
        materials: [material],
        materialBindingSources: ['mesh-default'],
        localAabb: new Float32Array([
          section.x,
          minHeight,
          section.z,
          terrainAxisEndpoint(section.x, width),
          maxHeight,
          terrainAxisEndpoint(section.z, width),
        ]),
        terrainSection: { source: content, index, lod, neighbors },
        ...(changed
          ? {
              temporal: {
                previousSource: temporal?.previousSource ?? 'current-seed',
                motionValid: false,
                reactive: true,
                reactiveReasons: ['geometry-revision'],
                previousTransform: temporal?.previousTransform ?? source.transform,
                previousInstances: undefined,
              },
            }
          : {}),
      };
      const renderableIndex = renderables.length;
      renderables.push(draw);
      if (source.authorVisible === false) continue;
      appendMaterialDispatchEntries(
        dispatch,
        base.passes.filter(
          (pass) =>
            source.shadowCaster !== false ||
            ((pass.renderState?.tags as Record<string, string> | undefined)?.LightMode !==
              'ShadowCaster' &&
              pass.name !== 'shadow-caster'),
        ),
        source.entityKey as EntityHandle,
        material.snapshot.materialHandle ?? 0,
        renderableIndex,
        terrain.layer,
        0,
        material.snapshot.materialProgramKeys,
      );
    }
  }
  return { frame: { ...frame, renderables, dispatch: sortDispatchByQueue(dispatch) }, materials };
}
