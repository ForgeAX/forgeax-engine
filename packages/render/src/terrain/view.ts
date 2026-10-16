import type { EntityHandle } from '@forgeax/engine-ecs';
import { terrainAxisEndpoint, terrainHeightBounds, terrainLod } from '@forgeax/engine-terrain';
import { worldEntityKey } from '../record/frame-snapshot.js';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  type ExtractedFrame,
  type RenderableSnapshot,
  sortDispatchByQueue,
} from '../render-system-extract.js';
import { terrainShadowReceivers } from './shadow-family.js';

export function terrainSectionKey(source: RenderableSnapshot, index: number): string {
  return `${source.worldId}:${source.entityKey}:${index}`;
}

/** A view-local draw roster derived from one retained entity, without synthetic ECS identities. */
export function projectTerrainView(
  frame: ExtractedFrame,
  accepted: ReadonlyMap<string, RenderableSnapshot>,
): ExtractedFrame {
  if (!frame.renderables.some((source) => source.terrain !== undefined)) return frame;
  const camera = frame.cameras[0];
  if (camera === undefined) return frame;
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
    const asset = terrain.asset,
      n = asset.subsectionVertices,
      width = (n - 1) * asset.spacing;
    const nx = (asset.columns - 1) / (n - 1),
      nz = (asset.rows - 1) / (n - 1),
      maxLod = terrain.grids.length - 1;
    const lods = asset.sections.map((section) => {
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
    for (const [index, section] of asset.sections.entries()) {
      const [minHeight, maxHeight] = terrainHeightBounds(
        section.minHeight,
        section.maxHeight,
        asset.heightRange,
      );
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
      const base = source.materials[index];
      if (base === undefined) continue;
      const parameters = {
        ...base.paramSnapshot,
        terrainSection: [section.x, section.z, width, n],
        terrainLod: [grid, lod, asset.heightRange[0], asset.heightRange[1]],
        terrainNeighbors: neighbors,
        terrainShadowFamily:
          shadowFamilies.get(worldEntityKey(source.worldId, source.entityKey)) ?? 0,
      };
      const material = { ...base, paramSnapshot: parameters };
      const prior = accepted.get(terrainSectionKey(source, index));
      const changed =
        prior?.terrain?.asset !== asset ||
        prior?.terrain?.heightTextures[index] !== terrain.heightTextures[index] ||
        prior?.terrain?.grids[grid] !== terrain.grids[grid] ||
        prior?.terrainSection?.lod !== lod ||
        neighbors.some((v, i) => v !== prior?.terrainSection?.neighbors[i]);
      const temporal = source.temporal;
      const draw: RenderableSnapshot = {
        ...source,
        assetHandle: Number(terrain.grids[grid]),
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
        terrainSection: { index, lod, neighbors },
        ...(changed
          ? {
              temporal: {
                previousSource: temporal?.previousSource ?? 'current-seed',
                motionValid: false,
                reactive: true,
                reactiveReasons: ['geometry-revision'],
                previousTransform: temporal?.previousTransform ?? source.transform,
                previousInstances: undefined,
                previousSkin: undefined,
                previousMorphWeights: undefined,
              },
            }
          : {}),
      };
      const renderableIndex = renderables.length;
      renderables.push(draw);
      if (source.authorVisible === false) continue;
      appendMaterialDispatchEntries(
        dispatch,
        terrain.passes[index] ?? [],
        source.entityKey as EntityHandle,
        material.materialHandle ?? 0,
        renderableIndex,
        terrain.layer,
        parameters,
        0,
        material.materialProgramKeys,
      );
    }
  }
  return { ...frame, renderables, dispatch: sortDispatchByQueue(dispatch) };
}
