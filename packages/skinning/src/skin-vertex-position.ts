/**
 * Blend one four-influence vertex into homogeneous world coordinates (XYZW).
 * Palette entries are jointWorld × inverseBindMatrix. Weights are never
 * normalized and zero-weight lanes still require valid joint indices.
 * Callers admit complete streams and a four-double output buffer once, before
 * the vertex loop. The kernel validates the current position/influences; callers
 * own output finiteness, rounding and projection.
 */
export function skinVertexPosition(
  out: Float64Array,
  positions: Float32Array,
  indices: Uint16Array,
  weights: Float32Array,
  palette: Float32Array,
  vertex: number,
): boolean {
  const jointCount = palette.length / 16;
  const x = positions[vertex * 3] as number;
  const y = positions[vertex * 3 + 1] as number;
  const z = positions[vertex * 3 + 2] as number;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  let pointX = 0,
    pointY = 0,
    pointZ = 0;
  let homogeneousWeight = 0;
  for (let lane = 0; lane < 4; lane++) {
    const influence = vertex * 4 + lane;
    const joint = indices[influence] as number;
    const weight = weights[influence] as number;
    if (joint >= jointCount || !Number.isFinite(weight)) return false;
    if (weight === 0) continue;
    const base = joint * 16;
    homogeneousWeight +=
      weight *
      ((palette[base + 3] as number) * x +
        (palette[base + 7] as number) * y +
        (palette[base + 11] as number) * z +
        (palette[base + 15] as number));
    pointX +=
      weight *
      ((palette[base] as number) * x +
        (palette[base + 4] as number) * y +
        (palette[base + 8] as number) * z +
        (palette[base + 12] as number));
    pointY +=
      weight *
      ((palette[base + 1] as number) * x +
        (palette[base + 5] as number) * y +
        (palette[base + 9] as number) * z +
        (palette[base + 13] as number));
    pointZ +=
      weight *
      ((palette[base + 2] as number) * x +
        (palette[base + 6] as number) * y +
        (palette[base + 10] as number) * z +
        (palette[base + 14] as number));
  }
  out[0] = pointX;
  out[1] = pointY;
  out[2] = pointZ;
  out[3] = homogeneousWeight;
  return true;
}
