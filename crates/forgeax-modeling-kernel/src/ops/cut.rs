//! Cutting, bridging, duplication, disconnection, loop-cut, shell, layer, knife, and hole operators.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{add, cross, dot, face_normal, length, normalize, scale, sub, Vec3};
use crate::mesh::rewrite::{rewrite_faces, triangulate_loop, CornerSource, FaceRewrite};
use crate::mesh::{EditMesh, EDGE_SHARP, NONE};
use crate::ops::boolean::{boolean_op, BooleanOp};
use crate::ops::primitives::{add_attributed_faces, append_cylinder, mark_role, Attribution};
use crate::ops::wave2::{flip_faces, plane_offset};

pub fn duplicate_faces(
    mesh: &mut EditMesh,
    faces: &[i32],
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if faces.is_empty() {
        return Err(KernelError::no_effect("duplicate", "no faces selected"));
    }
    let mut vert_copy = HashMap::new();
    let mut created = Vec::with_capacity(faces.len());
    let words = mesh.tag_words;
    let role_idx = if attr.label == 0 {
        0
    } else {
        mesh.name_index_role("copy")
    };

    struct Snap {
        verts: Vec<i32>,
        mat: i32,
        label: i32,
        role: i32,
        flags: u8,
        tags: Vec<u32>,
    }
    let mut snaps = Vec::with_capacity(faces.len());
    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let fv = mesh.face_vertices(f);
        let fu = f as usize;
        for &v in &fv {
            if !vert_copy.contains_key(&v) {
                let p = mesh.position(v);
                vert_copy.insert(v, mesh.add_vertex(p[0], p[1], p[2])?);
            }
        }
        snaps.push(Snap {
            verts: fv,
            mat: mesh.f_material[fu],
            label: mesh.f_label[fu],
            role: mesh.f_role[fu],
            flags: mesh.f_flags[fu],
            tags: mesh.f_tags[fu * words..(fu + 1) * words].to_vec(),
        });
    }
    for s in snaps {
        let mapped: Vec<i32> = s.verts.iter().map(|v| vert_copy[v]).collect();
        let nf = mesh.add_face(&mapped, s.mat)?;
        let nfu = nf as usize;
        mesh.f_label[nfu] = if attr.label != 0 { attr.label } else { s.label };
        mesh.f_role[nfu] = if attr.label != 0 { role_idx } else { s.role };
        mesh.f_flags[nfu] = s.flags;
        for w in 0..words {
            mesh.f_tags[nfu * words + w] = s.tags[w];
        }
        if attr.tag >= 0 {
            mesh.add_tag(nf, attr.tag);
        }
        created.push(nf);
    }
    Ok(created)
}

pub fn disconnect_faces(mesh: &mut EditMesh, faces: &[i32]) -> Result<usize, KernelError> {
    let selected: HashSet<i32> = faces
        .iter()
        .copied()
        .filter(|&f| mesh.is_face_alive(f))
        .collect();
    if selected.is_empty() {
        return Err(KernelError::no_effect("disconnect", "no faces selected"));
    }
    let mut shared = HashMap::new();
    for &f in &selected {
        for v in mesh.face_vertices(f) {
            if shared.contains_key(&v) {
                continue;
            }
            // Check whether v touches any unselected face
            let mut touches_outside = false;
            for f2 in mesh.faces() {
                if !selected.contains(&f2) && mesh.face_vertices(f2).contains(&v) {
                    touches_outside = true;
                    break;
                }
            }
            if touches_outside {
                let p = mesh.position(v);
                shared.insert(v, mesh.add_vertex(p[0], p[1], p[2])?);
            }
        }
    }
    if shared.is_empty() {
        return Err(KernelError::no_effect(
            "disconnect",
            "selected faces share no vertices with outside faces",
        ));
    }
    let mut rewrites = Vec::new();
    for &f in &selected {
        let halves = mesh.face_halves(f);
        let lp: Vec<CornerSource> = halves
            .iter()
            .map(|&h| {
                let v = mesh.h_vert[h as usize];
                CornerSource::from_corner(shared.get(&v).copied().unwrap_or(v), h)
            })
            .collect();
        rewrites.push(FaceRewrite {
            face: f,
            loops: vec![lp],
        });
    }
    rewrite_faces(mesh, &rewrites)?;
    Ok(shared.len())
}

/// Bridge boundary edge chains with `segments` quad strips.
pub fn bridge_edges(
    mesh: &mut EditMesh,
    edges: &[i32],
    segments: usize,
    attr: Attribution,
) -> Result<usize, KernelError> {
    let boundary: Vec<i32> = edges
        .iter()
        .copied()
        .filter(|&e| mesh.is_edge_alive(e) && mesh.is_boundary_edge(e))
        .collect();
    if boundary.len() < 2 {
        return Err(KernelError::invalid_value(
            "edges",
            "bridge requires boundary edges",
        ));
    }
    // Extract ordered open boundary vertex chains from selected boundary edges
    let mut directed: Vec<(i32, i32)> = Vec::with_capacity(boundary.len());
    for &e in &boundary {
        let h = if mesh.h_face[(e * 2) as usize] == NONE {
            e * 2 + 1
        } else {
            e * 2
        };
        // Opposite orientation of boundary half-edge for the new bridging face
        let a = mesh.h_vert[h as usize];
        let b = mesh.h_vert[mesh.h_next[h as usize] as usize];
        directed.push((b, a));
    }
    // Group into connected components
    let mut chains: Vec<Vec<(i32, i32)>> = Vec::new();
    let mut used = vec![false; directed.len()];
    for i in 0..directed.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut chain = vec![directed[i]];
        loop {
            let mut extended = false;
            for j in 0..directed.len() {
                if used[j] {
                    continue;
                }
                if directed[j].0 == chain.last().unwrap().1 {
                    chain.push(directed[j]);
                    used[j] = true;
                    extended = true;
                    break;
                }
                if directed[j].1 == chain.first().unwrap().0 {
                    chain.insert(0, directed[j]);
                    used[j] = true;
                    extended = true;
                    break;
                }
            }
            if !extended {
                break;
            }
        }
        chains.push(chain);
    }
    if chains.len() != 2 || chains[0].len() != chains[1].len() {
        return Err(KernelError::invalid_value(
            "edges",
            "bridge expects two boundary loops/chains of equal edge count",
        ));
    }

    let n = chains[0].len();
    let ring_a: Vec<i32> = chains[0].iter().map(|&(a, _)| a).collect();
    let ring_b: Vec<i32> = chains[1].iter().map(|&(a, _)| a).collect();
    // Align ring_b in reverse to minimize total distance
    let mut best_off = 0usize;
    let mut best_dist = f64::INFINITY;
    for off in 0..n {
        let mut d = 0.0;
        for i in 0..n {
            let va = ring_a[i];
            let vb = ring_b[(off + n - 1 - i) % n];
            d += length(sub(mesh.position(va), mesh.position(vb)));
        }
        if d < best_dist {
            best_dist = d;
            best_off = off;
        }
    }
    let aligned_b: Vec<i32> = (0..n).map(|i| ring_b[(best_off + n - 1 - i) % n]).collect();
    let is_closed_loop = chains[0].first().unwrap().0 == chains[0].last().unwrap().1
        || chains[0].len() >= 3 && ring_a[0] == chains[0].last().unwrap().1;
    let _ = is_closed_loop;
    let segs = segments.max(1);
    let mut rings: Vec<Vec<i32>> = Vec::with_capacity(segs + 1);
    rings.push(ring_a.clone());
    for s in 1..segs {
        let t = (s as f64) / (segs as f64);
        let mut row = Vec::with_capacity(n);
        for i in 0..n {
            let pa = mesh.position(ring_a[i]);
            let pb = mesh.position(aligned_b[i]);
            let p = add(pa, scale(sub(pb, pa), t));
            row.push(mesh.add_vertex(p[0], p[1], p[2])?);
        }
        rings.push(row);
    }
    rings.push(aligned_b);

    let mut loops = Vec::new();
    for s in 0..segs {
        for i in 0..n {
            let i_next = (i + 1) % n;
            loops.push(vec![
                rings[s][i],
                rings[s][i_next],
                rings[s + 1][i_next],
                rings[s + 1][i],
            ]);
        }
    }
    let created = add_attributed_faces(mesh, &loops, attr, "bridge")?;
    Ok(created.len())
}

/// Split edge rings through seed edges with `cuts` parallel edge loops.
pub fn loop_cut(mesh: &mut EditMesh, seeds: &[i32], cuts: usize) -> Result<usize, KernelError> {
    if cuts < 1 {
        return Err(KernelError::invalid_value("cuts", "must be >= 1"));
    }
    let mut visited_e = HashSet::new();
    let mut crossings: Vec<(i32, i32, i32)> = Vec::new(); // (face, half_in, half_out)
    let mut split_edges: HashMap<i32, Vec<i32>> = HashMap::new(); // edge -> new verts from hVert[2e] to hVert[2e+1]

    for &seed in seeds {
        if !mesh.is_edge_alive(seed) || visited_e.contains(&seed) {
            continue;
        }
        // Walk both directions along even-sided faces (quads)
        for &start_h in &[seed * 2, seed * 2 + 1] {
            let mut h = start_h;
            for _ in 0..4096 {
                let f = mesh.h_face[h as usize];
                if f == NONE {
                    break;
                }
                let e = h >> 1;
                if !visited_e.insert(e) && crossings.iter().any(|c| c.0 == f) {
                    break;
                }
                let halves = mesh.face_halves(f);
                if halves.len() != 4 {
                    break;
                }
                let pos = halves.iter().position(|&x| x == h).unwrap();
                let opp_h = halves[(pos + 2) % 4];
                crossings.push((f, h, opp_h));
                let next_e = opp_h >> 1;
                visited_e.insert(next_e);
                if next_e == seed {
                    break;
                }
                h = opp_h ^ 1;
            }
        }
    }
    if crossings.is_empty() {
        return Err(KernelError::no_effect(
            "loopCut",
            "seed edges do not border quad strips",
        ));
    }

    // Create split vertices along each crossed edge
    for &e in &visited_e {
        let [va, vb] = mesh.edge_vertices(e);
        let pa = mesh.position(va);
        let pb = mesh.position(vb);
        let mut vs = Vec::with_capacity(cuts);
        for c in 1..=cuts {
            let t = (c as f64) / ((cuts + 1) as f64);
            let p = add(pa, scale(sub(pb, pa), t));
            vs.push(mesh.add_vertex(p[0], p[1], p[2])?);
        }
        split_edges.insert(e, vs);
    }

    let mut rewrites = Vec::new();
    let mut seen_f = HashSet::new();
    for (f, h_in, h_out) in crossings {
        if !seen_f.insert(f) {
            continue;
        }
        let halves = mesh.face_halves(f);
        let p_in = halves.iter().position(|&x| x == h_in).unwrap();
        let h0 = halves[p_in];
        let h1 = halves[(p_in + 1) % 4];
        let _ = h_out;
        let h2 = halves[(p_in + 2) % 4];
        let h3 = halves[(p_in + 3) % 4];

        let e_in = h0 >> 1;
        let e_out = h2 >> 1;
        let vs_in = &split_edges[&e_in];
        let vs_out = &split_edges[&e_out];
        let fwd_in = (h0 & 1) == 0;
        let fwd_out = (h2 & 1) == 0;

        let in_list: Vec<i32> = if fwd_in {
            vs_in.clone()
        } else {
            vs_in.iter().copied().rev().collect()
        };
        let out_list: Vec<i32> = if fwd_out {
            vs_out.iter().copied().rev().collect()
        } else {
            vs_out.clone()
        };

        let mut strips = Vec::with_capacity(cuts + 1);
        let mut a0 = CornerSource::from_corner(mesh.h_vert[h0 as usize], h0);
        let mut b0 = CornerSource::from_corner(mesh.h_vert[h3 as usize], h3);
        for k in 0..cuts {
            let t = ((k + 1) as f64) / ((cuts + 1) as f64);
            let a1 = CornerSource::from_interp(in_list[k], h0, mesh.h_next[h0 as usize], t);
            let b1 = CornerSource::from_interp(out_list[k], h2, mesh.h_next[h2 as usize], 1.0 - t);
            strips.push(vec![a0, a1, b1, b0]);
            a0 = a1;
            b0 = b1;
        }
        strips.push(vec![
            a0,
            CornerSource::from_corner(mesh.h_vert[h1 as usize], h1),
            CornerSource::from_corner(mesh.h_vert[h2 as usize], h2),
            b0,
        ]);
        rewrites.push(FaceRewrite {
            face: f,
            loops: strips,
        });
    }
    let created = rewrite_faces(mesh, &rewrites)?;
    Ok(created.into_iter().map(|v| v.len()).sum())
}

/// Slice mesh across plane `(point, normal)`, inserting cut edges on the plane;
/// when `positive_only` is true, removes the negative half and optionally caps the cut loops.
pub fn slice_or_plane_cut(
    mesh: &mut EditMesh,
    point: Vec3,
    normal: Vec3,
    positive_only: bool,
    fill_holes_cap: bool,
    tolerance: f64,
    attr: Attribution,
) -> Result<usize, KernelError> {
    let n = normalize(normal);
    if !(length(n) > 0.0) {
        return Err(KernelError::invalid_value(
            "normal",
            "plane normal cannot be zero",
        ));
    }
    let all_faces = mesh.faces();
    let mut edge_split: HashMap<i32, i32> = HashMap::new();
    let mut rewrites = Vec::new();
    let mut neg_faces = Vec::new();
    let mut boundary_cut_edges: Vec<(i32, i32)> = Vec::new();

    let signed_dist = |p: Vec3| -> f64 { dot(sub(p, point), n) };

    for &f in &all_faces {
        let halves = mesh.face_halves(f);
        let ds: Vec<f64> = halves
            .iter()
            .map(|&h| signed_dist(mesh.position(mesh.h_vert[h as usize])))
            .collect();
        let has_pos = ds.iter().any(|&d| d > tolerance);
        let has_neg = ds.iter().any(|&d| d < -tolerance);
        if !has_pos && has_neg {
            neg_faces.push(f);
            continue;
        }
        if !has_pos || !has_neg {
            continue;
        }

        // Split face across plane
        let mut pos_lp: Vec<CornerSource> = Vec::new();
        let mut neg_lp: Vec<CornerSource> = Vec::new();
        let mut crossings_on_pos: Vec<i32> = Vec::new();

        for i in 0..halves.len() {
            let h = halves[i];
            let nh = halves[(i + 1) % halves.len()];
            let va = mesh.h_vert[h as usize];
            let da = ds[i];
            let db = ds[(i + 1) % halves.len()];
            let cs = CornerSource::from_corner(va, h);
            if da >= -tolerance {
                pos_lp.push(cs);
            }
            if da <= tolerance {
                neg_lp.push(cs);
            }
            if (da > tolerance && db < -tolerance) || (da < -tolerance && db > tolerance) {
                let e = h >> 1;
                let t = da / (da - db);
                let v_mid = match edge_split.get(&e) {
                    Some(&v) => v,
                    None => {
                        let pa = mesh.position(va);
                        let pb = mesh.position(mesh.h_vert[nh as usize]);
                        let pm = add(pa, scale(sub(pb, pa), t));
                        let nv = mesh.add_vertex(pm[0], pm[1], pm[2])?;
                        edge_split.insert(e, nv);
                        nv
                    }
                };
                let cs_m = CornerSource::from_interp(v_mid, h, nh, t);
                pos_lp.push(cs_m);
                neg_lp.push(cs_m);
                crossings_on_pos.push(v_mid);
            }
        }
        if crossings_on_pos.len() == 2 {
            boundary_cut_edges.push((crossings_on_pos[0], crossings_on_pos[1]));
        }
        let mut loops = Vec::new();
        if pos_lp.len() >= 3 {
            loops.push(pos_lp);
        }
        if !positive_only && neg_lp.len() >= 3 {
            loops.push(neg_lp);
        }
        rewrites.push(FaceRewrite { face: f, loops });
    }

    if positive_only {
        for f in neg_faces {
            rewrites.push(FaceRewrite {
                face: f,
                loops: Vec::new(),
            });
        }
    }

    let created = rewrite_faces(mesh, &rewrites)?;
    let cut_faces: usize = created.iter().map(|v| v.len()).sum();

    if positive_only && fill_holes_cap {
        let b_edges: Vec<i32> = mesh
            .edges()
            .into_iter()
            .filter(|&e| {
                if !mesh.is_boundary_edge(e) {
                    return false;
                }
                let [a, b] = mesh.edge_vertices(e);
                signed_dist(mesh.position(a)).abs() <= tolerance * 10.0
                    && signed_dist(mesh.position(b)).abs() <= tolerance * 10.0
            })
            .collect();
        if !b_edges.is_empty() {
            crate::ops::assembly::fill_holes(mesh, &b_edges, Some(attr.material), attr)?;
        }
    }
    let _ = boundary_cut_edges;
    Ok(cut_faces)
}

/// Shell selected faces along their vertex normals by `thickness`, creating inner/outer wall + rim.
pub fn shell_faces(
    mesh: &mut EditMesh,
    faces: &[i32],
    thickness: f64,
    direction: i8, // -1 = in, +1 = out, 0 = both
    attr: Attribution,
) -> Result<usize, KernelError> {
    if !thickness.is_finite() || thickness <= 0.0 {
        return Err(KernelError::invalid_value("thickness", "must be > 0"));
    }
    let selected: HashSet<i32> = faces
        .iter()
        .copied()
        .filter(|&f| mesh.is_face_alive(f))
        .collect();
    if selected.is_empty() {
        return Err(KernelError::no_effect("shell", "no faces selected"));
    }

    // Collect incident face normals per vertex
    let mut v_normals: HashMap<i32, Vec<Vec3>> = HashMap::new();
    for &f in &selected {
        let fn_v = face_normal(mesh, f);
        for v in mesh.face_vertices(f) {
            v_normals.entry(v).or_default().push(fn_v);
        }
    }

    let (d_out, d_in) = match direction {
        1 => (thickness, 0.0),
        0 => (thickness * 0.5, -thickness * 0.5),
        _ => (0.0, -thickness),
    };

    let mut inner_vert: HashMap<i32, i32> = HashMap::new();
    for (&v, ns) in &v_normals {
        let p = mesh.position(v);
        let off_in = plane_offset(ns, d_in);
        let p_in = add(p, off_in);
        let iv = mesh.add_vertex(p_in[0], p_in[1], p_in[2])?;
        inner_vert.insert(v, iv);
        if d_out != 0.0 {
            let off_out = plane_offset(ns, d_out);
            let p_out = add(p, off_out);
            mesh.set_position(v, p_out[0], p_out[1], p_out[2]);
        }
    }

    let mut inner_loops = Vec::with_capacity(selected.len());
    let mut rim_loops = Vec::new();
    for &f in &selected {
        let halves = mesh.face_halves(f);
        let mut rev_lp: Vec<i32> = halves
            .iter()
            .map(|&h| inner_vert[&mesh.h_vert[h as usize]])
            .collect();
        rev_lp.reverse();
        inner_loops.push(rev_lp);

        for &h in &halves {
            let opp = mesh.h_face[(h ^ 1) as usize];
            if opp == NONE || !selected.contains(&opp) {
                let va = mesh.h_vert[h as usize];
                let vb = mesh.h_vert[mesh.h_next[h as usize] as usize];
                rim_loops.push(vec![vb, va, inner_vert[&va], inner_vert[&vb]]);
            }
        }
    }

    let mut total = 0usize;
    let inner_f = add_attributed_faces(mesh, &inner_loops, attr, "inner")?;
    total += inner_f.len();
    if !rim_loops.is_empty() {
        let rim_f = add_attributed_faces(mesh, &rim_loops, attr, "rim")?;
        total += rim_f.len();
        // Mark rim borders sharp
        for &f in &rim_f {
            for h in mesh.face_halves(f) {
                mesh.e_flags[(h >> 1) as usize] |= EDGE_SHARP;
            }
        }
    }
    let _ = flip_faces;
    Ok(total)
}

/// Cut circular cylindrical holes into a planar face along `-face_normal` using boolean difference.
pub fn hole_cut(
    mesh: &mut EditMesh,
    face: i32,
    centers: &[[f64; 2]],
    diameter: f64,
    depth: f64,
    segments: u32,
    attr: Attribution,
    tolerance: f64,
) -> Result<usize, KernelError> {
    if !mesh.is_face_alive(face) {
        return Err(KernelError::invalid_value("face", "target face not alive"));
    }
    if !(diameter > 0.0) || !(depth > 0.0) {
        return Err(KernelError::invalid_value(
            "hole",
            "diameter and depth must be > 0",
        ));
    }
    let fn_v = face_normal(mesh, face);
    let f_verts = mesh.face_vertices(face);
    let p0 = mesh.position(f_verts[0]);
    let axis_i = (0..3)
        .max_by(|&a, &b| fn_v[a].abs().total_cmp(&fn_v[b].abs()))
        .unwrap_or(2);
    let mut ref_v = [0.0; 3];
    ref_v[(axis_i + 1) % 3] = 1.0;
    let u_ax = normalize(sub(ref_v, scale(fn_v, dot(ref_v, fn_v))));
    let v_ax = cross(fn_v, u_ax);
    let origin = scale(fn_v, dot(p0, fn_v));

    let r = diameter * 0.5;
    let overhang = (depth * 0.25).max(0.05);
    let h_len = depth + overhang;
    let mut cut_count = 0usize;
    for &[cx, cy] in centers {
        let center_on_plane = add(origin, add(scale(u_ax, cx), scale(v_ax, cy)));
        let cyl_center = add(center_on_plane, scale(fn_v, (overhang - depth) * 0.5));
        let mut cutter = EditMesh::new();
        append_cylinder(
            &mut cutter,
            r,
            r,
            h_len,
            segments.max(8),
            1,
            false,
            [0.0; 3],
            attr,
        )?;
        // Align cutter local Y axis to fn_v
        let y_ax = [0.0, 1.0, 0.0];
        let rot_axis = cross(y_ax, fn_v);
        let sin_a = length(rot_axis);
        let cos_a = dot(y_ax, fn_v).clamp(-1.0, 1.0);
        if sin_a > 1e-9 || cos_a < 0.0 {
            let k = if sin_a > 1e-9 {
                scale(rot_axis, 1.0 / sin_a)
            } else {
                [1.0, 0.0, 0.0]
            };
            let theta = if sin_a > 1e-9 {
                sin_a.atan2(cos_a)
            } else {
                std::f64::consts::PI
            };
            let c_t = theta.cos();
            let s_t = theta.sin();
            for v in cutter.vertices() {
                let p = cutter.position(v);
                let kv = dot(k, p);
                let kxp = cross(k, p);
                let rp = [
                    p[0] * c_t + kxp[0] * s_t + k[0] * kv * (1.0 - c_t),
                    p[1] * c_t + kxp[1] * s_t + k[1] * kv * (1.0 - c_t),
                    p[2] * c_t + kxp[2] * s_t + k[2] * kv * (1.0 - c_t),
                ];
                cutter.set_position(
                    v,
                    rp[0] + cyl_center[0],
                    rp[1] + cyl_center[1],
                    rp[2] + cyl_center[2],
                );
            }
        } else {
            for v in cutter.vertices() {
                let p = cutter.position(v);
                cutter.set_position(
                    v,
                    p[0] + cyl_center[0],
                    p[1] + cyl_center[1],
                    p[2] + cyl_center[2],
                );
            }
        }
        boolean_op(mesh, &cutter, BooleanOp::Difference, tolerance)?;
        cut_count += 1;
    }
    let _ = (mark_role, triangulate_loop, BTreeMap::<i32, i32>::new());
    Ok(cut_count)
}
