//! Polyline sweep (`sweep_polyline`) and planar panel-line groove (`panel_line_plane`).

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{
    add, cross, dot, face_normal, length, newell, normalize, scale, sub, Vec3,
};
use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SEAM, EDGE_SHARP, NONE};

use super::primitives::{mark_edge_flags, Attribution};
use super::region::{extrude, RegionMode};

fn shoelace_2d(pts: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..pts.len() {
        let p = pts[i];
        let q = pts[(i + 1) % pts.len()];
        a += p[0] * q[1] - q[0] * p[1];
    }
    0.5 * a
}

fn ensure_ccw_2d(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut clean: Vec<[f64; 2]> = pts.to_vec();
    if clean.len() > 2 {
        let first = clean[0];
        let last = *clean.last().unwrap();
        if (first[0] - last[0]).hypot(first[1] - last[1]) < 1e-12 {
            clean.pop();
        }
    }
    if shoelace_2d(&clean) < 0.0 {
        let first = clean[0];
        let mut out = Vec::with_capacity(clean.len());
        out.push(first);
        for &p in clean[1..].iter().rev() {
            out.push(p);
        }
        out
    } else {
        clean
    }
}

struct PathFrame {
    point: Vec3,
    x: Vec3,
    y: Vec3,
    s: f64,
    miter: f64,
    miter_axis: Vec3,
    sharp: bool,
}

fn compute_polyline_frames(
    path: &[Vec3],
    up: Vec3,
    sharp_angle_rad: f64,
) -> Result<Vec<PathFrame>, KernelError> {
    if path.len() < 2 {
        return Err(KernelError::invalid_value(
            "path",
            "sweep path needs at least 2 points",
        ));
    }
    let n = path.len();
    let mut tangents: Vec<Vec3> = Vec::with_capacity(n - 1);
    let mut arc_s: Vec<f64> = Vec::with_capacity(n);
    arc_s.push(0.0);
    let mut total = 0.0;
    for i in 0..(n - 1) {
        let d = sub(path[i + 1], path[i]);
        let l = length(d);
        if l <= 1e-12 {
            return Err(KernelError::degenerate(
                "path",
                "consecutive sweep path points coincide",
            ));
        }
        tangents.push(scale(d, 1.0 / l));
        total += l;
        arc_s.push(total);
    }

    // Initial RMF frame
    let t0 = tangents[0];
    let mut up_ref = normalize(up);
    if dot(t0, up_ref).abs() > 0.999 {
        up_ref = if t0[0].abs() < 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 0.0, 1.0]
        };
    }
    let x0 = normalize(cross(up_ref, t0));
    let y0 = cross(t0, x0);

    let mut frames = Vec::with_capacity(n);
    let mut cur_x = x0;
    let mut cur_y = y0;
    let mut prev_t = t0;

    for i in 0..n {
        if i == 0 {
            frames.push(PathFrame {
                point: path[0],
                x: cur_x,
                y: cur_y,
                s: arc_s[0],
                miter: 1.0,
                miter_axis: [1.0, 0.0, 0.0],
                sharp: false,
            });
            continue;
        }
        let seg_t = if i == n - 1 {
            tangents[n - 2]
        } else {
            let ta = tangents[i - 1];
            let tb = tangents[i];
            let bis = add(ta, tb);
            let bl = length(bis);
            if bl > 1e-12 {
                scale(bis, 1.0 / bl)
            } else {
                ta
            }
        };

        // Rotation-minimizing parallel transport from prev_t -> seg_t
        let axis = cross(prev_t, seg_t);
        let sin_a = length(axis);
        let cos_a = dot(prev_t, seg_t).clamp(-1.0, 1.0);
        if sin_a > 1e-12 {
            let k = scale(axis, 1.0 / sin_a);
            let rot = |v: Vec3| -> Vec3 {
                add(
                    add(scale(v, cos_a), scale(cross(k, v), sin_a)),
                    scale(k, dot(k, v) * (1.0 - cos_a)),
                )
            };
            cur_x = normalize(rot(cur_x));
            cur_y = normalize(cross(seg_t, cur_x));
        }

        let (miter, miter_axis, sharp) = if i > 0 && i < n - 1 {
            let ta = tangents[i - 1];
            let tb = tangents[i];
            let turn = length(cross(ta, tb)).atan2(dot(ta, tb));
            let c_half = dot(ta, seg_t).max(0.2);
            let m_dir = sub(tb, ta);
            let ml = length(m_dir);
            let ma = if ml > 1e-12 {
                scale(m_dir, 1.0 / ml)
            } else {
                cur_x
            };
            (1.0 / c_half, ma, turn >= sharp_angle_rad)
        } else {
            (1.0, cur_x, false)
        };

        frames.push(PathFrame {
            point: path[i],
            x: cur_x,
            y: cur_y,
            s: arc_s[i],
            miter,
            miter_axis,
            sharp,
        });
        prev_t = seg_t;
    }
    Ok(frames)
}

/// Sweep a closed 2D `[x, y]` section along a 3D polyline path with optional end caps,
/// RMF frames, `uv0`, and sharp/seam edge flags.
pub fn sweep_polyline(
    mesh: &mut EditMesh,
    profile_raw: &[[f64; 2]],
    path: &[Vec3],
    caps: bool,
    sharp_angle_deg: f64,
    up: Vec3,
    attribution: Attribution,
) -> Result<usize, KernelError> {
    if profile_raw.len() < 3 {
        return Err(KernelError::invalid_value(
            "profile",
            "profile needs at least 3 points",
        ));
    }
    let profile = ensure_ccw_2d(profile_raw);
    let n = profile.len();
    let sharp_rad = sharp_angle_deg.to_radians();
    let frames = compute_polyline_frames(path, up, sharp_rad)?;
    let rows = frames.len();

    // Compute profile perimeter u-coordinates and sharp corner flags
    let mut u_coords = Vec::with_capacity(n + 1);
    let mut run = 0.0;
    u_coords.push(0.0);
    let mut col_sharp = vec![false; n];
    for j in 0..n {
        let p_prev = profile[(j + n - 1) % n];
        let p = profile[j];
        let p_next = profile[(j + 1) % n];
        let d1 = [p[0] - p_prev[0], p[1] - p_prev[1]];
        let d2 = [p_next[0] - p[0], p_next[1] - p[1]];
        let cross2 = (d1[0] * d2[1] - d1[1] * d2[0]).abs();
        let dot2 = d1[0] * d2[0] + d1[1] * d2[1];
        if cross2.atan2(dot2) >= sharp_rad {
            col_sharp[j] = true;
        }
        run += d2[0].hypot(d2[1]);
        u_coords.push(run);
    }

    // Create grid vertices
    let mut ids: Vec<Vec<i32>> = Vec::with_capacity(rows);
    for frame in &frames {
        let mut row = Vec::with_capacity(n);
        for &p in &profile {
            let o = add(scale(frame.x, p[0]), scale(frame.y, p[1]));
            let stretched = add(
                o,
                scale(
                    frame.miter_axis,
                    (frame.miter - 1.0) * dot(o, frame.miter_axis),
                ),
            );
            let pos = add(frame.point, stretched);
            row.push(mesh.add_vertex(pos[0], pos[1], pos[2])?);
        }
        ids.push(row);
    }

    let side_role = if attribution.label != 0 {
        mesh.name_index_role("side")
    } else {
        0
    };
    let mut created_faces = Vec::new();
    let mut sharp_edges = Vec::new();
    let mut seam_edges = Vec::new();

    for i in 0..(rows - 1) {
        let v0 = frames[i].s as f32;
        let v1 = frames[i + 1].s as f32;
        for j in 0..n {
            let jn = (j + 1) % n;
            let quad = [ids[i][j], ids[i][jn], ids[i + 1][jn], ids[i + 1][j]];
            let u0 = u_coords[j] as f32;
            let u1 = u_coords[j + 1] as f32;
            let f = mesh.add_face(&quad, attribution.material)?;
            if attribution.label != 0 {
                mesh.f_label[f as usize] = attribution.label;
                mesh.f_role[f as usize] = side_role;
            }
            if attribution.tag >= 0 {
                mesh.add_tag(f, attribution.tag);
            }
            let uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
            for (ci, h) in mesh.face_halves(f).into_iter().enumerate() {
                mesh.set_corner(CornerChannelKind::Uv0, h, &uvs[ci]);
            }
            created_faces.push(f);
        }
    }

    if caps {
        let start_role = if attribution.label != 0 {
            mesh.name_index_role("start")
        } else {
            0
        };
        let end_role = if attribution.label != 0 {
            mesh.name_index_role("end")
        } else {
            0
        };
        let mut start_cols: Vec<usize> = Vec::with_capacity(n);
        start_cols.push(0);
        for j in (1..n).rev() {
            start_cols.push(j);
        }
        let start_loop: Vec<i32> = start_cols.iter().map(|&j| ids[0][j]).collect();
        let sf = mesh.add_face(&start_loop, attribution.material)?;
        if attribution.label != 0 {
            mesh.f_label[sf as usize] = attribution.label;
            mesh.f_role[sf as usize] = start_role;
        }
        if attribution.tag >= 0 {
            mesh.add_tag(sf, attribution.tag);
        }
        for (ci, h) in mesh.face_halves(sf).into_iter().enumerate() {
            let p = profile[start_cols[ci]];
            mesh.set_corner(CornerChannelKind::Uv0, h, &[p[0] as f32, p[1] as f32]);
        }
        created_faces.push(sf);

        let end_loop: Vec<i32> = (0..n).map(|j| ids[rows - 1][j]).collect();
        let ef = mesh.add_face(&end_loop, attribution.material)?;
        if attribution.label != 0 {
            mesh.f_label[ef as usize] = attribution.label;
            mesh.f_role[ef as usize] = end_role;
        }
        if attribution.tag >= 0 {
            mesh.add_tag(ef, attribution.tag);
        }
        for (ci, h) in mesh.face_halves(ef).into_iter().enumerate() {
            let p = profile[ci];
            mesh.set_corner(CornerChannelKind::Uv0, h, &[p[0] as f32, p[1] as f32]);
        }
        created_faces.push(ef);

        for j in 0..n {
            let jn = (j + 1) % n;
            let h0 = mesh.find_half(ids[0][j], ids[0][jn]);
            if h0 != NONE {
                sharp_edges.push(h0 >> 1);
            }
            let h1 = mesh.find_half(ids[rows - 1][j], ids[rows - 1][jn]);
            if h1 != NONE {
                sharp_edges.push(h1 >> 1);
            }
        }
    }

    for i in 0..rows {
        for j in 0..n {
            if i + 1 < rows {
                let h = mesh.find_half(ids[i][j], ids[i + 1][j]);
                if h != NONE {
                    if col_sharp[j] {
                        sharp_edges.push(h >> 1);
                    }
                    if j == 0 {
                        seam_edges.push(h >> 1);
                    }
                }
            }
            if frames[i].sharp {
                let h = mesh.find_half(ids[i][j], ids[i][(j + 1) % n]);
                if h != NONE {
                    sharp_edges.push(h >> 1);
                }
            }
        }
    }
    mark_edge_flags(mesh, &sharp_edges, EDGE_SHARP, true);
    mark_edge_flags(mesh, &seam_edges, EDGE_SEAM, true);

    Ok(created_faces.len())
}

/// Split selected faces along a plane `{ point, normal }`, returning newly created face IDs
/// belonging to the split subset (preserving connectivity on adjacent unselected faces if needed).
fn bisect_face_set(
    mesh: &mut EditMesh,
    within: &mut HashSet<i32>,
    point: Vec3,
    normal: Vec3,
    eps: f64,
) -> Result<(), KernelError> {
    // Find every live face in `within` strictly straddling the plane
    let candidates: Vec<i32> = within
        .iter()
        .copied()
        .filter(|&f| mesh.is_face_alive(f))
        .collect();
    let mut split_edges: HashMap<(i32, i32), i32> = HashMap::new();
    let mut to_split: Vec<i32> = Vec::new();
    let mut touched_neighbors: HashSet<i32> = HashSet::new();

    for &f in &candidates {
        let lp = mesh.face_vertices(f);
        let mut has_pos = false;
        let mut has_neg = false;
        for &v in &lp {
            let d = dot(sub(mesh.position(v), point), normal);
            if d > eps {
                has_pos = true;
            } else if d < -eps {
                has_neg = true;
            }
        }
        if has_pos && has_neg {
            to_split.push(f);
        }
    }
    if to_split.is_empty() {
        return Ok(());
    }

    // Create intersection vertices on every straddling edge of `to_split`
    for &f in &to_split {
        let lp = mesh.face_vertices(f);
        let halves = mesh.face_halves(f);
        for i in 0..lp.len() {
            let a = lp[i];
            let b = lp[(i + 1) % lp.len()];
            let da = dot(sub(mesh.position(a), point), normal);
            let db = dot(sub(mesh.position(b), point), normal);
            if (da > eps && db < -eps) || (da < -eps && db > eps) {
                let key = if a < b { (a, b) } else { (b, a) };
                if !split_edges.contains_key(&key) {
                    let t = da / (da - db);
                    let pa = mesh.position(a);
                    let pb = mesh.position(b);
                    let p = add(pa, scale(sub(pb, pa), t));
                    let nv = mesh.add_vertex(p[0], p[1], p[2])?;
                    split_edges.insert(key, nv);
                }
                let twin_f = mesh.h_face[(halves[i] ^ 1) as usize];
                if twin_f != NONE && !within.contains(&twin_f) {
                    touched_neighbors.insert(twin_f);
                }
            }
        }
    }

    // Collect metadata for all faces being rewritten (`to_split` + `touched_neighbors`)
    struct FaceMeta {
        f: i32,
        loop_v: Vec<i32>,
        mat: i32,
        label: i32,
        role: i32,
        flags: u8,
        tags: Vec<u32>,
        in_within: bool,
    }
    let mut rewrite_list: Vec<FaceMeta> = Vec::new();
    let tw = mesh.tag_words;
    for &f in to_split.iter().chain(touched_neighbors.iter()) {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let tags = if tw > 0 {
            mesh.f_tags[(f as usize) * tw..(f as usize + 1) * tw].to_vec()
        } else {
            Vec::new()
        };
        rewrite_list.push(FaceMeta {
            f,
            loop_v: mesh.face_vertices(f),
            mat: mesh.f_material[f as usize],
            label: mesh.f_label[f as usize],
            role: mesh.f_role[f as usize],
            flags: mesh.f_flags[f as usize],
            tags,
            in_within: within.contains(&f),
        });
    }

    for meta in &rewrite_list {
        mesh.remove_face(meta.f);
        within.remove(&meta.f);
    }

    for meta in &rewrite_list {
        if !meta.in_within {
            // Unselected neighbor: just insert split vertices along its shared edges (preserve manifoldness!)
            let mut new_lp = Vec::with_capacity(meta.loop_v.len() + 2);
            for i in 0..meta.loop_v.len() {
                let a = meta.loop_v[i];
                let b = meta.loop_v[(i + 1) % meta.loop_v.len()];
                new_lp.push(a);
                let key = if a < b { (a, b) } else { (b, a) };
                if let Some(&mv) = split_edges.get(&key) {
                    new_lp.push(mv);
                }
            }
            let nf = mesh.add_face(&new_lp, meta.mat)?;
            mesh.f_label[nf as usize] = meta.label;
            mesh.f_role[nf as usize] = meta.role;
            mesh.f_flags[nf as usize] = meta.flags;
            for w in 0..meta.tags.len().min(tw) {
                mesh.f_tags[(nf as usize) * tw + w] = meta.tags[w];
            }
            continue;
        }

        // Split face into front (>= 0) and back (<= 0) polygons
        let mut front = Vec::new();
        let mut back = Vec::new();
        for i in 0..meta.loop_v.len() {
            let a = meta.loop_v[i];
            let b = meta.loop_v[(i + 1) % meta.loop_v.len()];
            let da = dot(sub(mesh.position(a), point), normal);
            if da >= -eps {
                front.push(a);
            }
            if da <= eps {
                back.push(a);
            }
            let key = if a < b { (a, b) } else { (b, a) };
            if let Some(&mv) = split_edges.get(&key) {
                front.push(mv);
                back.push(mv);
            }
        }
        for poly in [front, back] {
            if poly.len() >= 3 {
                let nf = mesh.add_face(&poly, meta.mat)?;
                mesh.f_label[nf as usize] = meta.label;
                mesh.f_role[nf as usize] = meta.role;
                mesh.f_flags[nf as usize] = meta.flags;
                for w in 0..meta.tags.len().min(tw) {
                    mesh.f_tags[(nf as usize) * tw + w] = meta.tags[w];
                }
                within.insert(nf);
            }
        }
    }
    Ok(())
}

/// Cut a square-profile panel-line groove into `faces` crossed by `{ point, normal }`.
pub fn panel_line_plane(
    mesh: &mut EditMesh,
    faces: &[i32],
    point: Vec3,
    normal_raw: Vec3,
    width: f64,
    depth: f64,
    material: Option<i32>,
    attribution: Attribution,
    tolerance: f64,
) -> Result<usize, KernelError> {
    if faces.is_empty() {
        return Err(KernelError::selection_empty("faces", "no faces selected"));
    }
    if !(width > 0.0) || !(depth > 0.0) {
        return Err(KernelError::invalid_value(
            "width/depth",
            "panelLine width and depth must be > 0",
        ));
    }
    let n_len = length(normal_raw);
    if n_len <= 1e-12 {
        return Err(KernelError::invalid_value(
            "normal",
            "panelLine normal must be non-zero",
        ));
    }
    let normal = scale(normal_raw, 1.0 / n_len);
    let half = 0.5 * width;

    let mut within: HashSet<i32> = faces.iter().copied().collect();
    for frac in [-1.0f64, 1.0f64] {
        let p = add(point, scale(normal, frac * half));
        bisect_face_set(mesh, &mut within, p, normal, tolerance)?;
    }

    let mut strip: Vec<i32> = within
        .into_iter()
        .filter(|&f| {
            mesh.is_face_alive(f)
                && mesh
                    .face_vertices(f)
                    .iter()
                    .all(|&v| dot(sub(mesh.position(v), point), normal).abs() <= half + tolerance)
        })
        .collect();
    strip.sort_unstable();
    if strip.is_empty() {
        return Err(KernelError::precondition(
            "panelLine",
            "panel plane does not cross selected faces",
        ));
    }

    // Extrude strip inward by `-depth`
    let before: HashSet<i32> = mesh.faces().into_iter().collect();
    let (moved, walls) = extrude(mesh, &strip, -depth, RegionMode::Merged, attribution.label)?;
    let _ = (moved, walls, newell, face_normal);

    // Assign groove material and mark rim sharp
    let floor_set: HashSet<i32> = strip.iter().copied().collect();
    let mut groove_faces: Vec<i32> = strip.clone();
    for f in mesh.faces() {
        if !before.contains(&f) {
            groove_faces.push(f);
        }
    }
    if let Some(mat) = material {
        for &f in &groove_faces {
            if mesh.is_face_alive(f) {
                mesh.f_material[f as usize] = mat;
            }
        }
    }
    if attribution.tag >= 0 {
        for &f in &groove_faces {
            if mesh.is_face_alive(f) {
                mesh.add_tag(f, attribution.tag);
            }
        }
    }

    let groove_set: HashSet<i32> = groove_faces.iter().copied().collect();
    let mut sharp_edges = Vec::new();
    for &f in &groove_faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        for h in mesh.face_halves(f) {
            let tf = mesh.h_face[(h ^ 1) as usize];
            if tf == NONE
                || !groove_set.contains(&tf)
                || floor_set.contains(&f) != floor_set.contains(&tf)
            {
                sharp_edges.push(h >> 1);
            }
        }
    }
    mark_edge_flags(mesh, &sharp_edges, EDGE_SHARP, true);
    Ok(groove_faces.len())
}
