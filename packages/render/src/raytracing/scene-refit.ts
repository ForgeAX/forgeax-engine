import { RAY_ATTRIBUTE_TRIANGLE_STRIDE, type RaySurfaceScene } from './attributes';
import { RAY_NODE_STRIDE, RAY_TRIANGLE_STRIDE } from './scene';

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const key = (bytes: DataView, triangle: number) =>
  `${bytes.getUint32(triangle * RAY_TRIANGLE_STRIDE + 48, true)}:${bytes.getUint32(triangle * RAY_TRIANGLE_STRIDE + 56, true)}`;

export interface RayTrianglePatch {
  readonly source: RaySurfaceScene;
  /** Local BVH triangle address -> the retained BVH triangle address. */
  readonly targets: readonly number[];
  readonly materials: readonly number[];
}

/** Physical addresses derived once from the cold BVH, never a second source-row catalogue. */
export class RaySceneRefit {
  readonly #triangles = new Map<string, number>();
  readonly #rows = new Map<number, number[]>();
  readonly #leaves: Int32Array;
  readonly #parents: Int32Array;

  constructor(
    private readonly scene: RaySurfaceScene,
    surfaceRecords: Uint32Array,
  ) {
    const triangles = view(scene.triangles);
    for (let i = 0; i < scene.triangleCount; i++) {
      this.#triangles.set(key(triangles, i), i);
      const instance = triangles.getUint32(i * RAY_TRIANGLE_STRIDE + 48, true);
      const slot = surfaceRecords[(instance - 1) * 16] as number;
      let addresses = this.#rows.get(slot);
      if (addresses === undefined) {
        addresses = [];
        this.#rows.set(slot, addresses);
      }
      addresses.push(i);
    }
    this.#leaves = new Int32Array(scene.triangleCount);
    this.#parents = new Int32Array(scene.nodes.byteLength / RAY_NODE_STRIDE).fill(-1);
    const nodes = view(scene.nodes);
    for (let i = 0; i < this.#parents.length; i++) {
      const at = i * RAY_NODE_STRIDE;
      const count = nodes.getUint32(at + 32, true);
      if (count > 0) {
        const first = nodes.getUint32(at + 28, true);
        this.#leaves.fill(i, first, first + count);
      } else {
        this.#parents[i + 1] = i;
        this.#parents[nodes.getUint32(at + 36, true)] = i;
      }
    }
  }

  /** Validate every address before the accepted scene is mutated. Shape changes rebuild cold. */
  patch(
    slot: number,
    source: RaySurfaceScene,
    materials: readonly number[],
  ): RayTrianglePatch | undefined {
    const expected = this.#rows.get(slot);
    if (source.triangleCount !== (expected?.length ?? 0)) return undefined;
    const triangles = view(source.triangles);
    const targets: number[] = [];
    const membership = new Set(expected);
    for (let i = 0; i < source.triangleCount; i++) {
      const target = this.#triangles.get(key(triangles, i));
      if (target === undefined || !membership.delete(target)) return undefined;
      targets.push(target);
    }
    return { source, targets, materials };
  }

  /** Apply already validated triangles, then refit affected leaves and their ancestors once. */
  apply(patches: readonly RayTrianglePatch[]): {
    triangles: readonly number[];
    nodes: readonly number[];
  } {
    const changed: number[] = [];
    const dirty = new Set<number>();
    const triangles = view(this.scene.triangles);
    for (const patch of patches) {
      const source = view(patch.source.triangles);
      for (let i = 0; i < patch.targets.length; i++) {
        const target = patch.targets[i] as number;
        const at = target * RAY_TRIANGLE_STRIDE;
        this.scene.triangles.set(
          patch.source.triangles.subarray(i * RAY_TRIANGLE_STRIDE, (i + 1) * RAY_TRIANGLE_STRIDE),
          at,
        );
        triangles.setUint32(
          at + 60,
          patch.materials[source.getUint32(i * RAY_TRIANGLE_STRIDE + 60, true)] as number,
          true,
        );
        this.scene.attributes.set(
          patch.source.attributes.subarray(
            i * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
            (i + 1) * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
          ),
          target * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
        );
        changed.push(target);
        let node = this.#leaves[target] as number;
        while (node !== -1 && !dirty.has(node)) {
          dirty.add(node);
          node = this.#parents[node] as number;
        }
      }
      const attributes = this.scene.instanceAttributes as Map<
        number,
        { uvCount: number; tangentFrame: boolean }
      >;
      for (const [id, value] of patch.source.instanceAttributes) attributes.set(id, value);
    }
    // Depth-first node addresses put every child after its parent.
    const nodes = [...dirty].sort((a, b) => b - a);
    for (const node of nodes) this.#refit(node);
    return { triangles: changed, nodes };
  }

  #refit(index: number): void {
    const nodes = view(this.scene.nodes);
    const triangles = view(this.scene.triangles);
    const at = index * RAY_NODE_STRIDE;
    const count = nodes.getUint32(at + 32, true);
    const first = nodes.getUint32(at + 28, true);
    for (let axis = 0; axis < 3; axis++) {
      let lo = Infinity;
      let hi = -Infinity;
      if (count > 0) {
        for (let triangle = first; triangle < first + count; triangle++) {
          for (let vertex = 0; vertex < 3; vertex++) {
            const value = triangles.getFloat32(
              triangle * RAY_TRIANGLE_STRIDE + vertex * 16 + axis * 4,
              true,
            );
            lo = Math.min(lo, value);
            hi = Math.max(hi, value);
          }
        }
      } else {
        for (const child of [index + 1, nodes.getUint32(at + 36, true)]) {
          lo = Math.min(lo, nodes.getFloat32(child * RAY_NODE_STRIDE + axis * 4, true));
          hi = Math.max(hi, nodes.getFloat32(child * RAY_NODE_STRIDE + 16 + axis * 4, true));
        }
      }
      nodes.setFloat32(at + axis * 4, lo, true);
      nodes.setFloat32(at + 16 + axis * 4, hi, true);
    }
  }
}
