import { box3 } from '@forgeax/engine-math';
import type { RenderableSnapshot } from '../render-system-extract';
import type { MeshFrame, MeshGeometry } from './mesh-frame';

/** Conservative proof over this cull's actual residual bounds and Mesh reads. */
export class ResidualBoundsProof {
  private extent: box3.Box3 | undefined;
  private meshReads: WeakSet<MeshGeometry> | undefined;

  constructor(previous?: ResidualBoundsProof) {
    this.extent =
      previous === undefined || previous.extent !== undefined ? box3.create() : undefined;
    if (previous?.extent !== undefined) this.extent?.set(previous.extent);
    // Extra historical dependencies can only force another full test. Weak
    // canonical keys do not retain retired Mesh versions or source rows.
    this.meshReads = previous === undefined ? new WeakSet() : previous.meshReads;
  }

  record(source: RenderableSnapshot, meshes: MeshFrame, bounds?: box3.Box3): void {
    if (
      source.assetHandle !== undefined &&
      source.generatedMesh === undefined &&
      source.terrainSection === undefined
    ) {
      const mesh = meshes.get(source.worldId, source.assetHandle);
      if (mesh === undefined) this.meshReads = undefined;
      else this.meshReads?.add(mesh);
    }
    const extent = this.extent;
    if (extent === undefined || bounds === undefined) return;
    for (let axis = 0; axis < 3; axis++) {
      const min = bounds[axis] as number;
      const max = bounds[axis + 3] as number;
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        this.extent = undefined;
        return;
      }
      extent[axis] = Math.min(extent[axis] as number, min);
      extent[axis + 3] = Math.max(extent[axis + 3] as number, max);
    }
  }

  meshesUnchanged(previous: MeshFrame, current: MeshFrame): boolean {
    if (previous === current) return true;
    const reads = this.meshReads;
    if (reads === undefined) return false;
    let same = true;
    current.changesSince(previous, (left) => {
      if (left !== undefined && reads.has(left)) same = false;
    });
    return same;
  }

  /** One camera enclosing the whole box proves every bounded residual visible. */
  enclosed(planes: readonly Float32Array[]): boolean {
    if (planes.length === 0 || planes.some((camera) => camera.length === 0)) return true;
    const extent = this.extent;
    if (extent === undefined) return false;
    // No bounded rows: unchanged unknown bounds stay conservatively visible.
    if ((extent[0] as number) > (extent[3] as number)) return true;
    return planes.some((camera) => this.inside(camera, extent));
  }

  private inside(planes: Float32Array, extent: box3.Box3): boolean {
    for (let at = 0; at < planes.length; at += 4) {
      const nx = planes[at] as number;
      const ny = planes[at + 1] as number;
      const nz = planes[at + 2] as number;
      // Negative-most corner, with the same arithmetic order as intersectsBox.
      // A boundary or NaN that cannot prove containment takes the ordinary test.
      const x = extent[nx >= 0 ? 0 : 3] as number;
      const y = extent[ny >= 0 ? 1 : 4] as number;
      const z = extent[nz >= 0 ? 2 : 5] as number;
      if (!(nx * x + ny * y + nz * z + (planes[at + 3] as number) >= 0)) return false;
    }
    return true;
  }
}
