// @forgeax/engine-runtime - per-vertex tangent (vec4) helper (M4 / w20).
//
// Implements the path A formula (LearnOpenGL section 5.4 + glTF 2.0 vec4
// shape) for procedural geometry: per-triangle UV-derivative tangent ->
// face-area-weighted average -> Gram-Schmidt re-orthogonalisation against
// the supplied per-vertex normal -> handedness sign(det(deltaUV)) packed
// into the .w channel.
//
// Output shape: Float32Array (vertexCount * 4) where each vertex is
// [tx, ty, tz, w] with `.w` in {+1, -1}. The .w sign is forward-compatible
// with glTF 2.0 spec / MikkTSpace baker (`B = cross(N, T.xyz) * T.w`),
// satisfying feat-20260518 risk R-4 mitigation (path A vec4 -> path B
// shader consumption is a no-op switch).
//
// Plan-strategy anchors: section 2 D-2 (path A); D-7 (single-file helper to
// avoid 30-line per-geometry re-implementation -- SSOT #1 + DRY #2).
// Knowledge-base anchor: .forgeax-harness/knowledge-base/wiki/normal-mapping-and-tbn.md
// section 2 (math skeleton) and section 2.2 (per-vertex average +
// handedness). Risk anchor: R-4 (vec4 + .w forward compatibility).
//
// Pure function with shared Result/AssetError vocabulary and no mutable state
// or side effects. Indices may be Uint16Array, Uint32Array, or
// undefined (sequential 0..vertexCount-1 -- triangle list). Degenerate
// triangles (zero area UV; det ~ 0) are skipped from the accumulation;
// Inputs with no valid UV-derived triangle fail closed. Procedural pole/seam
// vertices may have no local contribution while sharing valid neighboring
// faces; they retain the established deterministic frame until the material
// admission layer has mesh-level tangent context.

import { ASSET_ERROR_HINTS, AssetError, err, ok, type Result } from '@forgeax/engine-types';

const EPSILON = 1e-8;

/** Write a finite unit tangent in the normal plane; leave output unchanged on failure.
 * Writes xyz only, so the producer retains its own handedness policy.
 */
export function writeNormalPlaneTangent(
  out: Float32Array,
  offset: number,
  nx: number,
  ny: number,
  nz: number,
): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > out.length - 3) return false;
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return false;
  const tx = Math.abs(nx) > Math.abs(nz) ? -ny : 0;
  const ty = Math.abs(nx) > Math.abs(nz) ? nx : -nz;
  const tz = Math.abs(nx) > Math.abs(nz) ? 0 : ny;
  const length = Math.hypot(tx, ty, tz);
  if (!(length > 0) || !Number.isFinite(length)) return false;
  out[offset] = tx / length;
  out[offset + 1] = ty / length;
  out[offset + 2] = tz / length;
  return true;
}

function tangentInputError(field: string, value: number, reason: string): AssetError {
  return new AssetError({
    code: 'asset-parse-failed',
    expected: `valid tangent topology: ${reason}`,
    hint: ASSET_ERROR_HINTS['asset-parse-failed'],
    detail: { field, value, reason },
  });
}

function preflightTangentInput(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices: Uint16Array | Uint32Array | undefined,
): Result<number, AssetError> {
  if (positions.length % 3 !== 0) {
    return err(
      tangentInputError(
        'positions',
        positions.length,
        'positions.length must be divisible by the position stride of 3',
      ),
    );
  }
  const vertexCount = positions.length / 3;
  if (normals.length !== vertexCount * 3) {
    return err(
      tangentInputError(
        'normals',
        normals.length,
        `normals.length must equal vertexCount * 3 (${vertexCount * 3})`,
      ),
    );
  }
  if (uvs.length !== vertexCount * 2) {
    return err(
      tangentInputError(
        'uvs',
        uvs.length,
        `uvs.length must equal vertexCount * 2 (${vertexCount * 2})`,
      ),
    );
  }
  if (indices === undefined) {
    if (vertexCount % 3 !== 0) {
      return err(
        tangentInputError(
          'positions',
          vertexCount,
          'non-indexed vertexCount must be divisible by the triangle size of 3',
        ),
      );
    }
    return ok(vertexCount);
  }
  if (indices.length % 3 !== 0) {
    return err(
      tangentInputError(
        'indices',
        indices.length,
        'indices.length must be divisible by the triangle size of 3',
      ),
    );
  }
  for (let indexPosition = 0; indexPosition < indices.length; indexPosition++) {
    const index = indices[indexPosition];
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= vertexCount) {
      return err(
        tangentInputError(
          'indices',
          index ?? -1,
          `indices[${indexPosition}] must be an integer in [0, ${vertexCount})`,
        ),
      );
    }
  }
  return ok(vertexCount);
}

/**
 * Compute per-vertex tangent (vec4) for a procedural mesh using path A
 * (UV-derivative + face-area-weighted average + Gram-Schmidt + handedness).
 *
 * @param positions Float32Array, vertexCount * 3 (xyz interleaved).
 * @param normals Float32Array, vertexCount * 3 (xyz interleaved); must be
 *   pre-normalised by the caller (procedural factories already produce
 *   unit-length normals at vertex emit time).
 * @param uvs Float32Array, vertexCount * 2 (uv interleaved).
 * @param indices optional Uint16Array | Uint32Array triangle list; when
 *   undefined, sequential triangulation 0,1,2,3,4,5,... is assumed.
 * @returns `Result<Float32Array, AssetError>` with a Float32Array of
 *   vertexCount * 4 on success. `.xyz` is the tangent and `.w` is the
 *   handedness sign in {+1, -1}; malformed topology returns the existing
 *   `asset-parse-failed` AssetError before working or output buffers exist.
 *
 * @remarks
 * Path A formula (per triangle):
 * ```
 * dP1 = p2 - p1; dP2 = p3 - p1
 * dUV1 = uv2 - uv1; dUV2 = uv3 - uv1
 * det = dUV1.u * dUV2.v - dUV2.u * dUV1.v
 * T_face = (dUV2.v * dP1 - dUV1.v * dP2) / det
 * sign = det >= 0 ? +1 : -1
 * ```
 * Per-vertex aggregation: accumulate `T_face * faceArea` into the three
 * vertices of the triangle; accumulate `sign` (the dominant sign per
 * vertex wins). After accumulation: Gram-Schmidt against the supplied
 * normal `T' = normalize(T - dot(T, N) * N)`; repack as vec4 with the
 * dominant handedness sign.
 */
export function computeTangentVec4(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices?: Uint16Array | Uint32Array,
): Result<Float32Array, AssetError> {
  const preflight = preflightTangentInput(positions, normals, uvs, indices);
  if (!preflight.ok) return preflight;
  const vertexCount = preflight.value;

  // Working buffers: per-vertex accumulated tangent + accumulated handedness
  // signed weight (sum of (face area * sign(det))). The dominant sign of
  // the running sum is the per-vertex .w handedness.
  const accumT = new Float32Array(vertexCount * 3);
  const accumSign = new Float32Array(vertexCount);
  let validTriangleCount = 0;

  const triangleCount = indices !== undefined ? indices.length / 3 : vertexCount / 3;

  for (let tri = 0; tri < triangleCount; tri++) {
    const i0 = indices !== undefined ? (indices[tri * 3] ?? 0) : tri * 3;
    const i1 = indices !== undefined ? (indices[tri * 3 + 1] ?? 0) : tri * 3 + 1;
    const i2 = indices !== undefined ? (indices[tri * 3 + 2] ?? 0) : tri * 3 + 2;

    const p0x = positions[i0 * 3] ?? 0;
    const p0y = positions[i0 * 3 + 1] ?? 0;
    const p0z = positions[i0 * 3 + 2] ?? 0;
    const p1x = positions[i1 * 3] ?? 0;
    const p1y = positions[i1 * 3 + 1] ?? 0;
    const p1z = positions[i1 * 3 + 2] ?? 0;
    const p2x = positions[i2 * 3] ?? 0;
    const p2y = positions[i2 * 3 + 1] ?? 0;
    const p2z = positions[i2 * 3 + 2] ?? 0;

    const u0 = uvs[i0 * 2] ?? 0;
    const v0 = uvs[i0 * 2 + 1] ?? 0;
    const u1 = uvs[i1 * 2] ?? 0;
    const v1 = uvs[i1 * 2 + 1] ?? 0;
    const u2 = uvs[i2 * 2] ?? 0;
    const v2 = uvs[i2 * 2 + 1] ?? 0;

    const dP1x = p1x - p0x;
    const dP1y = p1y - p0y;
    const dP1z = p1z - p0z;
    const dP2x = p2x - p0x;
    const dP2y = p2y - p0y;
    const dP2z = p2z - p0z;

    const dU1 = u1 - u0;
    const dV1 = v1 - v0;
    const dU2 = u2 - u0;
    const dV2 = v2 - v0;

    const det = dU1 * dV2 - dU2 * dV1;
    if (Math.abs(det) < EPSILON) {
      // degenerate UV (collinear / zero-area in UV space); skip
      continue;
    }
    const invDet = 1 / det;
    const tx = invDet * (dV2 * dP1x - dV1 * dP2x);
    const ty = invDet * (dV2 * dP1y - dV1 * dP2y);
    const tz = invDet * (dV2 * dP1z - dV1 * dP2z);

    // Face area (cross product magnitude / 2). Used as accumulation weight.
    const cx = dP1y * dP2z - dP1z * dP2y;
    const cy = dP1z * dP2x - dP1x * dP2z;
    const cz = dP1x * dP2y - dP1y * dP2x;
    const faceArea = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (faceArea < EPSILON) continue;
    validTriangleCount += 1;

    const signDet = det >= 0 ? 1 : -1;
    const signedWeight = faceArea * signDet;

    for (const vi of [i0, i1, i2]) {
      accumT[vi * 3] = (accumT[vi * 3] ?? 0) + tx * faceArea;
      accumT[vi * 3 + 1] = (accumT[vi * 3 + 1] ?? 0) + ty * faceArea;
      accumT[vi * 3 + 2] = (accumT[vi * 3 + 2] ?? 0) + tz * faceArea;
      accumSign[vi] = (accumSign[vi] ?? 0) + signedWeight;
    }
  }

  if (validTriangleCount === 0) {
    return err(
      tangentInputError(
        'tangent',
        0,
        'material-tangent-required: no triangle has a valid UV-derived tangent',
      ),
    );
  }

  const out = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    let tx = accumT[v * 3] ?? 0;
    let ty = accumT[v * 3 + 1] ?? 0;
    let tz = accumT[v * 3 + 2] ?? 0;
    const nx = normals[v * 3] ?? 0;
    const ny = normals[v * 3 + 1] ?? 0;
    const nz = normals[v * 3 + 2] ?? 0;

    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tLen < EPSILON) {
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const az = Math.abs(nz);
      let rx = 1;
      let ry = 0;
      let rz = 0;
      if (ax > ay && ax > az) {
        rx = 0;
        ry = 1;
      } else if (ay > ax && ay > az) {
        rx = 0;
        rz = 1;
      }
      tx = ny * rz - nz * ry;
      ty = nz * rx - nx * rz;
      tz = nx * ry - ny * rx;
      const fallbackLength = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (fallbackLength < EPSILON) {
        return err(
          tangentInputError(
            'tangent',
            v,
            'material-tangent-required: supplied normal cannot define a tangent frame',
          ),
        );
      }
      tx /= fallbackLength;
      ty /= fallbackLength;
      tz /= fallbackLength;
    } else {
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;
    }

    // Gram-Schmidt: T' = normalize(T - dot(T, N) * N)
    const dotTN = tx * nx + ty * ny + tz * nz;
    let gx = tx - dotTN * nx;
    let gy = ty - dotTN * ny;
    let gz = tz - dotTN * nz;
    const gLen = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gLen < EPSILON) {
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const az = Math.abs(nz);
      let rx = 1;
      let ry = 0;
      let rz = 0;
      if (ax > ay && ax > az) {
        rx = 0;
        ry = 1;
      } else if (ay > ax && ay > az) {
        rx = 0;
        rz = 1;
      }
      gx = ny * rz - nz * ry;
      gy = nz * rx - nx * rz;
      gz = nx * ry - ny * rx;
      const fallbackLength = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (fallbackLength < EPSILON) {
        return err(
          tangentInputError(
            'tangent',
            v,
            'material-tangent-required: supplied normal cannot define a tangent frame',
          ),
        );
      }
      gx /= fallbackLength;
      gy /= fallbackLength;
      gz /= fallbackLength;
    } else {
      gx /= gLen;
      gy /= gLen;
      gz /= gLen;
    }

    const accSign = accumSign[v] ?? 0;
    const w = accSign >= 0 ? 1 : -1;

    out[v * 4] = gx;
    out[v * 4 + 1] = gy;
    out[v * 4 + 2] = gz;
    out[v * 4 + 3] = w;
  }

  return ok(out);
}
