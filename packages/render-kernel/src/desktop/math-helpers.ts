// Pure allocation-explicit matrix and vertex-packing helpers for DesktopNativeSceneRenderer.

const DESKTOP_VERTEX_STRIDE_FLOATS = 12;
const DESKTOP_SKINNED_VERTEX_STRIDE_FLOATS = 20;

/** Column-major WebGPU [0, 1] NDC perspective projection matrix. */
export function desktopMat4Perspective(
  fovRad: number,
  aspect: number,
  near: number,
  far: number,
  out: Float32Array,
): Float32Array {
  const f = 1 / Math.tan(fovRad * 0.5);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / Math.max(aspect, 1e-4);
  out[5] = f;
  out[10] = far * nf;
  out[11] = -1;
  out[14] = far * near * nf;
  return out;
}

/** Column-major WebGPU [0, 1] NDC orthographic projection matrix. */
export function desktopMat4Ortho(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
  out: Float32Array,
): Float32Array {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = -2 * lr;
  out[5] = -2 * bt;
  out[10] = nf;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = near * nf;
  out[15] = 1;
  return out;
}

/** Column-major right-handed look-at view matrix. */
export function desktopMat4LookAt(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
  out: Float32Array,
): Float32Array {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zLen = Math.hypot(zx, zy, zz) || 1;
  zx /= zLen;
  zy /= zLen;
  zz /= zLen;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  let xLen = Math.hypot(xx, xy, xz);
  if (xLen < 1e-6) {
    xx = 1;
    xy = 0;
    xz = 0;
    xLen = 1;
  } else {
    xx /= xLen;
    xy /= xLen;
    xz /= xLen;
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

/** Column-major 4x4 matrix multiply `out = a * b` (safe when `out` is distinct from `a` and `b`). */
export function desktopMat4Multiply(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float32Array,
): Float32Array {
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4 + 0] as number;
    const b1 = b[col * 4 + 1] as number;
    const b2 = b[col * 4 + 2] as number;
    const b3 = b[col * 4 + 3] as number;
    out[col * 4 + 0] =
      (a[0] as number) * b0 +
      (a[4] as number) * b1 +
      (a[8] as number) * b2 +
      (a[12] as number) * b3;
    out[col * 4 + 1] =
      (a[1] as number) * b0 +
      (a[5] as number) * b1 +
      (a[9] as number) * b2 +
      (a[13] as number) * b3;
    out[col * 4 + 2] =
      (a[2] as number) * b0 +
      (a[6] as number) * b1 +
      (a[10] as number) * b2 +
      (a[14] as number) * b3;
    out[col * 4 + 3] =
      (a[3] as number) * b0 +
      (a[7] as number) * b1 +
      (a[11] as number) * b2 +
      (a[15] as number) * b3;
  }
  return out;
}

/** Inverts a general 4x4 column-major matrix (used to derive view matrix from camera GlobalTransform.world). */
export function desktopMat4Invert(m: ArrayLike<number>, out: Float32Array): Float32Array {
  const a00 = m[0] as number;
  const a01 = m[1] as number;
  const a02 = m[2] as number;
  const a03 = m[3] as number;
  const a10 = m[4] as number;
  const a11 = m[5] as number;
  const a12 = m[6] as number;
  const a13 = m[7] as number;
  const a20 = m[8] as number;
  const a21 = m[9] as number;
  const a22 = m[10] as number;
  const a23 = m[11] as number;
  const a30 = m[12] as number;
  const a31 = m[13] as number;
  const a32 = m[14] as number;
  const a33 = m[15] as number;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) {
    out.fill(0);
    out[0] = 1;
    out[5] = 1;
    out[10] = 1;
    out[15] = 1;
    return out;
  }
  const invDet = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * invDet;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * invDet;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * invDet;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * invDet;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * invDet;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * invDet;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * invDet;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * invDet;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
  return out;
}

function writeFallbackTangent(
  nx: number,
  ny: number,
  nz: number,
  out: Float32Array,
  offset: number,
): void {
  let tx: number;
  let ty: number;
  let tz: number;
  if (Math.abs(ny) < 0.99) {
    tx = nz;
    ty = 0;
    tz = -nx;
  } else {
    tx = 1;
    ty = 0;
    tz = 0;
  }
  const len = Math.hypot(tx, ty, tz);
  if (len > 1e-6) {
    out[offset] = tx / len;
    out[offset + 1] = ty / len;
    out[offset + 2] = tz / len;
  } else {
    out[offset] = 1;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
  }
  out[offset + 3] = 1;
}

function writeBaseVertexAttributes(
  out: Float32Array,
  base: number,
  i: number,
  px: number,
  py: number,
  pz: number,
  normals: ArrayLike<number> | undefined,
  uvs: ArrayLike<number> | undefined,
  tangents: ArrayLike<number> | undefined,
): void {
  let nx = 0;
  let ny = 1;
  let nz = 0;
  if (normals !== undefined) {
    nx = (normals[i * 3 + 0] as number | undefined) ?? 0;
    ny = (normals[i * 3 + 1] as number | undefined) ?? 1;
    nz = (normals[i * 3 + 2] as number | undefined) ?? 0;
  }
  let u = 0;
  let v = 0;
  if (uvs !== undefined) {
    u = (uvs[i * 2 + 0] as number | undefined) ?? 0;
    v = (uvs[i * 2 + 1] as number | undefined) ?? 0;
  }
  out[base + 0] = px;
  out[base + 1] = py;
  out[base + 2] = pz;
  out[base + 3] = nx;
  out[base + 4] = ny;
  out[base + 5] = nz;
  out[base + 6] = u;
  out[base + 7] = v;
  if (tangents !== undefined && i * 4 + 3 < tangents.length) {
    out[base + 8] = tangents[i * 4 + 0] as number;
    out[base + 9] = tangents[i * 4 + 1] as number;
    out[base + 10] = tangents[i * 4 + 2] as number;
    out[base + 11] = tangents[i * 4 + 3] as number;
  } else {
    writeFallbackTangent(nx, ny, nz, out, base + 8);
  }
}

function writeSkinnedVertexAttributes(
  out: Float32Array,
  base: number,
  i: number,
  skinIndices: ArrayLike<number> | undefined,
  skinWeights: ArrayLike<number> | undefined,
): void {
  if (skinIndices !== undefined) {
    out[base + 12] = (skinIndices[i * 4 + 0] as number | undefined) ?? 0;
    out[base + 13] = (skinIndices[i * 4 + 1] as number | undefined) ?? 0;
    out[base + 14] = (skinIndices[i * 4 + 2] as number | undefined) ?? 0;
    out[base + 15] = (skinIndices[i * 4 + 3] as number | undefined) ?? 0;
  } else {
    out[base + 12] = 0;
    out[base + 13] = 0;
    out[base + 14] = 0;
    out[base + 15] = 0;
  }
  let w0 = 1;
  let w1 = 0;
  let w2 = 0;
  let w3 = 0;
  if (skinWeights !== undefined) {
    w0 = (skinWeights[i * 4 + 0] as number | undefined) ?? 1;
    w1 = (skinWeights[i * 4 + 1] as number | undefined) ?? 0;
    w2 = (skinWeights[i * 4 + 2] as number | undefined) ?? 0;
    w3 = (skinWeights[i * 4 + 3] as number | undefined) ?? 0;
  }
  const wSum = w0 + w1 + w2 + w3;
  if (wSum > 1e-6) {
    out[base + 16] = w0 / wSum;
    out[base + 17] = w1 / wSum;
    out[base + 18] = w2 / wSum;
    out[base + 19] = w3 / wSum;
  } else {
    out[base + 16] = 1;
    out[base + 17] = 0;
    out[base + 18] = 0;
    out[base + 19] = 0;
  }
}

/**
 * Packs separate position(3), optional normal(3), optional uv(2), and optional tangent(4) buffers
 * into the canonical 48-byte interleaved vertex layout consumed by DesktopNativeSceneRenderer.
 */
export function packDesktopMeshVertices(
  positions: ArrayLike<number>,
  normals?: ArrayLike<number> | undefined,
  uvs?: ArrayLike<number> | undefined,
  tangents?: ArrayLike<number> | undefined,
): {
  readonly vertices: Float32Array;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
} {
  const vertexCount = Math.floor(positions.length / 3);
  const vertices = new Float32Array(vertexCount * DESKTOP_VERTEX_STRIDE_FLOATS);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < vertexCount; i++) {
    const px = positions[i * 3 + 0] as number;
    const py = positions[i * 3 + 1] as number;
    const pz = positions[i * 3 + 2] as number;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;

    writeBaseVertexAttributes(
      vertices,
      i * DESKTOP_VERTEX_STRIDE_FLOATS,
      i,
      px,
      py,
      pz,
      normals,
      uvs,
      tangents,
    );
  }

  if (vertexCount === 0) {
    return { vertices, boundsMin: [0, 0, 0], boundsMax: [0, 0, 0] };
  }
  return {
    vertices,
    boundsMin: [minX, minY, minZ],
    boundsMax: [maxX, maxY, maxZ],
  };
}

/**
 * Packs position(3) + normal(3) + uv(2) + tangent(4) + skinIndices(4) + skinWeights(4)
 * into the canonical 80-byte interleaved skinned vertex layout (`skinned: true`).
 */
export function packDesktopSkinnedMeshVertices(
  positions: ArrayLike<number>,
  normals?: ArrayLike<number> | undefined,
  uvs?: ArrayLike<number> | undefined,
  tangents?: ArrayLike<number> | undefined,
  skinIndices?: ArrayLike<number> | undefined,
  skinWeights?: ArrayLike<number> | undefined,
): {
  readonly vertices: Float32Array;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
} {
  const vertexCount = Math.floor(positions.length / 3);
  const vertices = new Float32Array(vertexCount * DESKTOP_SKINNED_VERTEX_STRIDE_FLOATS);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < vertexCount; i++) {
    const px = positions[i * 3 + 0] as number;
    const py = positions[i * 3 + 1] as number;
    const pz = positions[i * 3 + 2] as number;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;

    const base = i * DESKTOP_SKINNED_VERTEX_STRIDE_FLOATS;
    writeBaseVertexAttributes(vertices, base, i, px, py, pz, normals, uvs, tangents);
    writeSkinnedVertexAttributes(vertices, base, i, skinIndices, skinWeights);
  }

  if (vertexCount === 0) {
    return { vertices, boundsMin: [0, 0, 0], boundsMax: [0, 0, 0] };
  }
  return {
    vertices,
    boundsMin: [minX, minY, minZ],
    boundsMax: [maxX, maxY, maxZ],
  };
}
