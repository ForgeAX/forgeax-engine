//! Wave 2 modeling operators: `offset`, `mirror`, `weld`, `flip_faces`, `delete_faces`.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{add, dot, face_normal, length, scale, sub, Vec3};
use crate::mesh::{CornerChannelKind, EditMesh, CHANNEL_COUNT, FACE_MIRRORED, NONE};
use crate::ops::primitives::{mark_role, set_edge_flags_between};
use crate::ops::region::{extrude_region_pub, region_groups, RegionMode};

const OFFSET_MITER_LIMIT: f64 = 4.0;

/// Least-squares plane-offset solver using 3x3 Jacobi eigendecomposition
/// (exact parity with `@forgeax/engine-modeling`'s `planeOffset`).
pub fn plane_offset(normals: &[Vec3], distance: f64) -> Vec3 {
    let mut a = [0.0f64; 9];
    let mut b = [0.0f64; 3];
    for n in normals {
        for i in 0..3 {
            b[i] += distance * n[i];
            for j in 0..3 {
                a[i * 3 + j] += n[i] * n[j];
            }
        }
    }
    let mut v = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    const PAIRS: [(usize, usize); 3] = [(0, 1), (0, 2), (1, 2)];
    for _ in 0..32 {
        let off: f64 = PAIRS.iter().map(|&(p, q)| a[p * 3 + q].abs()).sum();
        if off < 1e-15 {
            break;
        }
        for &(p, q) in &PAIRS {
            let apq = a[p * 3 + q];
            if apq.abs() < 1e-300 {
                continue;
            }
            let theta = (a[q * 3 + q] - a[p * 3 + p]) / (2.0 * apq);
            let sign = if theta < 0.0 { -1.0 } else { 1.0 };
            let t = sign / (theta.abs() + (theta * theta + 1.0).sqrt());
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            for k in 0..3 {
                let akp = a[k * 3 + p];
                let akq = a[k * 3 + q];
                a[k * 3 + p] = c * akp - s * akq;
                a[k * 3 + q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let apk = a[p * 3 + k];
                let aqk = a[q * 3 + k];
                a[p * 3 + k] = c * apk - s * aqk;
                a[q * 3 + k] = s * apk + c * aqk;
            }
            for k in 0..3 {
                let vkp = v[k * 3 + p];
                let vkq = v[k * 3 + q];
                v[k * 3 + p] = c * vkp - s * vkq;
                v[k * 3 + q] = s * vkp + c * vkq;
            }
        }
    }
    let eigen = [a[0], a[4], a[8]];
    let max_eig = eigen[0].max(eigen[1]).max(eigen[2]);
    let cutoff = max_eig * 1e-9;
    let mut x = [0.0f64; 3];
    for k in 0..3 {
        let lambda = eigen[k];
        if lambda <= cutoff {
            continue;
        }
        let col = [v[k], v[3 + k], v[6 + k]];
        let coeff = dot(col, b) / lambda;
        for i in 0..3 {
            x[i] += coeff * col[i];
        }
    }
    x
}

/// Offset faces so each face plane moves by `distance` along its own normal.
pub fn offset(
    mesh: &mut EditMesh,
    faces: &[i32],
    distance: f64,
    mode: RegionMode,
    label: i32,
) -> Result<(usize, usize), KernelError> {
    if !distance.is_finite() || distance == 0.0 {
        return Err(KernelError::invalid_value(
            "distance",
            "must be finite and non-zero",
        ));
    }
    let mut top_count = 0usize;
    let mut side_count = 0usize;
    let limit = distance.abs() * OFFSET_MITER_LIMIT;
    for group in region_groups(mesh, faces, mode) {
        let mut incident: HashMap<i32, Vec<Vec3>> = HashMap::new();
        for &f in &group {
            let n = face_normal(mesh, f);
            for h in mesh.face_halves(f) {
                incident.entry(mesh.h_vert[h as usize]).or_default().push(n);
            }
        }
        let mut targets: HashMap<i32, Vec3> = HashMap::with_capacity(incident.len());
        for (v, normals) in incident {
            let mut mv = plane_offset(&normals, distance);
            let reach = length(mv);
            if reach > limit {
                mv = scale(mv, limit / reach);
            }
            targets.insert(v, add(mesh.position(v), mv));
        }
        let (moved, walls) = extrude_region_pub(mesh, &group, |v, orig| {
            targets.get(&v).copied().unwrap_or(orig)
        })?;
        mark_role(mesh, &moved, label, "top");
        mark_role(mesh, &walls, label, "side");
        top_count += moved.len();
        side_count += walls.len();
    }
    Ok((top_count, side_count))
}

/// Mirror the whole mesh across an axis plane through the origin (`0=x, 1=y, 2=z`).
pub fn mirror(mesh: &mut EditMesh, axis: u8, weld_distance: f64) -> Result<usize, KernelError> {
    if axis > 2 || !weld_distance.is_finite() || weld_distance < 0.0 {
        return Err(KernelError::invalid_value(
            "mirror",
            "invalid axis or weldDistance",
        ));
    }
    let k = axis as usize;
    let faces = mesh.faces();
    let verts = mesh.vertices();
    let has_pos = verts.iter().any(|&v| mesh.position(v)[k] > weld_distance);
    let has_neg = verts.iter().any(|&v| mesh.position(v)[k] < -weld_distance);
    if has_pos && has_neg {
        return Err(KernelError::precondition(
            "mirror",
            "the mesh lies on both sides of the mirror plane",
        ));
    }
    for &f in &faces {
        if mesh
            .face_vertices(f)
            .into_iter()
            .all(|v| mesh.position(v)[k].abs() <= weld_distance)
        {
            return Err(KernelError::precondition(
                "mirror",
                "a face lies on the mirror plane",
            ));
        }
    }
    let mut image: HashMap<i32, i32> = HashMap::with_capacity(verts.len());
    for &v in &verts {
        let mut p = mesh.position(v);
        if p[k].abs() <= weld_distance {
            p[k] = 0.0;
            mesh.set_position(v, p[0], p[1], p[2]);
            image.insert(v, v);
        } else {
            p[k] = -p[k];
            image.insert(v, mesh.add_vertex(p[0], p[1], p[2])?);
        }
    }

    let scratch = mesh.clone();
    let mut copies = Vec::with_capacity(faces.len());
    for &f in &faces {
        let lp = scratch.face_vertices(f);
        let halves = scratch.face_halves(f);
        let rev_lp: Vec<i32> = lp.iter().rev().map(|v| image[v]).collect();
        let rev_halves: Vec<i32> = halves.iter().rev().copied().collect();
        let g = mesh.add_face(&rev_lp, 0)?;
        scratch.copy_face_attributes_to(f, mesh, g);
        mesh.f_flags[g as usize] |= FACE_MIRRORED;
        let new_halves = mesh.face_halves(g);
        for (i, &nh) in new_halves.iter().enumerate() {
            for kind in CornerChannelKind::ALL {
                if let Some(val) = scratch.corner(kind, rev_halves[i]) {
                    mesh.set_corner(kind, nh, val);
                }
            }
        }
        copies.push(g);
    }

    for e in scratch.edges() {
        let ef = scratch.e_flags[e as usize];
        if ef == 0 {
            continue;
        }
        let [a, b] = scratch.edge_vertices(e);
        set_edge_flags_between(mesh, image[&a], image[&b], ef);
    }
    Ok(copies.len())
}

/// Merge vertices within `distance` (spatial hash, deterministic ascending order).
/// Returns `(merged_vertex_count, collapsed_face_count)`.
pub fn weld(mesh: &mut EditMesh, distance: f64) -> Result<(usize, usize), KernelError> {
    if !distance.is_finite() || distance <= 0.0 {
        return Err(KernelError::invalid_value(
            "distance",
            "must be finite and > 0",
        ));
    }
    let cell = |x: f64| (x / distance).floor() as i64;
    let mut buckets: HashMap<(i64, i64, i64), Vec<i32>> = HashMap::new();
    let mut target: HashMap<i32, i32> = HashMap::new();
    let mut merged = 0usize;

    for v in mesh.vertices() {
        let p = mesh.position(v);
        let (ix, iy, iz) = (cell(p[0]), cell(p[1]), cell(p[2]));
        let mut found = NONE;
        'search: for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = buckets.get(&(ix + dx, iy + dy, iz + dz)) {
                        for &u in list {
                            if length(sub(mesh.position(u), p)) <= distance {
                                found = u;
                                break 'search;
                            }
                        }
                    }
                }
            }
        }
        if found == NONE {
            buckets.entry((ix, iy, iz)).or_default().push(v);
            target.insert(v, v);
        } else {
            target.insert(v, found);
            merged += 1;
        }
    }
    if merged == 0 {
        return Err(KernelError::precondition(
            "weld",
            "weld merges at least one vertex pair within distance",
        ));
    }

    let scratch = mesh.clone();
    let faces = mesh.faces();
    let saved_edges: Vec<([i32; 2], u8)> = mesh
        .edges()
        .into_iter()
        .filter_map(|e| {
            let ef = mesh.e_flags[e as usize];
            if ef == 0 {
                None
            } else {
                Some((mesh.edge_vertices(e), ef))
            }
        })
        .collect();
    for &f in &faces {
        mesh.remove_face(f);
    }

    let mut collapsed = 0usize;
    for &f in &faces {
        let src_verts = scratch.face_vertices(f);
        let src_halves = scratch.face_halves(f);
        let mut lp: Vec<i32> = Vec::with_capacity(src_verts.len());
        let mut corners: Vec<i32> = Vec::with_capacity(src_verts.len());
        for i in 0..src_verts.len() {
            let v = target[&src_verts[i]];
            if lp.last() == Some(&v) {
                continue;
            }
            lp.push(v);
            corners.push(src_halves[i]);
        }
        if lp.len() > 1 && lp.first() == lp.last() {
            lp.pop();
            corners.pop();
        }
        if lp.len() < 3 {
            collapsed += 1;
            continue;
        }
        let g = mesh.add_face(&lp, 0)?;
        scratch.copy_face_attributes_to(f, mesh, g);
        let dst_halves = mesh.face_halves(g);
        for (i, &dh) in dst_halves.iter().enumerate() {
            for kind in CornerChannelKind::ALL {
                if let Some(val) = scratch.corner(kind, corners[i]) {
                    mesh.set_corner(kind, dh, val);
                }
            }
        }
    }

    for ([a, b], ef) in saved_edges {
        set_edge_flags_between(mesh, target[&a], target[&b], ef);
    }
    for (v, t) in target {
        if v != t {
            mesh.remove_vertex(v);
        }
    }
    let _ = CHANNEL_COUNT;
    Ok((merged, collapsed))
}

pub fn flip_faces(mesh: &mut EditMesh, faces: &[i32]) -> Result<usize, KernelError> {
    let scratch = mesh.clone();
    for &f in faces {
        mesh.remove_face(f);
    }
    for &f in faces {
        let mut lp = scratch.face_vertices(f);
        let mut corners = scratch.face_halves(f);
        lp.reverse();
        corners.reverse();
        let g = mesh.add_face(&lp, 0)?;
        scratch.copy_face_attributes_to(f, mesh, g);
        let dst_halves = mesh.face_halves(g);
        for (i, &dh) in dst_halves.iter().enumerate() {
            for kind in CornerChannelKind::ALL {
                if let Some(val) = scratch.corner(kind, corners[i]) {
                    mesh.set_corner(kind, dh, val);
                }
            }
        }
    }
    Ok(faces.len())
}

pub fn delete_faces(mesh: &mut EditMesh, faces: &[i32]) -> Result<usize, KernelError> {
    let mut touched = HashSet::new();
    for &f in faces {
        for v in mesh.face_vertices(f) {
            touched.insert(v);
        }
    }
    for &f in faces {
        mesh.remove_face(f);
    }
    let mut used = HashSet::new();
    for f in mesh.faces() {
        for v in mesh.face_vertices(f) {
            used.insert(v);
        }
    }
    for v in touched {
        if !used.contains(&v) {
            mesh.remove_vertex(v);
        }
    }
    Ok(faces.len())
}
