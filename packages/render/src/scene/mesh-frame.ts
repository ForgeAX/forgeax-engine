import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import type { MaterialResource } from '../material-resource';
import { changes, type Node, put, remove } from './frame-tree';
import { skinGeometryEnvelopes } from './skin-geometry';

const EMPTY_MATERIALS: readonly MaterialResource[] = Object.freeze([]);

/** Shared geometry facts. Vertex bytes remain with the asset and GPU residency owners. */
export interface MeshGeometry {
  readonly worldId: number;
  readonly handle: number;
  readonly bounds: Float32Array | undefined;
  /** Shared base-position enclosure, derived only on admitted Mesh changes.
   * Absence forbids Skin culling; never substitute the rigid/bind-pose box.
   */
  readonly skinEnvelopes: Float32Array | undefined;
  readonly layout: ReturnType<typeof deriveVertexLayoutProjection>;
  readonly indexed: boolean;
  readonly materialSlots: MeshAsset['materialSlots'];
  readonly materials: readonly MaterialResource[];
  readonly submeshes: MeshAsset['submeshes'];
  readonly lods: MeshAsset['lods'];
  readonly lodHysteresis: MeshAsset['lodHysteresis'];
}

/** An immutable geometry root; asset edits copy tree paths, never instance bindings. */
export class MeshFrame {
  constructor(private readonly root: Node<MeshGeometry> | undefined = undefined) {}

  get(worldId: number, handle: number | undefined): MeshGeometry | undefined {
    if (handle === undefined) return undefined;
    let node = this.root;
    while (node !== undefined) {
      if (node.queue === worldId && node.key === handle) return node.value;
      node =
        worldId < node.queue || (worldId === node.queue && handle < node.key)
          ? node.left
          : node.right;
    }
    return undefined;
  }

  with(
    worldId: number,
    handle: number,
    mesh: MeshAsset,
    materials: readonly MaterialResource[] = EMPTY_MATERIALS,
  ): MeshFrame {
    // Only metadata is captured. A range edit may mutate the asset's backing bytes,
    // while old frames must retain their original bounds and section description.
    const source = mesh.aabb;
    const bounds =
      source !== undefined &&
      source.length >= 6 &&
      source.every(Number.isFinite) &&
      (source[0] as number) <= (source[3] as number) &&
      (source[1] as number) <= (source[4] as number) &&
      (source[2] as number) <= (source[5] as number)
        ? source.slice()
        : undefined;
    const geometry: MeshGeometry = {
      worldId,
      handle,
      bounds,
      skinEnvelopes: skinGeometryEnvelopes(mesh),
      layout: deriveVertexLayoutProjection(mesh.attributes),
      indexed: mesh.indices !== undefined,
      materialSlots: mesh.materialSlots,
      materials,
      submeshes: mesh.submeshes,
      lods: mesh.lods,
      lodHysteresis: mesh.lodHysteresis,
    };
    return new MeshFrame(put(this.root, geometry, worldId, handle, 1));
  }

  without(worldId: number, handle: number): MeshFrame {
    return this.get(worldId, handle) === undefined
      ? this
      : new MeshFrame(remove(this.root, worldId, handle));
  }

  changesSince(
    previous: MeshFrame,
    visit: (before: MeshGeometry | undefined, after: MeshGeometry | undefined) => void,
  ): void {
    changes(previous.root, this.root, visit);
  }
}
