import type { Buffer } from '@forgeax/engine-rhi';
import type { MeshGpuHandles } from '../device/gpu-residency';

export interface RasterMeshBinding {
  readonly mesh: MeshGpuHandles;
  vertex: Buffer | undefined;
  index: Buffer | undefined;
}

/** A live raster publication's unique mesh imports, captured before any graph pass executes. */
export class RasterMeshBindings {
  private readonly rows = new Map<MeshGpuHandles, RasterMeshBinding>();

  forMesh(mesh: MeshGpuHandles): RasterMeshBinding {
    let row = this.rows.get(mesh);
    if (row === undefined) {
      row = { mesh, vertex: undefined, index: undefined };
      this.rows.set(mesh, row);
    }
    return row;
  }

  capture(): void {
    for (const row of this.rows.values()) {
      const vertex = row.mesh.vertexBuffer;
      const index = row.mesh.indexBuffer;
      if (vertex.isDestroyed || index?.isDestroyed) {
        throw new Error('current raster mesh buffers must be live on the recording device');
      }
      const vertexHandle = vertex.handle;
      const indexHandle = index?.handle;
      if (
        vertexHandle === undefined ||
        vertexHandle === null ||
        (index !== null && (indexHandle === undefined || indexHandle === null))
      ) {
        throw new Error('current raster mesh buffers must resolve before any pass executes');
      }
      row.vertex = vertexHandle;
      row.index = indexHandle;
    }
  }
}
