// Deterministic flat-chart position fields for isolated integer-flow tests and examples.

import type { PositionField } from '../../src/quad/field.ts';
import type { TriMesh } from '../../src/quad/trimesh.ts';

export function alignedPositionField(mesh: TriMesh, scale = 0.1, perturb = 0): PositionField {
  const vertexCount = mesh.positions.length / 3;
  const normal = new Float64Array(3 * vertexCount);
  const direction = new Float64Array(3 * vertexCount);
  const origin = new Float64Array(3 * vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    normal[3 * vertex + 2] = 1;
    direction[3 * vertex] = 1;
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = mesh.positions[3 * vertex + axis] as number;
      const ripple = perturb * Math.sin(1.7 * vertex + axis);
      origin[3 * vertex + axis] = Math.round(coordinate / scale) * scale + ripple;
    }
  }
  return {
    orientation: {
      site: 'vertex',
      mesh,
      normal,
      direction,
      fixed: new Uint8Array(vertexCount),
      singularities: [],
    },
    scale,
    origin,
    vertexSource: Uint32Array.from({ length: vertexCount }, (_, i) => i),
  };
}
