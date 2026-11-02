import { meshGeometryDraws } from '../gpu-driven/mesh-batches';
import type { RenderableSnapshot } from '../render-system-extract';
import type { MeshFrame, MeshGeometry } from './mesh-frame';
import { createMeshMaterialReader, meshMaterialGeometry } from './mesh-materials';

interface DrawEntry {
  value: RenderableSnapshot;
  read: number;
}
interface DrawTable {
  readonly materials: ReturnType<typeof createMeshMaterialReader>;
  readonly instances: WeakMap<RenderableSnapshot, DrawEntry>;
  /** Insertions conservatively bound retained entries, including collected keys. */
  capacity: number;
  reads: number;
  previous: DrawTable | undefined;
}
type DrawTables = WeakMap<MeshGeometry, DrawTable>;
let draws: DrawTables = new WeakMap();
let previousDraws: DrawTables = new WeakMap();
let readGeneration = 0;

/** Drop unread Mesh tables; hot tables amortize their own population changes. */
export function rotateMeshDraws(): void {
  // Keep stamps in the small-integer domain; no young frame token per cached row.
  previousDraws = readGeneration === 0x3fffffff ? new WeakMap() : draws;
  draws = new WeakMap();
  readGeneration = readGeneration === 0x3fffffff ? 1 : readGeneration + 1;
}

function drawTable(mesh: MeshGeometry): DrawTable {
  let table = draws.get(mesh);
  if (table !== undefined) return table;
  const previous = previousDraws.get(mesh);
  // Geometric rebuilding bounds cold entries by the requested population,
  // without copying every hot entry after each frame or sparse source edit.
  table =
    previous !== undefined && previous.capacity <= previous.reads * 2
      ? previous
      : {
          materials: createMeshMaterialReader(mesh),
          instances: new WeakMap(),
          capacity: 0,
          reads: 0,
          previous,
        };
  if (table === previous) table.previous = undefined;
  table.reads = 0;
  draws.set(mesh, table);
  return table;
}

/**
 * The effective draw materials only, without a draw snapshot. Pose-only
 * replacements reuse the per-Mesh override binding, so temporal and GPU Scene
 * readers avoid rebuilding the complete draw row for every moved instance.
 */
export function meshDrawMaterials(
  source: RenderableSnapshot,
  meshes: MeshFrame,
): Pick<RenderableSnapshot, 'material' | 'materials'> {
  if (source.terrain !== undefined || source.materialOverrides === undefined) return source;
  const mesh = meshes.get(source.worldId, source.assetHandle);
  return mesh === undefined
    ? source
    : drawTable(mesh).materials(source, meshMaterialGeometry(source));
}

/** Draw consumption combines instance facts with the frame's shared geometry and bindings. */
export function meshDrawSnapshot(
  source: RenderableSnapshot,
  meshes: MeshFrame,
): RenderableSnapshot {
  const mesh = meshes.get(source.worldId, source.assetHandle);
  if (mesh === undefined || source.terrain !== undefined || source.materialOverrides === undefined)
    return source;
  const table = drawTable(mesh);
  const materials = table.materials(source, meshMaterialGeometry(source));
  let cached = table.instances.get(source);
  if (cached === undefined) {
    cached = table.previous?.instances.get(source);
    if (cached !== undefined) {
      table.instances.set(source, cached);
      table.capacity++;
    }
  }
  if (cached !== undefined && cached.read !== readGeneration) {
    cached.read = readGeneration;
    table.reads++;
  }
  // A Pass query can replace resolved material identities without replacing the
  // Mesh or the instance. Only reuse a draw from the same admitted binding.
  if (cached?.value.materials === materials.materials) return cached.value;
  const { lods: _lods, lodHysteresis: _hysteresis, localAabb: _bounds, ...current } = source;
  // The rest object is fresh and unescaped; publish it after projecting shared geometry.
  // Borrowed getter inputs can select the source itself, preserving their second spread/read.
  const result: { -readonly [Key in keyof RenderableSnapshot]: RenderableSnapshot[Key] } =
    materials === source ? { ...current, ...materials } : Object.assign(current, materials);
  if (source.gpuDrivenDraws !== undefined) {
    result.gpuDrivenDraws = meshGeometryDraws(
      mesh,
      materials.materials,
      source.skinBinding === undefined ? 'rigid' : 'skin',
    );
  }
  // Morphed rows keep their weight-expanded producer bounds.
  if (source.morph !== undefined) {
    if (source.localAabb !== undefined) result.localAabb = source.localAabb;
  } else if (mesh.bounds !== undefined) result.localAabb = mesh.bounds;
  if (mesh.lods !== undefined) result.lods = mesh.lods;
  if (mesh.lodHysteresis !== undefined) result.lodHysteresis = mesh.lodHysteresis;
  if (cached === undefined) {
    table.instances.set(source, { value: result, read: readGeneration });
    table.capacity++;
    table.reads++;
  } else cached.value = result;
  return result;
}
