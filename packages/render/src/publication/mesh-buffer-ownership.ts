import type { MeshAsset } from '@forgeax/engine-types';

/** Publication owns these private bytes. Edits advance a scalar witness before
 * touching storage, so GPU sharing can borrow a source instead of copying it.
 * Weak buffer keys retain neither a mesh, receiver nor GPU cache. */
export interface MeshBufferVersion {
  generation: number;
}
const versions = new WeakMap<ArrayBuffer, MeshBufferVersion>();

export function ownPublishedMeshBuffers<T extends MeshAsset>(mesh: T): T {
  for (const view of [mesh.vertices, mesh.indices]) {
    if (view?.buffer instanceof ArrayBuffer && !versions.has(view.buffer))
      versions.set(view.buffer, { generation: 0 });
  }
  return mesh;
}

export function publishedMeshBufferVersion(buffer: ArrayBufferLike): MeshBufferVersion | undefined {
  return buffer instanceof ArrayBuffer ? versions.get(buffer) : undefined;
}

export function beforePublishedMeshBufferWrite(buffer: ArrayBufferLike): void {
  const version = publishedMeshBufferVersion(buffer);
  if (version !== undefined) version.generation++;
}
