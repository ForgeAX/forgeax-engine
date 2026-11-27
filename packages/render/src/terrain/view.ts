import type { EntityHandle } from '@forgeax/engine-ecs';
import { terrainLod, terrainTranslationValid } from '@forgeax/engine-terrain';
import { deriveOwnedMaterialParameters, type MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  type ExtractedFrame,
  type RenderableSnapshot,
} from '../render-system-extract.js';
import type { AcceptedMaterial, MaterialFrame } from '../scene/material-dispatch';
import type { TerrainLayers } from './layers';
import { terrainShadowReceivers } from './shadow-family.js';
import {
  type TerrainDrawSection,
  type TerrainDrawSource,
  type TerrainRenderSource,
  type TerrainSourceCache,
  terrainDrawSection,
  terrainSourceError,
} from './source';

export function terrainSectionKey(source: RenderableSnapshot, index: number): string {
  return `${source.entityKey}:${index}`;
}

function sameFourParameters(value: unknown, a: number, b: number, c: number, d: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value[0] === a &&
    value[1] === b &&
    value[2] === c &&
    value[3] === d
  );
}

const TERRAIN_MATERIAL_BINDING = Object.freeze(['mesh-default'] as const);

/** Independent of materials. Only perspective selection needs one f32 per section for its neighbors. */
function sectionLods(
  content: TerrainDrawSource,
  source: RenderableSnapshot,
  camera: CameraSnapshot,
  terrain: TerrainRenderSource,
  width: number,
  maxLod: number,
): number | Float32Array {
  if (terrain.forcedLod >= 0) return Math.fround(Math.min(maxLod, terrain.forcedLod));
  if (camera.projection === 'orthographic')
    return Math.fround(
      terrainLod(
        width / Math.abs(camera.orthoTop - camera.orthoBottom),
        terrain.lod0Diameter,
        maxLod,
      ),
    );
  const lods = new Float32Array(content.sectionCount);
  const pose = source.transform.world;
  const tangent = Math.tan(camera.fov / 2);
  for (let index = 0; index < lods.length; index++) {
    const section = terrainDrawSection(content, index).data;
    const dx = section.x + width / 2 + (pose[12] ?? 0) - (camera.position[0] ?? 0);
    const dy =
      (section.minHeight + section.maxHeight) / 2 + (pose[13] ?? 0) - (camera.position[1] ?? 0);
    const dz = section.z + width / 2 + (pose[14] ?? 0) - (camera.position[2] ?? 0);
    const distance = Math.max(camera.near, Math.hypot(dx, dy, dz));
    lods[index] = terrainLod(width / (distance * tangent), terrain.lod0Diameter, maxLod);
  }
  return lods;
}

const NO_SECTION_PASSES: readonly DispatchEntry[] = Object.freeze([]);

/** Bind this material's prepared Passes to the current physical section address. */
function bindSectionPasses(
  accepted: AcceptedMaterial,
  source: RenderableSnapshot,
  layer: number,
  renderableIndex: number,
  previous: readonly DispatchEntry[] | undefined,
): readonly DispatchEntry[] {
  if (source.authorVisible === false) return NO_SECTION_PASSES;
  const first = previous?.[0];
  if (previous !== undefined) {
    if (first === undefined || (first.renderableIndex === renderableIndex && first.layer === layer))
      return previous;
    return Object.freeze(
      previous.map((entry) => Object.freeze({ ...entry, layer, renderableIndex })),
    );
  }
  const entries: DispatchEntry[] = [];
  for (const pass of accepted.passes) {
    if (
      source.shadowCaster === false &&
      (pass.tags.LightMode === 'ShadowCaster' ||
        accepted.snapshot.passes[pass.passIndex]?.name === 'shadow-caster')
    )
      continue;
    entries.push(
      Object.freeze({
        ...pass,
        entityIndex: source.entityKey as EntityHandle,
        layer,
        renderableIndex,
        passIndex: entries.length,
      }),
    );
  }
  return Object.freeze(entries);
}

type ProjectedSection = NonNullable<RenderableSnapshot['terrainSection']>;
type MaterialBinding = NonNullable<ProjectedSection['materialReuse']>;

interface TerrainView {
  readonly source: RenderableSnapshot;
  readonly content: TerrainDrawSource;
  readonly world: RenderResourceScope;
  readonly width: number;
  readonly columns: number;
  readonly rows: number;
  readonly layer: number;
  readonly shadowFamily: number;
  readonly layers: TerrainLayers | undefined;
  readonly layerFrame: ReturnType<TerrainLayers['capture']> | undefined;
  readonly lods: number | Float32Array;
}

function sectionNeighbors(
  lods: TerrainView['lods'],
  index: number,
  columns: number,
  lod: number,
  previous: readonly number[] | undefined,
): readonly number[] {
  const x = index % columns;
  const left = typeof lods === 'number' || x === 0 ? lod : (lods[index - 1] as number);
  const right = typeof lods === 'number' || x + 1 === columns ? lod : (lods[index + 1] as number);
  const top = typeof lods === 'number' || index < columns ? lod : (lods[index - columns] as number);
  const bottom =
    typeof lods === 'number' || index + columns >= lods.length
      ? lod
      : (lods[index + columns] as number);
  return previous !== undefined && sameFourParameters(previous, left, right, top, bottom)
    ? previous
    : Object.freeze([left, right, top, bottom]);
}

function atProjectedLod(
  view: TerrainView,
  section: TerrainDrawSection['data'],
  lod: number,
  neighbors: readonly number[],
  prior: RenderableSnapshot,
  binding: MaterialBinding,
): boolean {
  const projected = binding.projectedSnapshot;
  if (
    prior.material.snapshot !== projected ||
    !prior.material.ownsValues(projected) ||
    binding.acceptedMaterial.resource !== prior.material ||
    binding.acceptedMaterial.snapshot !== projected ||
    binding.layerFrame !== view.layerFrame ||
    prior.terrainSection?.neighbors !== neighbors
  )
    return false;
  if (view.layerFrame !== undefined && view.layers?.isBound(projected, view.layerFrame) !== true)
    return false;
  const values = projected.paramSnapshot;
  return (
    sameFourParameters(
      values?.terrainSection,
      section.x,
      section.z,
      view.width,
      view.content.asset.subsectionVertices,
    ) &&
    sameFourParameters(values?.terrainLod, Math.floor(lod), lod, view.columns, view.rows) &&
    values?.terrainShadowFamily === view.shadowFamily
  );
}

function projectSectionMaterial(
  view: TerrainView,
  section: TerrainDrawSection['data'],
  resource: MaterialResource,
  base: MaterialResource['snapshot'],
  lod: number,
  neighbors: readonly number[],
): MaterialResource {
  const values = {
    ...base.paramSnapshot,
    terrainSection: [section.x, section.z, view.width, view.content.asset.subsectionVertices],
    terrainLod: [Math.floor(lod), lod, view.columns, view.rows],
    terrainNeighbors: [...neighbors],
    terrainShadowFamily: view.shadowFamily,
  };
  const material =
    deriveOwnedMaterialParameters(resource, base, values) ?? resource.withParameters(values);
  if (view.layerFrame !== undefined) view.layers?.bind(material.snapshot, view.layerFrame);
  return material;
}

function appendSectionPasses(
  output: DispatchEntry[],
  view: TerrainView,
  index: number,
  address: number,
  material: MaterialResource,
  base: MaterialResource['snapshot'],
  owned: AcceptedMaterial | undefined,
  binding: MaterialBinding | undefined,
  prior: RenderableSnapshot | undefined,
): readonly DispatchEntry[] | undefined {
  const source = view.source;
  if (owned !== undefined) {
    const sameParticipation =
      prior?.entityKey === source.entityKey &&
      prior.terrainSection?.index === index &&
      (prior.authorVisible === false) === (source.authorVisible === false) &&
      prior.shadowCaster === source.shadowCaster;
    const passes = bindSectionPasses(
      owned,
      source,
      view.layer,
      address,
      sameParticipation ? binding?.dispatch : undefined,
    );
    for (const pass of passes) output.push(pass);
    return passes;
  }
  if (source.authorVisible !== false) {
    const passes =
      source.shadowCaster === false
        ? base.passes.filter(
            (pass) =>
              (pass.renderState?.tags as Record<string, string> | undefined)?.LightMode !==
                'ShadowCaster' && pass.name !== 'shadow-caster',
          )
        : base.passes;
    const snapshot = material.snapshot;
    appendMaterialDispatchEntries(
      output,
      passes,
      source.entityKey as EntityHandle,
      snapshot.materialHandle ?? 0,
      address,
      view.layer,
      0,
      snapshot.materialProgramKeys,
    );
  }
  return undefined;
}

function sectionGeometryChanged(
  previous: ProjectedSection | undefined,
  content: TerrainDrawSource,
  geometry: TerrainDrawSection,
  lod: number,
  neighbors: readonly number[],
): boolean {
  if (previous === undefined || previous.lod !== lod || previous.neighbors !== neighbors)
    return true;
  if (previous.source === content) return false;
  const grid = Math.floor(lod);
  return (
    terrainDrawSection(previous.source, previous.index).heights !== geometry.heights ||
    previous.source.asset.spacing !== content.asset.spacing ||
    previous.source.grids[grid] !== content.grids[grid]
  );
}

function checkSectionTextures(
  section: TerrainDrawSection['data'],
  base: MaterialResource['snapshot'],
): void {
  const textures = base.textureHandles;
  if (
    textures?.get('terrainHeightTexture') !== section.heightTexture ||
    textures?.get('terrainWeightTexture') !== section.weightTexture
  )
    terrainSourceError(
      'terrain-query-unavailable',
      'material terrain bindings',
      'the admitted height/control closure',
    );
}

function projectSection(
  view: TerrainView,
  index: number,
  prior: RenderableSnapshot | undefined,
  materials: MaterialFrame,
  resolve: (world: RenderResourceScope, handle: number) => MaterialResource,
  renderables: RenderableSnapshot[],
  dispatch: DispatchEntry[],
): MaterialFrame {
  const { content, source, world } = view;
  const geometry = terrainDrawSection(content, index);
  const section = geometry.data;
  const lod = typeof view.lods === 'number' ? view.lods : (view.lods[index] as number);
  const previous = prior?.terrainSection;
  const neighbors = sectionNeighbors(view.lods, index, view.columns, lod, previous?.neighbors);
  if (typeof section.material !== 'number')
    terrainSourceError('terrain-query-unavailable', 'material', 'an admitted Material reference');
  const resource = resolve(world, section.material);
  const base = resource.snapshot;
  checkSectionTextures(section, base);

  const sourceOwned = resource.ownsValues(base);
  const previousBinding = previous?.materialReuse;
  const binding =
    sourceOwned &&
    previousBinding?.source === resource &&
    previousBinding.world === world &&
    previousBinding.sourceSnapshot === base
      ? previousBinding
      : undefined;
  const matches =
    binding !== undefined &&
    prior !== undefined &&
    atProjectedLod(view, section, lod, neighbors, prior, binding);
  const material = matches
    ? prior.material
    : projectSectionMaterial(view, section, resource, base, lod, neighbors);
  const current = matches
    ? materials.withAccepted(binding.acceptedMaterial)
    : materials.with(material);
  const accepted = current.get(material);
  const snapshot = material.snapshot;
  const owned =
    sourceOwned &&
    material.ownsValues(snapshot) &&
    accepted?.resource === material &&
    accepted.snapshot === snapshot
      ? accepted
      : undefined;
  const passes = appendSectionPasses(
    dispatch,
    view,
    index,
    renderables.length,
    material,
    base,
    owned,
    binding,
    prior,
  );
  const projected =
    matches &&
    previous?.source === content &&
    previous.index === index &&
    binding.dispatch === passes
      ? previous
      : createSection(view, index, lod, neighbors, resource, base, owned, passes);
  const changed = sectionGeometryChanged(previous, content, geometry, lod, neighbors);
  renderables.push({
    ...source,
    assetHandle: Number(content.grids[Math.floor(lod)]),
    material,
    materials: [material],
    materialBindingSources: TERRAIN_MATERIAL_BINDING,
    localAabb: new Float32Array(geometry.localAabb),
    terrainSection: projected,
    ...(changed ? { temporal: sectionMotionReset(source) } : {}),
  });
  return current;
}

function createSection(
  view: TerrainView,
  index: number,
  lod: number,
  neighbors: readonly number[],
  resource: MaterialResource,
  base: MaterialResource['snapshot'],
  accepted: AcceptedMaterial | undefined,
  passes: readonly DispatchEntry[] | undefined,
): ProjectedSection {
  const section = { source: view.content, index, lod, neighbors };
  if (accepted === undefined || passes === undefined) return Object.freeze(section);
  return Object.freeze({
    ...section,
    materialReuse: {
      world: view.world,
      source: resource,
      sourceSnapshot: base,
      projectedSnapshot: accepted.snapshot,
      layerFrame: view.layerFrame,
      acceptedMaterial: accepted,
      dispatch: passes,
    },
  });
}

function sectionMotionReset(
  source: RenderableSnapshot,
): NonNullable<RenderableSnapshot['temporal']> {
  const temporal = source.temporal;
  return {
    previousSource: temporal?.previousSource ?? 'current-seed',
    motionValid: false,
    reactive: true,
    reactiveReasons: ['geometry-revision'],
    previousTransform: temporal?.previousTransform ?? source.transform,
    previousInstances: undefined,
  };
}

/** A view-local draw roster derived from one retained entity, without synthetic ECS identities. */
export function projectTerrainView(
  frame: ExtractedFrame,
  accepted: ReadonlyMap<string, RenderableSnapshot>,
  materials: MaterialFrame,
  sourceScope: RenderResourceScope,
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
  // Terrain roots expand into contiguous sections. Only these boundaries change
  // source row addresses, regardless of the number of ordinary meshes.
  const terrainRows: number[] = [];
  const offsetsAfterTerrain: number[] = [];
  const shadowFamilies = new Map(
    terrainShadowReceivers(frame.renderables).map(
      (root, index) => [root.entityKey, index + 1] as const,
    ),
  );
  let oldIndex = -1;
  for (const source of frame.renderables) {
    oldIndex++;
    const terrain = source.terrain;
    if (terrain === undefined) {
      renderables.push(source);
      continue;
    }
    const world = sourceScope;
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
    const view: TerrainView = {
      source,
      content,
      world,
      width,
      columns: nx,
      rows: nz,
      layer: terrain.layer,
      shadowFamily: shadowFamilies.get(source.entityKey) ?? 0,
      layers,
      layerFrame,
      lods: sectionLods(content, source, camera, terrain, width, maxLod),
    };
    for (let index = 0; index < content.sectionCount; index++) {
      const prior = accepted.get(terrainSectionKey(source, index));
      materials = projectSection(
        view,
        index,
        prior,
        materials,
        resolveMaterial,
        renderables,
        dispatch,
      );
    }
    terrainRows.push(oldIndex);
    offsetsAfterTerrain.push(renderables.length - oldIndex - 1);
  }
  for (const entry of frame.dispatch) {
    const sourceIndex = entry.renderableIndex;
    if (
      !Number.isInteger(sourceIndex) ||
      sourceIndex < 0 ||
      sourceIndex >= frame.renderables.length
    )
      continue;
    let first = 0;
    let end = terrainRows.length;
    while (first < end) {
      const middle = first + Math.floor((end - first) / 2);
      if ((terrainRows[middle] as number) < sourceIndex) first = middle + 1;
      else end = middle;
    }
    if (terrainRows[first] === sourceIndex) continue;
    const offset = first === 0 ? 0 : (offsetsAfterTerrain[first - 1] as number);
    dispatch.push(
      offset === 0 && Object.isFrozen(entry)
        ? entry
        : { ...entry, renderableIndex: sourceIndex + offset },
    );
  }
  // Preserve queue order, then source/section order and original per-row pass order.
  // The array belongs to this projection and can be ordered in place.
  dispatch.sort((a, b) => a.queue - b.queue || a.renderableIndex - b.renderableIndex);
  return { frame: { ...frame, renderables, dispatch }, materials };
}
