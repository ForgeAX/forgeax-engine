//! Mesh assembly and utility operators: `append_mesh`, `array_faces`, `fill_holes`, and `taper_faces`.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{add, cross, dot, length, normalize, scale, sub, Vec3};
use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SHARP, NONE};

use super::primitives::{mark_edge_flags, Attribution};

/// Copy all live faces/vertices/attributes/channels/edge-flags from `source` into `dst`.
pub fn append_mesh(
    dst: &mut EditMesh,
    source: &EditMesh,
    translate: Vec3,
    attribution: Attribution,
) -> Result<usize, KernelError> {
    for c in translate {
        if !c.is_finite() {
            return Err(KernelError::invalid_value(
                "translate",
                "translate must be finite",
            ));
        }
    }
    let src_faces = source.faces();
    if src_faces.is_empty() {
        return Err(KernelError::precondition(
            "source",
            "appended mesh has no faces",
        ));
    }

    let mut v_map: Vec<i32> = vec![NONE; source.vertex_high_water as usize];
    for v in 0..source.vertex_high_water {
        if !source.is_vertex_alive(v) {
            continue;
        }
        let p = add(source.position(v), translate);
        let nv = dst.add_vertex(p[0], p[1], p[2])?;
        v_map[v as usize] = nv;
    }

    let tag_map: Vec<i32> = source
        .tag_names
        .iter()
        .map(|name| dst.tag_index(name, true))
        .collect();
    let mat_map: Vec<i32> = source
        .material_names
        .iter()
        .map(|name| dst.name_index_material(name))
        .collect();
    let label_map: Vec<i32> = source
        .label_names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            if i == 0 {
                0
            } else {
                dst.name_index_label(name)
            }
        })
        .collect();
    let role_map: Vec<i32> = source
        .role_names
        .iter()
        .enumerate()
        .map(|(i, name)| if i == 0 { 0 } else { dst.name_index_role(name) })
        .collect();
    let part_role = if attribution.label != 0 {
        dst.name_index_role("part")
    } else {
        0
    };
    let active_channels: Vec<CornerChannelKind> = CornerChannelKind::ALL
        .into_iter()
        .filter(|&k| source.channels[k as usize].is_some())
        .collect();

    let mut mapped_loop: Vec<i32> = Vec::with_capacity(8);
    let mut from_halves: Vec<i32> = Vec::with_capacity(8);
    for &f in &src_faces {
        mapped_loop.clear();
        from_halves.clear();
        let start = source.f_half[f as usize];
        let mut h = start;
        loop {
            from_halves.push(h);
            mapped_loop.push(v_map[source.h_vert[h as usize] as usize]);
            h = source.h_next[h as usize];
            if h == start || h == NONE {
                break;
            }
        }
        let mat_idx = source.f_material[f as usize] as usize;
        let dst_mat = mat_map.get(mat_idx).copied().unwrap_or(0);
        let g = dst.add_face(&mapped_loop, dst_mat)?;
        dst.f_flags[g as usize] = source.f_flags[f as usize];

        if attribution.label != 0 {
            dst.f_label[g as usize] = attribution.label;
            dst.f_role[g as usize] = part_role;
        } else if source.f_label[f as usize] != 0 {
            let li = source.f_label[f as usize] as usize;
            let ri = source.f_role[f as usize] as usize;
            dst.f_label[g as usize] = label_map.get(li).copied().unwrap_or(0);
            dst.f_role[g as usize] = role_map.get(ri).copied().unwrap_or(0);
        }

        for (ti, &dst_ti) in tag_map.iter().enumerate() {
            if source.has_tag(f, ti as i32) {
                dst.add_tag(g, dst_ti);
            }
        }
        if attribution.tag >= 0 {
            dst.add_tag(g, attribution.tag);
        }

        if !active_channels.is_empty() {
            let mut th = dst.f_half[g as usize];
            for &fh in &from_halves {
                for &kind in &active_channels {
                    if let Some(val) = source.corner(kind, fh) {
                        dst.set_corner(kind, th, val);
                    }
                }
                th = dst.h_next[th as usize];
            }
        }
    }

    // Copy edge flags (EDGE_SHARP / EDGE_SEAM) directly over alive edges
    let edge_hw = (source.half_high_water / 2) as usize;
    for e in 0..edge_hw {
        let flags = source.e_flags[e];
        if flags == 0 {
            continue;
        }
        let a = source.h_vert[e * 2];
        let b = source.h_vert[e * 2 + 1];
        if a == NONE || b == NONE {
            continue;
        }
        let na = v_map[a as usize];
        let nb = v_map[b as usize];
        if na != NONE && nb != NONE {
            let th = dst.find_half(na, nb);
            if th != NONE {
                dst.e_flags[(th >> 1) as usize] |= flags;
            }
        }
    }

    Ok(src_faces.len())
}

#[derive(Debug, Clone, Copy)]
pub enum ArrayMode {
    Linear {
        count: u32,
        offset: Vec3,
    },
    Radial {
        count: u32,
        axis: Vec3,
        angle_deg: f64,
        center: Vec3,
    },
}

fn rotate_about_axis(p: Vec3, axis: Vec3, degrees: f64, center: Vec3) -> Vec3 {
    let rad = (degrees % 360.0).to_radians();
    let c = rad.cos();
    let s = rad.sin();
    let [x, y, z] = axis;
    let k = 1.0 - c;
    let d = sub(p, center);
    let rx = (c + x * x * k) * d[0] + (x * y * k - z * s) * d[1] + (x * z * k + y * s) * d[2];
    let ry = (y * x * k + z * s) * d[0] + (c + y * y * k) * d[1] + (y * z * k - x * s) * d[2];
    let rz = (z * x * k - y * s) * d[0] + (z * y * k + x * s) * d[1] + (c + z * z * k) * d[2];
    [rx + center[0], ry + center[1], rz + center[2]]
}

/// Duplicate selected faces in a linear or radial array, tagging copy `i` with `<prefix>:<i>`.
pub fn array_faces(
    mesh: &mut EditMesh,
    faces: &[i32],
    mode: ArrayMode,
    prefix: &str,
    attribution: Attribution,
) -> Result<usize, KernelError> {
    if faces.is_empty() {
        return Err(KernelError::selection_empty("faces", "no faces selected"));
    }
    let count = match mode {
        ArrayMode::Linear { count, .. } | ArrayMode::Radial { count, .. } => count,
    };
    if count < 2 {
        return Err(KernelError::invalid_value(
            "count",
            "array count must be >= 2",
        ));
    }

    // Collect original face data cleanly before mutating
    struct SavedFace {
        loop_verts: Vec<i32>,
        material: i32,
        label: i32,
        role: i32,
        flags: u8,
        tags: Vec<u32>,
        corners: Vec<Vec<(CornerChannelKind, Vec<f32>)>>,
    }

    let mut orig_verts: Vec<i32> = Vec::new();
    let mut seen_v: HashSet<i32> = HashSet::new();
    let mut saved: Vec<SavedFace> = Vec::with_capacity(faces.len());
    let mut saved_edges: Vec<(i32, i32, u8)> = Vec::new();

    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let lp = mesh.face_vertices(f);
        let halves = mesh.face_halves(f);
        for &v in &lp {
            if seen_v.insert(v) {
                orig_verts.push(v);
            }
        }
        for i in 0..lp.len() {
            let a = lp[i];
            let b = lp[(i + 1) % lp.len()];
            let h = mesh.find_half(a, b);
            if h != NONE {
                let ef = mesh.e_flags[(h >> 1) as usize];
                if ef != 0 {
                    saved_edges.push((a, b, ef));
                }
            }
        }
        let tw = mesh.tag_words;
        let tags = if tw > 0 {
            mesh.f_tags[(f as usize) * tw..(f as usize + 1) * tw].to_vec()
        } else {
            Vec::new()
        };
        let mut corners = Vec::with_capacity(halves.len());
        for &h in &halves {
            let mut list = Vec::new();
            for kind in CornerChannelKind::ALL {
                if let Some(val) = mesh.corner(kind, h) {
                    list.push((kind, val.to_vec()));
                }
            }
            corners.push(list);
        }
        saved.push(SavedFace {
            loop_verts: lp,
            material: mesh.f_material[f as usize],
            label: mesh.f_label[f as usize],
            role: mesh.f_role[f as usize],
            flags: mesh.f_flags[f as usize],
            tags,
            corners,
        });
    }

    let orig_pos: HashMap<i32, Vec3> = orig_verts.iter().map(|&v| (v, mesh.position(v))).collect();
    let copy_role = if attribution.label != 0 {
        mesh.name_index_role("copy")
    } else {
        0
    };

    // Tag copy 0 (original faces)
    let tag0 = mesh.tag_index(&format!("{prefix}:0"), true);
    for &f in faces {
        if mesh.is_face_alive(f) {
            mesh.add_tag(f, tag0);
            if attribution.tag >= 0 {
                mesh.add_tag(f, attribution.tag);
            }
        }
    }

    let mut total_added = 0usize;
    for i in 1..count {
        let tag_i = mesh.tag_index(&format!("{prefix}:{i}"), true);
        let mut v_map: HashMap<i32, i32> = HashMap::with_capacity(orig_verts.len());
        for &v in &orig_verts {
            let p = orig_pos[&v];
            let np = match mode {
                ArrayMode::Linear { offset, .. } => add(p, scale(offset, i as f64)),
                ArrayMode::Radial {
                    axis,
                    angle_deg,
                    center,
                    ..
                } => {
                    let u_axis = normalize(axis);
                    let step = if (angle_deg - 360.0).abs() < 1e-12 {
                        360.0 / (count as f64)
                    } else {
                        angle_deg / ((count - 1) as f64)
                    };
                    rotate_about_axis(p, u_axis, step * (i as f64), center)
                }
            };
            let nv = mesh.add_vertex(np[0], np[1], np[2])?;
            v_map.insert(v, nv);
        }

        for sf in &saved {
            let mapped: Vec<i32> = sf.loop_verts.iter().map(|v| v_map[v]).collect();
            let nf = mesh.add_face(&mapped, sf.material)?;
            mesh.f_flags[nf as usize] = sf.flags;
            if attribution.label != 0 {
                mesh.f_label[nf as usize] = attribution.label;
                mesh.f_role[nf as usize] = copy_role;
            } else {
                mesh.f_label[nf as usize] = sf.label;
                mesh.f_role[nf as usize] = sf.role;
            }
            let tw = mesh.tag_words;
            for w in 0..sf.tags.len().min(tw) {
                mesh.f_tags[(nf as usize) * tw + w] |= sf.tags[w];
            }
            mesh.add_tag(nf, tag_i);
            if attribution.tag >= 0 {
                mesh.add_tag(nf, attribution.tag);
            }
            let nhalves = mesh.face_halves(nf);
            for (ci, list) in sf.corners.iter().enumerate() {
                let th = nhalves[ci];
                for (kind, val) in list {
                    mesh.set_corner(*kind, th, val);
                }
            }
            total_added += 1;
        }

        for &(a, b, ef) in &saved_edges {
            let h = mesh.find_half(v_map[&a], v_map[&b]);
            if h != NONE {
                mesh.e_flags[(h >> 1) as usize] |= ef;
            }
        }
    }

    Ok(total_added)
}

/// Trace closed boundary loops from selected boundary edges and fill each loop with an n-gon cap.
pub fn fill_holes(
    mesh: &mut EditMesh,
    edges: &[i32],
    material: Option<i32>,
    attribution: Attribution,
) -> Result<usize, KernelError> {
    if edges.is_empty() {
        return Err(KernelError::selection_empty("edges", "no edges selected"));
    }
    // Collect free (faceless) directed half-edges (u -> v) along selected boundary edges
    let mut outgoing: HashMap<i32, Vec<i32>> = HashMap::new();
    let mut free_edges: Vec<(i32, i32)> = Vec::new();
    let mut seen_e: HashSet<i32> = HashSet::new();
    for &e in edges {
        if !seen_e.insert(e) || !mesh.is_edge_alive(e) {
            continue;
        }
        let h0 = e * 2;
        let h1 = h0 + 1;
        let f0 = mesh.h_face[h0 as usize];
        let f1 = mesh.h_face[h1 as usize];
        let free_h = if f0 == NONE && f1 != NONE {
            h0
        } else if f1 == NONE && f0 != NONE {
            h1
        } else {
            return Err(KernelError::precondition(
                "edges",
                "every selected edge must be a boundary edge",
            ));
        };
        let u = mesh.h_vert[free_h as usize];
        let v = mesh.h_vert[(free_h ^ 1) as usize];
        outgoing.entry(u).or_default().push(v);
        free_edges.push((u, v));
    }

    // Walk closed directed loops
    let mut visited: HashSet<(i32, i32)> = HashSet::new();
    let mut loops: Vec<Vec<i32>> = Vec::new();
    for &(su, sv) in &free_edges {
        if visited.contains(&(su, sv)) {
            continue;
        }
        let mut lp = vec![su];
        let mut cur_u = su;
        let mut cur_v = sv;
        loop {
            visited.insert((cur_u, cur_v));
            if cur_v == su {
                break;
            }
            lp.push(cur_v);
            let next_v = outgoing.get(&cur_v).and_then(|list| {
                list.iter()
                    .copied()
                    .find(|&nv| !visited.contains(&(cur_v, nv)))
            });
            match next_v {
                Some(nv) => {
                    cur_u = cur_v;
                    cur_v = nv;
                }
                None => {
                    return Err(KernelError::precondition(
                        "edges",
                        "selected boundary edges do not form closed loops",
                    ));
                }
            }
            if lp.len() > free_edges.len() + 1 {
                return Err(KernelError::precondition(
                    "edges",
                    "degenerate boundary loop",
                ));
            }
        }
        if lp.len() >= 3 {
            loops.push(lp);
        }
    }

    let cap_role = if attribution.label != 0 {
        mesh.name_index_role("cap")
    } else {
        0
    };
    let mut created = 0usize;
    let mut rim_edges: Vec<i32> = Vec::new();

    for lp in &loops {
        let mut rim_faces = Vec::with_capacity(lp.len());
        let mut mat_set: HashSet<i32> = HashSet::new();
        for i in 0..lp.len() {
            let a = lp[i];
            let b = lp[(i + 1) % lp.len()];
            let th = mesh.find_half(b, a);
            if th != NONE {
                let rf = mesh.h_face[th as usize];
                if rf != NONE {
                    rim_faces.push(rf);
                    mat_set.insert(mesh.f_material[rf as usize]);
                }
            }
        }
        let mat = match material {
            Some(m) => m,
            None => {
                if mat_set.len() > 1 {
                    return Err(KernelError::invalid_value(
                        "material",
                        "cap material is ambiguous across rim slots",
                    ));
                }
                mat_set.into_iter().next().unwrap_or(0)
            }
        };
        let f = mesh.add_face(lp, mat)?;
        if attribution.label != 0 {
            mesh.f_label[f as usize] = attribution.label;
            mesh.f_role[f as usize] = cap_role;
        }
        // Inherit tags shared by all rim faces
        let tw = mesh.tag_words;
        if !rim_faces.is_empty() && tw > 0 {
            for w in 0..tw {
                let mut mask = u32::MAX;
                for &rf in &rim_faces {
                    mask &= mesh.f_tags[(rf as usize) * tw + w];
                }
                mesh.f_tags[(f as usize) * tw + w] = mask;
            }
        }
        if attribution.tag >= 0 {
            mesh.add_tag(f, attribution.tag);
        }
        for i in 0..lp.len() {
            let h = mesh.find_half(lp[i], lp[(i + 1) % lp.len()]);
            if h != NONE {
                rim_edges.push(h >> 1);
            }
        }
        created += 1;
    }
    mark_edge_flags(mesh, &rim_edges, EDGE_SHARP, true);
    Ok(created)
}

/// Taper vertices of `faces` along `axis` (0=X,1=Y,2=Z), scaling axes in `scale_axes_mask`
/// from 1.0 at `range[0]` to `factor` at `range[1]` about `origin`.
pub fn taper_faces(
    mesh: &mut EditMesh,
    faces: &[i32],
    axis: u8,
    factor: f64,
    scale_axes_mask: u8,
    range: Option<[f64; 2]>,
    origin: Option<Vec3>,
) -> Result<usize, KernelError> {
    if faces.is_empty() {
        return Err(KernelError::selection_empty("faces", "no faces selected"));
    }
    if axis > 2 {
        return Err(KernelError::invalid_value(
            "axis",
            "axis must be 0, 1, or 2",
        ));
    }
    if !factor.is_finite() || factor <= 0.0 || (factor - 1.0).abs() < 1e-15 {
        return Err(KernelError::invalid_value(
            "factor",
            "factor must be positive and != 1",
        ));
    }
    let a = axis as usize;
    let mask = if scale_axes_mask == 0 {
        0b111 & !(1u8 << a)
    } else {
        scale_axes_mask
    };
    if (mask & (1u8 << a)) != 0 || (mask & 0b111) == 0 {
        return Err(KernelError::invalid_value(
            "axes",
            "axes must list perpendicular axes only",
        ));
    }

    let mut verts: Vec<i32> = Vec::new();
    let mut seen: HashSet<i32> = HashSet::new();
    let mut bmin = [f64::INFINITY; 3];
    let mut bmax = [f64::NEG_INFINITY; 3];
    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        for v in mesh.face_vertices(f) {
            if seen.insert(v) {
                verts.push(v);
                let p = mesh.position(v);
                for k in 0..3 {
                    bmin[k] = bmin[k].min(p[k]);
                    bmax[k] = bmax[k].max(p[k]);
                }
            }
        }
    }
    if verts.is_empty() {
        return Err(KernelError::selection_empty(
            "vertices",
            "no vertices selected",
        ));
    }
    let [r0, r1] = range.unwrap_or([bmin[a], bmax[a]]);
    let span = r1 - r0;
    if span.abs() <= 1e-12 {
        return Err(KernelError::degenerate(
            "range",
            "taper range has zero extent",
        ));
    }
    let orig = origin.unwrap_or([
        0.5 * (bmin[0] + bmax[0]),
        0.5 * (bmin[1] + bmax[1]),
        0.5 * (bmin[2] + bmax[2]),
    ]);

    for &v in &verts {
        let p = mesh.position(v);
        let t = ((p[a] - r0) / span).clamp(0.0, 1.0);
        let k = 1.0 + (factor - 1.0) * t;
        let mut q = p;
        for c in 0..3 {
            if (mask & (1u8 << c)) != 0 {
                q[c] = orig[c] + k * (p[c] - orig[c]);
            }
        }
        mesh.set_position(v, q[0], q[1], q[2]);
    }
    let _ = (cross, dot, length);
    Ok(verts.len())
}
