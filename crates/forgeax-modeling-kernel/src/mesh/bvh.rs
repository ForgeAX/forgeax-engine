//! Fast triangle BVH over `EditMesh` for raycasting, occlusion, thickness queries,
//! and high-to-low surface baking. Zero external dependencies.

use std::collections::{HashMap, HashSet};

use super::geom::{cross, dot, face_centroid, face_normal, length, sub, Vec3};
use super::{EditMesh, NONE};

#[derive(Debug, Clone, Copy)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    pub fn empty() -> Self {
        Self {
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
        }
    }

    pub fn from_tri(a: Vec3, b: Vec3, c: Vec3) -> Self {
        Self {
            min: [
                a[0].min(b[0]).min(c[0]),
                a[1].min(b[1]).min(c[1]),
                a[2].min(b[2]).min(c[2]),
            ],
            max: [
                a[0].max(b[0]).max(c[0]),
                a[1].max(b[1]).max(c[1]),
                a[2].max(b[2]).max(c[2]),
            ],
        }
    }

    pub fn union(self, other: Self) -> Self {
        Self {
            min: [
                self.min[0].min(other.min[0]),
                self.min[1].min(other.min[1]),
                self.min[2].min(other.min[2]),
            ],
            max: [
                self.max[0].max(other.max[0]),
                self.max[1].max(other.max[1]),
                self.max[2].max(other.max[2]),
            ],
        }
    }

    #[inline]
    pub fn intersect_ray(
        &self,
        origin: Vec3,
        inv_dir: Vec3,
        t_min: f64,
        t_max: f64,
    ) -> Option<f64> {
        let mut lo = t_min;
        let mut hi = t_max;
        for k in 0..3 {
            let t0 = (self.min[k] - origin[k]) * inv_dir[k];
            let t1 = (self.max[k] - origin[k]) * inv_dir[k];
            let (near, far) = if t0 <= t1 { (t0, t1) } else { (t1, t0) };
            if near > lo {
                lo = near;
            }
            if far < hi {
                hi = far;
            }
            if hi < lo {
                return None;
            }
        }
        Some(lo)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BvhTri {
    pub face: i32,
    pub a: Vec3,
    pub b: Vec3,
    pub c: Vec3,
    pub centroid: Vec3,
    pub bounds: Aabb,
}

#[derive(Debug, Clone, Copy)]
pub struct RayHit {
    pub distance: f64,
    pub face: i32,
    pub u: f64,
    pub v: f64,
    pub tri_index: usize,
}

#[derive(Debug, Clone)]
enum BvhNodeKind {
    Leaf { start: usize, count: usize },
    Branch { left: usize, right: usize },
}

#[derive(Debug, Clone)]
struct BvhNode {
    bounds: Aabb,
    kind: BvhNodeKind,
}

pub struct Bvh {
    pub tris: Vec<BvhTri>,
    nodes: Vec<BvhNode>,
}

const LEAF_LIMIT: usize = 4;

impl Bvh {
    pub fn build_from_mesh(mesh: &EditMesh) -> Self {
        let mut tris = Vec::new();
        for f in mesh.faces() {
            let verts = mesh.face_vertices(f);
            if verts.len() < 3 {
                continue;
            }
            let p0 = mesh.position(verts[0]);
            for i in 1..(verts.len() - 1) {
                let p1 = mesh.position(verts[i]);
                let p2 = mesh.position(verts[i + 1]);
                let bounds = Aabb::from_tri(p0, p1, p2);
                let centroid = [
                    (p0[0] + p1[0] + p2[0]) / 3.0,
                    (p0[1] + p1[1] + p2[1]) / 3.0,
                    (p0[2] + p1[2] + p2[2]) / 3.0,
                ];
                tris.push(BvhTri {
                    face: f,
                    a: p0,
                    b: p1,
                    c: p2,
                    centroid,
                    bounds,
                });
            }
        }
        let mut bvh = Self {
            tris,
            nodes: Vec::new(),
        };
        if !bvh.tris.is_empty() {
            let len = bvh.tris.len();
            bvh.build_node(0, len);
        }
        bvh
    }

    fn build_node(&mut self, start: usize, end: usize) -> usize {
        let mut bounds = Aabb::empty();
        let mut cent_bounds = Aabb::empty();
        for t in &self.tris[start..end] {
            bounds = bounds.union(t.bounds);
            cent_bounds = cent_bounds.union(Aabb {
                min: t.centroid,
                max: t.centroid,
            });
        }
        let count = end - start;
        let idx = self.nodes.len();
        if count <= LEAF_LIMIT {
            self.nodes.push(BvhNode {
                bounds,
                kind: BvhNodeKind::Leaf { start, count },
            });
            return idx;
        }
        let ext = [
            cent_bounds.max[0] - cent_bounds.min[0],
            cent_bounds.max[1] - cent_bounds.min[1],
            cent_bounds.max[2] - cent_bounds.min[2],
        ];
        let axis = if ext[0] >= ext[1] && ext[0] >= ext[2] {
            0
        } else if ext[1] >= ext[2] {
            1
        } else {
            2
        };
        let mid_coord = 0.5 * (cent_bounds.min[axis] + cent_bounds.max[axis]);
        let mut mid = start;
        let mut i = start;
        while i < end {
            if self.tris[i].centroid[axis] < mid_coord {
                self.tris.swap(i, mid);
                mid += 1;
            }
            i += 1;
        }
        if mid == start || mid == end {
            mid = start + count / 2;
            self.tris[start..end].select_nth_unstable_by(mid - start, |a, b| {
                a.centroid[axis].total_cmp(&b.centroid[axis])
            });
        }
        self.nodes.push(BvhNode {
            bounds,
            kind: BvhNodeKind::Leaf { start, count: 0 },
        });
        let left = self.build_node(start, mid);
        let right = self.build_node(mid, end);
        self.nodes[idx].kind = BvhNodeKind::Branch { left, right };
        idx
    }

    /// Nearest ray hit within `(t_min, t_max]` skipping faces where `skip(face)` is true.
    pub fn raycast(
        &self,
        origin: Vec3,
        dir: Vec3,
        t_min: f64,
        t_max: f64,
        mut skip: impl FnMut(i32) -> bool,
    ) -> Option<RayHit> {
        if self.nodes.is_empty() {
            return None;
        }
        let inv_dir = [
            if dir[0].abs() > 1e-30 {
                1.0 / dir[0]
            } else {
                f64::copysign(1e30, dir[0])
            },
            if dir[1].abs() > 1e-30 {
                1.0 / dir[1]
            } else {
                f64::copysign(1e30, dir[1])
            },
            if dir[2].abs() > 1e-30 {
                1.0 / dir[2]
            } else {
                f64::copysign(1e30, dir[2])
            },
        ];
        let mut best: Option<RayHit> = None;
        let mut best_t = t_max;
        let mut stack = [0usize; 64];
        let mut sp = 1usize;
        stack[0] = 0;

        while sp > 0 {
            sp -= 1;
            let node_idx = stack[sp];
            let node = &self.nodes[node_idx];
            if node
                .bounds
                .intersect_ray(origin, inv_dir, t_min, best_t)
                .is_none()
            {
                continue;
            }
            match node.kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ti in start..(start + count) {
                        let tri = &self.tris[ti];
                        if skip(tri.face) {
                            continue;
                        }
                        if let Some((t, u, v)) = hit_triangle(origin, dir, tri.a, tri.b, tri.c) {
                            if t > t_min && t < best_t {
                                best_t = t;
                                best = Some(RayHit {
                                    distance: t,
                                    face: tri.face,
                                    u,
                                    v,
                                    tri_index: ti,
                                });
                            }
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => {
                    let dl = self.nodes[left]
                        .bounds
                        .intersect_ray(origin, inv_dir, t_min, best_t);
                    let dr = self.nodes[right]
                        .bounds
                        .intersect_ray(origin, inv_dir, t_min, best_t);
                    match (dl, dr) {
                        (Some(tl), Some(tr)) => {
                            if sp + 2 <= stack.len() {
                                if tl <= tr {
                                    stack[sp] = right;
                                    stack[sp + 1] = left;
                                } else {
                                    stack[sp] = left;
                                    stack[sp + 1] = right;
                                }
                                sp += 2;
                            }
                        }
                        (Some(_), None) => {
                            if sp < stack.len() {
                                stack[sp] = left;
                                sp += 1;
                            }
                        }
                        (None, Some(_)) => {
                            if sp < stack.len() {
                                stack[sp] = right;
                                sp += 1;
                            }
                        }
                        (None, None) => {}
                    }
                }
            }
        }
        best
    }

    /// Any-hit occlusion test within `(t_min, t_max]` (used for AO raycasting).
    pub fn is_occluded(
        &self,
        origin: Vec3,
        dir: Vec3,
        t_min: f64,
        t_max: f64,
        mut skip: impl FnMut(i32) -> bool,
    ) -> bool {
        if self.nodes.is_empty() {
            return false;
        }
        let inv_dir = [
            if dir[0].abs() > 1e-30 {
                1.0 / dir[0]
            } else {
                f64::copysign(1e30, dir[0])
            },
            if dir[1].abs() > 1e-30 {
                1.0 / dir[1]
            } else {
                f64::copysign(1e30, dir[1])
            },
            if dir[2].abs() > 1e-30 {
                1.0 / dir[2]
            } else {
                f64::copysign(1e30, dir[2])
            },
        ];
        let mut stack = [0usize; 64];
        let mut sp = 1usize;
        stack[0] = 0;
        while sp > 0 {
            sp -= 1;
            let node = &self.nodes[stack[sp]];
            if node
                .bounds
                .intersect_ray(origin, inv_dir, t_min, t_max)
                .is_none()
            {
                continue;
            }
            match node.kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ti in start..(start + count) {
                        let tri = &self.tris[ti];
                        if skip(tri.face) {
                            continue;
                        }
                        if let Some((t, _, _)) = hit_triangle(origin, dir, tri.a, tri.b, tri.c) {
                            if t > t_min && t <= t_max {
                                return true;
                            }
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => {
                    if sp + 2 <= stack.len() {
                        stack[sp] = right;
                        stack[sp + 1] = left;
                        sp += 2;
                    }
                }
            }
        }
        false
    }
}

#[inline]
fn hit_triangle(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Option<(f64, f64, f64)> {
    let e1 = sub(b, a);
    let e2 = sub(c, a);
    let p = cross(dir, e2);
    let det = dot(e1, p);
    if det.abs() < 1e-15 {
        return None;
    }
    let inv_det = 1.0 / det;
    let s = sub(origin, a);
    let u = dot(s, p) * inv_det;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(s, e1);
    let v = dot(dir, q) * inv_det;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = dot(e2, q) * inv_det;
    Some((t, u, v))
}

fn solid_angle(a: Vec3, b: Vec3, c: Vec3) -> f64 {
    let la = length(a);
    let lb = length(b);
    let lc = length(c);
    if la == 0.0 || lb == 0.0 || lc == 0.0 {
        return 0.0;
    }
    let num = dot(a, cross(b, c));
    let den = la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb;
    2.0 * num.atan2(den)
}

pub fn winding_number(mesh: &EditMesh, faces: &[i32], point: Vec3) -> f64 {
    let mut sum = 0.0;
    for &f in faces {
        let verts = mesh.face_vertices(f);
        if verts.len() < 3 {
            continue;
        }
        let a = sub(mesh.position(verts[0]), point);
        for i in 1..(verts.len() - 1) {
            let b = sub(mesh.position(verts[i]), point);
            let c = sub(mesh.position(verts[i + 1]), point);
            sum += solid_angle(a, b, c);
        }
    }
    sum / (4.0 * std::f64::consts::PI)
}

/// BVH-accelerated face thickness matching `@forgeax/engine-modeling`'s `faceThickness`.
pub fn face_thickness(mesh: &EditMesh, max_width: f64, minimum: f64) -> HashMap<i32, f64> {
    let mut out = HashMap::new();
    if !(max_width > 0.0) {
        return out;
    }
    let bvh = Bvh::build_from_mesh(mesh);
    let all_faces = mesh.faces();
    let mut normals: HashMap<i32, Vec3> = HashMap::with_capacity(all_faces.len());
    for &f in &all_faces {
        normals.insert(f, face_normal(mesh, f));
    }

    // Edge-connected face components
    let mut comp_of: HashMap<i32, usize> = HashMap::with_capacity(all_faces.len());
    let mut comp_faces: Vec<Vec<i32>> = Vec::new();
    for &seed in &all_faces {
        if comp_of.contains_key(&seed) {
            continue;
        }
        let cid = comp_faces.len();
        let mut list = Vec::new();
        let mut stack = vec![seed];
        comp_of.insert(seed, cid);
        while let Some(f) = stack.pop() {
            list.push(f);
            for h in mesh.face_halves(f) {
                let g = mesh.h_face[(h ^ 1) as usize];
                if g != NONE && !comp_of.contains_key(&g) {
                    comp_of.insert(g, cid);
                    stack.push(g);
                }
            }
        }
        comp_faces.push(list);
    }

    for &f in &all_faces {
        let n = normals[&f];
        let back = [-n[0], -n[1], -n[2]];
        let origin = face_centroid(mesh, f);
        let own = comp_of[&f];
        let mut inside_cache: HashMap<usize, bool> = HashMap::new();
        let hit = bvh.raycast(origin, back, minimum, max_width, |g| {
            if g == f || dot(back, normals[&g]) <= 0.0 {
                return true;
            }
            let c = comp_of[&g];
            if c == own {
                return false;
            }
            *inside_cache
                .entry(c)
                .or_insert_with(|| winding_number(mesh, &comp_faces[c], origin) > 0.5)
        });
        if let Some(h) = hit {
            out.insert(f, h.distance);
        }
    }
    let _ = HashSet::<i32>::new();
    out
}

/// GPU-ready stackless preorder BVH buffers for multi-group high-to-low texture baking.
/// Matches `bake-webgpu-correspond.ts` WGSL struct layouts byte-for-byte:
/// - `nodes`: 8 u32s (32 B) per node: `low(f32x3), first(i32), high(f32x3), endAndCount(u32)`
/// - `tris`: 16 u32s (64 B) per tri: `a(f32x3), triId(u32), e1(f32x3), flags(u32), e2(f32x3), slot(u32), faceN(f32x3), pad(u32)`
/// - `tri_normals`: 12 f32s (48 B) per tri: `n0(f32x4), n1(f32x4), n2(f32x4)`
/// - `group_roots`: 2 i32s per group: `[root, solid_root]`
pub struct GpuBakeBvhPack {
    pub nodes: Vec<u32>,
    pub tris: Vec<u32>,
    pub tri_normals: Vec<f32>,
    pub group_roots: Vec<i32>,
}

const GPU_BVH_LEAF: usize = 4;
const GPU_BVH_BINS: usize = 16;
const GPU_BVH_SAH_DEPTH: usize = 48;

/// Build binned-SAH stackless preorder BVHs for all bake groups in one Rust batch call.
/// `group_ranges` holds 4 `u32`s per group: `[all_start, all_end, solid_start, solid_end]` into `group_tris`.
pub fn build_gpu_bake_bvh_groups(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    slots: &[i32],
    floater: &[u8],
    stray: &[u8],
    group_tris: &[u32],
    group_ranges: &[u32],
) -> GpuBakeBvhPack {
    let total_tris = indices.len() / 3;
    let group_count = group_ranges.len() / 4;

    // Precompute per-triangle bounds, centroids, and unit face normals once
    let mut t_lo = vec![0.0f32; total_tris * 3];
    let mut t_hi = vec![0.0f32; total_tris * 3];
    let mut t_cen = vec![0.0f32; total_tris * 3];
    let mut t_fn = vec![0.0f32; total_tris * 3];

    for t in 0..total_tris {
        let i0 = (indices[t * 3] as usize) * 3;
        let i1 = (indices[t * 3 + 1] as usize) * 3;
        let i2 = (indices[t * 3 + 2] as usize) * 3;
        let (ax, ay, az) = (positions[i0], positions[i0 + 1], positions[i0 + 2]);
        let (bx, by, bz) = (positions[i1], positions[i1 + 1], positions[i1 + 2]);
        let (cx, cy, cz) = (positions[i2], positions[i2 + 1], positions[i2 + 2]);

        let lx = ax.min(bx).min(cx);
        let ly = ay.min(by).min(cy);
        let lz = az.min(bz).min(cz);
        let hx = ax.max(bx).max(cx);
        let hy = ay.max(by).max(cy);
        let hz = az.max(bz).max(cz);
        t_lo[t * 3] = lx;
        t_lo[t * 3 + 1] = ly;
        t_lo[t * 3 + 2] = lz;
        t_hi[t * 3] = hx;
        t_hi[t * 3 + 1] = hy;
        t_hi[t * 3 + 2] = hz;
        t_cen[t * 3] = (lx + hx) * 0.5;
        t_cen[t * 3 + 1] = (ly + hy) * 0.5;
        t_cen[t * 3 + 2] = (lz + hz) * 0.5;

        let e1x = bx - ax;
        let e1y = by - ay;
        let e1z = bz - az;
        let e2x = cx - ax;
        let e2y = cy - ay;
        let e2z = cz - az;
        let nx = (e1y as f64) * (e2z as f64) - (e1z as f64) * (e2y as f64);
        let ny = (e1z as f64) * (e2x as f64) - (e1x as f64) * (e2z as f64);
        let nz = (e1x as f64) * (e2y as f64) - (e1y as f64) * (e2x as f64);
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len > 0.0 {
            let inv = 1.0 / len;
            t_fn[t * 3] = (nx * inv) as f32;
            t_fn[t * 3 + 1] = (ny * inv) as f32;
            t_fn[t * 3 + 2] = (nz * inv) as f32;
        }
    }

    let mut nodes: Vec<u32> = Vec::with_capacity(group_tris.len() * 8);
    let mut tris: Vec<u32> = Vec::with_capacity(group_tris.len() * 16);
    let mut tri_normals: Vec<f32> = Vec::with_capacity(group_tris.len() * 12);
    let mut group_roots: Vec<i32> = Vec::with_capacity(group_count * 2);
    let mut order: Vec<u32> = Vec::new();
    let mut scratch: Vec<u32> = Vec::new();

    struct BuildCtx<'a> {
        positions: &'a [f32],
        normals: &'a [f32],
        indices: &'a [u32],
        slots: &'a [i32],
        floater: &'a [u8],
        stray: &'a [u8],
        t_lo: &'a [f32],
        t_hi: &'a [f32],
        t_cen: &'a [f32],
        t_fn: &'a [f32],
        nodes: &'a mut Vec<u32>,
        tris: &'a mut Vec<u32>,
        tri_normals: &'a mut Vec<f32>,
        order: &'a mut Vec<u32>,
        scratch: &'a mut Vec<u32>,
    }

    fn emit_subtree(ctx: &mut BuildCtx<'_>, start: usize, end: usize, depth: usize, pad: f32) {
        let mut bx0 = f32::INFINITY;
        let mut by0 = f32::INFINITY;
        let mut bz0 = f32::INFINITY;
        let mut bx1 = f32::NEG_INFINITY;
        let mut by1 = f32::NEG_INFINITY;
        let mut bz1 = f32::NEG_INFINITY;
        let mut cx0 = f32::INFINITY;
        let mut cy0 = f32::INFINITY;
        let mut cz0 = f32::INFINITY;
        let mut cx1 = f32::NEG_INFINITY;
        let mut cy1 = f32::NEG_INFINITY;
        let mut cz1 = f32::NEG_INFINITY;

        for i in start..end {
            let t = (ctx.order[i] as usize) * 3;
            bx0 = bx0.min(ctx.t_lo[t]);
            by0 = by0.min(ctx.t_lo[t + 1]);
            bz0 = bz0.min(ctx.t_lo[t + 2]);
            bx1 = bx1.max(ctx.t_hi[t]);
            by1 = by1.max(ctx.t_hi[t + 1]);
            bz1 = bz1.max(ctx.t_hi[t + 2]);
            cx0 = cx0.min(ctx.t_cen[t]);
            cy0 = cy0.min(ctx.t_cen[t + 1]);
            cz0 = cz0.min(ctx.t_cen[t + 2]);
            cx1 = cx1.max(ctx.t_cen[t]);
            cy1 = cy1.max(ctx.t_cen[t + 1]);
            cz1 = cz1.max(ctx.t_cen[t + 2]);
        }

        let rec = ctx.nodes.len();
        ctx.nodes.push((bx0 - pad).to_bits());
        ctx.nodes.push((by0 - pad).to_bits());
        ctx.nodes.push((bz0 - pad).to_bits());
        ctx.nodes.push(0);
        ctx.nodes.push((bx1 + pad).to_bits());
        ctx.nodes.push((by1 + pad).to_bits());
        ctx.nodes.push((bz1 + pad).to_bits());
        ctx.nodes.push(0);

        let count = end - start;
        if count <= GPU_BVH_LEAF {
            let tri_start = (ctx.tris.len() / 16) as i32;
            ctx.nodes[rec + 3] = (-tri_start - 1) as u32;
            for i in start..end {
                let gt = ctx.order[i] as usize;
                let i0 = (ctx.indices[gt * 3] as usize) * 3;
                let i1 = (ctx.indices[gt * 3 + 1] as usize) * 3;
                let i2 = (ctx.indices[gt * 3 + 2] as usize) * 3;
                let (ax, ay, az) = (
                    ctx.positions[i0],
                    ctx.positions[i0 + 1],
                    ctx.positions[i0 + 2],
                );
                let e1x = ctx.positions[i1] - ax;
                let e1y = ctx.positions[i1 + 1] - ay;
                let e1z = ctx.positions[i1 + 2] - az;
                let e2x = ctx.positions[i2] - ax;
                let e2y = ctx.positions[i2 + 1] - ay;
                let e2z = ctx.positions[i2 + 2] - az;
                let fl = ((ctx.floater.get(gt).copied().unwrap_or(0) & 1) as u32)
                    | (((ctx.stray.get(gt).copied().unwrap_or(0) & 1) as u32) << 1);
                let slot = ctx.slots.get(gt).copied().unwrap_or(0) as u32;
                ctx.tris.extend_from_slice(&[
                    ax.to_bits(),
                    ay.to_bits(),
                    az.to_bits(),
                    gt as u32,
                    e1x.to_bits(),
                    e1y.to_bits(),
                    e1z.to_bits(),
                    fl,
                    e2x.to_bits(),
                    e2y.to_bits(),
                    e2z.to_bits(),
                    slot,
                    ctx.t_fn[gt * 3].to_bits(),
                    ctx.t_fn[gt * 3 + 1].to_bits(),
                    ctx.t_fn[gt * 3 + 2].to_bits(),
                    0,
                ]);
                ctx.tri_normals.extend_from_slice(&[
                    ctx.normals[i0],
                    ctx.normals[i0 + 1],
                    ctx.normals[i0 + 2],
                    0.0,
                    ctx.normals[i1],
                    ctx.normals[i1 + 1],
                    ctx.normals[i1 + 2],
                    0.0,
                    ctx.normals[i2],
                    ctx.normals[i2 + 1],
                    ctx.normals[i2 + 2],
                    0.0,
                ]);
            }
            ctx.nodes[rec + 7] = ((ctx.nodes.len() / 8) as u32) * 16 + (count as u32);
            return;
        }

        // Binned SAH split
        let c_lo = [cx0, cy0, cz0];
        let c_hi = [cx1, cy1, cz1];
        let mut best_cost = f32::INFINITY;
        let mut best_axis: Option<usize> = None;
        let mut best_bin = 0usize;

        if depth < GPU_BVH_SAH_DEPTH {
            for axis in 0..3 {
                let extent = c_hi[axis] - c_lo[axis];
                if !(extent > 0.0) {
                    continue;
                }
                let inv_ext = (GPU_BVH_BINS as f32) / extent;
                let mut counts = [0u32; GPU_BVH_BINS];
                let mut b_lo = [[f32::INFINITY; 3]; GPU_BVH_BINS];
                let mut b_hi = [[f32::NEG_INFINITY; 3]; GPU_BVH_BINS];
                for i in start..end {
                    let t = (ctx.order[i] as usize) * 3;
                    let b = (((ctx.t_cen[t + axis] - c_lo[axis]) * inv_ext) as usize)
                        .min(GPU_BVH_BINS - 1);
                    counts[b] += 1;
                    for k in 0..3 {
                        b_lo[b][k] = b_lo[b][k].min(ctx.t_lo[t + k]);
                        b_hi[b][k] = b_hi[b][k].max(ctx.t_hi[t + k]);
                    }
                }
                let mut r_area = [0.0f32; GPU_BVH_BINS];
                let mut r_cnt = [0u32; GPU_BVH_BINS];
                let mut acc_lo = [f32::INFINITY; 3];
                let mut acc_hi = [f32::NEG_INFINITY; 3];
                let mut n = 0u32;
                for b in (1..GPU_BVH_BINS).rev() {
                    for k in 0..3 {
                        acc_lo[k] = acc_lo[k].min(b_lo[b][k]);
                        acc_hi[k] = acc_hi[k].max(b_hi[b][k]);
                    }
                    n += counts[b];
                    if n > 0 {
                        let dx = acc_hi[0] - acc_lo[0];
                        let dy = acc_hi[1] - acc_lo[1];
                        let dz = acc_hi[2] - acc_lo[2];
                        r_area[b] = dx * dy + dy * dz + dz * dx;
                    }
                    r_cnt[b] = n;
                }
                let mut l_lo = [f32::INFINITY; 3];
                let mut l_hi = [f32::NEG_INFINITY; 3];
                let mut m = 0u32;
                for b in 1..GPU_BVH_BINS {
                    for k in 0..3 {
                        l_lo[k] = l_lo[k].min(b_lo[b - 1][k]);
                        l_hi[k] = l_hi[k].max(b_hi[b - 1][k]);
                    }
                    m += counts[b - 1];
                    let r = r_cnt[b];
                    if m == 0 || r == 0 {
                        continue;
                    }
                    let dx = l_hi[0] - l_lo[0];
                    let dy = l_hi[1] - l_lo[1];
                    let dz = l_hi[2] - l_lo[2];
                    let cost = (dx * dy + dy * dz + dz * dx) * (m as f32) + r_area[b] * (r as f32);
                    if cost < best_cost {
                        best_cost = cost;
                        best_axis = Some(axis);
                        best_bin = b;
                    }
                }
            }
        }

        let mid = if let Some(axis) = best_axis {
            let inv_ext = (GPU_BVH_BINS as f32) / (c_hi[axis] - c_lo[axis]);
            ctx.scratch.clear();
            for i in start..end {
                let gt = ctx.order[i];
                let b = (((ctx.t_cen[(gt as usize) * 3 + axis] - c_lo[axis]) * inv_ext) as usize)
                    .min(GPU_BVH_BINS - 1);
                if b < best_bin {
                    ctx.scratch.push(gt);
                }
            }
            let left_len = ctx.scratch.len();
            for i in start..end {
                let gt = ctx.order[i];
                let b = (((ctx.t_cen[(gt as usize) * 3 + axis] - c_lo[axis]) * inv_ext) as usize)
                    .min(GPU_BVH_BINS - 1);
                if b >= best_bin {
                    ctx.scratch.push(gt);
                }
            }
            ctx.order[start..end].copy_from_slice(&ctx.scratch);
            start + left_len
        } else {
            let mut axis = 0usize;
            if c_hi[1] - c_lo[1] > c_hi[axis] - c_lo[axis] {
                axis = 1;
            }
            if c_hi[2] - c_lo[2] > c_hi[axis] - c_lo[axis] {
                axis = 2;
            }
            let t_cen = ctx.t_cen;
            ctx.order[start..end].sort_unstable_by(|&a, &b| {
                t_cen[(a as usize) * 3 + axis]
                    .total_cmp(&t_cen[(b as usize) * 3 + axis])
                    .then_with(|| a.cmp(&b))
            });
            (start + end) >> 1
        };

        let mid = if mid <= start || mid >= end {
            (start + end) >> 1
        } else {
            mid
        };
        emit_subtree(ctx, start, mid, depth + 1, pad);
        emit_subtree(ctx, mid, end, depth + 1, pad);
        ctx.nodes[rec + 7] = ((ctx.nodes.len() / 8) as u32) * 16;
    }

    let mut ctx = BuildCtx {
        positions,
        normals,
        indices,
        slots,
        floater,
        stray,
        t_lo: &t_lo,
        t_hi: &t_hi,
        t_cen: &t_cen,
        t_fn: &t_fn,
        nodes: &mut nodes,
        tris: &mut tris,
        tri_normals: &mut tri_normals,
        order: &mut order,
        scratch: &mut scratch,
    };

    let build_slice = |ctx: &mut BuildCtx<'_>, slice: &[u32]| -> i32 {
        if slice.is_empty() {
            return -1;
        }
        ctx.order.clear();
        ctx.order.extend_from_slice(slice);
        let mut bx0 = f32::INFINITY;
        let mut by0 = f32::INFINITY;
        let mut bz0 = f32::INFINITY;
        let mut bx1 = f32::NEG_INFINITY;
        let mut by1 = f32::NEG_INFINITY;
        let mut bz1 = f32::NEG_INFINITY;
        for &gt in slice {
            let t = (gt as usize) * 3;
            bx0 = bx0.min(ctx.t_lo[t]);
            by0 = by0.min(ctx.t_lo[t + 1]);
            bz0 = bz0.min(ctx.t_lo[t + 2]);
            bx1 = bx1.max(ctx.t_hi[t]);
            by1 = by1.max(ctx.t_hi[t + 1]);
            bz1 = bz1.max(ctx.t_hi[t + 2]);
        }
        let dx = bx1 - bx0;
        let dy = by1 - by0;
        let dz = bz1 - bz0;
        let pad = 1e-6 * ((dx * dx + dy * dy + dz * dz) + 1.0).sqrt();
        let root = (ctx.nodes.len() / 8) as i32;
        emit_subtree(ctx, 0, slice.len(), 0, pad);
        root
    };

    for g in 0..group_count {
        let a0 = group_ranges[g * 4] as usize;
        let a1 = group_ranges[g * 4 + 1] as usize;
        let s0 = group_ranges[g * 4 + 2] as usize;
        let s1 = group_ranges[g * 4 + 3] as usize;
        let root = build_slice(&mut ctx, &group_tris[a0..a1]);
        let solid_root = if s0 == a0 && s1 == a1 {
            root
        } else {
            build_slice(&mut ctx, &group_tris[s0..s1])
        };
        group_roots.push(root);
        group_roots.push(solid_root);
    }

    GpuBakeBvhPack {
        nodes,
        tris,
        tri_normals,
        group_roots,
    }
}

/// Closest barycentric point `(u, v)` and squared distance from `p` to triangle `(a, b, c)`.
/// Follows Ericson's Voronoi region test in plain float64.
#[inline]
pub fn closest_point_triangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> (f64, f64, f64) {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        let d = sub(a, p);
        return (0.0, 0.0, dot(d, d));
    }

    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        let d = sub(b, p);
        return (1.0, 0.0, dot(d, d));
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let u = d1 / (d1 - d3);
        let q = [
            a[0] + u * ab[0] - p[0],
            a[1] + u * ab[1] - p[1],
            a[2] + u * ab[2] - p[2],
        ];
        return (u, 0.0, dot(q, q));
    }

    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        let d = sub(c, p);
        return (0.0, 1.0, dot(d, d));
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let v = d2 / (d2 - d6);
        let q = [
            a[0] + v * ac[0] - p[0],
            a[1] + v * ac[1] - p[1],
            a[2] + v * ac[2] - p[2],
        ];
        return (0.0, v, dot(q, q));
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        let u = 1.0 - w;
        let q = [
            b[0] + w * (c[0] - b[0]) - p[0],
            b[1] + w * (c[1] - b[1]) - p[1],
            b[2] + w * (c[2] - b[2]) - p[2],
        ];
        return (u, w, dot(q, q));
    }

    let denom = 1.0 / (va + vb + vc);
    let u = vb * denom;
    let v = vc * denom;
    let q = [
        a[0] + u * ab[0] + v * ac[0] - p[0],
        a[1] + u * ab[1] + v * ac[1] - p[1],
        a[2] + u * ab[2] + v * ac[2] - p[2],
    ];
    (u, v, dot(q, q))
}

#[inline]
pub fn aabb_dist_sq(bounds: &Aabb, p: Vec3) -> f64 {
    let mut d2 = 0.0;
    for k in 0..3 {
        let v = p[k];
        if v < bounds.min[k] {
            let d = bounds.min[k] - v;
            d2 += d * d;
        } else if v > bounds.max[k] {
            let d = v - bounds.max[k];
            d2 += d * d;
        }
    }
    d2
}

#[derive(Debug, Clone, Copy)]
pub struct SoupRayHit {
    pub triangle: usize,
    pub t: f64,
    pub u: f64,
    pub v: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct SoupNearest {
    pub triangle: usize,
    pub u: f64,
    pub v: f64,
    pub distance_squared: f64,
}

#[derive(Debug, Clone)]
struct SoupTri {
    id: usize,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    centroid: Vec3,
    bounds: Aabb,
}

#[derive(Debug, Clone)]
struct SoupNode {
    bounds: Aabb,
    kind: BvhNodeKind,
}

/// Fast binned-SAH float64 BVH over indexed triangle soups or triangle index subsets.
#[derive(Debug, Clone)]
pub struct TriSoupBvh {
    tris: Vec<SoupTri>,
    nodes: Vec<SoupNode>,
    pad: f64,
}

impl TriSoupBvh {
    pub fn build(positions: &[f64], indices: &[u32], subset: Option<&[usize]>) -> Self {
        let total = indices.len() / 3;
        let count = subset.map_or(total, |s| s.len());
        let mut tris = Vec::with_capacity(count);
        let mut root_bounds = Aabb::empty();

        for local in 0..count {
            let t = subset.map_or(local, |s| s[local]);
            let i0 = (indices[t * 3] as usize) * 3;
            let i1 = (indices[t * 3 + 1] as usize) * 3;
            let i2 = (indices[t * 3 + 2] as usize) * 3;
            let a = [positions[i0], positions[i0 + 1], positions[i0 + 2]];
            let b = [positions[i1], positions[i1 + 1], positions[i1 + 2]];
            let c = [positions[i2], positions[i2 + 1], positions[i2 + 2]];
            let bounds = Aabb::from_tri(a, b, c);
            root_bounds = root_bounds.union(bounds);
            let centroid = [
                (a[0] + b[0] + c[0]) / 3.0,
                (a[1] + b[1] + c[1]) / 3.0,
                (a[2] + b[2] + c[2]) / 3.0,
            ];
            tris.push(SoupTri {
                id: t,
                a,
                b,
                c,
                centroid,
                bounds,
            });
        }

        let diag = if count == 0 {
            0.0
        } else {
            length(sub(root_bounds.max, root_bounds.min))
        };
        let pad = 1e-8 * (diag + 1.0);
        let mut bvh = Self {
            tris,
            nodes: Vec::new(),
            pad,
        };
        if count > 0 {
            bvh.build_node(0, count, 0);
        }
        bvh
    }

    fn build_node(&mut self, start: usize, end: usize, depth: usize) -> usize {
        let mut bounds = Aabb::empty();
        let mut cent_bounds = Aabb::empty();
        for t in &self.tris[start..end] {
            bounds = bounds.union(t.bounds);
            cent_bounds = cent_bounds.union(Aabb {
                min: t.centroid,
                max: t.centroid,
            });
        }
        bounds.min[0] -= self.pad;
        bounds.min[1] -= self.pad;
        bounds.min[2] -= self.pad;
        bounds.max[0] += self.pad;
        bounds.max[1] += self.pad;
        bounds.max[2] += self.pad;

        let count = end - start;
        let idx = self.nodes.len();
        if count <= LEAF_LIMIT || depth >= 48 {
            self.nodes.push(SoupNode {
                bounds,
                kind: BvhNodeKind::Leaf { start, count },
            });
            return idx;
        }

        let mut best_cost = f64::INFINITY;
        let mut best_axis = 0usize;
        let mut best_split = 0usize;
        for axis in 0..3 {
            let lo = cent_bounds.min[axis];
            let hi = cent_bounds.max[axis];
            let span = hi - lo;
            if span <= 1e-18 {
                continue;
            }
            let mut b_counts = [0usize; 16];
            let mut b_bounds = [Aabb::empty(); 16];
            let inv = 16.0 / span;
            for t in &self.tris[start..end] {
                let mut bin = ((t.centroid[axis] - lo) * inv) as isize;
                if bin < 0 {
                    bin = 0;
                } else if bin >= 16 {
                    bin = 15;
                }
                let bi = bin as usize;
                b_counts[bi] += 1;
                b_bounds[bi] = b_bounds[bi].union(t.bounds);
            }
            let mut right_area = [0.0f64; 15];
            let mut right_cnt = [0usize; 15];
            let mut rb = Aabb::empty();
            let mut rc = 0usize;
            for bi in (1..16).rev() {
                rb = rb.union(b_bounds[bi]);
                rc += b_counts[bi];
                right_cnt[bi - 1] = rc;
                if rc > 0 {
                    let e = sub(rb.max, rb.min);
                    right_area[bi - 1] = e[0] * e[1] + e[1] * e[2] + e[2] * e[0];
                }
            }
            let mut lb = Aabb::empty();
            let mut lc = 0usize;
            for bi in 0..15 {
                lb = lb.union(b_bounds[bi]);
                lc += b_counts[bi];
                let rc_s = right_cnt[bi];
                if lc == 0 || rc_s == 0 {
                    continue;
                }
                let e = sub(lb.max, lb.min);
                let la = e[0] * e[1] + e[1] * e[2] + e[2] * e[0];
                let cost = (lc as f64) * la + (rc_s as f64) * right_area[bi];
                if cost < best_cost {
                    best_cost = cost;
                    best_axis = axis;
                    best_split = bi + 1;
                }
            }
        }

        let mid = if best_cost.is_finite() {
            let lo = cent_bounds.min[best_axis];
            let span = cent_bounds.max[best_axis] - lo;
            let inv = 16.0 / span;
            let mut m = start;
            for i in start..end {
                let mut bin = ((self.tris[i].centroid[best_axis] - lo) * inv) as isize;
                if bin < 0 {
                    bin = 0;
                } else if bin >= 16 {
                    bin = 15;
                }
                if (bin as usize) < best_split {
                    self.tris.swap(i, m);
                    m += 1;
                }
            }
            m
        } else {
            let ext = sub(cent_bounds.max, cent_bounds.min);
            let axis = if ext[0] >= ext[1] && ext[0] >= ext[2] {
                0
            } else if ext[1] >= ext[2] {
                1
            } else {
                2
            };
            let m = start + count / 2;
            self.tris[start..end].select_nth_unstable_by(m - start, |a, b| {
                a.centroid[axis].total_cmp(&b.centroid[axis])
            });
            m
        };

        let mid = if mid == start || mid == end {
            start + count / 2
        } else {
            mid
        };

        self.nodes.push(SoupNode {
            bounds,
            kind: BvhNodeKind::Leaf { start, count: 0 },
        });
        let left = self.build_node(start, mid, depth + 1);
        let right = self.build_node(mid, end, depth + 1);
        self.nodes[idx].kind = BvhNodeKind::Branch { left, right };
        idx
    }

    pub fn raycast_filtered(
        &self,
        origin: Vec3,
        dir: Vec3,
        t_min: f64,
        t_max: f64,
        mut filter: impl FnMut(usize) -> bool,
    ) -> Option<SoupRayHit> {
        if self.nodes.is_empty() {
            return None;
        }
        let inv_dir = [
            if dir[0].abs() > 1e-30 {
                1.0 / dir[0]
            } else {
                f64::copysign(1e30, dir[0])
            },
            if dir[1].abs() > 1e-30 {
                1.0 / dir[1]
            } else {
                f64::copysign(1e30, dir[1])
            },
            if dir[2].abs() > 1e-30 {
                1.0 / dir[2]
            } else {
                f64::copysign(1e30, dir[2])
            },
        ];
        let mut best: Option<SoupRayHit> = None;
        let mut best_t = t_max;
        let mut stack = [0usize; 64];
        let mut sp = 1usize;
        stack[0] = 0;

        while sp > 0 {
            sp -= 1;
            let node = &self.nodes[stack[sp]];
            if node
                .bounds
                .intersect_ray(origin, inv_dir, t_min, best_t)
                .is_none()
            {
                continue;
            }
            match node.kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ti in start..(start + count) {
                        let tri = &self.tris[ti];
                        if !filter(tri.id) {
                            continue;
                        }
                        if let Some((t, u, v)) = hit_triangle(origin, dir, tri.a, tri.b, tri.c) {
                            if t > t_min
                                && (t < best_t
                                    || ((t - best_t).abs() <= 1e-12
                                        && best.map_or(true, |b| tri.id < b.triangle)))
                            {
                                best_t = t;
                                best = Some(SoupRayHit {
                                    triangle: tri.id,
                                    t,
                                    u,
                                    v,
                                });
                            }
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => {
                    let dl = self.nodes[left]
                        .bounds
                        .intersect_ray(origin, inv_dir, t_min, best_t);
                    let dr = self.nodes[right]
                        .bounds
                        .intersect_ray(origin, inv_dir, t_min, best_t);
                    match (dl, dr) {
                        (Some(tl), Some(tr)) => {
                            if sp + 2 <= stack.len() {
                                if tl <= tr {
                                    stack[sp] = right;
                                    stack[sp + 1] = left;
                                } else {
                                    stack[sp] = left;
                                    stack[sp + 1] = right;
                                }
                                sp += 2;
                            }
                        }
                        (Some(_), None) => {
                            if sp < stack.len() {
                                stack[sp] = left;
                                sp += 1;
                            }
                        }
                        (None, Some(_)) => {
                            if sp < stack.len() {
                                stack[sp] = right;
                                sp += 1;
                            }
                        }
                        (None, None) => {}
                    }
                }
            }
        }
        best
    }

    pub fn is_occluded_filtered(
        &self,
        origin: Vec3,
        dir: Vec3,
        t_min: f64,
        t_max: f64,
        mut filter: impl FnMut(usize) -> bool,
    ) -> bool {
        if self.nodes.is_empty() {
            return false;
        }
        let inv_dir = [
            if dir[0].abs() > 1e-30 {
                1.0 / dir[0]
            } else {
                f64::copysign(1e30, dir[0])
            },
            if dir[1].abs() > 1e-30 {
                1.0 / dir[1]
            } else {
                f64::copysign(1e30, dir[1])
            },
            if dir[2].abs() > 1e-30 {
                1.0 / dir[2]
            } else {
                f64::copysign(1e30, dir[2])
            },
        ];
        let mut stack = [0usize; 64];
        let mut sp = 1usize;
        stack[0] = 0;
        while sp > 0 {
            sp -= 1;
            let node = &self.nodes[stack[sp]];
            if node
                .bounds
                .intersect_ray(origin, inv_dir, t_min, t_max)
                .is_none()
            {
                continue;
            }
            match node.kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ti in start..(start + count) {
                        let tri = &self.tris[ti];
                        if !filter(tri.id) {
                            continue;
                        }
                        if let Some((t, _, _)) = hit_triangle(origin, dir, tri.a, tri.b, tri.c) {
                            if t > t_min && t <= t_max {
                                return true;
                            }
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => {
                    if sp + 2 <= stack.len() {
                        stack[sp] = right;
                        stack[sp + 1] = left;
                        sp += 2;
                    }
                }
            }
        }
        false
    }

    pub fn nearest_filtered(
        &self,
        point: Vec3,
        max_dist_sq: f64,
        mut filter: impl FnMut(usize) -> bool,
    ) -> Option<SoupNearest> {
        if self.nodes.is_empty() {
            return None;
        }
        let mut best: Option<SoupNearest> = None;
        let mut best_d2 = max_dist_sq;
        let mut stack = [0usize; 64];
        let mut sp = 1usize;
        stack[0] = 0;

        while sp > 0 {
            sp -= 1;
            let node = &self.nodes[stack[sp]];
            if aabb_dist_sq(&node.bounds, point) > best_d2 {
                continue;
            }
            match node.kind {
                BvhNodeKind::Leaf { start, count } => {
                    for ti in start..(start + count) {
                        let tri = &self.tris[ti];
                        if !filter(tri.id) {
                            continue;
                        }
                        let (u, v, d2) = closest_point_triangle(point, tri.a, tri.b, tri.c);
                        if d2 < best_d2
                            || ((d2 - best_d2).abs() <= 1e-18
                                && best.map_or(true, |b| tri.id < b.triangle))
                        {
                            best_d2 = d2;
                            best = Some(SoupNearest {
                                triangle: tri.id,
                                u,
                                v,
                                distance_squared: d2,
                            });
                        }
                    }
                }
                BvhNodeKind::Branch { left, right } => {
                    let dl = aabb_dist_sq(&self.nodes[left].bounds, point);
                    let dr = aabb_dist_sq(&self.nodes[right].bounds, point);
                    if dl <= dr {
                        if dr <= best_d2 && sp < stack.len() {
                            stack[sp] = right;
                            sp += 1;
                        }
                        if dl <= best_d2 && sp < stack.len() {
                            stack[sp] = left;
                            sp += 1;
                        }
                    } else {
                        if dl <= best_d2 && sp < stack.len() {
                            stack[sp] = left;
                            sp += 1;
                        }
                        if dr <= best_d2 && sp < stack.len() {
                            stack[sp] = right;
                            sp += 1;
                        }
                    }
                }
            }
        }
        best
    }
}
