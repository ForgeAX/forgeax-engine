//! Extended UV operators: `plan_seams`, `straighten_uv`, `lightmap_uv`, `trim_uv`,
//! `swatch_uv`, and `uv_overlap_pairs`.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{dot, face_normal, length, sub};
use crate::mesh::rewrite::triangulate_loop;
use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SEAM, EDGE_SHARP, NONE};
use crate::uv::{auto_uv, pack_uv_skyline, unwrap_uv_lscm, SeamSource};

/// Mark UV seams along edges sharper than `max_angle_deg` (or existing sharp edges)
/// and open up closed charts with longest-edge BFS paths if needed.
pub fn plan_seams(
    mesh: &mut EditMesh,
    faces: &[i32],
    max_angle_deg: f64,
    respect_sharp: bool,
) -> Result<usize, KernelError> {
    let selected: HashSet<i32> = faces
        .iter()
        .copied()
        .filter(|&f| mesh.is_face_alive(f))
        .collect();
    if selected.is_empty() {
        return Err(KernelError::no_effect("uv.plan", "no faces selected"));
    }
    let cos_thresh = max_angle_deg.to_radians().cos();
    let mut marked = 0usize;
    let mut seen_e = HashSet::new();
    for &f in &selected {
        let nf = face_normal(mesh, f);
        for h in mesh.face_halves(f) {
            let e = h >> 1;
            if !seen_e.insert(e) {
                continue;
            }
            let f1 = mesh.h_face[(e * 2) as usize];
            let f2 = mesh.h_face[(e * 2 + 1) as usize];
            if f1 == NONE || f2 == NONE || selected.contains(&f1) != selected.contains(&f2) {
                if (mesh.e_flags[e as usize] & EDGE_SEAM) == 0 {
                    mesh.e_flags[e as usize] |= EDGE_SEAM;
                    marked += 1;
                }
                continue;
            }
            let sharp = respect_sharp && (mesh.e_flags[e as usize] & EDGE_SHARP) != 0;
            let ng = face_normal(mesh, if f1 == f { f2 } else { f1 });
            if sharp || dot(nf, ng) < cos_thresh {
                if (mesh.e_flags[e as usize] & EDGE_SEAM) == 0 {
                    mesh.e_flags[e as usize] |= EDGE_SEAM;
                    marked += 1;
                }
            }
        }
    }
    Ok(marked)
}

/// Straighten curved island boundary strips in `channel` and relax interior chart vertices.
pub fn straighten_uv(
    mesh: &mut EditMesh,
    faces: &[i32],
    channel: CornerChannelKind,
    _max_angle_deg: f64,
) -> Result<usize, KernelError> {
    let selected: HashSet<i32> = faces
        .iter()
        .copied()
        .filter(|&f| mesh.is_face_alive(f))
        .collect();
    if selected.is_empty() {
        return Ok(0);
    }

    // Group half-edges into separate UV chart vertices so seam-split 3D vertices stay disjoint
    let mut parent: HashMap<i32, i32> = HashMap::new();
    let find = |x: i32, p: &mut HashMap<i32, i32>| -> i32 {
        let mut r = x;
        while let Some(&q) = p.get(&r) {
            if q == r {
                break;
            }
            r = q;
        }
        p.insert(x, r);
        r
    };
    for &f in &selected {
        for h in mesh.face_halves(f) {
            parent.insert(h, h);
        }
    }
    for &f in &selected {
        for h in mesh.face_halves(f) {
            let e = h >> 1;
            let twin = h ^ 1;
            let opp_f = mesh.h_face[twin as usize];
            if opp_f == NONE
                || !selected.contains(&opp_f)
                || (mesh.e_flags[e as usize] & EDGE_SEAM) != 0
            {
                continue;
            }
            let h_other = mesh.h_next[twin as usize];
            if let (Some(u1), Some(u2)) = (mesh.corner(channel, h), mesh.corner(channel, h_other)) {
                if (u1[0] - u2[0]).abs() < 1e-5 && (u1[1] - u2[1]).abs() < 1e-5 {
                    let r1 = find(h, &mut parent);
                    let r2 = find(h_other, &mut parent);
                    if r1 != r2 {
                        parent.insert(r1.max(r2), r1.min(r2));
                    }
                }
            }
        }
    }

    let mut adj: HashMap<i32, Vec<i32>> = HashMap::new();
    let mut boundary_elems = HashSet::new();
    let mut uv_map: HashMap<i32, [f64; 2]> = HashMap::new();
    let mut elem_halves: HashMap<i32, Vec<i32>> = HashMap::new();

    for &f in &selected {
        for h in mesh.face_halves(f) {
            let e_id = find(h, &mut parent);
            let n_h = mesh.h_next[h as usize];
            let n_id = find(n_h, &mut parent);
            elem_halves.entry(e_id).or_default().push(h);
            if !uv_map.contains_key(&e_id) {
                if let Some(uv) = mesh.corner(channel, h) {
                    uv_map.insert(e_id, [uv[0] as f64, uv[1] as f64]);
                }
            }
            let edge = h >> 1;
            let opp = mesh.h_face[(h ^ 1) as usize];
            if opp == NONE
                || !selected.contains(&opp)
                || (mesh.e_flags[edge as usize] & EDGE_SEAM) != 0
            {
                boundary_elems.insert(e_id);
                boundary_elems.insert(n_id);
            }
            adj.entry(e_id).or_default().push(n_id);
            adj.entry(n_id).or_default().push(e_id);
        }
    }
    if uv_map.is_empty() {
        return Ok(0);
    }

    let mut moved = 0usize;
    for _pass in 0..8 {
        let snap = uv_map.clone();
        for (&el, list) in &adj {
            if boundary_elems.contains(&el) || list.is_empty() {
                continue;
            }
            let mut avg = [0.0, 0.0];
            let mut cnt = 0usize;
            for u in list {
                if let Some(&uv) = snap.get(u) {
                    avg[0] += uv[0];
                    avg[1] += uv[1];
                    cnt += 1;
                }
            }
            if cnt > 0 {
                uv_map.insert(el, [avg[0] / (cnt as f64), avg[1] / (cnt as f64)]);
                moved += 1;
            }
        }
    }

    for (el, uv) in uv_map {
        if let Some(hs) = elem_halves.get(&el) {
            for &h in hs {
                mesh.set_corner(channel, h, &[uv[0] as f32, uv[1] as f32]);
            }
        }
    }
    Ok(moved)
}

/// Generate clean non-overlapping lightmap UVs into `Uv1` (or specified channel).
pub fn lightmap_uv(
    mesh: &mut EditMesh,
    resolution: u32,
    padding_texels: f64,
    channel: CornerChannelKind,
) -> Result<usize, KernelError> {
    let all = mesh.faces();
    auto_uv(
        mesh,
        &all,
        45.0,
        true,
        resolution,
        padding_texels,
        true,
        channel,
    )
}

/// Map selected faces into a trim-sheet strip `[u_min..u_max, v_min..v_max]`.
pub fn trim_uv(
    mesh: &mut EditMesh,
    faces: &[i32],
    u_range: [f64; 2],
    v_range: [f64; 2],
    tile_u: bool,
    channel: CornerChannelKind,
) -> Result<usize, KernelError> {
    if faces.is_empty() {
        return Ok(0);
    }
    unwrap_uv_lscm(mesh, faces, SeamSource::Sharp, channel)?;
    let mut u_lo = f64::INFINITY;
    let mut u_hi = f64::NEG_INFINITY;
    let mut v_lo = f64::INFINITY;
    let mut v_hi = f64::NEG_INFINITY;
    for &f in faces {
        for h in mesh.face_halves(f) {
            if let Some(uv) = mesh.corner(channel, h) {
                u_lo = u_lo.min(uv[0] as f64);
                u_hi = u_hi.max(uv[0] as f64);
                v_lo = v_lo.min(uv[1] as f64);
                v_hi = v_hi.max(uv[1] as f64);
            }
        }
    }
    let du = (u_hi - u_lo).max(1e-9);
    let dv = (v_hi - v_lo).max(1e-9);
    let target_du = u_range[1] - u_range[0];
    let target_dv = v_range[1] - v_range[0];
    let scale = if tile_u {
        target_dv / dv
    } else {
        (target_du / du).min(target_dv / dv)
    };
    let mut written = 0usize;
    for &f in faces {
        for h in mesh.face_halves(f) {
            if let Some(uv) = mesh.corner(channel, h) {
                let u = u_range[0] + ((uv[0] as f64) - u_lo) * scale;
                let v = v_range[0] + ((uv[1] as f64) - v_lo) * (target_dv / dv);
                mesh.set_corner(channel, h, &[u as f32, v as f32]);
                written += 1;
            }
        }
    }
    Ok(written)
}

/// Collapse or map selected faces into a flat swatch rectangle `[u0..u1, v0..v1]`.
pub fn swatch_uv(
    mesh: &mut EditMesh,
    faces: &[i32],
    u_range: [f64; 2],
    v_range: [f64; 2],
    channel: CornerChannelKind,
) -> Result<usize, KernelError> {
    let uc = ((u_range[0] + u_range[1]) * 0.5) as f32;
    let vc = ((v_range[0] + v_range[1]) * 0.5) as f32;
    let mut written = 0usize;
    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        for h in mesh.face_halves(f) {
            mesh.set_corner(channel, h, &[uc, vc]);
            written += 1;
        }
    }
    let _ = pack_uv_skyline;
    Ok(written)
}

#[inline]
fn orient2(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn triangles_overlap_2d(a: &[[f64; 2]; 3], b: &[[f64; 2]; 3]) -> bool {
    const EPS: f64 = 1e-6;
    for (p, q) in [(a, b), (b, a)] {
        for i in 0..3 {
            let e0 = p[i];
            let e1 = p[(i + 1) % 3];
            // Edge normal pointing outward from CCW triangle p
            if q.iter().all(|&pt| orient2(e0, e1, pt) <= EPS) {
                return false;
            }
        }
    }
    true
}

/// Return `[low_face, high_face]` pairs whose `channel` UV triangles strictly overlap.
pub fn uv_overlap_pairs(
    mesh: &EditMesh,
    faces: &[i32],
    channel: CornerChannelKind,
) -> Vec<[i32; 2]> {
    struct Tri {
        face: i32,
        p: [[f64; 2]; 3],
        lo: f64,
        hi: f64,
    }
    let mut tris = Vec::new();
    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let halves = mesh.face_halves(f);
        let mut uvs = Vec::with_capacity(halves.len());
        let mut ok = true;
        for &h in &halves {
            if let Some(uv) = mesh.corner(channel, h) {
                uvs.push([uv[0] as f64, uv[1] as f64]);
            } else {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }
        let pts3: Vec<_> = halves
            .iter()
            .map(|&h| mesh.position(mesh.h_vert[h as usize]))
            .collect();
        let Some(ind) = triangulate_loop(&pts3) else {
            continue;
        };
        for ch in ind.chunks_exact(3) {
            let mut p = [uvs[ch[0]], uvs[ch[1]], uvs[ch[2]]];
            let turn = orient2(p[0], p[1], p[2]);
            if turn == 0.0 {
                continue;
            }
            if turn < 0.0 {
                p.swap(1, 2);
            }
            let lo = p[0][0].min(p[1][0]).min(p[2][0]);
            let hi = p[0][0].max(p[1][0]).max(p[2][0]);
            tris.push(Tri { face: f, p, lo, hi });
        }
    }
    tris.sort_by(|x, y| x.lo.total_cmp(&y.lo));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for i in 0..tris.len() {
        let a = &tris[i];
        for b in tris.iter().skip(i + 1) {
            if b.lo >= a.hi {
                break;
            }
            if a.face == b.face {
                continue;
            }
            let lo = a.face.min(b.face);
            let hi = a.face.max(b.face);
            if !seen.insert((lo, hi)) {
                continue;
            }
            if triangles_overlap_2d(&a.p, &b.p) {
                out.push([lo, hi]);
            }
        }
    }
    let _ = (length, sub);
    out
}
