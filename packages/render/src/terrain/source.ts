import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type AssetChange, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import { GlobalTransform, readPresentationWorldMatrix, Transform } from '@forgeax/engine-scene';
import {
  Terrain,
  terrainAxisEndpoint,
  terrainHeightAtlas,
  terrainHeightBounds,
  terrainHeightMipOffset,
  terrainTranslationValid,
} from '@forgeax/engine-terrain';
import type {
  AssetHandle,
  TerrainAsset,
  TerrainError,
  TerrainSection,
  TextureAsset,
} from '@forgeax/engine-types';
import { Layer } from '../components/layer.js';
import { ShadowParticipation } from '../components/shadow-participation.js';
import { MaterialResource } from '../material-resource';
import { type RenderResourceScope, renderAssetRevision } from '../publication/resource-scope';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract.js';

/** Instance facts only. The asset owner supplies current content during section execution. */
export interface TerrainRenderSource {
  readonly handle: AssetHandle<'terrain'>;
  readonly lod0Diameter: number;
  readonly forcedLod: number;
  readonly layer: number;
}

/** Exact geometry retained by prepared draws and submitted receipts. No borrowed author arrays. */
export interface TerrainDrawSource {
  readonly version: number;
  readonly asset: Pick<
    TerrainAsset,
    'columns' | 'rows' | 'spacing' | 'subsectionVertices' | 'heightRange'
  >;
  readonly layers: TerrainAsset['layers'];
  readonly activeLayers: readonly number[];
  readonly grids: readonly AssetHandle<'mesh'>[];
  readonly sectionCount: number;
  readonly sections: TerrainSections;
}

export interface TerrainDrawSection {
  readonly data: TerrainSection;
  /** Section-local f32 bounds advance with the admitted height tile. */
  readonly localAabb: readonly number[];
  /** This section's packed f32 mip chain, detached once per affected tile. */
  readonly heights: Uint8Array;
}

const rootMaterial = MaterialResource.from({ ...defaultMaterialSnapshot(), passes: [] });

function fixedAsset(asset: TerrainAsset): TerrainDrawSource['asset'] {
  return {
    columns: asset.columns,
    rows: asset.rows,
    spacing: asset.spacing,
    subsectionVertices: asset.subsectionVertices,
    heightRange: [...asset.heightRange],
  };
}

function fixedSection(
  world: RenderResourceScope,
  asset: TerrainAsset,
  index: number,
  atlas: ReturnType<typeof terrainHeightAtlas>,
): TerrainDrawSection {
  const section = asset.sections[index];
  if (section === undefined || typeof section.heightTexture !== 'number')
    terrainSourceError('terrain-query-unavailable', 'section', 'an admitted Terrain section');
  const texture = world.resolveAsset<TextureAsset>(section.heightTexture).unwrap();
  if (texture.kind !== 'texture' || texture.format !== 'rgba8unorm' || texture.data === undefined)
    terrainSourceError('terrain-query-unavailable', 'height', 'packed f32 height mip bytes');
  const n = asset.subsectionVertices;
  const heights = new Uint8Array(terrainHeightMipOffset(n, n, Math.log2(n) + 1));
  let sourceOffset = 0,
    targetOffset = 0;
  for (let size = n; size >= 1; size /= 2) {
    const width = atlas.tileColumns * size;
    const x = (index % atlas.tileColumns) * size;
    const z = Math.floor(index / atlas.tileColumns) * size;
    for (let row = 0; row < size; row++) {
      const offset = sourceOffset + ((z + row) * width + x) * 4;
      heights.set(texture.data.subarray(offset, offset + size * 4), targetOffset + row * size * 4);
    }
    sourceOffset += width * atlas.tileRows * size * 4;
    targetOffset += size * size * 4;
  }
  const width = (n - 1) * asset.spacing;
  const [min, max] = terrainHeightBounds(section.minHeight, section.maxHeight);
  return {
    data: { ...section, activeLayers: [...section.activeLayers] },
    heights,
    localAabb: Object.freeze([
      Math.fround(section.x),
      Math.fround(min),
      Math.fround(section.z),
      terrainAxisEndpoint(section.x, width),
      Math.fround(max),
      terrainAxisEndpoint(section.z, width),
    ]),
  };
}

const SECTIONS_PER_PAGE = 64;
const PAGES_PER_GROUP = 256;
const SECTIONS_PER_GROUP = SECTIONS_PER_PAGE * PAGES_PER_GROUP;

/** Dense section indices survive height edits. Each issued view keeps its own page directory. */
class TerrainSections {
  private constructor(private readonly groups: TerrainDrawSection[][][]) {}

  static capture(world: RenderResourceScope, asset: TerrainAsset): TerrainSections {
    const groups: TerrainDrawSection[][][] = [];
    const atlas = terrainHeightAtlas(asset);
    for (let start = 0; start < asset.sections.length; start += SECTIONS_PER_GROUP) {
      const group: TerrainDrawSection[][] = [];
      const end = Math.min(start + SECTIONS_PER_GROUP, asset.sections.length);
      for (let pageStart = start; pageStart < end; pageStart += SECTIONS_PER_PAGE) {
        const page: TerrainDrawSection[] = [];
        const pageEnd = Math.min(end, pageStart + SECTIONS_PER_PAGE);
        for (let index = pageStart; index < pageEnd; index++)
          page.push(fixedSection(world, asset, index, atlas));
        group.push(page);
      }
      groups.push(group);
    }
    return new TerrainSections(groups);
  }

  at(index: number): TerrainDrawSection | undefined {
    const group = this.groups[Math.floor(index / SECTIONS_PER_GROUP)];
    return group?.[Math.floor(index / SECTIONS_PER_PAGE) % PAGES_PER_GROUP]?.[
      index % SECTIONS_PER_PAGE
    ];
  }

  update(
    world: RenderResourceScope,
    asset: TerrainAsset,
    indices: ReadonlySet<number>,
  ): TerrainSections {
    if (indices.size === 0) return this;
    const groups = this.groups.slice();
    const atlas = terrainHeightAtlas(asset);
    for (const index of indices) {
      const groupId = Math.floor(index / SECTIONS_PER_GROUP);
      const pageId = Math.floor(index / SECTIONS_PER_PAGE) % PAGES_PER_GROUP;
      const priorGroup = this.groups[groupId] as TerrainDrawSection[][];
      let group = groups[groupId] as TerrainDrawSection[][];
      if (group === priorGroup) {
        group = group.slice();
        groups[groupId] = group;
      }
      let page = group[pageId] as TerrainDrawSection[];
      if (page === priorGroup[pageId]) {
        page = page.slice();
        group[pageId] = page;
      }
      page[index % SECTIONS_PER_PAGE] = fixedSection(world, asset, index, atlas);
    }
    return new TerrainSections(groups);
  }
}

/** Renderer-owned geometry projection; the existing source change stream drives path copies. */
export class TerrainSourceCache {
  private source: RenderResourceScope | undefined;
  private readonly roots = new Map<number, TerrainDrawSource>();
  private rootsFor(source: RenderResourceScope): Map<number, TerrainDrawSource> {
    if (this.source !== source) {
      this.clear();
      this.source = source;
    }
    return this.roots;
  }
  resolve(world: RenderResourceScope, handle: AssetHandle<'terrain'>): TerrainDrawSource {
    const roots = this.rootsFor(world);
    const cached = roots?.get(handle);
    if (cached !== undefined) return cached;
    const resolved = world.resolveAsset<TerrainAsset>(handle);
    if (!resolved.ok || resolved.value.kind !== 'terrain')
      terrainSourceError('terrain-query-unavailable', 'asset', 'one admitted TerrainAsset');
    const asset = resolved.value;
    const grids = asset.grids.map((value) => {
      if (typeof value !== 'number')
        terrainSourceError('terrain-query-unavailable', 'grid', 'an admitted Mesh reference');
      return value;
    });
    const sections = TerrainSections.capture(world, asset);
    const version = renderAssetRevision(world, handle);
    if (version === undefined)
      terrainSourceError(
        'terrain-query-unavailable',
        'version',
        'one admitted Terrain asset version',
      );
    const result = {
      version,
      asset: fixedAsset(asset),
      layers: asset.layers.map((layer) =>
        layer.blend === 'height'
          ? { ...layer, heightRange: [...layer.heightRange] as const }
          : { ...layer },
      ),
      activeLayers: [...new Set(asset.sections.flatMap((section) => section.activeLayers))],
      grids,
      sectionCount: asset.sections.length,
      sections,
    };
    roots.set(handle, result);
    return result;
  }

  adopt(world: RenderResourceScope, changes: readonly AssetChange[]): void {
    const roots = this.rootsFor(world);
    if (roots === undefined) return;
    for (const change of changes) {
      const before = roots.get(change.handle);
      if (before === undefined) continue;
      if (
        change.removed ||
        change.ranges.length === 0 ||
        change.ranges.some((range) => range.path.length !== 1 || range.path[0] !== 'heights')
      ) {
        roots.delete(change.handle);
        continue;
      }
      const asset = world.resolveAsset<TerrainAsset>(change.handle).unwrap();
      const stride = asset.subsectionVertices - 1;
      const nx = (asset.columns - 1) / stride;
      const nz = (asset.rows - 1) / stride;
      const indices = new Set<number>();
      for (const range of change.ranges) {
        const rowBytes = range.rowBytes ?? range.byteLength;
        const byteStride = range.byteStride ?? rowBytes;
        const rowCount = (range.byteLength - rowBytes) / byteStride + 1;
        for (let row = 0; row < rowCount; row++) {
          let start = (range.byteOffset + row * byteStride) / 4;
          let remaining = rowBytes / 4;
          while (remaining > 0) {
            const x = start % asset.columns;
            const z = Math.floor(start / asset.columns);
            const count = Math.min(remaining, asset.columns - x);
            const minX = Math.max(0, Math.ceil(x / stride) - 1);
            const maxX = Math.min(nx - 1, Math.floor((x + count - 1) / stride));
            const minZ = Math.max(0, Math.ceil(z / stride) - 1);
            const maxZ = Math.min(nz - 1, Math.floor(z / stride));
            for (let sz = minZ; sz <= maxZ; sz++)
              for (let sx = minX; sx <= maxX; sx++) indices.add(sz * nx + sx);
            start += count;
            remaining -= count;
          }
        }
      }
      roots.set(change.handle, {
        ...before,
        version: change.revision,
        asset: fixedAsset(asset),
        sections: before.sections.update(world, asset, indices),
      });
    }
  }

  detach(world: RenderResourceScope): void {
    if (this.source === world) this.clear();
  }
  clear(): void {
    this.roots.clear();
    this.source = undefined;
  }
}

export function terrainDrawSection(source: TerrainDrawSource, index: number): TerrainDrawSection {
  const section = source.sections.at(index);
  if (section === undefined)
    terrainSourceError('terrain-query-unavailable', 'section', 'a fixed prepared Terrain section');
  return section;
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
  _assets: AssetRegistry,
  _context: MaterialCookRasterContext | undefined,
  renderables: RenderableSnapshot[],
  _dispatch: DispatchEntry[],
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
    const read = world[worldRead];
    const terrainAsset = read.getFieldValue(row.entity, Terrain, 'asset') as AssetHandle<'terrain'>;
    const lod0Diameter = read.getFieldValue(row.entity, Terrain, 'lod0Diameter') as number;
    const forcedLod = read.getFieldValue(row.entity, Terrain, 'forcedLod') as number;
    const transform = readPresentationWorldMatrix(world, row.entity);
    if (transform === undefined) continue;
    const layer = read.getFieldValue(row.entity, Layer, 'value') ?? 0;
    const cast = read.getFieldValue(row.entity, ShadowParticipation, 'cast');
    const receive = read.getFieldValue(row.entity, ShadowParticipation, 'receive');
    const value = runtimeAssets(world.assets).resolveAsset<TerrainAsset>(terrainAsset);
    if (!value.ok || value.value.kind !== 'terrain')
      terrainSourceError('terrain-query-unavailable', 'asset', 'one loaded TerrainAsset');
    const asset = value.value as TerrainAsset;
    const matrix = transform;
    if (!terrainTranslationValid(asset, matrix))
      terrainSourceError(
        'terrain-pose-unsupported',
        'Transform',
        'finite GPU world bounds, translation with exact identity rotation and unit scale',
      );
    if (
      !Number.isFinite(lod0Diameter) ||
      lod0Diameter <= 0 ||
      !Number.isFinite(forcedLod) ||
      forcedLod > Math.log2(asset.subsectionVertices) - 1
    )
      terrainSourceError(
        'terrain-input-invalid',
        'LOD',
        'finite positive LOD0 diameter and a forced LOD within resident range',
      );
    const grids = asset.grids.map((value) => {
      if (typeof value !== 'number')
        terrainSourceError('terrain-query-unavailable', 'grids', 'admitted mesh references');
      return value;
    });
    if (!grids[0])
      terrainSourceError('terrain-input-invalid', 'grids', 'at least one complete subsection grid');
    const [minHeight, maxHeight] = terrainHeightBounds(...asset.heightRange);
    renderables.push({
      layer,
      ...(cast === 0 ? { shadowCaster: false as const } : {}),
      assetHandle: Number(grids[0]),
      transform: { world: new Float32Array(matrix) },
      material: rootMaterial,
      materials: [rootMaterial],
      materialBindingSources: ['mesh-default'],
      entityKey: row.entity,
      ...(authorVisible ? {} : { authorVisible: false }),
      ...(receive === 0 ? { shadowReceiver: false } : {}),
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
        handle: terrainAsset,
        lod0Diameter: lod0Diameter,
        forcedLod: forcedLod,
        layer,
      },
    });
  }
}
