import { createBoxGeometry, meshFromInterleaved } from '@forgeax/engine-geometry';
import type { AreaBox, Point3 } from './gi-scene-area.fixture';
import { cookSceneMesh } from './gi-scene-curved.fixture';
import { sceneValue } from './gi-scene-value.fixture';

export const CONCAVE_BARS: readonly AreaBox[] = [
  { min: [-2, -2, -1.2], max: [-0.75, 2, -0.8], radiance: [0, 0, 0] },
  { min: [0.75, -2, -1.2], max: [2, 2, -0.8], radiance: [0, 0, 0] },
  { min: [-0.75, -2, -1.2], max: [0.75, -0.75, -0.8], radiance: [0, 0, 0] },
  { min: [-0.75, 0.75, -1.2], max: [0.75, 2, -0.8], radiance: [0, 0, 0] },
];
export const CONCAVE_SOURCE: AreaBox = {
  min: [-2, -2, 0.65],
  max: [2, 2, 0.9],
  radiance: [0.8, 0.3, 0.5],
};

/** Project both aperture depth planes onto the emitter's visible back face.
 * The full finite emitter is inside the outer frame's angular silhouette for
 * these receivers, so every unblocked segment must cross the actual hole. */
export function aperturePolygon(point: Point3): Point3[] {
  const lo = [-2, -2],
    hi = [2, 2];
  for (const z of [-1.2, -0.8]) {
    const t = (z - point[2]) / (CONCAVE_SOURCE.min[2] - point[2]);
    for (let axis = 0; axis < 2; axis++) {
      lo[axis] = Math.max(sceneValue(lo[axis]), (-0.75 - (1 - t) * sceneValue(point[axis])) / t);
      hi[axis] = Math.min(sceneValue(hi[axis]), (0.75 - (1 - t) * sceneValue(point[axis])) / t);
    }
  }
  return [
    [sceneValue(lo[0]), sceneValue(lo[1]), 0.65],
    [sceneValue(hi[0]), sceneValue(lo[1]), 0.65],
    [sceneValue(hi[0]), sceneValue(hi[1]), 0.65],
    [sceneValue(lo[0]), sceneValue(hi[1]), 0.65],
  ];
}

/** One concave MeshAsset with an actual through-hole, not four scene instances. */
export async function concaveFrame() {
  const vertices: number[] = [],
    indices: number[] = [];
  for (const bar of CONCAVE_BARS) {
    const size = bar.max.map((v, i) => v - sceneValue(bar.min[i])) as [number, number, number];
    const center = bar.min.map((v, i) => (v + sceneValue(bar.max[i])) / 2) as [
      number,
      number,
      number,
    ];
    const mesh = createBoxGeometry(...size).unwrap(),
      base = vertices.length / 8;
    if (!mesh.indices) throw new Error('Box must have actual indices');
    for (let vertex = 0; vertex < mesh.vertices.length / 12; vertex++) {
      const row = vertex * 12;
      vertices.push(
        sceneValue(mesh.vertices[row]) + center[0],
        sceneValue(mesh.vertices[row + 1]) + center[1],
        sceneValue(mesh.vertices[row + 2]) + center[2],
        ...mesh.vertices.subarray(row + 3, row + 8),
      );
    }
    for (const index of mesh.indices) indices.push(index + base);
  }
  return cookSceneMesh(
    meshFromInterleaved(new Float32Array(vertices), new Uint32Array(indices)).unwrap(),
    0.125,
  );
}
