//! Manifold edge bevel (`bevel_edges`) with tangent-plane quarter-circle profiles,
//! edge strips (`role = "bevel"`), and 3-/4-sided smooth corner patches (`role = "corner"`).

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{add, cross, dot, face_normal, length, normalize, scale, sub, Vec3};
use crate::mesh::{EditMesh, FACE_EDGE_ROUND, NONE};

use super::primitives::Attribution;

fn tangent_toward(from: Vec3, to: Vec3, normal: Vec3) -> Vec3 {
    let n = normalize(normal);
    let d = sub(to, from);
    sub(d, scale(n, dot(d, n)))
}

/// Quarter-circle arc from `x` to `y` tangent to planes `(x, nx)` and `(y, ny)`.
fn round_profile(
    x: Vec3,
    y: Vec3,
    nx: Vec3,
    ny: Vec3,
    segments: usize,
) -> (Vec<Vec3>, Option<Vec3>) {
    let straight = || {
        let pts = (0..=segments)
            .map(|i| add(x, scale(sub(y, x), (i as f64) / (segments as f64))))
            .collect();
        (pts, None)
    };
    if segments <= 1 {
        return straight();
    }
    let span = length(sub(y, x));
    if span <= 1e-12 {
        return straight();
    }
    let tx = tangent_toward(x, y, nx);
    let ty = tangent_toward(y, x, ny);
    let a = dot(tx, tx);
    let b = dot(tx, ty);
    let c = dot(ty, ty);
    let denom = a * c - b * b;
    if a < span * span * 1e-12 || c < span * span * 1e-12 || denom <= a * c * 1e-9 {
        return straight();
    }
    let w0 = sub(x, y);
    let d = dot(tx, w0);
    let e = dot(ty, w0);
    let s = (b * e - c * d) / denom;
    let t = (a * e - b * d) / denom;
    if s <= 0.0 || t <= 0.0 {
        return straight();
    }
    let q = scale(add(add(x, scale(tx, s)), add(y, scale(ty, t))), 0.5);
    let leg_x = sub(x, q);
    let leg_y = sub(y, q);
    let mut pts = Vec::with_capacity(segments + 1);
    pts.push(x);
    for i in 1..segments {
        let phi = (std::f64::consts::FRAC_PI_2) * (i as f64) / (segments as f64);
        pts.push(add(
            q,
            add(scale(leg_x, 1.0 - phi.sin()), scale(leg_y, 1.0 - phi.cos())),
        ));
    }
    pts.push(y);
    (pts, Some(add(leg_x, y)))
}

/// Corner point inside face `f` at vertex `v` offset by `w_prev` from incoming edge `e_prev`
/// and `w_next` from outgoing edge `e_next`.
fn face_corner_point(
    p: Vec3,
    p_prev: Vec3,
    p_next: Vec3,
    n: Vec3,
    w_prev: f64,
    w_next: f64,
) -> Vec3 {
    // Outgoing edge dir along face boundary: u_next = normalize(p_next - p)
    // Incoming edge dir from v toward p_prev: u_prev = normalize(p_prev - p)
    let e_prev = sub(p_prev, p);
    let e_next = sub(p_next, p);
    let l_prev = length(e_prev);
    let l_next = length(e_next);
    if l_prev <= 1e-12 || l_next <= 1e-12 {
        return p;
    }
    let u_prev = scale(e_prev, 1.0 / l_prev);
    let u_next = scale(e_next, 1.0 / l_next);

    // Inward unit normals in face plane:
    // For CCW face with normal n, edge (p -> p_next) has inward normal cross(n, u_next).
    // Edge (p_prev -> p) has dir -u_prev, inward normal cross(n, -u_prev) = cross(u_prev, n).
    let in_next = normalize(cross(n, u_next));
    let in_prev = normalize(cross(u_prev, n));

    if w_prev <= 0.0 && w_next <= 0.0 {
        return p;
    }
    if w_prev > 0.0 && w_next <= 0.0 {
        // Slide along outgoing edge u_next so dot(t * u_next, in_prev) = w_prev
        let denom = dot(u_next, in_prev);
        let t = if denom.abs() > 0.05 {
            (w_prev / denom).clamp(0.0, l_next * 0.48)
        } else {
            w_prev.min(l_next * 0.48)
        };
        return add(p, scale(u_next, t));
    }
    if w_next > 0.0 && w_prev <= 0.0 {
        // Slide along incoming edge u_prev so dot(t * u_prev, in_next) = w_next
        let denom = dot(u_prev, in_next);
        let t = if denom.abs() > 0.05 {
            (w_next / denom).clamp(0.0, l_prev * 0.48)
        } else {
            w_next.min(l_prev * 0.48)
        };
        return add(p, scale(u_prev, t));
    }

    // Both adjacent edges at corner (f, v) are bevelled:
    // Solve 2D intersection in face plane: dot(d, in_prev) = w_prev AND dot(d, in_next) = w_next
    // Using basis (in_prev, u_prev): d = a * in_prev + b * u_prev
    let d11 = dot(in_prev, in_prev);
    let d12 = dot(in_prev, in_next);
    let d22 = dot(in_next, in_next);
    let det = d11 * d22 - d12 * d12;
    if det.abs() > 1e-6 {
        let alpha = (w_prev * d22 - w_next * d12) / det;
        let beta = (d11 * w_next - d12 * w_prev) / det;
        let offset = add(scale(in_prev, alpha), scale(in_next, beta));
        // Clamp offset to avoid crossing face midpoint
        let max_off = (l_prev.min(l_next) * 0.48).max(1e-6);
        let olen = length(offset);
        if olen > max_off {
            add(p, scale(offset, max_off / olen))
        } else {
            add(p, offset)
        }
    } else {
        let bis = normalize(add(in_prev, in_next));
        add(p, scale(bis, 0.5 * (w_prev + w_next)))
    }
}

/// 3-sided or 4-sided corner patch topology matching `bevel-shape.ts:patchTopology`.
fn corner_patch_topology(sides: usize, segments: usize) -> (usize, Vec<Vec<usize>>) {
    let n = segments;
    let ring_size = sides * n;
    let mut next = ring_size;
    let ring = |s: usize, i: usize| -> usize { (s % sides) * n + i };
    let at = |s: usize, i: usize| -> usize {
        if i == n {
            ring(s + 1, 0)
        } else {
            ring(s, i)
        }
    };
    let mut faces: Vec<Vec<usize>> = Vec::new();

    if sides == 4 {
        let mut grid = vec![vec![0usize; n + 1]; n + 1];
        for i in 0..=n {
            for j in 0..=n {
                grid[i][j] = if j == 0 {
                    at(0, i)
                } else if i == n {
                    at(1, j)
                } else if j == n {
                    at(2, n - i)
                } else if i == 0 {
                    at(3, n - j)
                } else {
                    let id = next;
                    next += 1;
                    id
                };
            }
        }
        for i in 0..n {
            for j in 0..n {
                faces.push(vec![
                    grid[i][j],
                    grid[i + 1][j],
                    grid[i + 1][j + 1],
                    grid[i][j + 1],
                ]);
            }
        }
        return (next - ring_size, faces);
    }

    // 3-sided corner patch
    let q = n / 2;
    let odd = n % 2 == 1;
    let center = if odd {
        usize::MAX
    } else {
        let id = next;
        next += 1;
        id
    };
    let inner: [usize; 3] = if odd {
        if q == 0 {
            [at(0, 0), at(1, 0), at(2, 0)]
        } else {
            let a = next;
            next += 1;
            let b = next;
            next += 1;
            let c = next;
            next += 1;
            [a, b, c]
        }
    } else {
        [center, center, center]
    };

    let mut make_curve = |start: usize, end: usize| -> Vec<usize> {
        let mut out = Vec::with_capacity(q + 1);
        out.push(start);
        for _ in 1..q {
            let id = next;
            next += 1;
            out.push(id);
        }
        out.push(end);
        out
    };
    let left: [Vec<usize>; 3] = [
        make_curve(at(0, q), inner[0]),
        make_curve(at(1, q), inner[1]),
        make_curve(at(2, q), inner[2]),
    ];
    let right: [Vec<usize>; 3] = if odd {
        [
            make_curve(at(0, q + 1), inner[1]),
            make_curve(at(1, q + 1), inner[2]),
            make_curve(at(2, q + 1), inner[0]),
        ]
    } else {
        left.clone()
    };

    if q > 0 {
        for s in 0..3 {
            let lc = &left[s];
            let rc = &right[(s + 2) % 3];
            let mut grid = vec![vec![0usize; q + 1]; q + 1];
            for i in 0..=q {
                for j in 0..=q {
                    grid[i][j] = if j == 0 {
                        at(s, i)
                    } else if i == q {
                        lc[j]
                    } else if j == q {
                        rc[i]
                    } else if i == 0 {
                        at((s + 2) % 3, n - j)
                    } else {
                        let id = next;
                        next += 1;
                        id
                    };
                }
            }
            for i in 0..q {
                for j in 0..q {
                    faces.push(vec![
                        grid[i][j],
                        grid[i + 1][j],
                        grid[i + 1][j + 1],
                        grid[i][j + 1],
                    ]);
                }
            }
        }
    }
    if odd {
        for s in 0..3 {
            let l = &left[s];
            let r = &right[s];
            for j in 0..q {
                faces.push(vec![l[j], r[j], r[j + 1], l[j + 1]]);
            }
        }
        faces.push(vec![inner[0], inner[1], inner[2]]);
    }
    (next - ring_size, faces)
}

fn relax_interior(pts: &mut [Vec3], fixed: usize, faces: &[Vec<usize>], sweeps: usize) {
    let mut nbrs: Vec<Vec<usize>> = vec![Vec::new(); pts.len()];
    for f in faces {
        for i in 0..f.len() {
            let a = f[i];
            let b = f[(i + 1) % f.len()];
            if a >= fixed && !nbrs[a].contains(&b) {
                nbrs[a].push(b);
            }
            if b >= fixed && !nbrs[b].contains(&a) {
                nbrs[b].push(a);
            }
        }
    }
    for _ in 0..sweeps {
        for i in fixed..pts.len() {
            let list = &nbrs[i];
            if list.is_empty() {
                continue;
            }
            let mut sum = [0.0; 3];
            for &j in list {
                sum = add(sum, pts[j]);
            }
            pts[i] = scale(sum, 1.0 / (list.len() as f64));
        }
    }
}

/// Bevel interior manifold edges with `width` and `segments` (1 = chamfer, >=2 = round arc).
pub fn bevel_edges(
    mesh: &mut EditMesh,
    edges: &[i32],
    width: f64,
    segments: u32,
    material: Option<i32>,
    attribution: Attribution,
) -> Result<(usize, usize), KernelError> {
    if !(width.is_finite() && width > 0.0) {
        return Err(KernelError::invalid_value(
            "width",
            "bevel width must be > 0",
        ));
    }
    let segs = segments.clamp(1, 64) as usize;
    let mut bevel_set: HashSet<i32> = HashSet::new();
    let mut bevel_list: Vec<i32> = Vec::new();
    for &e in edges {
        if !mesh.is_edge_alive(e) {
            continue;
        }
        if mesh.h_face[(e * 2) as usize] == NONE || mesh.h_face[(e * 2 + 1) as usize] == NONE {
            return Err(KernelError::precondition(
                "edges",
                "cannot bevel open boundary edges",
            ));
        }
        if mesh.h_face[(e * 2) as usize] == mesh.h_face[(e * 2 + 1) as usize] {
            return Err(KernelError::precondition(
                "edges",
                "cannot bevel folded edge",
            ));
        }
        if bevel_set.insert(e) {
            bevel_list.push(e);
        }
    }
    if bevel_list.is_empty() {
        return Err(KernelError::selection_empty("edges", "no edges selected"));
    }

    // Clamp effective width per edge to at most 0.45 * min incident edge length so no face inverts
    let mut edge_width: HashMap<i32, f64> = HashMap::with_capacity(bevel_list.len());
    let mut touched_verts: HashSet<i32> = HashSet::new();
    let mut touched_faces: HashSet<i32> = HashSet::new();
    for &e in &bevel_list {
        let h0 = e * 2;
        let h1 = h0 + 1;
        let va = mesh.h_vert[h0 as usize];
        let vb = mesh.h_vert[h1 as usize];
        touched_verts.insert(va);
        touched_verts.insert(vb);
        touched_faces.insert(mesh.h_face[h0 as usize]);
        touched_faces.insert(mesh.h_face[h1 as usize]);
        edge_width.insert(e, width);
    }

    // Also include all faces incident to any touched vertex so their corners update cleanly
    for f in mesh.faces() {
        if mesh
            .face_vertices(f)
            .iter()
            .any(|v| touched_verts.contains(v))
        {
            touched_faces.insert(f);
        }
    }

    // Clamp widths against incident edge lengths of touched faces
    let mut min_adj_len: HashMap<i32, f64> = HashMap::new();
    for &f in &touched_faces {
        let lp = mesh.face_vertices(f);
        for i in 0..lp.len() {
            let a = lp[i];
            let b = lp[(i + 1) % lp.len()];
            let l = length(sub(mesh.position(b), mesh.position(a)));
            for v in [a, b] {
                let entry = min_adj_len.entry(v).or_insert(f64::INFINITY);
                if l < *entry {
                    *entry = l;
                }
            }
        }
    }
    for &e in &bevel_list {
        let va = mesh.h_vert[(e * 2) as usize];
        let vb = mesh.h_vert[(e * 2 + 1) as usize];
        let cap = 0.45 * min_adj_len[&va].min(min_adj_len[&vb]);
        let w = edge_width.get_mut(&e).unwrap();
        if *w > cap && cap > 1e-9 {
            *w = cap;
        }
    }

    // Precompute face normals and snapshot touched face data BEFORE mutating
    struct SavedFace {
        f: i32,
        verts: Vec<i32>,
        halves: Vec<i32>,
        normal: Vec3,
        mat: i32,
        label: i32,
        role: i32,
        flags: u8,
        tags: Vec<u32>,
    }
    let tw = mesh.tag_words;
    let mut face_normals: HashMap<i32, Vec3> = HashMap::with_capacity(touched_faces.len());
    let mut saved_faces: Vec<SavedFace> = Vec::with_capacity(touched_faces.len());
    let mut ordered_tf: Vec<i32> = touched_faces.iter().copied().collect();
    ordered_tf.sort_unstable();
    for &f in &ordered_tf {
        let n = face_normal(mesh, f);
        face_normals.insert(f, n);
        let tags = if tw > 0 {
            mesh.f_tags[(f as usize) * tw..(f as usize + 1) * tw].to_vec()
        } else {
            Vec::new()
        };
        saved_faces.push(SavedFace {
            f,
            verts: mesh.face_vertices(f),
            halves: mesh.face_halves(f),
            normal: n,
            mat: mesh.f_material[f as usize],
            label: mesh.f_label[f as usize],
            role: mesh.f_role[f as usize],
            flags: mesh.f_flags[f as usize],
            tags,
        });
    }

    // Build outgoing half-edge fans around every touched vertex BEFORE deleting faces
    let mut v_outgoing: HashMap<i32, Vec<i32>> = HashMap::new();
    for sf in &saved_faces {
        for &h in &sf.halves {
            let v = mesh.h_vert[h as usize];
            if touched_verts.contains(&v) {
                v_outgoing.entry(v).or_default().push(h);
            }
        }
    }
    // Order each vertex's outgoing fan in rotation order: next = h_prev[h] ^ 1
    struct VertexFan {
        v: i32,
        halves: Vec<i32>, // outgoing halves in CCW rotation around v
        closed: bool,
    }
    let mut fans: Vec<VertexFan> = Vec::new();
    let mut ordered_tv: Vec<i32> = touched_verts.iter().copied().collect();
    ordered_tv.sort_unstable();
    for &v in &ordered_tv {
        let Some(outs) = v_outgoing.get(&v) else {
            continue;
        };
        let open = outs
            .iter()
            .copied()
            .find(|&o| mesh.h_face[(o ^ 1) as usize] == NONE);
        let start = open.unwrap_or(outs[0]);
        let mut ring = vec![start];
        let mut cur = start;
        while mesh.h_face[cur as usize] != NONE {
            let next = mesh.h_prev[cur as usize] ^ 1;
            if next == start || ring.len() >= outs.len() {
                break;
            }
            ring.push(next);
            cur = next;
        }
        fans.push(VertexFan {
            v,
            halves: ring,
            closed: open.is_none(),
        });
    }

    // Snapshot edge -> (f0, f1, v0, v1, h0, h1) for every bevelled edge
    struct BevelEdgeInfo {
        h0: i32,
        h1: i32,
        v0: i32,
        v1: i32,
        f0: i32,
        f1: i32,
    }
    let bevel_infos: Vec<BevelEdgeInfo> = bevel_list
        .iter()
        .map(|&e| {
            let h0 = e * 2;
            let h1 = h0 + 1;
            BevelEdgeInfo {
                h0,
                h1,
                v0: mesh.h_vert[h0 as usize],
                v1: mesh.h_vert[h1 as usize],
                f0: mesh.h_face[h0 as usize],
                f1: mesh.h_face[h1 as usize],
            }
        })
        .collect();

    // Create inset corner vertex `(face, vert) -> new_vert_id` for every touched face corner
    // Note: if two adjacent faces share an UNBEVELLED edge incident to v, they share the same sliding vertex!
    let mut corner_vert: HashMap<(i32, i32), i32> = HashMap::new();
    for sf in &saved_faces {
        let m = sf.verts.len();
        for i in 0..m {
            let v = sf.verts[i];
            if !touched_verts.contains(&v) {
                corner_vert.insert((sf.f, v), v);
                continue;
            }
            let h_next = sf.halves[i];
            let h_prev = sf.halves[(i + m - 1) % m];
            let e_next = h_next >> 1;
            let e_prev = h_prev >> 1;
            let w_next = edge_width.get(&e_next).copied().unwrap_or(0.0);
            let w_prev = edge_width.get(&e_prev).copied().unwrap_or(0.0);
            if w_next == 0.0 && w_prev == 0.0 {
                corner_vert.insert((sf.f, v), v);
                continue;
            }
            let p = mesh.position(v);
            let p_prev = mesh.position(sf.verts[(i + m - 1) % m]);
            let p_next = mesh.position(sf.verts[(i + 1) % m]);
            let cp = face_corner_point(p, p_prev, p_next, sf.normal, w_prev, w_next);
            let nv = mesh.add_vertex(cp[0], cp[1], cp[2])?;
            corner_vert.insert((sf.f, v), nv);
        }
    }

    // Merge corner vertices across unbevelled edges around each touched vertex
    for fan in &fans {
        let m = fan.halves.len();
        for i in 0..m {
            let h = fan.halves[i];
            let e = h >> 1;
            if bevel_set.contains(&e) {
                continue;
            }
            let f_right = mesh.h_face[h as usize];
            let f_left = mesh.h_face[(h ^ 1) as usize];
            if f_right == NONE || f_left == NONE {
                continue;
            }
            let vr = corner_vert[&(f_right, fan.v)];
            let vl = corner_vert[&(f_left, fan.v)];
            if vr != vl {
                // Keep the vertex further from original v along the unbevelled edge
                let p0 = mesh.position(fan.v);
                let dr = length(sub(mesh.position(vr), p0));
                let dl = length(sub(mesh.position(vl), p0));
                let keep = if dr >= dl { vr } else { vl };
                let drop_v = if dr >= dl { vl } else { vr };
                if drop_v != fan.v {
                    mesh.remove_vertex(drop_v);
                }
                for val in corner_vert.values_mut() {
                    if *val == drop_v {
                        *val = keep;
                    }
                }
            }
        }
    }

    // Build profile vertex chains across each bevelled half-edge end `(half) -> Vec<i32>`
    // Profile goes from corner_vert[(f_twin, v)] to corner_vert[(f_own, v)] (length segs + 1)
    let mut end_profiles: HashMap<i32, (Vec<i32>, Option<Vec3>)> = HashMap::new();
    for info in &bevel_infos {
        for &(h, v, f_from, f_to) in &[
            (info.h0, info.v0, info.f1, info.f0),
            (info.h1, info.v1, info.f0, info.f1),
        ] {
            let v_from = corner_vert[&(f_from, v)];
            let v_to = corner_vert[&(f_to, v)];
            let p_from = mesh.position(v_from);
            let p_to = mesh.position(v_to);
            let (pts, center) = round_profile(
                p_from,
                p_to,
                face_normals[&f_from],
                face_normals[&f_to],
                segs,
            );
            let mut chain = Vec::with_capacity(segs + 1);
            chain.push(v_from);
            for pt in &pts[1..segs] {
                chain.push(mesh.add_vertex(pt[0], pt[1], pt[2])?);
            }
            chain.push(v_to);
            end_profiles.insert(h, (chain, center));
        }
    }

    // Remove all touched original faces
    for sf in &saved_faces {
        mesh.remove_face(sf.f);
    }

    // 1. Rebuild shrunken original faces
    for sf in &saved_faces {
        let mut new_lp: Vec<i32> = Vec::with_capacity(sf.verts.len());
        for &v in &sf.verts {
            let nv = corner_vert[&(sf.f, v)];
            if new_lp.last().copied() != Some(nv) {
                new_lp.push(nv);
            }
        }
        while new_lp.len() > 1 && new_lp.first() == new_lp.last() {
            new_lp.pop();
        }
        if new_lp.len() >= 3 {
            let nf = mesh.add_face(&new_lp, sf.mat)?;
            mesh.f_label[nf as usize] = sf.label;
            mesh.f_role[nf as usize] = sf.role;
            mesh.f_flags[nf as usize] = sf.flags;
            for w in 0..sf.tags.len().min(tw) {
                mesh.f_tags[(nf as usize) * tw + w] = sf.tags[w];
            }
        }
    }

    let bevel_role = if attribution.label != 0 {
        mesh.name_index_role("bevel")
    } else {
        0
    };
    let corner_role = if attribution.label != 0 {
        mesh.name_index_role("corner")
    } else {
        0
    };
    let mut bevel_count = 0usize;
    let mut corner_count = 0usize;

    // 2. Build bevel edge strips along every bevelled edge
    for info in &bevel_infos {
        let mat = material.unwrap_or_else(|| {
            saved_faces
                .iter()
                .find(|s| s.f == info.f0)
                .map(|s| s.mat)
                .unwrap_or(0)
        });
        let c0 = &end_profiles[&info.h0].0; // at v0: f1 -> f0
        let c1 = &end_profiles[&info.h1].0; // at v1: f0 -> f1 (reverse order vs c0!)
        for k in 0..segs {
            let a = c0[k];
            let b = c0[k + 1];
            let c = c1[segs - (k + 1)];
            let d = c1[segs - k];
            let quad = [a, d, c, b];
            let nf = mesh.add_face(&quad, mat)?;
            if segs > 1 {
                mesh.f_flags[nf as usize] |= FACE_EDGE_ROUND;
            }
            if attribution.label != 0 {
                mesh.f_label[nf as usize] = attribution.label;
                mesh.f_role[nf as usize] = bevel_role;
            }
            if attribution.tag >= 0 {
                mesh.add_tag(nf, attribution.tag);
            }
            bevel_count += 1;
        }
    }

    // 3. Build corner caps / smooth 3- and 4-sided corner patches around every touched vertex
    for fan in &fans {
        if !fan.closed {
            continue;
        }
        let bevel_halves: Vec<i32> = fan
            .halves
            .iter()
            .copied()
            .filter(|&h| bevel_set.contains(&(h >> 1)))
            .collect();
        if bevel_halves.len() < 3 {
            continue;
        }
        let mat = material.unwrap_or(0);
        // Collect boundary ring vertices in CCW order looking from outside
        // Around v in CCW fan order, each bevelled outgoing half `h` traverses its profile
        // from f_twin (h^1) to f_own (h) — matching `end_profiles[&h]` directly!
        let sides = bevel_halves.len();
        if (sides == 3 || sides == 4) && segs >= 2 {
            // Smooth corner patch (quad grid for 4-valence, 3-quad/center for 3-valence)
            let mut ring_verts: Vec<i32> = Vec::with_capacity(sides * segs);
            let mut ring_pts: Vec<Vec3> = Vec::with_capacity(sides * segs);
            let mut center_sum = [0.0; 3];
            let mut center_cnt = 0usize;
            for &h in &bevel_halves {
                let (chain, ctr) = &end_profiles[&h];
                for &vid in &chain[..segs] {
                    ring_verts.push(vid);
                    ring_pts.push(mesh.position(vid));
                }
                if let Some(c) = ctr {
                    center_sum = add(center_sum, *c);
                    center_cnt += 1;
                }
            }
            let (interior, patch_faces) = corner_patch_topology(sides, segs);
            let ring_len = ring_pts.len();
            let centroid = scale(
                ring_pts.iter().fold([0.0; 3], |acc, &p| add(acc, p)),
                1.0 / (ring_len as f64),
            );
            let mut all_pts = ring_pts.clone();
            all_pts.resize(ring_len + interior, centroid);
            relax_interior(&mut all_pts, ring_len, &patch_faces, 120);

            if center_cnt > 0 {
                let sphere_c = scale(center_sum, 1.0 / (center_cnt as f64));
                let radii: Vec<f64> = ring_pts.iter().map(|&p| length(sub(p, sphere_c))).collect();
                let lo = radii.iter().copied().fold(f64::INFINITY, f64::min);
                let hi = radii.iter().copied().fold(0.0f64, f64::max);
                if lo > 0.0 && hi <= lo * 3.0 {
                    for _ in 0..3 {
                        for i in ring_len..all_pts.len() {
                            let p = all_pts[i];
                            let mut w_sum = 0.0;
                            let mut r_sum = 0.0;
                            for (k, &r) in radii.iter().enumerate() {
                                let d = sub(p, ring_pts[k]);
                                let w = 1.0 / (dot(d, d) + 1e-30);
                                w_sum += w;
                                r_sum += w * r;
                            }
                            let dir = normalize(sub(p, sphere_c));
                            all_pts[i] = add(sphere_c, scale(dir, r_sum / w_sum));
                        }
                        if sides == 3 {
                            relax_interior(&mut all_pts, ring_len, &patch_faces, 25);
                        }
                    }
                }
            }

            let mut all_vids = ring_verts;
            for &p in &all_pts[ring_len..] {
                all_vids.push(mesh.add_vertex(p[0], p[1], p[2])?);
            }
            for pf in &patch_faces {
                let lp: Vec<i32> = pf.iter().map(|&idx| all_vids[idx]).collect();
                let nf = mesh.add_face(&lp, mat)?;
                mesh.f_flags[nf as usize] |= FACE_EDGE_ROUND;
                if attribution.label != 0 {
                    mesh.f_label[nf as usize] = attribution.label;
                    mesh.f_role[nf as usize] = corner_role;
                }
                if attribution.tag >= 0 {
                    mesh.add_tag(nf, attribution.tag);
                }
                corner_count += 1;
            }
        } else {
            // Single n-gon corner cap (chamfer segs==1 or valence >= 5)
            let mut ring_verts: Vec<i32> = Vec::new();
            for &h in &bevel_halves {
                let (chain, _) = &end_profiles[&h];
                for &vid in &chain[..segs] {
                    if ring_verts.last().copied() != Some(vid) {
                        ring_verts.push(vid);
                    }
                }
            }
            while ring_verts.len() > 1 && ring_verts.first() == ring_verts.last() {
                ring_verts.pop();
            }
            if ring_verts.len() >= 3 {
                let nf = mesh.add_face(&ring_verts, mat)?;
                if attribution.label != 0 {
                    mesh.f_label[nf as usize] = attribution.label;
                    mesh.f_role[nf as usize] = corner_role;
                }
                if attribution.tag >= 0 {
                    mesh.add_tag(nf, attribution.tag);
                }
                corner_count += 1;
            }
        }
    }

    // Remove orphaned original touched vertices that have no incident faces left
    let mut used_verts: HashSet<i32> = HashSet::new();
    for f in mesh.faces() {
        for v in mesh.face_vertices(f) {
            used_verts.insert(v);
        }
    }
    for &v in &ordered_tv {
        if mesh.is_vertex_alive(v) && !used_verts.contains(&v) {
            mesh.remove_vertex(v);
        }
    }

    Ok((bevel_count, corner_count))
}
