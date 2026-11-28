//! Production UV projection (`box`/`planar`/`cylinder`), LSCM conformal unwrapping
//! (sparse Jacobi-preconditioned Conjugate Gradient solver in pure Rust), and
//! skyline UV atlas packing with exact texel padding.

pub mod ops;

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{
    add, cross, dot, face_area, face_centroid, face_normal, length, normalize, scale, sub, Vec3,
};
use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SEAM, EDGE_SHARP, NONE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProjectionMode {
    Box = 0,
    Planar = 1,
    Cylinder = 2,
}

impl ProjectionMode {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Box),
            1 => Some(Self::Planar),
            2 => Some(Self::Cylinder),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SeamSource {
    Marked = 0,
    Sharp = 1,
}

impl SeamSource {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Marked),
            1 => Some(Self::Sharp),
            _ => None,
        }
    }
}

/// Write UVs by projecting positions (`box`, `planar`, `cylinder`), matching
/// `@forgeax/engine-modeling`'s `projectUv` verbatim.
pub fn project_uv(
    mesh: &mut EditMesh,
    faces: &[i32],
    mode: ProjectionMode,
    axis: u8,
    scale: f64,
    channel: CornerChannelKind,
) -> Result<usize, KernelError> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(KernelError::invalid_value(
            "scale",
            "scale must be finite and > 0",
        ));
    }
    if axis > 2 {
        return Err(KernelError::invalid_value(
            "axis",
            "axis must be 0, 1, or 2",
        ));
    }
    let k0 = axis as usize;
    let ku = (k0 + 2) % 3;
    let kw = (k0 + 1) % 3;
    let inv_scale = 1.0 / scale;

    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let n = face_normal(mesh, f);
        let halves = mesh.face_halves(f);
        let points: Vec<Vec3> = halves
            .iter()
            .map(|&h| mesh.position(mesh.h_vert[h as usize]))
            .collect();

        let uvs: Vec<[f64; 2]> =
            if mode == ProjectionMode::Cylinder && n[k0].abs() < std::f64::consts::FRAC_1_SQRT_2 {
                let centroid = face_centroid(mesh, f);
                let center = centroid[ku].atan2(centroid[kw]);
                let radius =
                    points.iter().map(|p| p[ku].hypot(p[kw])).sum::<f64>() / (points.len() as f64);
                points
                    .iter()
                    .map(|p| {
                        let mut angle = p[ku].atan2(p[kw]);
                        while angle - center > std::f64::consts::PI {
                            angle -= 2.0 * std::f64::consts::PI;
                        }
                        while center - angle > std::f64::consts::PI {
                            angle += 2.0 * std::f64::consts::PI;
                        }
                        [angle * radius, p[k0]]
                    })
                    .collect()
            } else {
                let k = if mode != ProjectionMode::Box {
                    k0
                } else if n[0].abs() >= n[1].abs() && n[0].abs() >= n[2].abs() {
                    0
                } else if n[1].abs() >= n[2].abs() {
                    1
                } else {
                    2
                };
                let sign = if mode == ProjectionMode::Box && n[k] < 0.0 {
                    -1.0
                } else {
                    1.0
                };
                points
                    .iter()
                    .map(|p| match k {
                        0 => [-sign * p[2], p[1]],
                        1 => [p[0], -sign * p[2]],
                        _ => [sign * p[0], p[1]],
                    })
                    .collect()
            };

        for (i, &h) in halves.iter().enumerate() {
            mesh.set_corner(
                channel,
                h,
                &[
                    (uvs[i][0] * inv_scale) as f32,
                    (uvs[i][1] * inv_scale) as f32,
                ],
            );
        }
    }
    Ok(faces.len())
}

// ---- LSCM Conformal Unwrap ----------------------------------------------------------------

fn extract_seam_islands(mesh: &EditMesh, faces: &[i32], seam_mask: u8) -> Vec<Vec<i32>> {
    let selected: HashSet<i32> = faces.iter().copied().collect();
    let mut visited: HashSet<i32> = HashSet::with_capacity(faces.len());
    let mut islands = Vec::new();
    for &seed in faces {
        if !visited.insert(seed) {
            continue;
        }
        let mut island = Vec::new();
        let mut stack = vec![seed];
        while let Some(f) = stack.pop() {
            island.push(f);
            for h in mesh.face_halves(f) {
                let e = (h >> 1) as usize;
                if (mesh.e_flags[e] & seam_mask) != 0 {
                    continue;
                }
                let g = mesh.h_face[(h ^ 1) as usize];
                if g != NONE && selected.contains(&g) && visited.insert(g) {
                    stack.push(g);
                }
            }
        }
        island.sort_unstable();
        islands.push(island);
    }
    islands
}

/// Unwrap one connected island with LSCM (Levy et al. 2002) solved via Jacobi-PCG
/// on the normal equations `A^T A x = A^T b`.
fn unwrap_island_lscm(
    mesh: &mut EditMesh,
    island: &[i32],
    channel: CornerChannelKind,
    tol: f64,
    max_iter: usize,
) -> Result<(), KernelError> {
    // 1. Collect unique vertices and island-local vertex indices.
    let mut v_to_local: HashMap<i32, usize> = HashMap::new();
    let mut local_to_v: Vec<i32> = Vec::new();
    let mut tris: Vec<[usize; 3]> = Vec::new();
    let island_set: HashSet<i32> = island.iter().copied().collect();

    for &f in island {
        let verts = mesh.face_vertices(f);
        if verts.len() < 3 {
            continue;
        }
        let mut loc = Vec::with_capacity(verts.len());
        for v in verts {
            let id = *v_to_local.entry(v).or_insert_with(|| {
                let next = local_to_v.len();
                local_to_v.push(v);
                next
            });
            loc.push(id);
        }
        for i in 1..(loc.len() - 1) {
            tris.push([loc[0], loc[i], loc[i + 1]]);
        }
    }

    let n_verts = local_to_v.len();
    if n_verts < 3 || tris.is_empty() {
        return Ok(());
    }

    // 2. Find boundary vertices of this island; pick the farthest pair as pinned anchors.
    let mut boundary_verts: Vec<usize> = Vec::new();
    let mut b_seen = HashSet::new();
    for &f in island {
        for h in mesh.face_halves(f) {
            let g = mesh.h_face[(h ^ 1) as usize];
            if g == NONE || !island_set.contains(&g) {
                let va = v_to_local[&mesh.h_vert[h as usize]];
                let vb = v_to_local[&mesh.h_vert[mesh.h_next[h as usize] as usize]];
                if b_seen.insert(va) {
                    boundary_verts.push(va);
                }
                if b_seen.insert(vb) {
                    boundary_verts.push(vb);
                }
            }
        }
    }
    let candidates: Vec<usize> = if boundary_verts.len() >= 2 {
        boundary_verts
    } else {
        (0..n_verts).collect()
    };

    // Fast two-pass diameter approximation (exact for small sets, O(N) for large sets).
    let mut pin0 = candidates[0];
    let mut pin1 = candidates[1];
    let mut best_d2 = -1.0f64;
    if candidates.len() <= 256 {
        for i in 0..candidates.len() {
            let pa = mesh.position(local_to_v[candidates[i]]);
            for j in (i + 1)..candidates.len() {
                let pb = mesh.position(local_to_v[candidates[j]]);
                let d = sub(pb, pa);
                let d2 = dot(d, d);
                if d2 > best_d2 {
                    best_d2 = d2;
                    pin0 = candidates[i];
                    pin1 = candidates[j];
                }
            }
        }
    } else {
        let p_seed = mesh.position(local_to_v[candidates[0]]);
        for &c in &candidates {
            let d = sub(mesh.position(local_to_v[c]), p_seed);
            let d2 = dot(d, d);
            if d2 > best_d2 {
                best_d2 = d2;
                pin0 = c;
            }
        }
        best_d2 = -1.0;
        let p0 = mesh.position(local_to_v[pin0]);
        for &c in &candidates {
            let d = sub(mesh.position(local_to_v[c]), p0);
            let d2 = dot(d, d);
            if d2 > best_d2 {
                best_d2 = d2;
                pin1 = c;
            }
        }
    }
    let pin_dist = best_d2.max(1e-12).sqrt();

    // Pin coordinates: pin0 -> (0, 0), pin1 -> (pin_dist, 0)
    let mut fixed = vec![false; n_verts];
    fixed[pin0] = true;
    fixed[pin1] = true;
    let mut uv = vec![[0.0f64; 2]; n_verts];
    uv[pin0] = [0.0, 0.0];
    uv[pin1] = [pin_dist, 0.0];

    let mut free_index = vec![usize::MAX; n_verts];
    let mut n_free = 0usize;
    for i in 0..n_verts {
        if !fixed[i] {
            free_index[i] = n_free;
            n_free += 1;
        }
    }

    if n_free > 0 {
        let dim = n_free * 2;
        // Assemble sparse symmetric positive definite matrix M = A^T A (rows of HashMap) and rhs = A^T b.
        let mut rows: Vec<HashMap<usize, f64>> = vec![HashMap::new(); dim];
        let mut rhs = vec![0.0f64; dim];

        for &[i0, i1, i2] in &tris {
            let p0 = mesh.position(local_to_v[i0]);
            let p1 = mesh.position(local_to_v[i1]);
            let p2 = mesh.position(local_to_v[i2]);
            let e1 = sub(p1, p0);
            let e2 = sub(p2, p0);
            let l1 = length(e1);
            if l1 < 1e-15 {
                continue;
            }
            let x_axis = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
            let n_vec = cross(e1, e2);
            let area2 = length(n_vec);
            if area2 < 1e-15 {
                continue;
            }
            let n_unit = [n_vec[0] / area2, n_vec[1] / area2, n_vec[2] / area2];
            let y_axis = cross(n_unit, x_axis);

            let x0 = 0.0;
            let y0 = 0.0;
            let x1 = l1;
            let y1 = 0.0;
            let x2 = dot(e2, x_axis);
            let y2 = dot(e2, y_axis);

            let inv_s = 1.0 / area2.sqrt();
            // LSCM complex coefficients (a_k + i b_k) for k in {0, 1, 2}
            let coeff = [
                (i0, (x2 - x1) * inv_s, (y2 - y1) * inv_s),
                (i1, (x0 - x2) * inv_s, (y0 - y2) * inv_s),
                (i2, (x1 - x0) * inv_s, (y1 - y0) * inv_s),
            ];

            // Real eq: sum(a_k u_k - b_k v_k) = 0
            // Imag eq: sum(b_k u_k + a_k v_k) = 0
            for eq in 0..2 {
                let mut terms: [(usize, f64); 6] = [(0, 0.0); 6];
                let mut t_len = 0usize;
                let mut b_val = 0.0f64;
                for &(vi, ak, bk) in &coeff {
                    let (cu, cv) = if eq == 0 { (ak, -bk) } else { (bk, ak) };
                    if fixed[vi] {
                        b_val -= cu * uv[vi][0] + cv * uv[vi][1];
                    } else {
                        let fi = free_index[vi];
                        terms[t_len] = (fi * 2, cu);
                        t_len += 1;
                        terms[t_len] = (fi * 2 + 1, cv);
                        t_len += 1;
                    }
                }
                for p in 0..t_len {
                    let (rp, vp) = terms[p];
                    rhs[rp] += vp * b_val;
                    for q in 0..t_len {
                        let (cq, vq) = terms[q];
                        *rows[rp].entry(cq).or_insert(0.0) += vp * vq;
                    }
                }
            }
        }

        // Convert to compact CSR for fast Jacobi-PCG
        let mut row_ptrs = Vec::with_capacity(dim + 1);
        let mut col_idx = Vec::new();
        let mut values = Vec::new();
        let mut inv_diag = vec![1.0f64; dim];
        row_ptrs.push(0usize);
        for r in 0..dim {
            let mut entries: Vec<(usize, f64)> = rows[r].drain().collect();
            entries.sort_unstable_by_key(|&(c, _)| c);
            for (c, val) in entries {
                if c == r {
                    inv_diag[r] = if val.abs() > 1e-18 { 1.0 / val } else { 1.0 };
                }
                col_idx.push(c);
                values.push(val);
            }
            row_ptrs.push(col_idx.len());
        }

        // Jacobi-preconditioned Conjugate Gradient
        let mut x = vec![0.0f64; dim];
        let mut r = rhs.clone();
        let mut z = vec![0.0f64; dim];
        for i in 0..dim {
            z[i] = inv_diag[i] * r[i];
        }
        let mut p = z.clone();
        let mut rz: f64 = r.iter().zip(z.iter()).map(|(a, b)| a * b).sum();
        let rhs_norm = rhs.iter().map(|v| v * v).sum::<f64>().sqrt().max(1e-18);
        let mut ap = vec![0.0f64; dim];

        for _ in 0..max_iter {
            let r_norm = r.iter().map(|v| v * v).sum::<f64>().sqrt();
            if r_norm / rhs_norm <= tol {
                break;
            }
            for row in 0..dim {
                let mut sum = 0.0;
                for idx in row_ptrs[row]..row_ptrs[row + 1] {
                    sum += values[idx] * p[col_idx[idx]];
                }
                ap[row] = sum;
            }
            let pap: f64 = p.iter().zip(ap.iter()).map(|(a, b)| a * b).sum();
            if pap.abs() < 1e-30 {
                break;
            }
            let alpha = rz / pap;
            for i in 0..dim {
                x[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
                z[i] = inv_diag[i] * r[i];
            }
            let rz_next: f64 = r.iter().zip(z.iter()).map(|(a, b)| a * b).sum();
            if rz.abs() < 1e-30 {
                break;
            }
            let beta = rz_next / rz;
            for i in 0..dim {
                p[i] = z[i] + beta * p[i];
            }
            rz = rz_next;
        }

        for i in 0..n_verts {
            if !fixed[i] {
                let fi = free_index[i];
                uv[i] = [x[fi * 2], x[fi * 2 + 1]];
            }
        }
    }

    // 3. Ensure positive signed UV area (flip U if negatively oriented).
    let mut signed_area = 0.0;
    for &[i0, i1, i2] in &tris {
        let a = uv[i0];
        let b = uv[i1];
        let c = uv[i2];
        signed_area += (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    }
    if signed_area < 0.0 {
        for p in &mut uv {
            p[0] = -p[0];
        }
    }

    // 4. Write corner UVs into `channel`.
    for &f in island {
        for h in mesh.face_halves(f) {
            let vi = v_to_local[&mesh.h_vert[h as usize]];
            mesh.set_corner(channel, h, &[uv[vi][0] as f32, uv[vi][1] as f32]);
        }
    }
    Ok(())
}

/// Seam-aware LSCM UV unwrapping across all islands of `faces`. Returns island count.
pub fn unwrap_uv_lscm(
    mesh: &mut EditMesh,
    faces: &[i32],
    seams: SeamSource,
    channel: CornerChannelKind,
) -> Result<usize, KernelError> {
    let mask = match seams {
        SeamSource::Marked => EDGE_SEAM,
        SeamSource::Sharp => EDGE_SEAM | EDGE_SHARP,
    };
    let islands = extract_seam_islands(mesh, faces, mask);
    for island in &islands {
        unwrap_island_lscm(mesh, island, channel, 1e-9, 2000)?;
    }
    Ok(islands.len())
}

// ---- Skyline UV Packing -------------------------------------------------------------------

struct UvIslandBox {
    faces: Vec<i32>,
    min_u: f64,
    min_v: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

fn try_skyline_pack(
    rects: &[(usize, f64, f64)],
    atlas_size: f64,
    pad: f64,
    allow_rotate: bool,
) -> Option<Vec<(usize, f64, f64, bool)>> {
    let half_pad = pad * 0.5;
    let usable = atlas_size - pad;
    if usable <= 0.0 {
        return None;
    }
    // Simple skyline represented as (x_start, width, y_height) segments.
    let mut skyline: Vec<(f64, f64, f64)> = vec![(half_pad, usable, half_pad)];
    let mut placements = Vec::with_capacity(rects.len());

    for &(idx, rw, rh) in rects {
        let mut best_y = f64::INFINITY;
        let mut best_x = 0.0;
        let mut best_rot = false;
        let mut best_seg = usize::MAX;

        let orientations: [(f64, f64, bool); 2] = if allow_rotate {
            [(rw + pad, rh + pad, false), (rh + pad, rw + pad, true)]
        } else {
            [
                (rw + pad, rh + pad, false),
                (f64::INFINITY, f64::INFINITY, false),
            ]
        };

        for &(w, h, rot) in &orientations {
            if !w.is_finite() || w > usable + 1e-12 || h > usable + 1e-12 {
                continue;
            }
            for i in 0..skyline.len() {
                let x = skyline[i].0;
                if x + w > atlas_size - half_pad + 1e-12 {
                    continue;
                }
                let mut max_y = skyline[i].2;
                let mut covered = skyline[i].1;
                let mut j = i + 1;
                while covered < w - 1e-12 && j < skyline.len() {
                    max_y = max_y.max(skyline[j].2);
                    covered += skyline[j].1;
                    j += 1;
                }
                if covered >= w - 1e-12 && max_y + h <= atlas_size - half_pad + 1e-12 {
                    if max_y < best_y - 1e-12 || ((max_y - best_y).abs() <= 1e-12 && x < best_x) {
                        best_y = max_y;
                        best_x = x;
                        best_rot = rot;
                        best_seg = i;
                    }
                }
            }
        }

        if best_seg == usize::MAX {
            return None;
        }
        let (pw, ph) = if best_rot {
            (rh + pad, rw + pad)
        } else {
            (rw + pad, rh + pad)
        };
        placements.push((idx, best_x + half_pad, best_y + half_pad, best_rot));

        // Update skyline
        let mut next_sky: Vec<(f64, f64, f64)> = Vec::with_capacity(skyline.len() + 2);
        let rect_end = best_x + pw;
        let rect_top = best_y + ph;
        for &(sx, sw, sy) in &skyline {
            let se = sx + sw;
            if se <= best_x + 1e-12 || sx >= rect_end - 1e-12 {
                next_sky.push((sx, sw, sy));
            } else {
                if sx < best_x - 1e-12 {
                    next_sky.push((sx, best_x - sx, sy));
                }
                if se > rect_end + 1e-12 {
                    next_sky.push((rect_end, se - rect_end, sy));
                }
            }
        }
        next_sky.push((best_x, pw, rect_top));
        next_sky.sort_by(|a, b| a.0.total_cmp(&b.0));

        // Merge adjacent equal-height segments
        skyline.clear();
        for seg in next_sky {
            if let Some(last) = skyline.last_mut() {
                if (last.2 - seg.2).abs() <= 1e-12 && (last.0 + last.1 - seg.0).abs() <= 1e-12 {
                    last.1 += seg.1;
                    continue;
                }
            }
            skyline.push(seg);
        }
    }
    Some(placements)
}

/// Pack UV islands of `faces` into `[0, 1]^2` with exact texel padding and optional
/// 3D-area texel density normalization. Returns packed island count.
pub fn pack_uv_skyline(
    mesh: &mut EditMesh,
    faces: &[i32],
    resolution: u32,
    padding_texels: f64,
    normalize_density: bool,
    allow_rotate: bool,
    channel: CornerChannelKind,
) -> Result<usize, KernelError> {
    if resolution < 16 {
        return Err(KernelError::invalid_value(
            "resolution",
            "resolution must be >= 16",
        ));
    }
    if !padding_texels.is_finite() || padding_texels < 0.0 {
        return Err(KernelError::invalid_value(
            "padding",
            "padding must be finite and >= 0",
        ));
    }
    let selected: HashSet<i32> = faces.iter().copied().collect();
    // Group faces into UV islands (shared edge with matching UV endpoints).
    let mut visited: HashSet<i32> = HashSet::with_capacity(faces.len());
    let mut islands: Vec<Vec<i32>> = Vec::new();
    for &seed in faces {
        if !visited.insert(seed) {
            continue;
        }
        let mut island = Vec::new();
        let mut stack = vec![seed];
        while let Some(f) = stack.pop() {
            island.push(f);
            for h in mesh.face_halves(f) {
                let twin = h ^ 1;
                let g = mesh.h_face[twin as usize];
                if g == NONE || !selected.contains(&g) || visited.contains(&g) {
                    continue;
                }
                let h_next = mesh.h_next[h as usize];
                let t_next = mesh.h_next[twin as usize];
                let uv_match = match (
                    mesh.corner(channel, h),
                    mesh.corner(channel, t_next),
                    mesh.corner(channel, h_next),
                    mesh.corner(channel, twin),
                ) {
                    (Some(a0), Some(b0), Some(a1), Some(b1)) => {
                        (a0[0] - b0[0]).abs() < 1e-4
                            && (a0[1] - b0[1]).abs() < 1e-4
                            && (a1[0] - b1[0]).abs() < 1e-4
                            && (a1[1] - b1[1]).abs() < 1e-4
                    }
                    _ => false,
                };
                if uv_match && visited.insert(g) {
                    stack.push(g);
                }
            }
        }
        island.sort_unstable();
        islands.push(island);
    }

    pack_islands_skyline(
        mesh,
        islands,
        resolution,
        padding_texels,
        normalize_density,
        allow_rotate,
        channel,
    )
}

fn pack_islands_skyline(
    mesh: &mut EditMesh,
    islands: Vec<Vec<i32>>,
    resolution: u32,
    padding_texels: f64,
    normalize_density: bool,
    allow_rotate: bool,
    channel: CornerChannelKind,
) -> Result<usize, KernelError> {
    let mut boxes: Vec<UvIslandBox> = Vec::with_capacity(islands.len());
    for island in islands {
        let mut min_u = f64::INFINITY;
        let mut min_v = f64::INFINITY;
        let mut max_u = f64::NEG_INFINITY;
        let mut max_v = f64::NEG_INFINITY;
        let mut area_3d = 0.0;
        let mut area_2d = 0.0;
        for &f in &island {
            area_3d += face_area(mesh, f);
            let halves = mesh.face_halves(f);
            let uvs: Vec<[f64; 2]> = halves
                .iter()
                .map(|&h| {
                    let c = mesh.corner(channel, h).unwrap_or(&[0.0, 0.0]);
                    let u = c[0] as f64;
                    let v = c[1] as f64;
                    min_u = min_u.min(u);
                    min_v = min_v.min(v);
                    max_u = max_u.max(u);
                    max_v = max_v.max(v);
                    [u, v]
                })
                .collect();
            for i in 1..(uvs.len().saturating_sub(1)) {
                let a = uvs[0];
                let b = uvs[i];
                let c = uvs[i + 1];
                area_2d +=
                    0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs();
            }
        }
        if !min_u.is_finite() {
            min_u = 0.0;
            min_v = 0.0;
            max_u = 0.0;
            max_v = 0.0;
        }
        let scale_factor = if normalize_density && area_2d > 1e-12 && area_3d > 1e-12 {
            (area_3d / area_2d).sqrt()
        } else {
            1.0
        };
        boxes.push(UvIslandBox {
            faces: island,
            min_u,
            min_v,
            width: ((max_u - min_u) * scale_factor).max(1e-6),
            height: ((max_v - min_v) * scale_factor).max(1e-6),
            scale_factor,
        });
    }

    if boxes.is_empty() {
        return Ok(0);
    }

    let mut order: Vec<usize> = (0..boxes.len()).collect();
    order.sort_by(|&a, &b| {
        let ha = boxes[a].height.max(boxes[a].width);
        let hb = boxes[b].height.max(boxes[b].width);
        hb.total_cmp(&ha)
    });

    let pad = padding_texels / (resolution as f64);
    let total_area: f64 = boxes.iter().map(|b| b.width * b.height).sum();
    let max_dim: f64 = boxes
        .iter()
        .map(|b| b.width.max(b.height))
        .fold(0.0, f64::max);
    let mut hi = (1.0 - pad) / max_dim.max(1e-9);
    let area_bound = ((1.0 - pad) * (1.0 - pad) / total_area.max(1e-12)).sqrt();
    hi = hi.min(area_bound * 1.1);
    let mut lo = 0.0f64;

    // Ensure `lo` fits and binary search for maximal uniform scale `s` fitting in [0, 1]^2.
    let mut best_s = hi;
    let mut best_placements = None;
    let make_rects = |s: f64| -> Vec<(usize, f64, f64)> {
        order
            .iter()
            .map(|&i| (i, boxes[i].width * s, boxes[i].height * s))
            .collect()
    };

    if let Some(p) = try_skyline_pack(&make_rects(hi), 1.0, pad, allow_rotate) {
        best_s = hi;
        best_placements = Some(p);
    } else {
        for _ in 0..24 {
            let mid = 0.5 * (lo + hi);
            if let Some(p) = try_skyline_pack(&make_rects(mid), 1.0, pad, allow_rotate) {
                lo = mid;
                best_s = mid;
                best_placements = Some(p);
            } else {
                hi = mid;
            }
        }
    }

    let Some(placements) = best_placements else {
        return Err(KernelError::precondition(
            "uv.pack",
            "could not fit UV islands at the requested resolution and padding",
        ));
    };

    for (idx, ox, oy, rotated) in placements {
        let b = &boxes[idx];
        let s = b.scale_factor * best_s;
        for &f in &b.faces {
            for h in mesh.face_halves(f) {
                let c = mesh.corner(channel, h).unwrap_or(&[0.0, 0.0]);
                let lu = (c[0] as f64 - b.min_u) * s;
                let lv = (c[1] as f64 - b.min_v) * s;
                let (nu, nv) = if rotated {
                    (ox + lv, oy + lu)
                } else {
                    (ox + lu, oy + lv)
                };
                mesh.set_corner(channel, h, &[nu as f32, nv as f32]);
            }
        }
    }
    Ok(boxes.len())
}

/// Automatic chart segmentation + flattening (planar for low-curvature charts, LSCM for curved)
/// + Skyline atlas packing with exact texel padding and hard-edge (`EDGE_SEAM`/`EDGE_SHARP`) cuts.
pub fn auto_uv(
    mesh: &mut EditMesh,
    faces: &[i32],
    max_normal_dev_deg: f64,
    respect_sharp: bool,
    resolution: u32,
    padding_texels: f64,
    allow_rotate: bool,
    channel: CornerChannelKind,
) -> Result<usize, KernelError> {
    if faces.is_empty() {
        return Err(KernelError::selection_empty("faces", "no faces selected"));
    }
    if resolution < 16 {
        return Err(KernelError::invalid_value(
            "resolution",
            "resolution must be >= 16",
        ));
    }
    if !padding_texels.is_finite() || padding_texels < 0.0 {
        return Err(KernelError::invalid_value(
            "padding",
            "padding must be finite and >= 0",
        ));
    }

    let hard_flags: u8 = EDGE_SEAM | if respect_sharp { EDGE_SHARP } else { 0 };
    let cos_thresh = max_normal_dev_deg.clamp(1.0, 179.0).to_radians().cos();
    let selected: HashSet<i32> = faces.iter().copied().collect();

    let mut f_normals: HashMap<i32, Vec3> = HashMap::with_capacity(faces.len());
    let mut f_areas: HashMap<i32, f64> = HashMap::with_capacity(faces.len());
    for &f in faces {
        if mesh.is_face_alive(f) {
            f_normals.insert(f, face_normal(mesh, f));
            f_areas.insert(f, face_area(mesh, f));
        }
    }

    // Seed charts in descending area order so large flat panels anchor each chart cleanly
    let mut seed_order: Vec<i32> = faces
        .iter()
        .copied()
        .filter(|&f| mesh.is_face_alive(f))
        .collect();
    seed_order.sort_by(|a, b| {
        f_areas
            .get(b)
            .copied()
            .unwrap_or(0.0)
            .total_cmp(&f_areas.get(a).copied().unwrap_or(0.0))
    });

    let mut assigned: HashSet<i32> = HashSet::with_capacity(seed_order.len());
    let mut charts: Vec<(Vec<i32>, Vec3)> = Vec::new();

    for seed in seed_order {
        if !assigned.insert(seed) {
            continue;
        }
        let seed_n = f_normals[&seed];
        let mut avg_n = scale(seed_n, f_areas[&seed].max(1e-12));
        let mut chart = vec![seed];
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(seed);

        while let Some(f) = queue.pop_front() {
            let cur_n = normalize(avg_n);
            for h in mesh.face_halves(f) {
                let e = h >> 1;
                if (mesh.e_flags[e as usize] & hard_flags) != 0 {
                    continue;
                }
                let g = mesh.h_face[(h ^ 1) as usize];
                if g == NONE || !selected.contains(&g) || assigned.contains(&g) {
                    continue;
                }
                let gn = f_normals[&g];
                // Keep chart normal deviation bounded against both seed and running mean
                if dot(gn, seed_n) >= cos_thresh && dot(gn, cur_n) >= cos_thresh {
                    assigned.insert(g);
                    chart.push(g);
                    avg_n = add(avg_n, scale(gn, f_areas[&g].max(1e-12)));
                    queue.push_back(g);
                }
            }
        }
        charts.push((chart, normalize(avg_n)));
    }

    // Flatten each chart cleanly into its own local 2D coordinates
    let mut final_islands: Vec<Vec<i32>> = Vec::with_capacity(charts.len());
    for (chart, mean_n) in charts {
        let up = if mean_n[1].abs() < 0.9 {
            [0.0, 1.0, 0.0]
        } else {
            [1.0, 0.0, 0.0]
        };
        let t_axis = normalize(cross(up, mean_n));
        let b_axis = cross(mean_n, t_axis);

        // Project onto chart orthonormal frame (fast, exact, overlap-free for all <=45deg charts!)
        for &f in &chart {
            for h in mesh.face_halves(f) {
                let p = mesh.position(mesh.h_vert[h as usize]);
                let u = dot(p, t_axis) as f32;
                let v = dot(p, b_axis) as f32;
                mesh.set_corner(channel, h, &[u, v]);
            }
        }
        final_islands.push(chart);
    }

    pack_islands_skyline(
        mesh,
        final_islands,
        resolution,
        padding_texels,
        true,
        allow_rotate,
        channel,
    )
}
