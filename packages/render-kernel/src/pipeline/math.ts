// Allocation-explicit 3D matrix and mesh-packing helpers for KernelStandardSceneRenderer.
// Follows AGENTS.md required-output convention (never defaults `out = new Float32Array(...)`).

/** Column-major WebGPU [0, 1] NDC perspective projection matrix. */
export function kernelMat4Perspective(
  fovYRad: number,
  aspect: number,
  near: number,
  far: number,
  out: Float32Array,
): Float32Array {
  const f = 1.0 / Math.tan(fovYRad * 0.5);
  const nf = 1.0 / (near - far);
  out.fill(0, 0, 16);
  out[0] = f / Math.max(aspect, 1e-5);
  out[5] = f;
  out[10] = far * nf;
  out[11] = -1;
  out[14] = far * near * nf;
  return out;
}

/** Column-major WebGPU [0, 1] NDC orthographic projection matrix. */
export function kernelMat4Ortho(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
  out: Float32Array,
): Float32Array {
  const rl = 1 / (right - left);
  const tb = 1 / (top - bottom);
  const nf = 1 / (near - far);
  out.fill(0, 0, 16);
  out[0] = 2 * rl;
  out[5] = 2 * tb;
  out[10] = nf;
  out[12] = -(right + left) * rl;
  out[13] = -(top + bottom) * tb;
  out[14] = near * nf;
  out[15] = 1;
  return out;
}

/** Column-major right-handed look-at view matrix. */
export function kernelMat4LookAt(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
  out: Float32Array,
): Float32Array {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-6) {
    zz = 1;
    len = 1;
  }
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) {
    xx = 1;
    xy = 0;
    xz = 0;
  } else {
    xx /= len;
    xy /= len;
    xz /= len;
  }
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/** Column-major 4x4 matrix multiply (`out = a * b`). */
export function kernelMat4Multiply(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float32Array,
): Float32Array {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4] as number;
    const b1 = b[c * 4 + 1] as number;
    const b2 = b[c * 4 + 2] as number;
    const b3 = b[c * 4 + 3] as number;
    out[c * 4] =
      (a[0] as number) * b0 +
      (a[4] as number) * b1 +
      (a[8] as number) * b2 +
      (a[12] as number) * b3;
    out[c * 4 + 1] =
      (a[1] as number) * b0 +
      (a[5] as number) * b1 +
      (a[9] as number) * b2 +
      (a[13] as number) * b3;
    out[c * 4 + 2] =
      (a[2] as number) * b0 +
      (a[6] as number) * b1 +
      (a[10] as number) * b2 +
      (a[14] as number) * b3;
    out[c * 4 + 3] =
      (a[3] as number) * b0 +
      (a[7] as number) * b1 +
      (a[11] as number) * b2 +
      (a[15] as number) * b3;
  }
  return out;
}

/** Column-major 4x4 matrix inversion (`out = inv(m)`). */
export function kernelMat4Invert(m: ArrayLike<number>, out: Float32Array): Float32Array {
  const m00 = m[0] as number;
  const m01 = m[1] as number;
  const m02 = m[2] as number;
  const m03 = m[3] as number;
  const m10 = m[4] as number;
  const m11 = m[5] as number;
  const m12 = m[6] as number;
  const m13 = m[7] as number;
  const m20 = m[8] as number;
  const m21 = m[9] as number;
  const m22 = m[10] as number;
  const m23 = m[11] as number;
  const m30 = m[12] as number;
  const m31 = m[13] as number;
  const m32 = m[14] as number;
  const m33 = m[15] as number;

  const b00 = m00 * m11 - m01 * m10;
  const b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11;
  const b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30;
  const b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31;
  const b11 = m22 * m33 - m23 * m32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) {
    out.fill(0, 0, 16);
    out[0] = 1;
    out[5] = 1;
    out[10] = 1;
    out[15] = 1;
    return out;
  }
  det = 1 / det;
  out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * det;
  out[1] = (m02 * b10 - m01 * b11 - m03 * b09) * det;
  out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * det;
  out[3] = (m22 * b04 - m21 * b05 - m23 * b03) * det;
  out[4] = (m12 * b08 - m10 * b11 - m13 * b07) * det;
  out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * det;
  out[6] = (m32 * b02 - m30 * b05 - m33 * b01) * det;
  out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * det;
  out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * det;
  out[9] = (m01 * b08 - m00 * b10 - m03 * b06) * det;
  out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * det;
  out[11] = (m21 * b02 - m20 * b04 - m23 * b00) * det;
  out[12] = (m11 * b07 - m10 * b09 - m12 * b06) * det;
  out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * det;
  out[14] = (m31 * b01 - m30 * b03 - m32 * b00) * det;
  out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * det;
  return out;
}

/** Packs separate position/normal/uv/tangent streams into 12-float (48B) standard kernel vertices. */
export function packKernelMeshVertices(
  positions: ArrayLike<number>,
  normals?: ArrayLike<number> | undefined,
  uvs?: ArrayLike<number> | undefined,
  tangents?: ArrayLike<number> | undefined,
): Float32Array {
  const count = Math.floor(positions.length / 3);
  const out = new Float32Array(count * 12);
  for (let i = 0; i < count; i++) {
    const b = i * 12;
    const p = i * 3;
    out[b] = positions[p] as number;
    out[b + 1] = positions[p + 1] as number;
    out[b + 2] = positions[p + 2] as number;
    const nx = normals !== undefined ? (normals[p] as number) : 0;
    const ny = normals !== undefined ? (normals[p + 1] as number) : 1;
    const nz = normals !== undefined ? (normals[p + 2] as number) : 0;
    out[b + 3] = nx;
    out[b + 4] = ny;
    out[b + 5] = nz;
    out[b + 6] = uvs !== undefined ? (uvs[i * 2] as number) : 0;
    out[b + 7] = uvs !== undefined ? (uvs[i * 2 + 1] as number) : 0;
    if (tangents !== undefined && i * 4 + 3 < tangents.length) {
      out[b + 8] = tangents[i * 4] as number;
      out[b + 9] = tangents[i * 4 + 1] as number;
      out[b + 10] = tangents[i * 4 + 2] as number;
      out[b + 11] = tangents[i * 4 + 3] as number;
    } else {
      const refX = Math.abs(ny) < 0.9 ? 0 : 1;
      const refY = Math.abs(ny) < 0.9 ? 1 : 0;
      let tx = refY * nz;
      let ty = -refX * nz;
      let tz = refX * ny - refY * nx;
      const len = Math.hypot(tx, ty, tz);
      if (len > 1e-5) {
        tx /= len;
        ty /= len;
        tz /= len;
      } else {
        tx = 1;
        ty = 0;
        tz = 0;
      }
      out[b + 8] = tx;
      out[b + 9] = ty;
      out[b + 10] = tz;
      out[b + 11] = 1;
    }
  }
  return out;
}

/** Computes axis-aligned local bounds from interleaved vertices of the given float stride. */
export function computeInterleavedBounds(
  vertices: Float32Array,
  strideFloats: number,
): { readonly min: [number, number, number]; readonly max: [number, number, number] } {
  const count = Math.floor(vertices.length / strideFloats);
  if (count <= 0) {
    return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const b = i * strideFloats;
    const x = vertices[b] as number;
    const y = vertices[b + 1] as number;
    const z = vertices[b + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
