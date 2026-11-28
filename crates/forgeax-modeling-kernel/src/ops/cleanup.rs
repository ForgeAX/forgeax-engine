//! Cleanup, edge/face rewriting, repair, and part-attribute operators over `EditMesh`.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{cross, dot, face_normal, length, newell, sub, volume_about, Vec3};
use crate::mesh::rewrite::{
    merge_flags, rewrite_faces, triangulate_loop, with_crease, CornerSource, FaceRewrite,
    CREASE_INFINITE,
};
use crate::mesh::{EditMesh, CHANNEL_COUNT, FACE_FLOAT, FACE_ROLE_MASK, FACE_ROLE_SHIFT, NONE};
use crate::ops::region::{region_groups, RegionMode};
use crate::ops::wave2::flip_faces;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PartRole {
    Form = 0,
    Detail = 1,
    Tool = 2,
}

impl PartRole {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Form),
            1 => Some(Self::Detail),
            2 => Some(Self::Tool),
            _ => None,
        }
    }
}

pub fn mark_part_role(mesh: &mut EditMesh, faces: &[i32], role: PartRole) -> usize {
    let bits = (role as u8) << FACE_ROLE_SHIFT;
    for &f in faces {
        if mesh.is_face_alive(f) {
            let cur = mesh.f_flags[f as usize] & !FACE_ROLE_MASK;
            mesh.f_flags[f as usize] = cur | bits;
        }
    }
    faces.len()
}

pub fn mark_float(mesh: &mut EditMesh, faces: &[i32], floating: bool) -> usize {
    for &f in faces {
        if mesh.is_face_alive(f) {
            if floating {
                mesh.f_flags[f as usize] |= FACE_FLOAT;
            } else {
                mesh.f_flags[f as usize] &= !FACE_FLOAT;
            }
        }
    }
    faces.len()
}

pub fn mark_crease(
    mesh: &mut EditMesh,
    edges: &[i32],
    sharpness: f64,
) -> Result<usize, KernelError> {
    if sharpness.is_nan() || sharpness < 0.0 {
        return Err(KernelError::invalid_value(
            "sharpness",
            "must be 0 or greater (Infinity allowed)",
        ));
    }
    for &e in edges {
        if mesh.is_edge_alive(e) {
            mesh.e_flags[e as usize] = with_crease(mesh.e_flags[e as usize], sharpness);
        }
    }
    let _ = CREASE_INFINITE;
    Ok(edges.len())
}

pub fn bake_groups(
    mesh: &mut EditMesh,
    faces: &[i32],
    parts: &[(String, String)],
    prefix: &str,
) -> usize {
    let mut tagged = 0usize;
    let part_indices: Vec<(i32, i32)> = parts
        .iter()
        .map(|(part_tag, group_name)| {
            let p_idx = mesh.find_tag_index(part_tag);
            let g_idx = mesh.tag_index(&format!("{prefix}{group_name}"), true);
            (p_idx, g_idx)
        })
        .collect();
    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        for &(p_idx, g_idx) in &part_indices {
            if p_idx >= 0 && mesh.has_tag(f, p_idx) {
                mesh.add_tag(f, g_idx);
                tagged += 1;
                break;
            }
        }
    }
    tagged
}

pub fn orient_faces(mesh: &mut EditMesh, faces: &[i32]) -> Result<usize, KernelError> {
    let touched: HashSet<i32> = faces.iter().copied().collect();
    let all = mesh.faces();
    let mut comps = region_groups(mesh, &all, RegionMode::PerIsland);
    comps.retain(|c| c.iter().any(|f| touched.contains(f)));

    let mut flipped = 0usize;
    for comp in comps {
        let closed = comp.iter().all(|&f| {
            mesh.face_halves(f)
                .into_iter()
                .all(|h| mesh.h_face[(h ^ 1) as usize] != NONE)
        });
        if !closed {
            continue;
        }
        // Compute signed volume of component
        let mut sub_mesh_vol = 0.0f64;
        for &f in &comp {
            let verts = mesh.face_vertices(f);
            if verts.len() < 3 {
                continue;
            }
            let p0 = mesh.position(verts[0]);
            for i in 1..(verts.len() - 1) {
                let pi = mesh.position(verts[i]);
                let pj = mesh.position(verts[i + 1]);
                sub_mesh_vol += dot(p0, cross(pi, pj)) / 6.0;
            }
        }
        if sub_mesh_vol >= 0.0 {
            continue;
        }
        flip_faces(mesh, &comp)?;
        flipped += comp.len();
    }
    let _ = volume_about;
    Ok(flipped)
}

pub fn triangulate_faces(mesh: &mut EditMesh, faces: &[i32]) -> Result<usize, KernelError> {
    let mut rewrites = Vec::new();
    let mut triangles = 0usize;
    for &f in faces {
        if !mesh.is_face_alive(f) || mesh.f_len[f as usize] == 3 {
            continue;
        }
        let halves = mesh.face_halves(f);
        let mut start = 0usize;
        let p_start = mesh.position(mesh.h_vert[halves[0] as usize]);
        let mut best_p = p_start;
        for (i, &h) in halves.iter().enumerate().skip(1) {
            let p = mesh.position(mesh.h_vert[h as usize]);
            if (p[0] < best_p[0])
                || (p[0] == best_p[0]
                    && (p[1] < best_p[1] || (p[1] == best_p[1] && p[2] < best_p[2])))
            {
                best_p = p;
                start = i;
            }
        }
        let mut ordered = Vec::with_capacity(halves.len());
        ordered.extend_from_slice(&halves[start..]);
        ordered.extend_from_slice(&halves[..start]);
        let points: Vec<Vec3> = ordered
            .iter()
            .map(|&h| mesh.position(mesh.h_vert[h as usize]))
            .collect();
        let Some(indices) = triangulate_loop(&points) else {
            return Err(KernelError::invalid_value(
                "face",
                &format!("face {f} cannot be triangulated by ear clipping"),
            ));
        };
        let corners: Vec<CornerSource> = ordered
            .iter()
            .map(|&h| CornerSource::from_corner(mesh.h_vert[h as usize], h))
            .collect();
        let mut loops = Vec::with_capacity(indices.len() / 3);
        for tri in indices.chunks_exact(3) {
            loops.push(vec![corners[tri[0]], corners[tri[1]], corners[tri[2]]]);
            triangles += 1;
        }
        rewrites.push(FaceRewrite { face: f, loops });
    }
    rewrite_faces(mesh, &rewrites)?;
    Ok(triangles)
}

#[derive(Default)]
struct DisjointFind(HashMap<i32, i32>);

impl DisjointFind {
    fn find(&mut self, x: i32) -> i32 {
        let mut r = x;
        while let Some(&p) = self.0.get(&r) {
            if p == r {
                break;
            }
            r = p;
        }
        self.0.insert(x, r);
        r
    }

    fn union(&mut self, a: i32, b: i32) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.0.insert(ra.max(rb), ra.min(rb));
        }
    }
}

pub fn dissolve_edges(mesh: &mut EditMesh, edges: &[i32]) -> Result<(usize, usize), KernelError> {
    let mut uf = DisjointFind::default();
    let mut removed = 0usize;
    for &e in edges {
        if !mesh.is_edge_alive(e) {
            continue;
        }
        let a = mesh.h_face[(e * 2) as usize];
        let b = mesh.h_face[(e * 2 + 1) as usize];
        if a == NONE || b == NONE || a == b {
            continue;
        }
        uf.union(a, b);
        removed += 1;
    }
    if removed == 0 {
        return Err(KernelError::no_effect(
            "dissolve",
            "selection contains no interior edges",
        ));
    }

    let mut members: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for &e in edges {
        for &h in &[e * 2, e * 2 + 1] {
            let f = mesh.h_face[h as usize];
            if f == NONE {
                continue;
            }
            let r = uf.find(f);
            let list = members.entry(r).or_default();
            if !list.contains(&f) {
                list.push(f);
            }
        }
    }

    let words = mesh.tag_words;
    let mut rewrites = Vec::new();
    let mut merged_tags = Vec::new();
    let mut touched_verts = HashSet::new();

    for (root, faces) in members {
        if faces.len() < 2 {
            continue;
        }
        let mat0 = mesh.f_material[faces[0] as usize];
        if faces.iter().any(|&f| mesh.f_material[f as usize] != mat0) {
            return Err(KernelError::invalid_value(
                "material",
                "dissolve cannot merge faces with different materials",
            ));
        }
        let inside: HashSet<i32> = faces.iter().copied().collect();
        let mut next_of: HashMap<i32, i32> = HashMap::new();
        for &f in &faces {
            for h in mesh.face_halves(f) {
                let opp = mesh.h_face[(h ^ 1) as usize];
                if opp != NONE && inside.contains(&opp) {
                    continue;
                }
                let v = mesh.h_vert[h as usize];
                if next_of.insert(v, h).is_some() {
                    return Err(KernelError::invalid_value(
                        "dissolve",
                        "merged faces leave a pinched boundary or hole",
                    ));
                }
            }
        }
        let Some(&first_h) = next_of.values().min() else {
            continue;
        };
        let mut lp = Vec::new();
        let mut h = first_h;
        while lp.len() <= next_of.len() {
            let v = mesh.h_vert[h as usize];
            touched_verts.insert(v);
            lp.push(CornerSource::from_corner(v, h));
            let nv = mesh.h_vert[mesh.h_next[h as usize] as usize];
            let Some(&nh) = next_of.get(&nv) else {
                return Err(KernelError::invalid_value(
                    "dissolve",
                    "merged faces do not form a closed loop",
                ));
            };
            h = nh;
            if h == first_h {
                break;
            }
        }
        if lp.len() != next_of.len() || lp.len() < 3 {
            return Err(KernelError::invalid_value(
                "dissolve",
                "merged faces contain a hole",
            ));
        }
        let mut tags = vec![0u32; words];
        for &f in &faces {
            let fu = f as usize;
            for w in 0..words {
                tags[w] |= mesh.f_tags[fu * words + w];
            }
        }
        merged_tags.push(tags);
        rewrites.push(FaceRewrite {
            face: root,
            loops: vec![lp],
        });
        for &f in &faces {
            if f != root {
                rewrites.push(FaceRewrite {
                    face: f,
                    loops: Vec::new(),
                });
            }
        }
    }

    let created = rewrite_faces(mesh, &rewrites)?;
    let mut merged = 0usize;
    let mut tag_idx = 0usize;
    for group in created {
        if let Some(&nf) = group.first() {
            if let Some(tags) = merged_tags.get(tag_idx) {
                for w in 0..words {
                    mesh.f_tags[(nf as usize) * words + w] = tags[w];
                }
            }
            tag_idx += 1;
            merged += 1;
        }
    }
    // Remove orphan vertices
    let mut used = HashSet::new();
    for f in mesh.faces() {
        for v in mesh.face_vertices(f) {
            used.insert(v);
        }
    }
    for v in touched_verts {
        if !used.contains(&v) {
            mesh.remove_vertex(v);
        }
    }
    Ok((removed, merged))
}

pub fn split_edges(mesh: &mut EditMesh, edges: &[i32]) -> Result<usize, KernelError> {
    let cut: HashSet<i32> = edges
        .iter()
        .copied()
        .filter(|&e| mesh.is_edge_alive(e) && !mesh.is_boundary_edge(e))
        .collect();
    if cut.is_empty() {
        return Err(KernelError::no_effect(
            "split",
            "selection has no interior edges",
        ));
    }
    let mut touched = HashSet::new();
    for &e in &cut {
        let [a, b] = mesh.edge_vertices(e);
        touched.insert(a);
        touched.insert(b);
    }
    let mut corners: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for f in mesh.faces() {
        for h in mesh.face_halves(f) {
            let v = mesh.h_vert[h as usize];
            if touched.contains(&v) {
                corners.entry(v).or_default().push(h);
            }
        }
    }
    let mut fans = DisjointFind::default();
    for list in corners.values() {
        for &h in list {
            if cut.contains(&(h >> 1)) || mesh.h_face[(h ^ 1) as usize] == NONE {
                continue;
            }
            fans.union(h, mesh.h_next[(h ^ 1) as usize]);
        }
    }
    let mut vert_of: HashMap<i32, i32> = HashMap::new();
    let mut new_verts = 0usize;
    for (v, list) in corners {
        let mut roots: Vec<i32> = list.iter().map(|&h| fans.find(h)).collect();
        roots.sort_unstable();
        roots.dedup();
        for (i, r) in roots.into_iter().enumerate() {
            if i == 0 {
                vert_of.insert(r, v);
            } else {
                let p = mesh.position(v);
                let copy = mesh.add_vertex(p[0], p[1], p[2])?;
                vert_of.insert(r, copy);
                new_verts += 1;
            }
        }
    }
    if new_verts == 0 {
        return Err(KernelError::no_effect(
            "split",
            "cut does not reach a boundary or close a loop",
        ));
    }
    let mut rewrites = Vec::new();
    for f in mesh.faces() {
        let halves = mesh.face_halves(f);
        let mut changed = false;
        let mut lp = Vec::with_capacity(halves.len());
        for &h in &halves {
            let v = mesh.h_vert[h as usize];
            let nv = if touched.contains(&v) {
                let r = fans.find(h);
                vert_of.get(&r).copied().unwrap_or(v)
            } else {
                v
            };
            if nv != v {
                changed = true;
            }
            lp.push(CornerSource::from_corner(nv, h));
        }
        if changed {
            rewrites.push(FaceRewrite {
                face: f,
                loops: vec![lp],
            });
        }
    }
    rewrite_faces(mesh, &rewrites)?;
    Ok(new_verts)
}

#[derive(PartialEq, Eq, Hash)]
struct FaceAttrKey {
    material: i32,
    label: i32,
    role: i32,
    flags: u8,
    tags: Vec<u32>,
}

fn face_attr_key(mesh: &EditMesh, f: i32) -> FaceAttrKey {
    let fu = f as usize;
    let w = mesh.tag_words;
    FaceAttrKey {
        material: mesh.f_material[fu],
        label: mesh.f_label[fu],
        role: mesh.f_role[fu],
        flags: mesh.f_flags[fu],
        tags: mesh.f_tags[fu * w..(fu + 1) * w].to_vec(),
    }
}

fn corners_match(mesh: &EditMesh, h: i32, k: i32) -> bool {
    const EPS: f32 = 1e-5;
    for ch in mesh.channels.iter().flatten() {
        let s1 = ch.set.get(h as usize).copied().unwrap_or(0) != 0;
        let s2 = ch.set.get(k as usize).copied().unwrap_or(0) != 0;
        if s1 != s2 {
            return false;
        }
        if !s1 {
            continue;
        }
        let d = ch.dim;
        for c in 0..d {
            if (ch.values[h as usize * d + c] - ch.values[k as usize * d + c]).abs() > EPS {
                return false;
            }
        }
    }
    true
}

pub fn cleanup_planar(
    mesh: &mut EditMesh,
    faces: &[i32],
    tolerance: f64,
) -> Result<(usize, usize), KernelError> {
    let dist = tolerance * 10.0;
    let allowed: HashSet<i32> = faces.iter().copied().collect();
    let mut visited = HashSet::new();
    let mut rewrites = Vec::new();
    let mut merged_groups = 0usize;
    let mut touched_verts = HashSet::new();

    for &seed in faces {
        if !mesh.is_face_alive(seed) || visited.contains(&seed) {
            continue;
        }
        visited.insert(seed);
        let key = face_attr_key(mesh, seed);
        let plane_n = face_normal(mesh, seed);
        let seed_verts = mesh.face_vertices(seed);
        let plane_p0 = mesh.position(seed_verts[0]);

        let mut group = vec![seed];
        let mut group_set: HashSet<i32> = HashSet::from([seed]);
        let mut group_verts: HashSet<i32> = seed_verts.into_iter().collect();

        loop {
            let mut grew = false;
            let cur_snapshot = group.clone();
            for &gf in &cur_snapshot {
                for h in mesh.face_halves(gf) {
                    let nb = mesh.h_face[(h ^ 1) as usize];
                    if nb == NONE
                        || !allowed.contains(&nb)
                        || visited.contains(&nb)
                        || group_set.contains(&nb)
                    {
                        continue;
                    }
                    if face_attr_key(mesh, nb) != key {
                        continue;
                    }
                    if dot(face_normal(mesh, nb), plane_n) <= 0.0 {
                        continue;
                    }
                    let nb_halves = mesh.face_halves(nb);
                    let planar_ok = nb_halves.iter().all(|&nh| {
                        dot(
                            sub(mesh.position(mesh.h_vert[nh as usize]), plane_p0),
                            plane_n,
                        )
                        .abs()
                            <= dist
                    });
                    if !planar_ok {
                        continue;
                    }
                    let shared: Vec<bool> = nb_halves
                        .iter()
                        .map(|&nh| group_set.contains(&mesh.h_face[(nh ^ 1) as usize]))
                        .collect();
                    let runs = (0..shared.len())
                        .filter(|&i| shared[i] && !shared[(i + shared.len() - 1) % shared.len()])
                        .count();
                    if runs != 1 || shared.iter().all(|&s| s) {
                        continue;
                    }
                    let mut on_path = HashSet::new();
                    let mut edge_ok = true;
                    for (i, &nh) in nb_halves.iter().enumerate() {
                        if !shared[i] {
                            continue;
                        }
                        if mesh.e_flags[(nh >> 1) as usize] != 0 {
                            edge_ok = false;
                            break;
                        }
                        let twin = nh ^ 1;
                        if !corners_match(mesh, nh, mesh.h_next[twin as usize])
                            || !corners_match(mesh, mesh.h_next[nh as usize], twin)
                        {
                            edge_ok = false;
                            break;
                        }
                        on_path.insert(mesh.h_vert[nh as usize]);
                        on_path.insert(mesh.h_vert[twin as usize]);
                    }
                    if !edge_ok {
                        continue;
                    }
                    if nb_halves.iter().any(|&nh| {
                        let v = mesh.h_vert[nh as usize];
                        !on_path.contains(&v) && group_verts.contains(&v)
                    }) {
                        continue;
                    }
                    visited.insert(nb);
                    group_set.insert(nb);
                    group.push(nb);
                    for &nh in &nb_halves {
                        group_verts.insert(mesh.h_vert[nh as usize]);
                    }
                    grew = true;
                }
            }
            if !grew {
                break;
            }
        }

        if group.len() > 1 {
            let mut start_of: HashMap<i32, i32> = HashMap::new();
            for &f in &group {
                for h in mesh.face_halves(f) {
                    if group_set.contains(&mesh.h_face[(h ^ 1) as usize]) {
                        continue;
                    }
                    start_of.insert(mesh.h_vert[h as usize], h);
                }
            }
            if let Some(&first) = start_of.values().min() {
                let mut lp = Vec::with_capacity(start_of.len());
                let mut h = first;
                while lp.len() <= start_of.len() {
                    let v = mesh.h_vert[h as usize];
                    touched_verts.insert(v);
                    lp.push(CornerSource::from_corner(v, h));
                    let nv = mesh.h_vert[mesh.h_next[h as usize] as usize];
                    let Some(&nh) = start_of.get(&nv) else {
                        break;
                    };
                    h = nh;
                    if h == first {
                        break;
                    }
                }
                if lp.len() == start_of.len() && lp.len() >= 3 {
                    let root = *group.iter().min().unwrap();
                    rewrites.push(FaceRewrite {
                        face: root,
                        loops: vec![lp],
                    });
                    for &f in &group {
                        if f != root {
                            rewrites.push(FaceRewrite {
                                face: f,
                                loops: Vec::new(),
                            });
                        }
                    }
                    merged_groups += 1;
                }
            }
        }
    }

    rewrite_faces(mesh, &rewrites)?;
    let mut used = HashSet::new();
    for f in mesh.faces() {
        for v in mesh.face_vertices(f) {
            used.insert(v);
        }
    }
    let mut removed_verts = 0usize;
    for v in touched_verts {
        if !used.contains(&v) {
            mesh.remove_vertex(v);
            removed_verts += 1;
        }
    }
    let _ = newell;
    let _ = merge_flags;
    let _ = CHANNEL_COUNT;
    Ok((merged_groups, removed_verts))
}

#[inline]
fn quad_planarity(p: [Vec3; 4]) -> f64 {
    let u = sub(p[2], p[0]);
    let v = sub(p[3], p[1]);
    let n = cross(u, v);
    let l = length(n);
    let diag = length(u).max(length(v));
    if !(l > 0.0) || !(diag > 0.0) {
        return f64::INFINITY;
    }
    dot(sub(p[1], p[0]), n).abs() / l / diag
}

pub fn cleanup_quads(
    mesh: &mut EditMesh,
    faces: &[i32],
    max_angle_deg: f64,
    max_planarity: f64,
) -> Result<usize, KernelError> {
    const STRAIGHT_CORNER: f64 = -0.9848;
    let min_dot = max_angle_deg.to_radians().cos();
    let allowed: HashSet<i32> = faces
        .iter()
        .copied()
        .filter(|&f| mesh.is_face_alive(f) && mesh.f_len[f as usize] == 3)
        .collect();
    if allowed.is_empty() {
        return Ok(0);
    }

    struct Cand {
        e: i32,
        f: i32,
        g: i32,
        score: f64,
        lp: Vec<CornerSource>,
    }
    let mut cands: Vec<Cand> = Vec::new();
    let mut seen_e = HashSet::new();
    for &f in &allowed {
        let nf = face_normal(mesh, f);
        for h in mesh.face_halves(f) {
            let e = h >> 1;
            if !seen_e.insert(e) {
                continue;
            }
            let twin = h ^ 1;
            let g = mesh.h_face[twin as usize];
            if g == NONE || g == f || !allowed.contains(&g) {
                continue;
            }
            if mesh.e_flags[e as usize] != 0 || face_attr_key(mesh, f) != face_attr_key(mesh, g) {
                continue;
            }
            if !corners_match(mesh, h, mesh.h_next[twin as usize])
                || !corners_match(mesh, mesh.h_next[h as usize], twin)
            {
                continue;
            }
            let ng = face_normal(mesh, g);
            let bend = dot(nf, ng);
            if bend < min_dot {
                continue;
            }
            let f_apex = mesh.h_prev[h as usize];
            let g_apex = mesh.h_prev[twin as usize];
            let lp = vec![
                CornerSource::from_corner(mesh.h_vert[h as usize], h),
                CornerSource::from_corner(mesh.h_vert[g_apex as usize], g_apex),
                CornerSource::from_corner(
                    mesh.h_vert[mesh.h_next[h as usize] as usize],
                    mesh.h_next[h as usize],
                ),
                CornerSource::from_corner(mesh.h_vert[f_apex as usize], f_apex),
            ];
            let p = [
                mesh.position(lp[0].v),
                mesh.position(lp[1].v),
                mesh.position(lp[2].v),
                mesh.position(lp[3].v),
            ];
            let avg_n = [nf[0] + ng[0], nf[1] + ng[1], nf[2] + ng[2]];
            let mut convex = true;
            let mut square = 0.0f64;
            for i in 0..4 {
                let prev = p[(i + 3) % 4];
                let at = p[i];
                let next = p[(i + 1) % 4];
                let u = sub(next, at);
                let w = sub(prev, at);
                if dot(cross(u, w), avg_n) <= 0.0 {
                    convex = false;
                    break;
                }
                let ll = length(u) * length(w);
                let c = if ll > 0.0 { dot(u, w) / ll } else { -1.0 };
                if c < STRAIGHT_CORNER {
                    convex = false;
                    break;
                }
                square += c.abs();
            }
            if !convex {
                continue;
            }
            let planarity = quad_planarity(p);
            if planarity > max_planarity {
                continue;
            }
            cands.push(Cand {
                e,
                f,
                g,
                score: planarity + (1.0 - bend) + square * 0.25,
                lp,
            });
        }
    }

    cands.sort_by(|a, b| a.score.total_cmp(&b.score).then_with(|| a.e.cmp(&b.e)));
    let mut used = HashSet::new();
    let mut rewrites = Vec::new();
    let mut paired = 0usize;
    for c in cands {
        if used.contains(&c.f) || used.contains(&c.g) {
            continue;
        }
        used.insert(c.f);
        used.insert(c.g);
        rewrites.push(FaceRewrite {
            face: c.f,
            loops: vec![c.lp],
        });
        rewrites.push(FaceRewrite {
            face: c.g,
            loops: Vec::new(),
        });
        paired += 1;
    }
    if paired > 0 {
        rewrite_faces(mesh, &rewrites)?;
    }
    Ok(paired)
}

/// Remove faces narrower than `width` (needle absorption & boundary collapse).
pub fn cleanup_slivers(
    mesh: &mut EditMesh,
    faces: &[i32],
    width: f64,
    tolerance: f64,
) -> Result<(usize, usize), KernelError> {
    if !width.is_finite() || width <= 0.0 {
        return Err(KernelError::invalid_value("width", "must be > 0"));
    }
    let is_sliver = |mesh: &EditMesh, f: i32| -> bool {
        if !mesh.is_face_alive(f) {
            return false;
        }
        let vs = mesh.face_vertices(f);
        if vs.len() < 3 {
            return true;
        }
        let mut max_edge = 0.0f64;
        for i in 0..vs.len() {
            let d = length(sub(
                mesh.position(vs[(i + 1) % vs.len()]),
                mesh.position(vs[i]),
            ));
            max_edge = max_edge.max(d);
        }
        if !(max_edge > 0.0) {
            return true;
        }
        let area = crate::mesh::geom::face_area(mesh, f);
        (2.0 * area / max_edge) < width
    };

    let targets: Vec<i32> = faces
        .iter()
        .copied()
        .filter(|&f| is_sliver(mesh, f))
        .collect();
    if targets.is_empty() {
        return Ok((0, 0));
    }

    let mut removed = 0usize;
    for &f in &targets {
        if !is_sliver(mesh, f) {
            continue;
        }
        let halves = mesh.face_halves(f);
        let mut long_i = 0usize;
        let mut longest = 0.0f64;
        for (i, &h) in halves.iter().enumerate() {
            let a = mesh.h_vert[h as usize];
            let b = mesh.h_vert[mesh.h_next[h as usize] as usize];
            let d = length(sub(mesh.position(b), mesh.position(a)));
            if d > longest {
                longest = d;
                long_i = i;
            }
        }
        let on_boundary = halves
            .iter()
            .enumerate()
            .all(|(i, &h)| i == long_i || mesh.h_face[(h ^ 1) as usize] == NONE);
        let long_h = halves[long_i];
        let across = mesh.h_face[(long_h ^ 1) as usize];
        if across == NONE && on_boundary {
            mesh.remove_face(f);
            removed += 1;
        } else if across != NONE {
            let a = mesh.h_vert[long_h as usize];
            let c = mesh.h_vert[mesh.h_next[long_h as usize] as usize];
            let n_ac = face_normal(mesh, across);
            let p_ac = mesh.position(a);
            let mut planar_ok = true;
            let mut apex = Vec::new();
            for k in 2..halves.len() {
                let ah = halves[(long_i + k) % halves.len()];
                let av = mesh.h_vert[ah as usize];
                if dot(sub(mesh.position(av), p_ac), n_ac).abs() > tolerance * 10.0 {
                    planar_ok = false;
                    break;
                }
                apex.push((av, ah));
            }
            if planar_ok {
                let mut lp_across = Vec::new();
                for ah in mesh.face_halves(across) {
                    let av = mesh.h_vert[ah as usize];
                    lp_across.push(CornerSource::from_corner(av, ah));
                    let nxt = mesh.h_vert[mesh.h_next[ah as usize] as usize];
                    if av == c && nxt == a {
                        for &(v, ch) in &apex {
                            lp_across.push(CornerSource::from_corner(v, ch));
                        }
                    }
                }
                rewrite_faces(
                    mesh,
                    &[
                        FaceRewrite {
                            face: f,
                            loops: Vec::new(),
                        },
                        FaceRewrite {
                            face: across,
                            loops: vec![lp_across],
                        },
                    ],
                )?;
                removed += 1;
            }
        }
    }
    let kept = faces.iter().filter(|&&f| is_sliver(mesh, f)).count();
    Ok((removed, kept))
}

/// Insert boundary vertices that lie within `distance` onto boundary edges to resolve T-junctions.
pub fn resolve_t_junctions(mesh: &mut EditMesh, distance: f64) -> Result<usize, KernelError> {
    if !distance.is_finite() || distance <= 0.0 {
        return Err(KernelError::invalid_value("distance", "must be > 0"));
    }
    let d2 = distance * distance;
    let mut inserted_total = 0usize;
    for _pass in 0..8 {
        let open_edges: Vec<i32> = mesh
            .edges()
            .into_iter()
            .filter(|&e| mesh.is_boundary_edge(e))
            .collect();
        let mut boundary_verts = HashSet::new();
        for &e in &open_edges {
            let [a, b] = mesh.edge_vertices(e);
            boundary_verts.insert(a);
            boundary_verts.insert(b);
        }
        let mut bvs: Vec<i32> = boundary_verts.into_iter().collect();
        bvs.sort_unstable();

        let mut inserts_by_face: BTreeMap<i32, Vec<(i32, i32, f64)>> = BTreeMap::new();
        for &e in &open_edges {
            let h = if mesh.h_face[(e * 2) as usize] == NONE {
                e * 2 + 1
            } else {
                e * 2
            };
            let f = mesh.h_face[h as usize];
            if f == NONE {
                continue;
            }
            let a = mesh.h_vert[h as usize];
            let b = mesh.h_vert[mesh.h_next[h as usize] as usize];
            let pa = mesh.position(a);
            let pb = mesh.position(b);
            let ab = sub(pb, pa);
            let len2 = dot(ab, ab);
            if !(len2 > 1e-18) {
                continue;
            }
            let mut hits: Vec<(i32, f64)> = Vec::new();
            for &v in &bvs {
                if v == a || v == b {
                    continue;
                }
                let pv = mesh.position(v);
                let ap = sub(pv, pa);
                let t = dot(ap, ab) / len2;
                if t <= 1e-6 || t >= 1.0 - 1e-6 {
                    continue;
                }
                let q = [pa[0] + ab[0] * t, pa[1] + ab[1] * t, pa[2] + ab[2] * t];
                let off = sub(pv, q);
                if dot(off, off) <= d2 {
                    hits.push((v, t));
                }
            }
            if !hits.is_empty() {
                hits.sort_by(|x, y| x.1.total_cmp(&y.1));
                for (v, t) in hits {
                    inserts_by_face.entry(f).or_default().push((h, v, t));
                }
            }
        }
        if inserts_by_face.is_empty() {
            break;
        }
        let mut rewrites = Vec::with_capacity(inserts_by_face.len());
        let mut pass_inserted = 0usize;
        for (f, mut list) in inserts_by_face {
            let mut present: HashSet<i32> = mesh.face_vertices(f).into_iter().collect();
            let mut per_half: HashMap<i32, Vec<(i32, f64)>> = HashMap::new();
            for (h, v, t) in list.drain(..) {
                if present.insert(v) {
                    per_half.entry(h).or_default().push((v, t));
                }
            }
            let mut lp = Vec::new();
            for h in mesh.face_halves(f) {
                let va = mesh.h_vert[h as usize];
                lp.push(CornerSource::from_corner(va, h));
                if let Some(extras) = per_half.get(&h) {
                    let next = mesh.h_next[h as usize];
                    for &(v, t) in extras {
                        lp.push(CornerSource::from_interp(v, h, next, t));
                        pass_inserted += 1;
                    }
                }
            }
            rewrites.push(FaceRewrite {
                face: f,
                loops: vec![lp],
            });
        }
        if pass_inserted == 0 {
            break;
        }
        rewrite_faces(mesh, &rewrites)?;
        inserted_total += pass_inserted;
    }
    Ok(inserted_total)
}
