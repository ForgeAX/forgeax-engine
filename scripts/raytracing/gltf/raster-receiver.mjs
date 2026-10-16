/** Offline raster witness. The default grid was measured on SwiftShader;
 * another grid requires independent backend evidence. This is not an Engine
 * visibility buffer and does not establish a unique identity at shared edges. */
export function rasterTriangleWitness(vertices, sample, frame, grid = 16) {
  const projected = vertices.map((position) => {
    const q = [0, 1, 2, 3].map((r) =>
      position.reduce(
        (sum, v, c) => sum + v * frame.viewProjection[c * 4 + r],
        frame.viewProjection[12 + r],
      ),
    );
    return [
      Math.round(((q[0] / q[3] + 1) * frame.width * grid) / 2) / grid,
      Math.round(((1 - q[1] / q[3]) * frame.height * grid) / 2) / grid,
      q[2] / q[3],
      q[3],
    ];
  });
  return triangleWitness(vertices, projected, sample, frame);
}

function triangleWitness(vertices, projected, sample, frame) {
  if (projected.some((p) => p === null)) return null;
  const [A, B, C] = projected,
    X = sample.x + 0.5,
    Y = sample.y + 0.5;

  const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
  if (det === 0) return null;
  const u = ((B[1] - C[1]) * (X - C[0]) + (C[0] - B[0]) * (Y - C[1])) / det;
  const v = ((C[1] - A[1]) * (X - C[0]) + (A[0] - C[0]) * (Y - C[1])) / det;

  const error = Math.abs(u * A[2] + v * B[2] + (1 - u - v) * C[2] - sample.depth);
  const weights = [u / A[3], v / B[3], (1 - u - v) / C[3]],
    total = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0 || Math.min(...weights.map((v) => v / total)) < -1e-6)
    return null;
  const position = [0, 1, 2].map((c) =>
    vertices.reduce((sum, p, i) => sum + (p[c] * weights[i]) / total, 0),
  );
  const ab = vertices[1].map((v, c) => v - vertices[0][c]),
    ac = vertices[2].map((v, c) => v - vertices[0][c]);
  let normal = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  normal = normal.map((v) => v / Math.hypot(...normal));
  if (normal.reduce((sum, v, c) => sum + v * (frame.eye[c] - position[c]), 0) < 0)
    normal = normal.map((v) => -v);
  return { error, position, normal };
}
