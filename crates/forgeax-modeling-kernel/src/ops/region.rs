//! Region topology operators (`extrude`, `inset`) with exact semantic parity to
//! `@forgeax/engine-modeling`'s `ops.ts`.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{
    add, cross, dot, face_normal, length, newell, normalize, scale, sub, Vec3,
};
use crate::mesh::{edge_key, CornerChannelKind, EditMesh, CHANNEL_COUNT, NONE};
use crate::ops::primitives::{mark_role, set_edge_flags_between};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RegionMode {
    Merged = 0,
    PerFace = 1,
    PerIsland = 2,
}

impl RegionMode {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Merged),
            1 => Some(Self::PerFace),
            2 => Some(Self::PerIsland),
            _ => None,
        }
    }
}

pub fn region_groups(mesh: &EditMesh, faces: &[i32], mode: RegionMode) -> Vec<Vec<i32>> {
    match mode {
        RegionMode::Merged => vec![faces.to_vec()],
        RegionMode::PerFace => faces.iter().map(|&f| vec![f]).collect(),
        RegionMode::PerIsland => {
            let selected: HashSet<i32> = faces.iter().copied().collect();
            let mut seen: HashSet<i32> = HashSet::with_capacity(faces.len());
            let mut groups = Vec::new();
            for &seed in faces {
                if !seen.insert(seed) {
                    continue;
                }
                let mut group = Vec::new();
                let mut stack = vec![seed];
                while let Some(f) = stack.pop() {
                    group.push(f);
                    for h in mesh.face_halves(f) {
                        let g = mesh.h_face[(h ^ 1) as usize];
                        if g != NONE && selected.contains(&g) && seen.insert(g) {
                            stack.push(g);
                        }
                    }
                }
                group.sort_unstable();
                groups.push(group);
            }
            groups
        }
    }
}

fn region_boundary(mesh: &EditMesh, faces: &[i32]) -> Vec<i32> {
    let set: HashSet<i32> = faces.iter().copied().collect();
    let mut boundary = Vec::new();
    for &f in faces {
        for h in mesh.face_halves(f) {
            let other = mesh.h_face[(h ^ 1) as usize];
            if other == NONE || !set.contains(&other) {
                boundary.push(h);
            }
        }
    }
    boundary
}

fn shared_vertices(mesh: &EditMesh, faces: &[i32], open_boundary: bool) -> HashSet<i32> {
    let mut inside = vec![0u8; mesh.face_high_water as usize];
    for &f in faces {
        inside[f as usize] = 1;
    }
    let mut region_vert = vec![0u8; mesh.vertex_high_water as usize];
    for &f in faces {
        for v in mesh.face_vertices(f) {
            region_vert[v as usize] = 1;
        }
    }
    let mut shared = HashSet::new();
    for h in 0..mesh.half_high_water {
        let f = mesh.h_face[h as usize];
        if f == NONE || inside[f as usize] == 1 {
            continue;
        }
        let v = mesh.h_vert[h as usize];
        if region_vert[v as usize] == 1 {
            shared.insert(v);
        }
    }
    for h in region_boundary(mesh, faces) {
        if !open_boundary && mesh.h_face[(h ^ 1) as usize] == NONE {
            continue;
        }
        shared.insert(mesh.h_vert[h as usize]);
        shared.insert(mesh.h_vert[mesh.h_next[h as usize] as usize]);
    }
    shared
}

struct SavedFace {
    face: i32,
    loop_verts: Vec<i32>,
    corners: Vec<i32>,
}

struct SavedFaceAttr {
    material: i32,
    label: i32,
    role: i32,
    flags: u8,
    tags: Vec<u32>,
}

struct RegionSnapshot {
    attrs: HashMap<i32, SavedFaceAttr>,
    positions: HashMap<i32, Vec3>,
    edge_flags: HashMap<u64, u8>,
    corners: HashMap<i32, [Option<Vec<f32>>; CHANNEL_COUNT]>,
}

impl RegionSnapshot {
    fn capture(mesh: &EditMesh, faces: &[i32]) -> Self {
        let mut attrs = HashMap::with_capacity(faces.len());
        let mut positions = HashMap::new();
        let mut edge_flags = HashMap::new();
        let mut corners = HashMap::new();
        for &f in faces {
            let fu = f as usize;
            let t_start = fu * mesh.tag_words;
            attrs.insert(
                f,
                SavedFaceAttr {
                    material: mesh.f_material[fu],
                    label: mesh.f_label[fu],
                    role: mesh.f_role[fu],
                    flags: mesh.f_flags[fu],
                    tags: mesh.f_tags[t_start..t_start + mesh.tag_words].to_vec(),
                },
            );
            for h in mesh.face_halves(f) {
                let v = mesh.h_vert[h as usize];
                positions.entry(v).or_insert_with(|| mesh.position(v));
                let w = mesh.h_vert[mesh.h_next[h as usize] as usize];
                let ef = mesh.e_flags[(h >> 1) as usize];
                if ef != 0 {
                    edge_flags.insert(edge_key(v, w), ef);
                }
                let mut ch_vals: [Option<Vec<f32>>; CHANNEL_COUNT] = Default::default();
                for kind in CornerChannelKind::ALL {
                    if let Some(val) = mesh.corner(kind, h) {
                        ch_vals[kind as usize] = Some(val.to_vec());
                    }
                }
                corners.insert(h, ch_vals);
            }
        }
        Self {
            attrs,
            positions,
            edge_flags,
            corners,
        }
    }

    fn copy_attrs_to(&self, from: i32, mesh: &mut EditMesh, to: i32) {
        let Some(a) = self.attrs.get(&from) else {
            return;
        };
        let tu = to as usize;
        mesh.f_material[tu] = a.material;
        mesh.f_label[tu] = a.label;
        mesh.f_role[tu] = a.role;
        mesh.f_flags[tu] = a.flags;
        let words = a.tags.len().min(mesh.tag_words);
        for w in 0..words {
            mesh.f_tags[tu * mesh.tag_words + w] = a.tags[w];
        }
    }
}

fn region_fans(saved: &[SavedFace], shared: &HashSet<i32>) -> HashMap<(i32, i32), usize> {
    let mut around: HashMap<i32, Vec<usize>> = HashMap::new();
    for (i, s) in saved.iter().enumerate() {
        for &v in &s.loop_verts {
            if shared.contains(&v) {
                around.entry(v).or_default().push(i);
            }
        }
    }
    let mut out = HashMap::new();
    for (v, list) in around {
        if list.len() < 2 {
            continue;
        }
        let mut parent: Vec<usize> = (0..list.len()).collect();
        let find = |parent: &[usize], mut k: usize| -> usize {
            while parent[k] != k {
                k = parent[k];
            }
            k
        };
        let neighbors = |idx: usize| -> [i32; 2] {
            let lp = &saved[idx].loop_verts;
            let at = lp.iter().position(|&x| x == v).unwrap();
            [lp[(at + 1) % lp.len()], lp[(at + lp.len() - 1) % lp.len()]]
        };
        for x in 0..list.len() {
            let nx = neighbors(list[x]);
            for y in (x + 1)..list.len() {
                let ny = neighbors(list[y]);
                if ny.iter().any(|w| nx.contains(w)) {
                    let rx = find(&parent, x);
                    let ry = find(&parent, y);
                    if rx != ry {
                        parent[rx.max(ry)] = rx.min(ry);
                    }
                }
            }
        }
        let mut roots: Vec<usize> = (0..list.len()).map(|k| find(&parent, k)).collect();
        roots.sort_unstable();
        roots.dedup();
        if roots.len() < 2 {
            continue;
        }
        for (k, &i) in list.iter().enumerate() {
            let r = find(&parent, k);
            let fan_idx = roots.iter().position(|&x| x == r).unwrap();
            out.insert((saved[i].face, v), fan_idx);
        }
    }
    out
}

struct BoundaryEdge {
    a: i32,
    b: i32,
    flags: u8,
    face: i32,
}

pub(crate) fn extrude_region_pub(
    mesh: &mut EditMesh,
    faces: &[i32],
    positions_fn: impl Fn(i32, Vec3) -> Vec3,
) -> Result<(Vec<i32>, Vec<i32>), KernelError> {
    extrude_region(mesh, faces, positions_fn)
}

fn extrude_region(
    mesh: &mut EditMesh,
    faces: &[i32],
    positions_fn: impl Fn(i32, Vec3) -> Vec3,
) -> Result<(Vec<i32>, Vec<i32>), KernelError> {
    let outline = region_boundary(mesh, faces);
    let shared_set = shared_vertices(mesh, faces, true);
    let boundary: Vec<BoundaryEdge> = outline
        .iter()
        .map(|&h| BoundaryEdge {
            a: mesh.h_vert[h as usize],
            b: mesh.h_vert[mesh.h_next[h as usize] as usize],
            flags: mesh.e_flags[(h >> 1) as usize],
            face: mesh.h_face[h as usize],
        })
        .collect();

    let snap = RegionSnapshot::capture(mesh, faces);
    let saved: Vec<SavedFace> = faces
        .iter()
        .map(|&f| SavedFace {
            face: f,
            loop_verts: mesh.face_vertices(f),
            corners: mesh.face_halves(f),
        })
        .collect();
    let fan_of = region_fans(&saved, &shared_set);

    for &f in faces {
        mesh.remove_face(f);
    }

    let mut copies: HashMap<(i32, usize), i32> = HashMap::new();
    let mut unmoved: HashSet<i32> = HashSet::new();

    for s in &saved {
        for &v in &s.loop_verts {
            if unmoved.contains(&v) {
                continue;
            }
            let fan = fan_of.get(&(s.face, v)).copied().unwrap_or(0);
            if copies.contains_key(&(v, fan)) {
                continue;
            }
            let orig = snap.positions[&v];
            let q = positions_fn(v, orig);
            if !shared_set.contains(&v) {
                mesh.set_position(v, q[0], q[1], q[2]);
                unmoved.insert(v);
            } else {
                let c = mesh.add_vertex(q[0], q[1], q[2])?;
                copies.insert((v, fan), c);
            }
        }
    }

    let resolve_target = |face: i32, v: i32| -> i32 {
        if unmoved.contains(&v) {
            return v;
        }
        let fan = fan_of.get(&(face, v)).copied().unwrap_or(0);
        copies[&(v, fan)]
    };

    let mut moved = Vec::with_capacity(saved.len());
    for s in &saved {
        let remapped: Vec<i32> = s
            .loop_verts
            .iter()
            .map(|&v| resolve_target(s.face, v))
            .collect();
        let f = mesh.add_face(&remapped, 0)?;
        snap.copy_attrs_to(s.face, mesh, f);
        let new_halves = mesh.face_halves(f);
        for (i, &nh) in new_halves.iter().enumerate() {
            if let Some(ch_vals) = snap.corners.get(&s.corners[i]) {
                for kind in CornerChannelKind::ALL {
                    if let Some(val) = &ch_vals[kind as usize] {
                        mesh.set_corner(kind, nh, val);
                    }
                }
            }
        }
        moved.push(f);
    }

    for s in &saved {
        let n = s.loop_verts.len();
        for i in 0..n {
            let a = s.loop_verts[i];
            let b = s.loop_verts[(i + 1) % n];
            if let Some(&ef) = snap.edge_flags.get(&edge_key(a, b)) {
                set_edge_flags_between(
                    mesh,
                    resolve_target(s.face, a),
                    resolve_target(s.face, b),
                    ef,
                );
            }
        }
    }

    let mut walls = Vec::with_capacity(boundary.len());
    for be in boundary {
        let a2 = resolve_target(be.face, be.a);
        let b2 = resolve_target(be.face, be.b);
        let w = mesh.add_face(&[be.a, be.b, b2, a2], 0)?;
        snap.copy_attrs_to(be.face, mesh, w);
        mesh.f_label[w as usize] = 0;
        mesh.f_role[w as usize] = 0;
        walls.push(w);
        if be.flags != 0 {
            set_edge_flags_between(mesh, be.a, be.b, be.flags);
        }
    }

    Ok((moved, walls))
}

fn region_normal(mesh: &EditMesh, faces: &[i32]) -> Vec3 {
    let mut sum = [0.0f64; 3];
    for &f in faces {
        let pts: Vec<Vec3> = mesh
            .face_vertices(f)
            .into_iter()
            .map(|v| mesh.position(v))
            .collect();
        sum = add(sum, newell(&pts));
    }
    normalize(sum)
}

/// Extrude `faces` along their region normal. Returns `(top_count, side_count)`.
pub fn extrude(
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
    for group in region_groups(mesh, faces, mode) {
        let normal = region_normal(mesh, &group);
        if length(normal) == 0.0 {
            return Err(KernelError::degenerate(
                "extrude",
                "the extruded region has no defined normal",
            ));
        }
        let offset = scale(normal, distance);
        let (moved, walls) = extrude_region(mesh, &group, |_v, orig| add(orig, offset))?;
        mark_role(mesh, &moved, label, "top");
        mark_role(mesh, &walls, label, "side");
        top_count += moved.len();
        side_count += walls.len();
    }
    Ok((top_count, side_count))
}

fn inset_targets(
    mesh: &EditMesh,
    faces: &[i32],
    thickness: f64,
) -> Result<HashMap<i32, Vec3>, KernelError> {
    let boundary = region_boundary(mesh, faces);
    let mut outgoing: HashMap<i32, i32> = HashMap::with_capacity(boundary.len());
    for &h in &boundary {
        let a = mesh.h_vert[h as usize];
        if outgoing.insert(a, h).is_some() {
            return Err(KernelError::precondition(
                "inset",
                "the inset region boundary visits each vertex once",
            ));
        }
    }
    let mut incoming: HashMap<i32, i32> = HashMap::with_capacity(boundary.len());
    for &h in &boundary {
        let b = mesh.h_vert[mesh.h_next[h as usize] as usize];
        incoming.insert(b, h);
    }

    let mut targets: HashMap<i32, Vec3> = HashMap::with_capacity(outgoing.len());
    for (&v, &h_out) in &outgoing {
        let Some(&h_in) = incoming.get(&v) else {
            return Err(KernelError::precondition(
                "inset",
                "the inset region boundary is closed",
            ));
        };
        let p = mesh.position(v);
        let next = mesh.position(mesh.h_vert[mesh.h_next[h_out as usize] as usize]);
        let prev = mesh.position(mesh.h_vert[h_in as usize]);
        let n_out = face_normal(mesh, mesh.h_face[h_out as usize]);
        let n_in = face_normal(mesh, mesh.h_face[h_in as usize]);
        let inward_out = normalize(cross(n_out, normalize(sub(next, p))));
        let inward_in = normalize(cross(n_in, normalize(sub(p, prev))));
        let denom = 1.0 + dot(inward_out, inward_in);
        if denom < 1e-6 {
            return Err(KernelError::degenerate(
                "inset",
                "boundary corners are folded back onto themselves",
            ));
        }
        targets.insert(
            v,
            add(p, scale(add(inward_out, inward_in), thickness / denom)),
        );
    }

    for &f in faces {
        let verts = mesh.face_vertices(f);
        let before: Vec<Vec3> = verts.iter().map(|&v| mesh.position(v)).collect();
        let after: Vec<Vec3> = verts
            .iter()
            .map(|&v| targets.get(&v).copied().unwrap_or_else(|| mesh.position(v)))
            .collect();
        let n = before.len();
        let inverted = (0..n).any(|i| {
            let p = before[i];
            let q = before[(i + 1) % n];
            let a = after[i];
            let b = after[(i + 1) % n];
            dot(sub(q, p), sub(b, a)) <= 0.0
        });
        if inverted || dot(newell(&before), newell(&after)) <= 0.0 {
            return Err(KernelError::degenerate(
                "inset",
                "the inset thickness leaves an inner face collapsed or inverted",
            ));
        }
    }
    Ok(targets)
}

/// Inset `faces` inside their own plane. Returns `(inner_count, rim_count)`.
pub fn inset(
    mesh: &mut EditMesh,
    faces: &[i32],
    thickness: f64,
    mode: RegionMode,
    label: i32,
) -> Result<(usize, usize), KernelError> {
    if !thickness.is_finite() || thickness <= 0.0 {
        return Err(KernelError::invalid_value(
            "thickness",
            "must be finite and > 0",
        ));
    }
    let mut inner_count = 0usize;
    let mut rim_count = 0usize;
    for group in region_groups(mesh, faces, mode) {
        let targets = inset_targets(mesh, &group, thickness)?;
        let (moved, walls) = extrude_region(mesh, &group, |v, orig| {
            targets.get(&v).copied().unwrap_or(orig)
        })?;
        mark_role(mesh, &moved, label, "inner");
        mark_role(mesh, &walls, label, "rim");
        inner_count += moved.len();
        rim_count += walls.len();
    }
    Ok((inner_count, rim_count))
}
