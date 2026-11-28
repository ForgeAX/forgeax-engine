//! Area-weighted normals, UV-derivative vec4 tangents, and 32-bit packed tangent frames.
//! Algorithms match the canonical TS baseline (`mesh-builder.ts`, `tangent.ts`, `tangent-frame32.ts`).

use crate::error::KernelError;

const EPSILON: f64 = 1e-8;

#[inline]
fn normalize_in_place(values: &mut [f32], offset: usize) -> bool {
    let x = values[offset] as f64;
    let y = values[offset + 1] as f64;
    let z = values[offset + 2] as f64;
    let len = (x * x + y * y + z * z).sqrt();
    if !(len > 1e-12) || !len.is_finite() {
        return false;
    }
    values[offset] = (x / len) as f32;
    values[offset + 1] = (y / len) as f32;
    values[offset + 2] = (z / len) as f32;
    true
}

/// Area-weighted smooth vertex normals; `[0, 0, 1]` where no non-degenerate triangle contributes.
pub fn area_weighted_normals(positions: &[f32], triangles: &[u32]) -> Vec<f32> {
    let mut normals = vec![0.0f32; positions.len()];
    let mut k = 0usize;
    while k + 2 < triangles.len() {
        let a = (triangles[k] as usize) * 3;
        let b = (triangles[k + 1] as usize) * 3;
        let c = (triangles[k + 2] as usize) * 3;
        let ax = positions[a];
        let ay = positions[a + 1];
        let az = positions[a + 2];
        let e1x = positions[b] - ax;
        let e1y = positions[b + 1] - ay;
        let e1z = positions[b + 2] - az;
        let e2x = positions[c] - ax;
        let e2y = positions[c + 1] - ay;
        let e2z = positions[c + 2] - az;
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        normals[a] += nx;
        normals[a + 1] += ny;
        normals[a + 2] += nz;
        normals[b] += nx;
        normals[b + 1] += ny;
        normals[b + 2] += nz;
        normals[c] += nx;
        normals[c + 1] += ny;
        normals[c + 2] += nz;
        k += 3;
    }
    let mut offset = 0usize;
    while offset < normals.len() {
        if !normalize_in_place(&mut normals, offset) {
            normals[offset] = 0.0;
            normals[offset + 1] = 0.0;
            normals[offset + 2] = 1.0;
        }
        offset += 3;
    }
    normals
}

/// Unit per-vertex frame normals for tangent derivation. Authored normals are normalized;
/// zero/non-finite normals fall back to derived area-weighted normals without mutating the source.
pub fn frame_normals(authored: Option<&[f32]>, positions: &[f32], triangles: &[u32]) -> Vec<f32> {
    let Some(src) = authored else {
        return area_weighted_normals(positions, triangles);
    };
    let mut normals = src.to_vec();
    let mut derived: Option<Vec<f32>> = None;
    let mut offset = 0usize;
    while offset < normals.len() {
        if normalize_in_place(&mut normals, offset) {
            offset += 3;
            continue;
        }
        let d = derived.get_or_insert_with(|| area_weighted_normals(positions, triangles));
        normals[offset] = d[offset];
        normals[offset + 1] = d[offset + 1];
        normals[offset + 2] = d[offset + 2];
        offset += 3;
    }
    normals
}

/// Deterministic unit tangent in the plane orthogonal to `(nx, ny, nz)`.
pub fn normal_plane_tangent(nx: f32, ny: f32, nz: f32) -> Option<[f32; 3]> {
    let nx = nx as f64;
    let ny = ny as f64;
    let nz = nz as f64;
    if !nx.is_finite() || !ny.is_finite() || !nz.is_finite() {
        return None;
    }
    let (tx, ty, tz) = if nx.abs() > nz.abs() {
        (-ny, nx, 0.0)
    } else {
        (0.0, -nz, ny)
    };
    let len = (tx * tx + ty * ty + tz * tz).sqrt();
    if !(len > 0.0) || !len.is_finite() {
        return None;
    }
    Some([(tx / len) as f32, (ty / len) as f32, (tz / len) as f32])
}

fn fallback_tangent(nx: f64, ny: f64, nz: f64) -> Result<[f64; 3], KernelError> {
    let ax = nx.abs();
    let ay = ny.abs();
    let az = nz.abs();
    let (rx, ry, rz) = if ax > ay && ax > az {
        (0.0, 1.0, 0.0)
    } else if ay > ax && ay > az {
        (0.0, 0.0, 1.0)
    } else {
        (1.0, 0.0, 0.0)
    };
    let tx = ny * rz - nz * ry;
    let ty = nz * rx - nx * rz;
    let tz = nx * ry - ny * rx;
    let len = (tx * tx + ty * ty + tz * tz).sqrt();
    if len < EPSILON {
        return Err(KernelError::degenerate(
            "tangent",
            "material-tangent-required: supplied normal cannot define a tangent frame",
        ));
    }
    Ok([tx / len, ty / len, tz / len])
}

/// Compute glTF-compatible per-vertex vec4 tangents (`[tx, ty, tz, handedness]`).
pub fn compute_tangent_vec4(
    positions: &[f32],
    normals: &[f32],
    uvs: &[f32],
    indices: Option<&[u32]>,
) -> Result<Vec<f32>, KernelError> {
    if positions.len() % 3 != 0 {
        return Err(KernelError::invalid_value(
            "positions",
            "positions.len must be divisible by 3",
        ));
    }
    let vertex_count = positions.len() / 3;
    if normals.len() != vertex_count * 3 {
        return Err(KernelError::invalid_value(
            "normals",
            "normals.len must equal vertexCount * 3",
        ));
    }
    if uvs.len() != vertex_count * 2 {
        return Err(KernelError::invalid_value(
            "uvs",
            "uvs.len must equal vertexCount * 2",
        ));
    }
    let triangle_count = if let Some(idx) = indices {
        if idx.len() % 3 != 0 {
            return Err(KernelError::invalid_value(
                "indices",
                "indices.len must be divisible by 3",
            ));
        }
        for &v in idx {
            if (v as usize) >= vertex_count {
                return Err(KernelError::invalid_value(
                    "indices",
                    "index out of vertex range",
                ));
            }
        }
        idx.len() / 3
    } else {
        if vertex_count % 3 != 0 {
            return Err(KernelError::invalid_value(
                "positions",
                "non-indexed vertexCount must be divisible by 3",
            ));
        }
        vertex_count / 3
    };

    let mut accum_t = vec![0.0f32; vertex_count * 3];
    let mut accum_sign = vec![0.0f32; vertex_count];
    let mut valid_triangles = 0usize;

    for tri in 0..triangle_count {
        let (i0, i1, i2) = if let Some(idx) = indices {
            (
                idx[tri * 3] as usize,
                idx[tri * 3 + 1] as usize,
                idx[tri * 3 + 2] as usize,
            )
        } else {
            (tri * 3, tri * 3 + 1, tri * 3 + 2)
        };
        let p0x = positions[i0 * 3] as f64;
        let p0y = positions[i0 * 3 + 1] as f64;
        let p0z = positions[i0 * 3 + 2] as f64;
        let p1x = positions[i1 * 3] as f64;
        let p1y = positions[i1 * 3 + 1] as f64;
        let p1z = positions[i1 * 3 + 2] as f64;
        let p2x = positions[i2 * 3] as f64;
        let p2y = positions[i2 * 3 + 1] as f64;
        let p2z = positions[i2 * 3 + 2] as f64;

        let u0 = uvs[i0 * 2] as f64;
        let v0 = uvs[i0 * 2 + 1] as f64;
        let u1 = uvs[i1 * 2] as f64;
        let v1 = uvs[i1 * 2 + 1] as f64;
        let u2 = uvs[i2 * 2] as f64;
        let v2 = uvs[i2 * 2 + 1] as f64;

        let dp1x = p1x - p0x;
        let dp1y = p1y - p0y;
        let dp1z = p1z - p0z;
        let dp2x = p2x - p0x;
        let dp2y = p2y - p0y;
        let dp2z = p2z - p0z;

        let du1 = u1 - u0;
        let dv1 = v1 - v0;
        let du2 = u2 - u0;
        let dv2 = v2 - v0;

        let det = du1 * dv2 - du2 * dv1;
        if det.abs() < EPSILON {
            continue;
        }
        let inv_det = 1.0 / det;
        let tx = inv_det * (dv2 * dp1x - dv1 * dp2x);
        let ty = inv_det * (dv2 * dp1y - dv1 * dp2y);
        let tz = inv_det * (dv2 * dp1z - dv1 * dp2z);

        let cx = dp1y * dp2z - dp1z * dp2y;
        let cy = dp1z * dp2x - dp1x * dp2z;
        let cz = dp1x * dp2y - dp1y * dp2x;
        let face_area = 0.5 * (cx * cx + cy * cy + cz * cz).sqrt();
        if face_area < EPSILON {
            continue;
        }
        valid_triangles += 1;

        let sign_det = if det >= 0.0 { 1.0 } else { -1.0 };
        let signed_weight = (face_area * sign_det) as f32;
        let wx = (tx * face_area) as f32;
        let wy = (ty * face_area) as f32;
        let wz = (tz * face_area) as f32;

        for idx_v in [i0, i1, i2] {
            accum_t[idx_v * 3] += wx;
            accum_t[idx_v * 3 + 1] += wy;
            accum_t[idx_v * 3 + 2] += wz;
            accum_sign[idx_v] += signed_weight;
        }
    }

    if valid_triangles == 0 {
        return Err(KernelError::degenerate(
            "tangent",
            "material-tangent-required: no triangle has a valid UV-derived tangent",
        ));
    }

    let mut out = vec![0.0f32; vertex_count * 4];
    for v in 0..vertex_count {
        let mut tx = accum_t[v * 3] as f64;
        let mut ty = accum_t[v * 3 + 1] as f64;
        let mut tz = accum_t[v * 3 + 2] as f64;
        let nx = normals[v * 3] as f64;
        let ny = normals[v * 3 + 1] as f64;
        let nz = normals[v * 3 + 2] as f64;

        let t_len = (tx * tx + ty * ty + tz * tz).sqrt();
        if t_len < EPSILON {
            let fb = fallback_tangent(nx, ny, nz)?;
            tx = fb[0];
            ty = fb[1];
            tz = fb[2];
        } else {
            tx /= t_len;
            ty /= t_len;
            tz /= t_len;
        }

        let dot_tn = tx * nx + ty * ny + tz * nz;
        let mut gx = tx - dot_tn * nx;
        let mut gy = ty - dot_tn * ny;
        let mut gz = tz - dot_tn * nz;
        let g_len = (gx * gx + gy * gy + gz * gz).sqrt();
        if g_len < EPSILON {
            let fb = fallback_tangent(nx, ny, nz)?;
            gx = fb[0];
            gy = fb[1];
            gz = fb[2];
        } else {
            gx /= g_len;
            gy /= g_len;
            gz /= g_len;
        }

        let w = if accum_sign[v] >= 0.0 {
            1.0f32
        } else {
            -1.0f32
        };
        out[v * 4] = gx as f32;
        out[v * 4 + 1] = gy as f32;
        out[v * 4 + 2] = gz as f32;
        out[v * 4 + 3] = w;
    }

    Ok(out)
}

/// Encode orthonormal tangent frame into 32 bits: oct11x2 normal + diamond9 tangent + bit31 sign.
/// Matches `encodeTangentFrame32` in `packages/geometry/src/tangent-frame32.ts`.
pub fn encode_tangent_frame32(
    nx_in: f32,
    ny_in: f32,
    nz_in: f32,
    tx_in: f32,
    ty_in: f32,
    tz_in: f32,
    handedness: f32,
) -> Result<u32, KernelError> {
    let mut nx = nx_in as f64;
    let mut ny = ny_in as f64;
    let mut nz = nz_in as f64;
    let mut tx = tx_in as f64;
    let mut ty = ty_in as f64;
    let mut tz = tz_in as f64;
    let normal_len = (nx * nx + ny * ny + nz * nz).sqrt();
    if !normal_len.is_finite()
        || normal_len == 0.0
        || !tx.is_finite()
        || !ty.is_finite()
        || !tz.is_finite()
        || (handedness != 1.0 && handedness != -1.0)
    {
        return Err(KernelError::invalid_value(
            "tangentFrame",
            "Tangent frame requires a finite nonzero normal, tangent and orientation +/-1",
        ));
    }
    nx /= normal_len;
    ny /= normal_len;
    nz /= normal_len;
    let proj = nx * tx + ny * ty + nz * tz;
    tx -= nx * proj;
    ty -= ny * proj;
    tz -= nz * proj;
    if (tx * tx + ty * ty + tz * tz).sqrt() < 1e-12 {
        return Err(KernelError::invalid_value(
            "tangentFrame",
            "Tangent frame requires a nonzero normal-plane tangent",
        ));
    }
    let l1 = nx.abs() + ny.abs() + nz.abs();
    let mut u = nx / l1;
    let mut v = ny / l1;
    if nz < 0.0 {
        let prev = u;
        u = (1.0 - v.abs()) * if prev >= 0.0 { 1.0 } else { -1.0 };
        v = (1.0 - prev.abs()) * if v >= 0.0 { 1.0 } else { -1.0 };
    }
    // JS Math.round(x) = floor(x + 0.5) for non-negative values in [0, 2047].
    let qu = (((u * 0.5 + 0.5) * 2047.0 + 0.5).floor() as i32).clamp(0, 2047) as u32;
    let qv = (((v * 0.5 + 0.5) * 2047.0 + 0.5).floor() as i32).clamp(0, 2047) as u32;

    nx = (qu as f64 / 2047.0) * 2.0 - 1.0;
    ny = (qv as f64 / 2047.0) * 2.0 - 1.0;
    nz = 1.0 - nx.abs() - ny.abs();
    let fold = (-nz).max(0.0);
    nx += if nx >= 0.0 { -fold } else { fold };
    ny += if ny >= 0.0 { -fold } else { fold };
    let inv = 1.0 / (nx * nx + ny * ny + nz * nz).sqrt();
    nx *= inv;
    ny *= inv;
    nz *= inv;

    let sign = if nz >= 0.0 { 1.0 } else { -1.0 };
    let a = -1.0 / (sign + nz);
    let b = nx * ny * a;
    let x = tx * (1.0 + sign * nx * nx * a) + ty * sign * b - tz * sign * nx;
    let y = tx * b + ty * (sign + ny * ny * a) - tz * ny;
    let len = x.abs() + y.abs();
    if !len.is_finite() || len < 1e-12 {
        return Err(KernelError::invalid_value(
            "tangentFrame",
            "Tangent frame requires a nonzero normal-plane tangent",
        ));
    }
    let diamond = if y >= 0.0 {
        (1.0 - x / len) * 0.25
    } else {
        (3.0 + x / len) * 0.25
    };
    let qt = (((diamond * 512.0) + 0.5).floor() as u32) & 511;
    let sign_bit = if handedness < 0.0 { 0x8000_0000u32 } else { 0 };
    Ok(qu | (qv << 11) | (qt << 22) | sign_bit)
}

/// Decode 32-bit packed tangent frame into `[nx, ny, nz, tx, ty, tz, handedness]`.
pub fn decode_tangent_frame32(word: u32) -> [f32; 7] {
    let mut nx = ((word & 2047) as f64 / 2047.0) * 2.0 - 1.0;
    let mut ny = (((word >> 11) & 2047) as f64 / 2047.0) * 2.0 - 1.0;
    let mut nz = 1.0 - nx.abs() - ny.abs();
    let fold = (-nz).max(0.0);
    nx += if nx >= 0.0 { -fold } else { fold };
    ny += if ny >= 0.0 { -fold } else { fold };
    let inv = 1.0 / (nx * nx + ny * ny + nz * nz).sqrt();
    nx *= inv;
    ny *= inv;
    nz *= inv;
    let sign = if nz >= 0.0 { 1.0 } else { -1.0 };
    let a = -1.0 / (sign + nz);
    let b = nx * ny * a;
    let ax = 1.0 + sign * nx * nx * a;
    let ay = sign * b;
    let az = -sign * nx;
    let bx = b;
    let by = sign + ny * ny * a;
    let bz = -ny;
    let diamond = ((word >> 22) & 511) as f64 / 512.0;
    let x = if diamond < 0.5 {
        1.0 - 4.0 * diamond
    } else {
        4.0 * diamond - 3.0
    };
    let y = (1.0 - x.abs()) * if diamond < 0.5 { 1.0 } else { -1.0 };
    let scale = 1.0 / (x * x + y * y).sqrt();
    let handedness = if (word >> 31) != 0 { -1.0 } else { 1.0 };
    [
        nx as f32,
        ny as f32,
        nz as f32,
        ((ax * x + bx * y) * scale) as f32,
        ((ay * x + by * y) * scale) as f32,
        ((az * x + bz * y) * scale) as f32,
        handedness,
    ]
}
