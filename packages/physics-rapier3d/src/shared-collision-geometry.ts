import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { buildMeshCollision, validateMeshCollisionAttachment } from '@forgeax/engine-geometry';
import { PhysicsError } from '@forgeax/engine-physics';
import { terrainHeightfield, validateTerrain } from '@forgeax/engine-terrain';
import type {
  AssetReferenceOwner,
  MeshAsset,
  MeshCollision,
  TerrainAsset,
} from '@forgeax/engine-types';
import type { ColliderDesc, Shape } from '../pkg/rapier.mjs';
import type { Rapier3DModule } from './wasm-loader.js';

type GeometryKind = 'convexHull' | 'trimesh' | 'heightfield';

interface NativeSharedGeometry {
  createSharedGeometry(shape: Shape): number;
  replaceSharedGeometry(geometry: number, shape: Shape): boolean;
  writeSharedHeightfield(geometry: number, indices: Uint32Array, values: Float32Array): boolean;
  removeSharedGeometry(geometry: number): boolean;
}

interface Geometry {
  readonly native: number;
}

interface AssetGeometry {
  readonly shapes: Map<GeometryKind, Geometry>;
  instances: number;
  version: number;
}

/** One asset change reaches native geometry roots, never a list of its colliders. */
export class SharedCollisionGeometry {
  private readonly records;
  private readonly observer;
  private readonly resources = new Map<number, AssetGeometry>();
  /** Actual collider lifecycle owns these forward bindings; adoption never reads them. */
  private readonly colliders = new Map<number, number>();

  constructor(
    readonly owner: AssetReferenceOwner,
    private readonly native: NativeSharedGeometry,
    private readonly rapier: Rapier3DModule,
  ) {
    this.records = runtimeAssets(owner);
    this.observer = this.records.observe().unwrap();
  }

  private failure(reason: string): never {
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'a finite collision geometry supported by the native collider owner',
      hint: 'Repair the asset geometry and retry the next fixed step.',
      detail: { code: 'invalid-body-config', field: 'Collider.geometry', value: reason },
    });
  }

  private collision(handle: number): MeshCollision {
    const mesh = this.records.borrow<MeshAsset>(handle).unwrap();
    if (mesh.kind !== 'mesh') return this.failure('the bound asset must be a Mesh');
    // Runtime geometry edits explicitly invalidate source-cooked collision.
    // Reuse the Geometry-owned pure kernel once per accepted Mesh version.
    return (
      mesh.collision === undefined
        ? buildMeshCollision(mesh)
        : validateMeshCollisionAttachment(mesh, mesh.collision)
    ).unwrap();
  }

  private shape(handle: number, kind: GeometryKind): Shape {
    if (kind === 'heightfield') {
      const terrain = this.records.borrow<TerrainAsset>(handle).unwrap();
      validateTerrain(terrain).unwrap();
      const field = terrainHeightfield(terrain);
      const shape = this.rapier.ColliderDesc.heightfield(field.rows, field.columns, field.heights, {
        x: field.scale[0],
        y: field.scale[1],
        z: field.scale[2],
      }).shape;
      // Source extent owns this recentering. Keeping it in the shared root makes
      // topology/spacing edits independent of the number of terrain instances.
      return this.rapier.ColliderDesc.compound(
        [shape],
        [{ x: field.origin[0], y: field.origin[1], z: field.origin[2] }],
        [{ x: 0, y: 0, z: 0, w: 1 }],
      ).shape;
    }
    const collision = this.collision(handle);
    const descriptor: ColliderDesc | null =
      kind === 'trimesh'
        ? this.rapier.ColliderDesc.trimesh(
            collision.positions,
            collision.indices,
            this.rapier.TriMeshFlags.FIX_INTERNAL_EDGES,
          )
        : this.rapier.ColliderDesc.convexHull(collision.positions);
    if (descriptor === null) return this.failure('convex hull construction failed');
    const shape = descriptor.shape;
    if (shape.type === 'shared')
      return this.failure('collision preparation requires owned shape input');
    return shape;
  }

  prepare(handle: number, kind: GeometryKind): Geometry {
    let resource = this.resources.get(handle);
    const existing = resource?.shapes.get(kind);
    if (existing !== undefined) return existing;
    const shape = this.shape(handle, kind);
    if (resource === undefined)
      this.records.retain(handle, kind === 'heightfield' ? 'terrain' : 'mesh').unwrap();
    let native: number;
    try {
      native = this.native.createSharedGeometry(shape);
    } catch (cause) {
      if (resource === undefined) this.records.release(handle).unwrap();
      throw cause;
    }
    const geometry = { native };
    if (resource === undefined) {
      resource = {
        shapes: new Map(),
        instances: 0,
        version: this.records.version(handle).unwrap(),
      };
      this.resources.set(handle, resource);
    }
    resource.shapes.set(kind, geometry);
    return geometry;
  }

  attach(collider: number, asset: number): void {
    if (this.colliders.has(collider)) this.failure('a native collider can have one asset binding');
    this.colliders.set(collider, asset);
    const resource = this.resources.get(asset);
    if (resource === undefined) this.failure('binding requires a prepared geometry');
    resource.instances++;
  }

  /** Call after the actual native collider has retired. */
  detach(collider: number): void {
    const asset = this.colliders.get(collider);
    if (asset === undefined) return;
    this.colliders.delete(collider);
    const resource = this.resources.get(asset);
    if (resource === undefined) this.failure('a live binding must retain its geometry');
    resource.instances--;
    this.releaseUnused(asset);
  }

  releaseUnused(asset: number): void {
    const resource = this.resources.get(asset);
    if (resource === undefined || resource.instances !== 0) return;
    for (const geometry of resource.shapes.values())
      if (!this.native.removeSharedGeometry(geometry.native))
        this.failure('native geometry still has an unretired collider binding');
    this.resources.delete(asset);
    this.records.release(asset).unwrap();
  }

  /** Version of the asset bytes successfully installed in the native root. */
  version(asset: number): number | undefined {
    return this.resources.get(asset)?.version;
  }

  adopt(): void {
    const batch = this.observer.read().unwrap();
    for (const change of batch.changes) {
      const resource = this.resources.get(change.handle);
      if (resource === undefined) continue;
      if (change.removed) this.failure('a live collision geometry cannot lose its asset owner');
      // Root range records carry exact author bytes. Only those samples cross
      // the column-major native boundary; no complete author validation/transpose.
      const heightfield = resource.shapes.get('heightfield');
      if (
        heightfield !== undefined &&
        change.ranges.length > 0 &&
        change.fields.every((field) => field === 'sections' || field === 'heightRange') &&
        change.ranges.every((range) => range.path.length === 1 && range.path[0] === 'heights')
      ) {
        const terrain = this.records.borrow<TerrainAsset>(change.handle).unwrap();
        const ranges = change.ranges;
        let count = 0;
        for (const range of ranges) {
          const rowBytes = range.rowBytes ?? range.byteLength;
          const rows = (range.byteLength - rowBytes) / (range.byteStride ?? rowBytes) + 1;
          count += (rows * rowBytes) / 4;
        }
        const indices = new Uint32Array(count),
          values = new Float32Array(count);
        let next = 0;
        for (const range of ranges) {
          const rowBytes = range.rowBytes ?? range.byteLength;
          const stride = range.byteStride ?? rowBytes;
          for (let row = 0; row < range.byteLength; row += stride)
            for (let byte = 0; byte < rowBytes; byte += 4) {
              const sample = (range.byteOffset + row + byte) / 4;
              indices[next] =
                (sample % terrain.columns) * terrain.rows + Math.floor(sample / terrain.columns);
              values[next++] = terrain.heights[sample] as number;
            }
        }
        if (!this.native.writeSharedHeightfield(heightfield.native, indices, values))
          this.failure('the native shared heightfield rejected a prepared author range');
        resource.version = change.revision;
        continue;
      }
      const prepared = [...resource.shapes].map(([kind, geometry]) => ({
        geometry,
        shape: this.shape(change.handle, kind),
      }));
      for (const { geometry, shape } of prepared) {
        if (!this.native.replaceSharedGeometry(geometry.native, shape))
          this.failure('the native shared geometry identity has retired');
      }
      resource.version = change.revision;
    }
    batch.accept();
  }

  dispose(): void {
    this.observer.dispose();
    for (const asset of this.resources.keys()) this.records.release(asset).unwrap();
    this.resources.clear();
    this.colliders.clear();
  }
}
