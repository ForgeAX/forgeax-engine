import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetChange } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { frustum, mat4 } from '@forgeax/engine-math';
import { GlobalTransform, readPresentationWorldMatrix, Transform } from '@forgeax/engine-scene';
import type { AssetHandle, MaterialAsset, MeshAsset, TilesetAsset } from '@forgeax/engine-types';
import { Tilemap } from './components/tilemap';
import { MaterialResource } from './material-resource';
import type { RenderResourceScope } from './publication/resource-scope';
import { computeProjectionMatrix, computeViewMatrix } from './record/helpers';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  defaultMaterialSnapshot,
  type ExtractedFrame,
  prepareMaterialSnapshot,
  type RenderableSnapshot,
  sortDispatchByQueue,
} from './render-system-extract';
import type { MaterialFrame } from './scene/material-dispatch';
import {
  type TilemapCellGeometry,
  type TilemapChunk,
  type TilemapRenderSource,
  tilemapCellGeometry,
  tilemapChunks,
  tilemapMesh,
  tilemapRegionMesh,
  tilemapSource,
} from './tilemap-geometry';

const rootMaterial = MaterialResource.from({ ...defaultMaterialSnapshot(), passes: [] });
const passes: NonNullable<MaterialAsset['passes']> = [
  {
    name: 'Forward',
    program: { module: 'forgeax::default-unlit' },
    renderState: {
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
      cullMode: 'none',
      tags: { LightMode: 'Forward' },
      queue: 3000,
    },
  },
];
interface TileDraw {
  readonly key: number;
  readonly atlas: number;
  readonly mesh: MeshAsset;
  readonly matrix?: Float32Array;
}
interface TilesetContent {
  readonly asset: TilesetAsset;
  readonly extent: number;
  readonly chunks: Map<
    TilemapChunk,
    { readonly draws: readonly TileDraw[]; readonly bytes: number }
  >;
  readonly regions: Map<number, MeshAsset>;
  readonly materials: Map<number, MaterialResource>;
  bytes: number;
}

/** One shared Tileset content per source scope. Adoption only touches changed handles. */
export class TilemapSources {
  private worlds = new WeakMap<RenderResourceScope, Map<number, TilesetContent>>();
  private partitions = new WeakMap<TilemapRenderSource, readonly TilemapChunk[]>();

  content(world: RenderResourceScope, handle: AssetHandle<'tileset'>): TilesetContent {
    let roots = this.worlds.get(world);
    let content = roots?.get(handle);
    if (content !== undefined) return content;
    const asset = structuredClone(world.resolveAsset<TilesetAsset>(handle).unwrap());
    let extent = 1;
    for (const tile of asset.tiles)
      extent = Math.max(extent, tile.widthCells ?? 1, tile.heightCells ?? 1);
    content = {
      asset,
      extent,
      chunks: new Map(),
      regions: new Map(),
      materials: new Map(),
      bytes: 0,
    };
    if (roots === undefined) {
      roots = new Map();
      this.worlds.set(world, roots);
    }
    roots.set(handle, content);
    return content;
  }
  chunks(source: TilemapRenderSource): readonly TilemapChunk[] {
    let chunks = this.partitions.get(source);
    if (chunks === undefined) {
      chunks = tilemapChunks(source);
      this.partitions.set(source, chunks);
    }
    return chunks;
  }
  adopt(world: RenderResourceScope, changes: readonly AssetChange[]): void {
    const roots = this.worlds.get(world);
    if (roots !== undefined) for (const change of changes) roots.delete(change.handle);
  }
  draws(
    source: TilemapRenderSource,
    chunk: TilemapChunk,
    content: TilesetContent,
  ): readonly TileDraw[] {
    const cached = content.chunks.get(chunk);
    if (cached !== undefined) return cached.draws;
    const draws: TileDraw[] = [];
    const groups = new Map<number, TilemapCellGeometry[]>();
    for (const cell of chunk.cells) {
      const geometry = tilemapCellGeometry(source, content.asset, cell);
      if (geometry === undefined) continue;
      const atlas = content.asset.regions[geometry.regionIndex]?.atlasIndex ?? 0;
      if (source.sortScope === 1) {
        let mesh = content.regions.get(geometry.regionIndex);
        if (mesh === undefined) {
          mesh = tilemapRegionMesh(content.asset, geometry.regionIndex);
          content.regions.set(geometry.regionIndex, mesh);
        }
        draws.push({ key: cell, atlas, mesh, matrix: geometry.matrix });
      } else {
        let group = groups.get(atlas);
        if (group === undefined) {
          group = [];
          groups.set(atlas, group);
        }
        group.push(geometry);
      }
    }
    for (const [atlas, cells] of groups)
      draws.push({
        key: chunk.index * content.asset.atlases.length + atlas,
        atlas,
        mesh: tilemapMesh(content.asset, cells),
      });
    const bytes = draws.reduce(
      (sum, draw) =>
        sum +
        (draw.matrix === undefined
          ? draw.mesh.vertices.byteLength * 2 + (draw.mesh.indices?.byteLength ?? 0)
          : draw.matrix.byteLength + 32),
      0,
    );
    // Derived geometry is a bounded cache. Eviction changes neither accepted source nor old frames.
    if (bytes <= 32 * 1024 * 1024) {
      while (content.bytes + bytes > 32 * 1024 * 1024) {
        const oldest = content.chunks.entries().next().value;
        if (oldest === undefined) break;
        content.chunks.delete(oldest[0]);
        content.bytes -= oldest[1].bytes;
      }
      content.chunks.set(chunk, { draws, bytes });
      content.bytes += bytes;
    }
    return draws;
  }
  material(
    world: RenderResourceScope,
    content: TilesetContent,
    atlas: number,
    assets: AssetRegistry,
  ): MaterialResource {
    let material = content.materials.get(atlas);
    if (material !== undefined) return material;
    const texture = content.asset.atlases[atlas];
    if (typeof texture !== 'number') throw new Error('Tilemap requires an admitted Tileset atlas');
    material = MaterialResource.from(
      prepareMaterialSnapshot({
        handle: 0,
        world,
        assets,
        programSelections: undefined,
        material: {
          kind: 'material',
          passes,
          colorSpace: 'linear',
          values: {
            baseColor: [1, 1, 1, 1],
            baseColorTexture: { texture },
          },
        },
      }),
    );
    content.materials.set(atlas, material);
    return material;
  }
  detach(world: RenderResourceScope): void {
    this.worlds.delete(world);
  }
  clear(): void {
    this.worlds = new WeakMap();
    this.partitions = new WeakMap();
  }
}

/** Copy only selected changed author rows. No registry lookup, layout or derived World writes. */
export function extractTilemapSources(
  world: World,
  worldId: number,
  renderables: RenderableSnapshot[],
  selected?: ReadonlySet<number>,
  visibility?: { effective(entity: number): string },
  retainHidden = false,
  hidden?: Set<number>,
): void {
  const append = (entity: EntityHandle) => {
    const source = tilemapSource(world, entity);
    if (source === undefined) return;
    const matrix = readPresentationWorldMatrix(world, entity);
    if (matrix === undefined) return;
    const visible = visibility?.effective(entity) !== 'hidden';
    if (!visible) {
      hidden?.add(entity);
      if (!retainHidden) return;
    }
    renderables.push({
      tilemap: source,
      transform: { world: new Float32Array(matrix) },
      worldId,
      entityKey: entity,
      material: rootMaterial,
      materials: [rootMaterial],
      materialBindingSources: ['mesh-default'],
      shadowCaster: false,
      layer: source.layerOrder << 20,
      ...(visible ? {} : { authorVisible: false }),
    });
  };
  // The changed set spans every renderable kind; a component miss would allocate an error per entity.
  if (selected !== undefined) {
    for (const entity of selected)
      if (world.hasComponent(entity as EntityHandle, Tilemap)) append(entity as EntityHandle);
  } else
    for (const row of world.query({ read: [Tilemap, Transform, GlobalTransform] }).unwrap())
      append(row.entity);
}

/** Actual visible chunk work reads current shared content; asset changes never fan out to cells. */
export function projectTilemapView(
  frame: ExtractedFrame,
  materials: MaterialFrame,
  worlds: readonly RenderResourceScope[],
  sources: TilemapSources,
  assets: AssetRegistry | undefined,
  hasSources = frame.renderables.some((source) => source.tilemap !== undefined),
): { frame: ExtractedFrame; materials: MaterialFrame } {
  if (!hasSources) return { frame, materials };
  const camera = frame.cameras[0];
  if (camera === undefined) return { frame, materials };
  const viewProjection = mat4.multiply(
    mat4.create(),
    computeProjectionMatrix(camera),
    computeViewMatrix(camera),
  );
  const renderables: RenderableSnapshot[] = [],
    dispatch: DispatchEntry[] = [];
  const dispatchBySource = new Map<number, DispatchEntry[]>();
  for (const entry of frame.dispatch) {
    let entries = dispatchBySource.get(entry.renderableIndex);
    if (entries === undefined) {
      entries = [];
      dispatchBySource.set(entry.renderableIndex, entries);
    }
    entries.push(entry);
  }
  for (const [oldIndex, snapshot] of frame.renderables.entries()) {
    const source = snapshot.tilemap;
    if (source === undefined) {
      const index = renderables.length;
      renderables.push(snapshot);
      for (const entry of dispatchBySource.get(oldIndex) ?? [])
        dispatch.push({ ...entry, renderableIndex: index });
      continue;
    }
    if (snapshot.authorVisible === false) continue;
    const world = worlds[snapshot.worldId];
    if (world === undefined || assets === undefined)
      throw new Error('Tilemap requires its resource scope and renderer asset service');
    const content = sources.content(world, source.tileset);
    const localFrustum = frustum.fromViewProjection(
      frustum.create(),
      mat4.multiply(mat4.create(), viewProjection, snapshot.transform.world),
    );
    for (const chunk of sources.chunks(source)) {
      // Include the maximum declared post-pivot/diagonal footprint before materializing cells.
      const margin = content.extent * Math.max(...source.tileSize);
      const x = chunk.x * source.chunkSize * source.tileSize[0],
        y = chunk.y * source.chunkSize * source.tileSize[1];
      if (
        !frustum.intersectsBox(localFrustum, [
          x - margin,
          y - margin,
          -0.001,
          x + source.chunkSize * source.tileSize[0] + margin,
          y + source.chunkSize * source.tileSize[1] + margin,
          0.001,
        ])
      )
        continue;
      for (const draw of sources.draws(source, chunk, content)) {
        const material = sources.material(world, content, draw.atlas, assets);
        materials = materials.with(material);
        const index = renderables.length;
        const layer =
          (source.layerOrder << 20) | (source.sortScope === 0 ? chunk.index & 0xfffff : 0);
        renderables.push({
          ...snapshot,
          generatedMesh: draw.mesh,
          ...(draw.mesh.aabb === undefined ? {} : { localAabb: draw.mesh.aabb }),
          nativeDraw: { key: `${source.sortScope}:${draw.key}` },
          transform:
            draw.matrix === undefined
              ? snapshot.transform
              : { world: mat4.multiply(mat4.create(), snapshot.transform.world, draw.matrix) },
          material,
          materials: [material],
          layer,
        });
        appendMaterialDispatchEntries(
          dispatch,
          material.snapshot.passes,
          snapshot.entityKey as EntityHandle,
          0,
          index,
          layer,
        );
      }
    }
  }
  return { frame: { ...frame, renderables, dispatch: sortDispatchByQueue(dispatch) }, materials };
}
