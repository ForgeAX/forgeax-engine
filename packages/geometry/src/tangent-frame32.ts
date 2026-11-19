/** A complete orthonormal tangent frame in 32 bits: oct11x2, diamond9,
 * and the original bitangent orientation in bit 31. CPU and shader decoders
 * use the quantized normal to construct the same Duff basis. */
export function decodeTangentFrame32(word: number, out: Float32Array | number[], offset = 0): void {
  let nx = ((word & 2047) / 2047) * 2 - 1;
  let ny = (((word >>> 11) & 2047) / 2047) * 2 - 1;
  let nz = 1 - Math.abs(nx) - Math.abs(ny);
  const fold = Math.max(-nz, 0);
  nx += nx >= 0 ? -fold : fold;
  ny += ny >= 0 ? -fold : fold;
  const inverse = 1 / Math.hypot(nx, ny, nz);
  nx *= inverse;
  ny *= inverse;
  nz *= inverse;
  const sign = nz >= 0 ? 1 : -1,
    a = -1 / (sign + nz),
    b = nx * ny * a;
  const ax = 1 + sign * nx * nx * a,
    ay = sign * b,
    az = -sign * nx;
  const bx = b,
    by = sign + ny * ny * a,
    bz = -ny;
  const diamond = ((word >>> 22) & 511) / 512;
  const x = diamond < 0.5 ? 1 - 4 * diamond : 4 * diamond - 3;
  const y = (1 - Math.abs(x)) * (diamond < 0.5 ? 1 : -1);
  const scale = 1 / Math.hypot(x, y);
  out[offset] = nx;
  out[offset + 1] = ny;
  out[offset + 2] = nz;
  out[offset + 3] = (ax * x + bx * y) * scale;
  out[offset + 4] = (ay * x + by * y) * scale;
  out[offset + 5] = (az * x + bz * y) * scale;
  out[offset + 6] = word >>> 31 ? -1 : 1;
}

/** Scalar encode with no temporary vectors or retained numeric mirrors.
 * Tangents are projected onto the reconstructed normal's plane, not the
 * original normal's basis; this avoids basis-boundary flips after quantization. */
export function encodeTangentFrame32(
  nx: number,
  ny: number,
  nz: number,
  tx: number,
  ty: number,
  tz: number,
  handedness: number,
): number {
  const normalLength = Math.hypot(nx, ny, nz);
  if (
    !Number.isFinite(normalLength) ||
    normalLength === 0 ||
    !Number.isFinite(tx) ||
    !Number.isFinite(ty) ||
    !Number.isFinite(tz) ||
    (handedness !== 1 && handedness !== -1)
  )
    throw new RangeError(
      'Tangent frame requires a finite nonzero normal, tangent and orientation +/-1',
    );
  nx /= normalLength;
  ny /= normalLength;
  nz /= normalLength;
  const projection = nx * tx + ny * ty + nz * tz;
  tx -= nx * projection;
  ty -= ny * projection;
  tz -= nz * projection;
  if (Math.hypot(tx, ty, tz) < 1e-12)
    throw new RangeError('Tangent frame requires a nonzero normal-plane tangent');
  const l1 = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
  let u = nx / l1,
    v = ny / l1;
  if (nz < 0) {
    const previous = u;
    u = (1 - Math.abs(v)) * (previous >= 0 ? 1 : -1);
    v = (1 - Math.abs(previous)) * (v >= 0 ? 1 : -1);
  }
  const qu = Math.max(0, Math.min(2047, Math.round((u * 0.5 + 0.5) * 2047)));
  const qv = Math.max(0, Math.min(2047, Math.round((v * 0.5 + 0.5) * 2047)));
  nx = (qu / 2047) * 2 - 1;
  ny = (qv / 2047) * 2 - 1;
  nz = 1 - Math.abs(nx) - Math.abs(ny);
  const fold = Math.max(-nz, 0);
  nx += nx >= 0 ? -fold : fold;
  ny += ny >= 0 ? -fold : fold;
  const inverse = 1 / Math.hypot(nx, ny, nz);
  nx *= inverse;
  ny *= inverse;
  nz *= inverse;
  const sign = nz >= 0 ? 1 : -1,
    a = -1 / (sign + nz),
    b = nx * ny * a;
  const x = tx * (1 + sign * nx * nx * a) + ty * sign * b - tz * sign * nx;
  const y = tx * b + ty * (sign + ny * ny * a) - tz * ny;
  const length = Math.abs(x) + Math.abs(y);
  if (!Number.isFinite(length) || length < 1e-12)
    throw new RangeError('Tangent frame requires a nonzero normal-plane tangent');
  const diamond = y >= 0 ? (1 - x / length) * 0.25 : (3 + x / length) * 0.25;
  const qt = Math.round(diamond * 512) & 511;
  return (qu | (qv << 11) | (qt << 22) | (handedness < 0 ? 0x80000000 : 0)) >>> 0;
}
