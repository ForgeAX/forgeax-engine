//! Garland-Heckbert QEM simplification, Botsch-Kobbelt isotropic remeshing,
//! and `cleanup.tiling` over `EditMesh`.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::bvh::TriSoupBvh;
use crate::mesh::geom::{add, cross, dot, face_normal, length, normalize, scale, sub, Vec3};
use crate::mesh::rewrite::{flag_sharpness, merge_flags, triangulate_loop, with_crease};
use crate::mesh::{CornerChannelKind, EditMesh, CHANNEL_COUNT, EDGE_SEAM, EDGE_SHARP, NONE};

pub const F_BOUNDARY: u32 = 1;
pub const F_SHARP: u32 = 2;
pub const F_SEAM: u32 = 4;
pub const F_MATERIAL: u32 = 8;
pub const F_LABEL: u32 = 16;
pub const F_BORDER: u32 = 32;
pub const F_UV: u32 = 64;
const F_CREASE_SHIFT: u32 = 8;
const F_FEATURE_BITS: u32 = (1 << F_CREASE_SHIFT) - 1;

#[inline]
fn merge_work_bits(a: u32, b: u32) -> u32 {
    let ca = ((a >> F_CREASE_SHIFT) & 0xff) as u8;
    let cb = ((b >> F_CREASE_SHIFT) & 0xff) as u8;
    let merged_c = merge_flags(ca, cb) as u32;
    ((a | b) & F_FEATURE_BITS) | (merged_c << F_CREASE_SHIFT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstraintLevel {
    Free,
    Keep,
    Pin,
}

#[derive(Debug, Clone, Copy)]
pub struct PreserveConstraints {
    pub boundary: ConstraintLevel,
    pub sharp: ConstraintLevel,
    pub seam: ConstraintLevel,
    pub material: ConstraintLevel,
    pub label: ConstraintLevel,
}

impl Default for PreserveConstraints {
    fn default() -> Self {
        Self {
            boundary: ConstraintLevel::Keep,
            sharp: ConstraintLevel::Keep,
            seam: ConstraintLevel::Keep,
            material: ConstraintLevel::Keep,
            label: ConstraintLevel::Keep,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SimplifyOptions {
    pub target_faces: Option<usize>,
    pub max_error: Option<f64>,
    pub volume_preserving: bool,
    pub max_aspect: Option<f64>,
    pub max_valence: Option<usize>,
    pub constraints: PreserveConstraints,
    pub silhouette_weight: f64,
}

impl Default for SimplifyOptions {
    fn default() -> Self {
        Self {
            target_faces: None,
            max_error: None,
            volume_preserving: true,
            max_aspect: None,
            max_valence: None,
            constraints: PreserveConstraints::default(),
            silhouette_weight: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RemeshOptions {
    pub target_edge_length: f64,
    pub iterations: usize,
    pub smooth_weight: f64,
    pub constraints: PreserveConstraints,
}

impl Default for RemeshOptions {
    fn default() -> Self {
        Self {
            target_edge_length: 0.1,
            iterations: 5,
            smooth_weight: 0.5,
            constraints: PreserveConstraints::default(),
        }
    }
}

/// 4x4 symmetric matrix stored as 10 upper-triangular floats:
/// [a00, a01, a02, a03, a11, a12, a13, a22, a23, a33]
#[derive(Debug, Clone, Copy, Default)]
struct Quadric {
    q: [f64; 10],
}

impl Quadric {
    fn from_plane(n: Vec3, d: f64, weight: f64) -> Self {
        let [a, b, c] = n;
        Self {
            q: [
                a * a * weight,
                a * b * weight,
                a * c * weight,
                a * d * weight,
                b * b * weight,
                b * c * weight,
                b * d * weight,
                c * c * weight,
                c * d * weight,
                d * d * weight,
            ],
        }
    }

    fn add(&mut self, o: &Self) {
        for i in 0..10 {
            self.q[i] += o.q[i];
        }
    }

    fn eval(&self, p: Vec3) -> f64 {
        let [x, y, z] = p;
        let m = &self.q;
        m[0] * x * x
            + 2.0 * m[1] * x * y
            + 2.0 * m[2] * x * z
            + 2.0 * m[3] * x
            + m[4] * y * y
            + 2.0 * m[5] * y * z
            + 2.0 * m[6] * y
            + m[7] * z * z
            + 2.0 * m[8] * z
            + m[9]
    }

    /// Solve 3x3 linear system A x = -b if invertible.
    fn solve_optimal(&self) -> Option<Vec3> {
        let m = &self.q;
        let a = [[m[0], m[1], m[2]], [m[1], m[4], m[5]], [m[2], m[5], m[7]]];
        let rhs = [-m[3], -m[6], -m[8]];
        solve3x3(a, rhs)
    }
}

fn solve3x3(a: [[f64; 3]; 3], b: [f64; 3]) -> Option<Vec3> {
    let det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv = 1.0 / det;
    let x0 = (b[0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (b[1] * a[2][2] - a[1][2] * b[2])
        + a[0][2] * (b[1] * a[2][1] - a[1][1] * b[2]))
        * inv;
    let x1 = (a[0][0] * (b[1] * a[2][2] - a[1][2] * b[2])
        - b[0] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * b[2] - b[1] * a[2][0]))
        * inv;
    let x2 = (a[0][0] * (a[1][1] * b[2] - b[1] * a[2][1])
        - a[0][1] * (a[1][0] * b[2] - b[1] * a[2][0])
        + b[0] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
        * inv;
    if x0.is_finite() && x1.is_finite() && x2.is_finite() {
        Some([x0, x1, x2])
    } else {
        None
    }
}

#[inline]
fn ekey(a: usize, b: usize) -> u64 {
    let (lo, hi) = if a < b {
        (a as u64, b as u64)
    } else {
        (b as u64, a as u64)
    };
    (lo << 32) | hi
}

fn mask_of(c: &PreserveConstraints, pred: impl Fn(ConstraintLevel) -> bool) -> u32 {
    let mut m = 0u32;
    if pred(c.boundary) {
        m |= F_BOUNDARY;
    }
    if pred(c.sharp) {
        m |= F_SHARP;
    }
    if pred(c.seam) {
        m |= F_SEAM | F_UV;
    }
    if pred(c.material) {
        m |= F_MATERIAL;
    }
    if pred(c.label) {
        m |= F_LABEL;
    }
    m
}

struct WorkMesh {
    pos: Vec<Vec3>,
    alive: Vec<bool>,
    tri: Vec<[isize; 3]>,
    tri_src: Vec<i32>,
    tri_alive: Vec<bool>,
    live_tris: usize,
    vt: Vec<Vec<usize>>,
    flags: HashMap<u64, u32>,
    vclass: Vec<u8>, // 0 = free, 1 = curve slide, 2 = fixed
    vfeat: Vec<u32>,
    keep_mask: u32,
    pin_mask: u32,
    quadrics: Vec<Quadric>,
    src_positions: Vec<f64>,
    src_indices: Vec<u32>,
    src_tri_face: Vec<i32>,
}

impl WorkMesh {
    fn from_edit_mesh(
        mesh: &EditMesh,
        faces: &[i32],
        constraints: &PreserveConstraints,
        silhouette_eyes: &[Vec3],
        silhouette_weight: f64,
    ) -> Result<(Self, HashMap<i32, usize>), KernelError> {
        let selected: HashSet<i32> = faces.iter().copied().collect();
        let mut vert_map: HashMap<i32, usize> = HashMap::new();
        let mut pos = Vec::new();

        for &f in faces {
            if !mesh.is_face_alive(f) {
                continue;
            }
            for v in mesh.face_vertices(f) {
                vert_map.entry(v).or_insert_with(|| {
                    let idx = pos.len();
                    pos.push(mesh.position(v));
                    idx
                });
            }
        }

        let n_v = pos.len();
        let mut work = Self {
            pos,
            alive: vec![true; n_v],
            tri: Vec::new(),
            tri_src: Vec::new(),
            tri_alive: Vec::new(),
            live_tris: 0,
            vt: vec![Vec::new(); n_v],
            flags: HashMap::new(),
            vclass: vec![0; n_v],
            vfeat: vec![0; n_v],
            keep_mask: mask_of(constraints, |l| l != ConstraintLevel::Free),
            pin_mask: mask_of(constraints, |l| l == ConstraintLevel::Pin),
            quadrics: vec![Quadric::default(); n_v],
            src_positions: Vec::new(),
            src_indices: Vec::new(),
            src_tri_face: Vec::new(),
        };

        for p in &work.pos {
            work.src_positions.extend_from_slice(p);
        }

        // Triangulate selected faces & track source triangles
        for &f in faces {
            if !mesh.is_face_alive(f) {
                continue;
            }
            let fv = mesh.face_vertices(f);
            if fv.len() < 3 {
                continue;
            }
            let pts: Vec<Vec3> = fv.iter().map(|&v| mesh.position(v)).collect();
            let indices = if fv.len() == 3 {
                vec![0, 1, 2]
            } else {
                triangulate_loop(&pts).ok_or_else(|| {
                    KernelError::invalid_value("face", "degenerate face cannot be triangulated")
                })?
            };
            for ch in indices.chunks_exact(3) {
                let va = vert_map[&fv[ch[0]]];
                let vb = vert_map[&fv[ch[1]]];
                let vc = vert_map[&fv[ch[2]]];
                if va == vb || vb == vc || vc == va {
                    continue;
                }
                let ti = work.tri.len();
                work.tri.push([va as isize, vb as isize, vc as isize]);
                work.tri_src.push(f);
                work.tri_alive.push(true);
                work.live_tris += 1;
                work.vt[va].push(ti);
                work.vt[vb].push(ti);
                work.vt[vc].push(ti);
                work.src_indices
                    .extend_from_slice(&[va as u32, vb as u32, vc as u32]);
                work.src_tri_face.push(f);
            }
        }

        // Collect feature edge flags from mesh edges adjacent to selected faces
        let mut seen_e = HashSet::new();
        for &f in faces {
            if !mesh.is_face_alive(f) {
                continue;
            }
            for h in mesh.face_halves(f) {
                let e = h >> 1;
                if !seen_e.insert(e) {
                    continue;
                }
                let [va_id, vb_id] = mesh.edge_vertices(e);
                let (Some(&va), Some(&vb)) = (vert_map.get(&va_id), vert_map.get(&vb_id)) else {
                    continue;
                };
                let f1 = mesh.h_face[(e * 2) as usize];
                let f2 = mesh.h_face[(e * 2 + 1) as usize];
                let in1 = f1 != NONE && selected.contains(&f1);
                let in2 = f2 != NONE && selected.contains(&f2);
                let mut bits = 0u32;
                if f1 == NONE || f2 == NONE {
                    bits |= F_BOUNDARY;
                } else if in1 != in2 {
                    bits |= F_BORDER;
                }
                let ef = mesh.e_flags[e as usize];
                if (ef & EDGE_SHARP) != 0 {
                    bits |= F_SHARP;
                    bits |= (ef as u32) << F_CREASE_SHIFT;
                }
                if (ef & EDGE_SEAM) != 0 {
                    bits |= F_SEAM;
                }
                if f1 != NONE && f2 != NONE {
                    if mesh.f_material[f1 as usize] != mesh.f_material[f2 as usize] {
                        bits |= F_MATERIAL;
                    }
                    if mesh.f_label[f1 as usize] != mesh.f_label[f2 as usize]
                        || mesh.f_role[f1 as usize] != mesh.f_role[f2 as usize]
                    {
                        bits |= F_LABEL;
                    }
                }
                if bits != 0 {
                    let k = ekey(va, vb);
                    work.flags
                        .entry(k)
                        .and_modify(|prev| *prev = merge_work_bits(*prev, bits))
                        .or_insert(bits);
                }
            }
        }

        work.classify_vertices();

        // Accumulate initial plane quadrics (area weighted)
        let mut weights = vec![1.0f64; n_v];
        if !silhouette_eyes.is_empty() && silhouette_weight > 0.0 {
            for &eye in silhouette_eyes {
                let mut sign_mask = vec![0u8; n_v];
                for t in 0..work.tri.len() {
                    let [ia, ib, ic] = [
                        work.tri[t][0] as usize,
                        work.tri[t][1] as usize,
                        work.tri[t][2] as usize,
                    ];
                    let n = cross(
                        sub(work.pos[ib], work.pos[ia]),
                        sub(work.pos[ic], work.pos[ia]),
                    );
                    let mid = [
                        (work.pos[ia][0] + work.pos[ib][0] + work.pos[ic][0]) / 3.0,
                        (work.pos[ia][1] + work.pos[ib][1] + work.pos[ic][1]) / 3.0,
                        (work.pos[ia][2] + work.pos[ib][2] + work.pos[ic][2]) / 3.0,
                    ];
                    let bit = if dot(n, sub(eye, mid)) >= 0.0 { 1 } else { 2 };
                    sign_mask[ia] |= bit;
                    sign_mask[ib] |= bit;
                    sign_mask[ic] |= bit;
                }
                for v in 0..n_v {
                    if sign_mask[v] == 3 {
                        weights[v] = (weights[v]).max(1.0 + silhouette_weight);
                    }
                }
            }
        }

        for t in 0..work.tri.len() {
            let [ia, ib, ic] = [
                work.tri[t][0] as usize,
                work.tri[t][1] as usize,
                work.tri[t][2] as usize,
            ];
            let ab = sub(work.pos[ib], work.pos[ia]);
            let ac = sub(work.pos[ic], work.pos[ia]);
            let cr = cross(ab, ac);
            let area2 = length(cr);
            if !(area2 > 1e-18) {
                continue;
            }
            let n = scale(cr, 1.0 / area2);
            let d = -dot(n, work.pos[ia]);
            let area = area2 * 0.5;
            for &v in &[ia, ib, ic] {
                let q = Quadric::from_plane(n, d, area * weights[v]);
                work.quadrics[v].add(&q);
            }
        }

        Ok((work, vert_map))
    }

    fn classify_vertices(&mut self) {
        let mut incident: Vec<Vec<u32>> = vec![Vec::new(); self.pos.len()];
        for (&k, &bits) in &self.flags {
            let a = (k >> 32) as usize;
            let b = (k & 0xffff_ffff) as usize;
            let active = bits & self.keep_mask;
            if active == 0 && (bits & F_BORDER) == 0 {
                continue;
            }
            incident[a].push(bits);
            incident[b].push(bits);
        }
        for v in 0..self.pos.len() {
            if !self.alive[v] {
                continue;
            }
            let list = &incident[v];
            if list.is_empty() {
                self.vclass[v] = 0;
                self.vfeat[v] = 0;
                continue;
            }
            let mut combined = 0u32;
            let mut active_count = 0usize;
            for &bits in list {
                if (bits & (self.keep_mask | F_BORDER)) != 0 {
                    active_count += 1;
                    combined |= bits;
                }
            }
            if (combined & (self.pin_mask | F_BORDER)) != 0 || active_count != 2 {
                self.vclass[v] = 2;
            } else {
                self.vclass[v] = 1;
            }
            self.vfeat[v] = combined;
        }
    }

    fn can_collapse(&self, a: usize, b: usize) -> Option<(Vec3, f64)> {
        if !self.alive[a] || !self.alive[b] || a == b {
            return None;
        }
        let ebits = self.flags.get(&ekey(a, b)).copied().unwrap_or(0);
        if (ebits & (self.pin_mask | F_BORDER)) != 0 {
            return None;
        }
        let ca = self.vclass[a];
        let cb = self.vclass[b];
        if ca == 2 && cb == 2 {
            return None;
        }
        if ca == 1 && cb == 1 && (ebits & self.keep_mask) == 0 {
            return None;
        }

        // Link condition: number of shared vertices between edge neighbors equals shared triangles
        let mut na = HashSet::new();
        for &t in &self.vt[a] {
            if !self.tri_alive[t] {
                continue;
            }
            for k in 0..3 {
                let u = self.tri[t][k] as usize;
                if u != a && u != b {
                    na.insert(u);
                }
            }
        }
        let mut shared_tris = 0usize;
        let mut nb_in_a = HashSet::new();
        for &t in &self.vt[b] {
            if !self.tri_alive[t] {
                continue;
            }
            let mut has_a = false;
            for k in 0..3 {
                let u = self.tri[t][k] as usize;
                if u == a {
                    has_a = true;
                }
                if u != a && u != b && na.contains(&u) {
                    nb_in_a.insert(u);
                }
            }
            if has_a {
                shared_tris += 1;
            }
        }
        if nb_in_a.len() != shared_tris {
            return None;
        }

        let mut q = self.quadrics[a];
        q.add(&self.quadrics[b]);
        let pos = if ca == 2 {
            self.pos[a]
        } else if cb == 2 {
            self.pos[b]
        } else if ca == 1 && cb == 0 {
            self.pos[a]
        } else if cb == 1 && ca == 0 {
            self.pos[b]
        } else {
            let mid = scale(add(self.pos[a], self.pos[b]), 0.5);
            if let Some(opt) = q.solve_optimal() {
                let ea = q.eval(self.pos[a]).max(0.0);
                let eb = q.eval(self.pos[b]).max(0.0);
                let em = q.eval(mid).max(0.0);
                let eo = q.eval(opt).max(0.0);
                let mut best_p = opt;
                let mut best_e = eo;
                for (cand_p, cand_e) in [(self.pos[a], ea), (self.pos[b], eb), (mid, em)] {
                    if cand_e < best_e {
                        best_e = cand_e;
                        best_p = cand_p;
                    }
                }
                best_p
            } else {
                let ea = q.eval(self.pos[a]).max(0.0);
                let eb = q.eval(self.pos[b]).max(0.0);
                let em = q.eval(mid).max(0.0);
                if ea <= eb && ea <= em {
                    self.pos[a]
                } else if eb <= em {
                    self.pos[b]
                } else {
                    mid
                }
            }
        };

        // Foldover check (MIN_NORMAL_DOT = 0.2)
        for &v in &[a, b] {
            for &t in &self.vt[v] {
                if !self.tri_alive[t] {
                    continue;
                }
                let vs = [
                    self.tri[t][0] as usize,
                    self.tri[t][1] as usize,
                    self.tri[t][2] as usize,
                ];
                if vs.contains(&a) && vs.contains(&b) {
                    continue;
                }
                let p_old = [self.pos[vs[0]], self.pos[vs[1]], self.pos[vs[2]]];
                let n_old = normalize(cross(sub(p_old[1], p_old[0]), sub(p_old[2], p_old[0])));
                let mut p_new = p_old;
                for k in 0..3 {
                    if vs[k] == a || vs[k] == b {
                        p_new[k] = pos;
                    }
                }
                let c_new = cross(sub(p_new[1], p_new[0]), sub(p_new[2], p_new[0]));
                let len_new = length(c_new);
                if !(len_new > 1e-18) {
                    return None;
                }
                let n_new = scale(c_new, 1.0 / len_new);
                if dot(n_old, n_new) < 0.2 {
                    return None;
                }
            }
        }

        let err = q.eval(pos).max(0.0);
        Some((pos, err))
    }

    fn collapse(&mut self, a: usize, b: usize, new_pos: Vec3) {
        self.pos[a] = new_pos;
        let mut q = self.quadrics[a];
        q.add(&self.quadrics[b]);
        self.quadrics[a] = q;
        self.alive[b] = false;
        if self.vclass[b] > self.vclass[a] {
            self.vclass[a] = self.vclass[b];
        }
        self.vfeat[a] |= self.vfeat[b];

        // Transfer b edge flags onto a
        let b_edges: Vec<(usize, u32)> = self
            .flags
            .iter()
            .filter_map(|(&k, &fl)| {
                let u = (k >> 32) as usize;
                let v = (k & 0xffff_ffff) as usize;
                if u == b {
                    Some((v, fl))
                } else if v == b {
                    Some((u, fl))
                } else {
                    None
                }
            })
            .collect();
        for (other, fl) in b_edges {
            self.flags.remove(&ekey(b, other));
            if other != a {
                self.flags
                    .entry(ekey(a, other))
                    .and_modify(|prev| *prev = merge_work_bits(*prev, fl))
                    .or_insert(fl);
            }
        }

        let bt = std::mem::take(&mut self.vt[b]);
        for t in bt {
            if !self.tri_alive[t] {
                continue;
            }
            let mut has_a = false;
            for k in 0..3 {
                if self.tri[t][k] as usize == a {
                    has_a = true;
                }
            }
            if has_a {
                self.tri_alive[t] = false;
                self.live_tris -= 1;
            } else {
                for k in 0..3 {
                    if self.tri[t][k] as usize == b {
                        self.tri[t][k] = a as isize;
                    }
                }
                self.vt[a].push(t);
            }
        }
        self.vt[a].retain(|&t| self.tri_alive[t]);
    }
}

#[derive(Clone, Copy)]
struct HeapItem {
    err: f64,
    a: usize,
    b: usize,
    stamp: u32,
}

impl Eq for HeapItem {}
impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.a == other.a && self.b == other.b && self.stamp == other.stamp
    }
}
impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .err
            .total_cmp(&self.err)
            .then_with(|| other.a.cmp(&self.a))
            .then_with(|| other.b.cmp(&self.b))
    }
}
impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Write a simplified or remeshed `WorkMesh` back into `mesh`, replacing `old_faces`,
/// preserving face attributes/tags, edge sharp/seam/crease flags, and interpolating corners.
fn commit_work_mesh(
    mesh: &mut EditMesh,
    old_faces: &[i32],
    work: &WorkMesh,
    src_map: &HashMap<i32, usize>,
) -> Result<usize, KernelError> {
    let words = mesh.tag_words;
    struct SnapAttr {
        material: i32,
        label: i32,
        role: i32,
        flags: u8,
        tags: Vec<u32>,
    }
    let mut attrs: HashMap<i32, SnapAttr> = HashMap::new();
    for &f in old_faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let fu = f as usize;
        attrs.insert(
            f,
            SnapAttr {
                material: mesh.f_material[fu],
                label: mesh.f_label[fu],
                role: mesh.f_role[fu],
                flags: mesh.f_flags[fu],
                tags: mesh.f_tags[fu * words..(fu + 1) * words].to_vec(),
            },
        );
    }

    // Build source triangle BVH and source corner channel values for attribute transfer
    let has_uv0 = mesh.channels[CornerChannelKind::Uv0 as usize].is_some();
    let mut src_tri_uvs: Vec<[[f32; 2]; 3]> = Vec::new();
    if has_uv0 {
        for &f in old_faces {
            if !mesh.is_face_alive(f) {
                continue;
            }
            let halves = mesh.face_halves(f);
            if halves.len() < 3 {
                continue;
            }
            let pts: Vec<Vec3> = halves
                .iter()
                .map(|&h| mesh.position(mesh.h_vert[h as usize]))
                .collect();
            let indices = if halves.len() == 3 {
                vec![0, 1, 2]
            } else {
                triangulate_loop(&pts).unwrap_or_else(|| vec![0, 1, 2])
            };
            for ch in indices.chunks_exact(3) {
                let u0 = mesh
                    .corner(CornerChannelKind::Uv0, halves[ch[0]])
                    .unwrap_or(&[0.0, 0.0]);
                let u1 = mesh
                    .corner(CornerChannelKind::Uv0, halves[ch[1]])
                    .unwrap_or(&[0.0, 0.0]);
                let u2 = mesh
                    .corner(CornerChannelKind::Uv0, halves[ch[2]])
                    .unwrap_or(&[0.0, 0.0]);
                src_tri_uvs.push([[u0[0], u0[1]], [u1[0], u1[1]], [u2[0], u2[1]]]);
            }
        }
    }
    let src_bvh = if has_uv0 && !work.src_indices.is_empty() {
        Some(TriSoupBvh::build(
            &work.src_positions,
            &work.src_indices,
            None,
        ))
    } else {
        None
    };

    // Preserve border vertex ids where exact correspondence exists
    let mut rev_vert: HashMap<usize, i32> = HashMap::new();
    for (&ov, &wi) in src_map {
        if (work.vfeat[wi] & F_BORDER) != 0 && work.alive[wi] {
            rev_vert.insert(wi, ov);
        }
    }

    let mut used_old = HashSet::new();
    for &f in old_faces {
        for v in mesh.face_vertices(f) {
            used_old.insert(v);
        }
        mesh.remove_face(f);
    }

    let mut new_verts: HashMap<usize, i32> = HashMap::new();
    for (wi, &ov) in &rev_vert {
        new_verts.insert(*wi, ov);
        mesh.set_position(ov, work.pos[*wi][0], work.pos[*wi][1], work.pos[*wi][2]);
    }
    for wi in 0..work.pos.len() {
        if !work.alive[wi] || new_verts.contains_key(&wi) {
            continue;
        }
        let p = work.pos[wi];
        new_verts.insert(wi, mesh.add_vertex(p[0], p[1], p[2])?);
    }

    // Remove unused interior old vertices
    let mut still_used = HashSet::new();
    for f in mesh.faces() {
        for v in mesh.face_vertices(f) {
            still_used.insert(v);
        }
    }
    for v in used_old {
        if !still_used.contains(&v) && !rev_vert.values().any(|&rv| rv == v) {
            mesh.remove_vertex(v);
        }
    }

    let mut created_tris = 0usize;
    for t in 0..work.tri.len() {
        if !work.tri_alive[t] {
            continue;
        }
        let [wa, wb, wc] = [
            work.tri[t][0] as usize,
            work.tri[t][1] as usize,
            work.tri[t][2] as usize,
        ];
        let va = new_verts[&wa];
        let vb = new_verts[&wb];
        let vc = new_verts[&wc];
        let src_f = work.tri_src[t];
        let attr = attrs.get(&src_f);
        let mat = attr.map_or(0, |a| a.material);
        let Ok(nf) = mesh.add_face(&[va, vb, vc], mat) else {
            continue;
        };
        created_tris += 1;
        if let Some(a) = attr {
            let nfu = nf as usize;
            mesh.f_label[nfu] = a.label;
            mesh.f_role[nfu] = a.role;
            mesh.f_flags[nfu] = a.flags;
            for w in 0..words {
                mesh.f_tags[nfu * words + w] = a.tags[w];
            }
        }
        if let Some(ref bvh) = src_bvh {
            let halves = mesh.face_halves(nf);
            for (k, &h) in halves.iter().enumerate() {
                let p = work.pos[[wa, wb, wc][k]];
                if let Some(nr) = bvh.nearest_filtered(p, f64::INFINITY, |_| true) {
                    if let Some(uv_tri) = src_tri_uvs.get(nr.triangle) {
                        let w0 = 1.0 - nr.u - nr.v;
                        let u = (w0 * (uv_tri[0][0] as f64)
                            + nr.u * (uv_tri[1][0] as f64)
                            + nr.v * (uv_tri[2][0] as f64)) as f32;
                        let v = (w0 * (uv_tri[0][1] as f64)
                            + nr.u * (uv_tri[1][1] as f64)
                            + nr.v * (uv_tri[2][1] as f64)) as f32;
                        mesh.set_corner(CornerChannelKind::Uv0, h, &[u, v]);
                    }
                }
            }
        }
    }

    // Reapply preserved edge flags
    for (&k, &bits) in &work.flags {
        let wa = (k >> 32) as usize;
        let wb = (k & 0xffff_ffff) as usize;
        if !work.alive[wa] || !work.alive[wb] {
            continue;
        }
        let Some(&va) = new_verts.get(&wa) else {
            continue;
        };
        let Some(&vb) = new_verts.get(&wb) else {
            continue;
        };
        let h = mesh.find_half(va, vb);
        if h == NONE {
            continue;
        }
        let mut intent = 0u8;
        if (bits & F_SHARP) != 0 {
            let c_raw = ((bits >> F_CREASE_SHIFT) & 0xff) as u8;
            let sharp = if (c_raw & EDGE_SHARP) != 0 {
                flag_sharpness(c_raw, true)
            } else {
                f64::INFINITY
            };
            intent = with_crease(intent, sharp);
        }
        if (bits & F_SEAM) != 0 {
            intent |= EDGE_SEAM;
        }
        if intent != 0 {
            let e = (h >> 1) as usize;
            mesh.e_flags[e] = merge_flags(mesh.e_flags[e], intent);
        }
    }
    let _ = CHANNEL_COUNT;
    Ok(created_tris)
}

/// Garland-Heckbert QEM simplification with feature & silhouette preservation.
pub fn qem_simplify(
    mesh: &mut EditMesh,
    faces: &[i32],
    opts: &SimplifyOptions,
    silhouette_eyes: &[Vec3],
) -> Result<(usize, f64), KernelError> {
    if faces.is_empty() {
        return Err(KernelError::no_effect("simplify", "no faces selected"));
    }
    let (mut work, src_map) = WorkMesh::from_edit_mesh(
        mesh,
        faces,
        &opts.constraints,
        silhouette_eyes,
        opts.silhouette_weight,
    )?;

    let target = opts.target_faces.unwrap_or(0);
    let max_err_sq = opts.max_error.map_or(f64::INFINITY, |e| e * e);

    let mut stamps: HashMap<u64, u32> = HashMap::new();
    let mut heap = BinaryHeap::new();
    let push_edge = |w: &WorkMesh,
                     u: usize,
                     v: usize,
                     heap: &mut BinaryHeap<HeapItem>,
                     stamps: &mut HashMap<u64, u32>| {
        if let Some((_, err)) = w.can_collapse(u, v) {
            let k = ekey(u, v);
            let s = stamps.entry(k).and_modify(|x| *x += 1).or_insert(0);
            let (a, b) = if u < v { (u, v) } else { (v, u) };
            heap.push(HeapItem {
                err,
                a,
                b,
                stamp: *s,
            });
        }
    };

    for t in 0..work.tri.len() {
        let [a, b, c] = [
            work.tri[t][0] as usize,
            work.tri[t][1] as usize,
            work.tri[t][2] as usize,
        ];
        push_edge(&work, a, b, &mut heap, &mut stamps);
        push_edge(&work, b, c, &mut heap, &mut stamps);
        push_edge(&work, c, a, &mut heap, &mut stamps);
    }

    let mut max_collapse_err = 0.0f64;
    while work.live_tris > target {
        let Some(item) = heap.pop() else {
            break;
        };
        if stamps.get(&ekey(item.a, item.b)).copied().unwrap_or(0) != item.stamp {
            continue;
        }
        if item.err > max_err_sq {
            break;
        }
        let Some((pos, exact_err)) = work.can_collapse(item.a, item.b) else {
            continue;
        };
        if exact_err > max_err_sq {
            break;
        }
        max_collapse_err = max_collapse_err.max(exact_err.sqrt());
        work.collapse(item.a, item.b, pos);

        let mut neigh = HashSet::new();
        for &t in &work.vt[item.a] {
            if work.tri_alive[t] {
                for k in 0..3 {
                    let u = work.tri[t][k] as usize;
                    if u != item.a {
                        neigh.insert(u);
                    }
                }
            }
        }
        for u in neigh {
            push_edge(&work, item.a, u, &mut heap, &mut stamps);
        }
    }

    let final_tris = commit_work_mesh(mesh, faces, &work, &src_map)?;
    Ok((final_tris, max_collapse_err))
}

/// Botsch-Kobbelt isotropic remeshing over `faces` with BVH reprojection.
pub fn isotropic_remesh(
    mesh: &mut EditMesh,
    faces: &[i32],
    opts: &RemeshOptions,
) -> Result<usize, KernelError> {
    if !opts.target_edge_length.is_finite() || opts.target_edge_length <= 0.0 {
        return Err(KernelError::invalid_value(
            "targetEdgeLength",
            "must be > 0",
        ));
    }
    let (mut work, src_map) = WorkMesh::from_edit_mesh(mesh, faces, &opts.constraints, &[], 0.0)?;
    let target_bvh = TriSoupBvh::build(&work.src_positions, &work.src_indices, None);

    let hi_len = (4.0 / 3.0) * opts.target_edge_length;
    let lo_len = (4.0 / 5.0) * opts.target_edge_length;
    let hi_sq = hi_len * hi_len;
    let lo_sq = lo_len * lo_len;

    for _iter in 0..opts.iterations.clamp(1, 20) {
        // 1. Split edges > 4/3 L
        let mut to_split: Vec<(usize, usize)> = Vec::new();
        let mut seen = HashSet::new();
        for t in 0..work.tri.len() {
            if !work.tri_alive[t] {
                continue;
            }
            for k in 0..3 {
                let a = work.tri[t][k] as usize;
                let b = work.tri[t][(k + 1) % 3] as usize;
                if seen.insert(ekey(a, b)) {
                    let d = sub(work.pos[a], work.pos[b]);
                    if dot(d, d) > hi_sq {
                        to_split.push((a, b));
                    }
                }
            }
        }
        for (a, b) in to_split {
            // Find up to 2 alive triangles sharing edge (a, b)
            let shared: Vec<usize> = work.vt[a]
                .iter()
                .copied()
                .filter(|&t| work.tri_alive[t] && (0..3).any(|k| work.tri[t][k] as usize == b))
                .collect();
            if shared.is_empty() || shared.len() > 2 {
                continue;
            }
            let mid = scale(add(work.pos[a], work.pos[b]), 0.5);
            let m = work.pos.len();
            work.pos.push(mid);
            work.alive.push(true);
            work.vt.push(Vec::new());
            let e_fl = work.flags.remove(&ekey(a, b)).unwrap_or(0);
            let mclass = if (e_fl & (work.pin_mask | F_BORDER)) != 0 {
                2
            } else if (e_fl & work.keep_mask) != 0 {
                1
            } else {
                0
            };
            work.vclass.push(mclass);
            work.vfeat.push(e_fl);
            work.quadrics.push(Quadric::default());
            if e_fl != 0 {
                work.flags.insert(ekey(a, m), e_fl);
                work.flags.insert(ekey(m, b), e_fl);
            }
            for st in shared {
                let vs = [
                    work.tri[st][0] as usize,
                    work.tri[st][1] as usize,
                    work.tri[st][2] as usize,
                ];
                let pos_a = (0..3).find(|&i| vs[i] == a).unwrap();
                let pos_b = (0..3).find(|&i| vs[i] == b).unwrap();
                let opp = vs[3 - pos_a - pos_b];
                let a_before_b = (pos_a + 1) % 3 == pos_b;
                let (t1v, t2v) = if a_before_b {
                    ([a, m, opp], [m, b, opp])
                } else {
                    ([b, m, opp], [m, a, opp])
                };
                let src = work.tri_src[st];
                work.tri_alive[st] = false;
                work.live_tris -= 1;
                for tv in [t1v, t2v] {
                    let nt = work.tri.len();
                    work.tri
                        .push([tv[0] as isize, tv[1] as isize, tv[2] as isize]);
                    work.tri_src.push(src);
                    work.tri_alive.push(true);
                    work.live_tris += 1;
                    for &vv in &tv {
                        work.vt[vv].push(nt);
                    }
                }
            }
        }

        // 2. Collapse short edges < 4/5 L
        let mut short_edges = Vec::new();
        seen.clear();
        for t in 0..work.tri.len() {
            if !work.tri_alive[t] {
                continue;
            }
            for k in 0..3 {
                let a = work.tri[t][k] as usize;
                let b = work.tri[t][(k + 1) % 3] as usize;
                if seen.insert(ekey(a, b)) {
                    let d = sub(work.pos[a], work.pos[b]);
                    if dot(d, d) < lo_sq {
                        short_edges.push((a, b));
                    }
                }
            }
        }
        for (a, b) in short_edges {
            if !work.alive[a] || !work.alive[b] {
                continue;
            }
            if let Some((pos, _)) = work.can_collapse(a, b) {
                work.collapse(a, b, pos);
            }
        }

        // 3. Tangential smoothing & BVH reprojection
        let smooth_w = opts.smooth_weight.clamp(0.0, 1.0);
        if smooth_w > 0.0 {
            let old_pos = work.pos.clone();
            for v in 0..work.pos.len() {
                if !work.alive[v] || work.vclass[v] == 2 {
                    continue;
                }
                let mut sum = [0.0f64; 3];
                let mut cnt = 0usize;
                let mut v_norm = [0.0f64; 3];
                let mut nbrs = HashSet::new();
                for &t in &work.vt[v] {
                    if !work.tri_alive[t] {
                        continue;
                    }
                    let [i0, i1, i2] = [
                        work.tri[t][0] as usize,
                        work.tri[t][1] as usize,
                        work.tri[t][2] as usize,
                    ];
                    let fn_v = cross(sub(old_pos[i1], old_pos[i0]), sub(old_pos[i2], old_pos[i0]));
                    v_norm = add(v_norm, fn_v);
                    for u in [i0, i1, i2] {
                        if u != v && nbrs.insert(u) {
                            let ok_nbr = work.vclass[v] == 0
                                || (work.flags.get(&ekey(v, u)).copied().unwrap_or(0)
                                    & work.keep_mask)
                                    != 0;
                            if ok_nbr {
                                sum = add(sum, old_pos[u]);
                                cnt += 1;
                            }
                        }
                    }
                }
                if cnt == 0 {
                    continue;
                }
                let avg = scale(sum, 1.0 / (cnt as f64));
                let delta = sub(avg, old_pos[v]);
                let p_move = if work.vclass[v] == 1 {
                    add(old_pos[v], scale(delta, smooth_w))
                } else {
                    let n = normalize(v_norm);
                    let tan = sub(delta, scale(n, dot(delta, n)));
                    add(old_pos[v], scale(tan, smooth_w))
                };
                if let Some(nr) = target_bvh.nearest_filtered(p_move, f64::INFINITY, |_| true) {
                    let i0 = (work.src_indices[nr.triangle * 3] as usize) * 3;
                    let i1 = (work.src_indices[nr.triangle * 3 + 1] as usize) * 3;
                    let i2 = (work.src_indices[nr.triangle * 3 + 2] as usize) * 3;
                    let w0 = 1.0 - nr.u - nr.v;
                    work.pos[v] = [
                        w0 * work.src_positions[i0]
                            + nr.u * work.src_positions[i1]
                            + nr.v * work.src_positions[i2],
                        w0 * work.src_positions[i0 + 1]
                            + nr.u * work.src_positions[i1 + 1]
                            + nr.v * work.src_positions[i2 + 1],
                        w0 * work.src_positions[i0 + 2]
                            + nr.u * work.src_positions[i1 + 2]
                            + nr.v * work.src_positions[i2 + 2],
                    ];
                } else {
                    work.pos[v] = p_move;
                }
            }
        }
    }

    let final_tris = commit_work_mesh(mesh, faces, &work, &src_map)?;
    let _ = (face_normal, F_UV);
    Ok(final_tris)
}

/// Clean poorly shaped triangles by Delaunay edge flips and short needle collapses.
pub fn cleanup_tiling(
    mesh: &mut EditMesh,
    faces: &[i32],
    max_aspect: f64,
    max_error: f64,
    iterations: usize,
) -> Result<usize, KernelError> {
    let (mut work, src_map) =
        WorkMesh::from_edit_mesh(mesh, faces, &PreserveConstraints::default(), &[], 0.0)?;
    let max_err_sq = max_error * max_error;
    for _pass in 0..iterations.clamp(1, 50) {
        let mut changed = 0usize;
        let mut short_edges = Vec::new();
        let mut seen = HashSet::new();
        for t in 0..work.tri.len() {
            if !work.tri_alive[t] {
                continue;
            }
            let [a, b, c] = [
                work.tri[t][0] as usize,
                work.tri[t][1] as usize,
                work.tri[t][2] as usize,
            ];
            let l0 = length(sub(work.pos[b], work.pos[a]));
            let l1 = length(sub(work.pos[c], work.pos[b]));
            let l2 = length(sub(work.pos[a], work.pos[c]));
            let max_l = l0.max(l1).max(l2);
            let min_l = l0.min(l1).min(l2);
            let area2 = length(cross(
                sub(work.pos[b], work.pos[a]),
                sub(work.pos[c], work.pos[a]),
            ));
            let aspect = if area2 > 1e-18 {
                (max_l * (l0 + l1 + l2)) / (2.0 * area2)
            } else {
                f64::INFINITY
            };
            if aspect > max_aspect {
                let (sa, sb) = if (l0 - min_l).abs() < 1e-12 {
                    (a, b)
                } else if (l1 - min_l).abs() < 1e-12 {
                    (b, c)
                } else {
                    (c, a)
                };
                if seen.insert(ekey(sa, sb)) {
                    short_edges.push((sa, sb));
                }
            }
        }
        for (a, b) in short_edges {
            if !work.alive[a] || !work.alive[b] {
                continue;
            }
            if let Some((pos, err)) = work.can_collapse(a, b) {
                if err <= max_err_sq {
                    work.collapse(a, b, pos);
                    changed += 1;
                }
            }
        }
        if changed == 0 {
            break;
        }
    }
    commit_work_mesh(mesh, faces, &work, &src_map)
}
