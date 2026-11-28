//! High-to-low bake group partitioning, cage bounds resolution, and ray direction fields.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::bvh::TriSoupBvh;
use crate::mesh::geom::{cross, dot, length, normalize, sub, Vec3};
use crate::mesh::{EditMesh, FACE_FLOAT, NONE};

pub const STEEP_COS: f64 = 0.2588190451025207;
pub const FACING_MIN: f64 = 0.1;
pub const CAGE_SAMPLES: usize = 64;
pub const CAGE_MARGIN: f64 = 1.05;
pub const CAGE_FLOOR: f64 = 1e-3;
pub const CAGE_LIMIT: f64 = 0.2;

#[derive(Debug, Clone, Copy)]
pub enum BakeDirection {
    Averaged,
    Shading,
    Face,
    FaceTag { face_tag: i32 },
    Blend { distance: f64 },
}

#[derive(Debug, Clone, Copy)]
pub struct CageSpec {
    /// `None` => auto resolution
    pub offset: Option<f64>,
    /// `None` => auto resolution
    pub max_ray: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ResolvedCage {
    pub offset: f64,
    pub max_ray: f64,
    pub diagonal: f64,
    pub steep_fraction: f64,
}

#[derive(Debug, Clone)]
pub struct BakeGroupPartition {
    pub names: Vec<String>,
    /// Per face index of mesh -> group id (0..names.len()) or `NONE`.
    pub face_group: Vec<i32>,
}

pub fn face_groups(
    mesh: &EditMesh,
    prefix: Option<&str>,
) -> Result<BakeGroupPartition, KernelError> {
    let mut face_group = vec![NONE; mesh.face_high_water.max(0) as usize];
    let mut tags: Vec<(usize, String)> = Vec::new();
    if let Some(pref) = prefix {
        for (ti, name) in mesh.tag_names.iter().enumerate() {
            if let Some(id) = name.strip_prefix(pref) {
                tags.push((ti, id.to_string()));
            }
        }
    }
    let mut names = Vec::new();
    let mut index: HashMap<String, i32> = HashMap::new();
    for f in mesh.faces() {
        let mut chosen = String::new();
        let mut found: Option<&str> = None;
        for (ti, id) in &tags {
            if !mesh.has_tag(f, *ti as i32) {
                continue;
            }
            if let Some(prev) = found {
                return Err(KernelError::invalid_value(
                    "bakeGroup",
                    &format!("face {f} belongs to multiple bake groups ({prev}, {id})"),
                ));
            }
            found = Some(id.as_str());
            chosen.clone_from(id);
        }
        let g = *index.entry(chosen.clone()).or_insert_with(|| {
            let next = names.len() as i32;
            names.push(chosen);
            next
        });
        face_group[f as usize] = g;
    }
    Ok(BakeGroupPartition { names, face_group })
}

pub fn floater_faces(mesh: &EditMesh, floater_tag: Option<&str>) -> Vec<u8> {
    let mut out = vec![0u8; mesh.face_high_water.max(0) as usize];
    let tag_id = floater_tag.and_then(|t| mesh.tag_names.iter().position(|n| n == t));
    for f in mesh.faces() {
        let floating = (mesh.f_flags[f as usize] & FACE_FLOAT) != 0;
        let tagged = tag_id.is_some_and(|ti| mesh.has_tag(f, ti as i32));
        if floating || tagged {
            out[f as usize] = 1;
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct PosKey {
    x: u64,
    y: u64,
    z: u64,
    g: i32,
}

#[inline]
fn pos_key(p: Vec3, g: i32) -> PosKey {
    let clean = |v: f64| {
        if v == 0.0 {
            0.0f64.to_bits()
        } else {
            v.to_bits()
        }
    };
    PosKey {
        x: clean(p[0]),
        y: clean(p[1]),
        z: clean(p[2]),
        g,
    }
}

/// Spatial hash grid over hard edges and cross-group borders.
pub struct HardEdgeGrid {
    radius: f64,
    segments: Vec<[f64; 6]>,
    cells: HashMap<(i32, i32, i32), Vec<usize>>,
}

impl HardEdgeGrid {
    pub fn empty(radius: f64) -> Self {
        Self {
            radius: radius.max(1e-12),
            segments: Vec::new(),
            cells: HashMap::new(),
        }
    }

    pub fn build(
        mesh: &EditMesh,
        base_pos: &[f64],
        base_indices: &[u32],
        tri_face: &[i32],
        tri_shading: &[f64],
        tri_group: &[i32],
        face_group: &[i32],
        radius: f64,
    ) -> Self {
        let mut grid = Self {
            radius: radius.max(1e-12),
            segments: Vec::new(),
            cells: HashMap::new(),
        };
        let mut render: HashMap<(i32, u32), usize> = HashMap::new();
        let tri_count = base_indices.len() / 3;
        for t in 0..tri_count {
            let f = tri_face[t];
            for k in 0..3 {
                let r = base_indices[t * 3 + k];
                // map (face, vert_pos_idx) -> corner offset
                render.entry((f, r)).or_insert(t * 9 + k * 3);
            }
        }
        let _ = base_pos;
        let _ = tri_group;

        // Edge hardness by cross-group or normal discontinuity across shared edge faces
        let mut edge_seen = HashSet::new();
        for h in 0..mesh.h_vert.len() {
            let e = h >> 1;
            if !edge_seen.insert(e) {
                continue;
            }
            let f1 = mesh.h_face[e * 2];
            let f2 = mesh.h_face[e * 2 + 1];
            if f1 == NONE || f2 == NONE {
                continue;
            }
            let a = mesh.h_vert[e * 2];
            let b = mesh.h_vert[e * 2 + 1];
            let g1 = face_group.get(f1 as usize).copied().unwrap_or(NONE);
            let g2 = face_group.get(f2 as usize).copied().unwrap_or(NONE);
            let mut hard = g1 != g2;
            if !hard {
                // Compare face normals as safe conservative hard check when vertex corner lookup isn't 1:1
                let n1 = crate::mesh::geom::face_normal(mesh, f1);
                let n2 = crate::mesh::geom::face_normal(mesh, f2);
                if dot(n1, n2) < 1.0 - 1e-6 {
                    hard = true;
                }
            }
            let _ = tri_shading;
            if hard {
                grid.add_segment(mesh.position(a), mesh.position(b));
            }
        }
        grid
    }

    #[inline]
    fn cell_of(&self, p: Vec3) -> (i32, i32, i32) {
        (
            (p[0] / self.radius).floor() as i32,
            (p[1] / self.radius).floor() as i32,
            (p[2] / self.radius).floor() as i32,
        )
    }

    pub fn add_segment(&mut self, a: Vec3, b: Vec3) {
        let s = self.segments.len();
        self.segments.push([a[0], a[1], a[2], b[0], b[1], b[2]]);
        let lo = self.cell_of([a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])]);
        let hi = self.cell_of([a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])]);
        for x in lo.0..=hi.0 {
            for y in lo.1..=hi.1 {
                for z in lo.2..=hi.2 {
                    self.cells.entry((x, y, z)).or_default().push(s);
                }
            }
        }
    }

    pub fn distance(&self, p: Vec3) -> f64 {
        let (cx, cy, cz) = self.cell_of(p);
        let mut best = self.radius;
        for x in (cx - 1)..=(cx + 1) {
            for y in (cy - 1)..=(cy + 1) {
                for z in (cz - 1)..=(cz + 1) {
                    let Some(list) = self.cells.get(&(x, y, z)) else {
                        continue;
                    };
                    for &si in list {
                        let seg = self.segments[si];
                        let a = [seg[0], seg[1], seg[2]];
                        let d = [seg[3] - seg[0], seg[4] - seg[1], seg[5] - seg[2]];
                        let ap = sub(p, a);
                        let dd = dot(d, d);
                        let u = if dd > 0.0 {
                            (dot(ap, d) / dd).clamp(0.0, 1.0)
                        } else {
                            0.0
                        };
                        let q = [ap[0] - d[0] * u, ap[1] - d[1] * u, ap[2] - d[2] * u];
                        let dist = length(q);
                        if dist < best {
                            best = dist;
                        }
                    }
                }
            }
        }
        best
    }
}

pub struct BaseTriData {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub group: Vec<i32>,
    pub averaged: Vec<f64>,
    pub shading: Vec<f64>,
    pub face: Vec<f64>,
    pub tagged: Vec<u8>,
}

impl BaseTriData {
    #[inline]
    pub fn corner(&self, t: usize, k: usize) -> Vec3 {
        let vi = (self.indices[t * 3 + k] as usize) * 3;
        [
            self.positions[vi],
            self.positions[vi + 1],
            self.positions[vi + 2],
        ]
    }

    #[inline]
    pub fn ray_direction(
        &self,
        t: usize,
        w: [f64; 3],
        direction: BakeDirection,
        p: Vec3,
        hard: Option<&HardEdgeGrid>,
    ) -> Vec3 {
        let lerp3 = |arr: &[f64]| -> Vec3 {
            let base = t * 9;
            let mut out = [0.0f64; 3];
            for k in 0..3 {
                let wk = w[k];
                out[0] += wk * arr[base + k * 3];
                out[1] += wk * arr[base + k * 3 + 1];
                out[2] += wk * arr[base + k * 3 + 2];
            }
            normalize(out)
        };
        let f_n = [self.face[t * 3], self.face[t * 3 + 1], self.face[t * 3 + 2]];
        match direction {
            BakeDirection::Averaged => lerp3(&self.averaged),
            BakeDirection::Shading => lerp3(&self.shading),
            BakeDirection::Face => f_n,
            BakeDirection::FaceTag { .. } => {
                if self.tagged[t] != 0 {
                    f_n
                } else {
                    lerp3(&self.averaged)
                }
            }
            BakeDirection::Blend { distance } => {
                let avg = lerp3(&self.averaged);
                let dist = hard.map_or(distance, |h| h.distance(p));
                let s = (dist / distance.max(1e-12)).min(1.0);
                let k = s * s * (3.0 - 2.0 * s);
                normalize([
                    avg[0] * (1.0 - k) + f_n[0] * k,
                    avg[1] * (1.0 - k) + f_n[1] * k,
                    avg[2] * (1.0 - k) + f_n[2] * k,
                ])
            }
        }
    }
}

/// Angle-weighted corner normals welded by `(position, group)` matching `averagedNormals`.
pub fn build_base_averaged_normals(
    positions: &[f64],
    indices: &[u32],
    tri_group: &[i32],
) -> Vec<f64> {
    let tri_count = indices.len() / 3;
    let mut sums: HashMap<PosKey, Vec3> = HashMap::with_capacity(indices.len());
    for t in 0..tri_count {
        let g = tri_group[t];
        let ps = [
            {
                let i = (indices[t * 3] as usize) * 3;
                [positions[i], positions[i + 1], positions[i + 2]]
            },
            {
                let i = (indices[t * 3 + 1] as usize) * 3;
                [positions[i], positions[i + 1], positions[i + 2]]
            },
            {
                let i = (indices[t * 3 + 2] as usize) * 3;
                [positions[i], positions[i + 1], positions[i + 2]]
            },
        ];
        let n = normalize(cross(sub(ps[1], ps[0]), sub(ps[2], ps[0])));
        for i in 0..3 {
            let p = ps[i];
            let a = sub(ps[(i + 2) % 3], p);
            let b = sub(ps[(i + 1) % 3], p);
            let angle = length(cross(a, b)).atan2(dot(a, b));
            let key = pos_key(p, g);
            let entry = sums.entry(key).or_insert([0.0, 0.0, 0.0]);
            entry[0] += n[0] * angle;
            entry[1] += n[1] * angle;
            entry[2] += n[2] * angle;
        }
    }
    let mut out = vec![0.0f64; tri_count * 9];
    for t in 0..tri_count {
        let g = tri_group[t];
        for k in 0..3 {
            let i = (indices[t * 3 + k] as usize) * 3;
            let p = [positions[i], positions[i + 1], positions[i + 2]];
            let n = normalize(sums.get(&pos_key(p, g)).copied().unwrap_or([0.0, 1.0, 0.0]));
            out[t * 9 + k * 3] = n[0];
            out[t * 9 + k * 3 + 1] = n[1];
            out[t * 9 + k * 3 + 2] = n[2];
        }
    }
    out
}

#[inline]
fn tri_points(a: Vec3, b: Vec3, c: Vec3, spacing: f64, mut visit: impl FnMut(Vec3, [f64; 3])) {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let longest = length(ab).max(length(ac)).max(length(sub(ab, ac)));
    let m = ((longest / spacing.max(1e-12)).ceil() as usize).clamp(1, CAGE_SAMPLES);
    let mf = m as f64;
    for i in 0..=m {
        for j in 0..=(m - i) {
            let fi = (i as f64) / mf;
            let fj = (j as f64) / mf;
            let q = [
                a[0] + ab[0] * fi + ac[0] * fj,
                a[1] + ab[1] * fi + ac[1] * fj,
                a[2] + ab[2] * fi + ac[2] * fj,
            ];
            visit(q, [1.0 - fi - fj, fi, fj]);
        }
    }
}

/// Resolve cage `(offset, max_ray, diagonal, steep_fraction)` for a single bake group.
pub fn resolve_cage_group(
    cage: CageSpec,
    group_id: &str,
    base: &BaseTriData,
    base_tris: &[usize],
    detail_pos: &[f64],
    detail_indices: &[u32],
    detail_tris: &[usize],
    direction: BakeDirection,
    hard: Option<&HardEdgeGrid>,
) -> Result<ResolvedCage, KernelError> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for &t in base_tris {
        for k in 0..3 {
            let p = base.corner(t, k);
            for c in 0..3 {
                lo[c] = lo[c].min(p[c]);
                hi[c] = hi[c].max(p[c]);
            }
        }
    }
    for &t in detail_tris {
        for k in 0..3 {
            let vi = (detail_indices[t * 3 + k] as usize) * 3;
            for c in 0..3 {
                let v = detail_pos[vi + c];
                lo[c] = lo[c].min(v);
                hi[c] = hi[c].max(v);
            }
        }
    }
    let diagonal = length(sub(hi, lo));

    let base_bvh = TriSoupBvh::build(&base.positions, &base.indices, Some(base_tris));
    let detail_bvh = TriSoupBvh::build(detail_pos, detail_indices, Some(detail_tris));
    let mut detail_normal: HashMap<usize, Vec3> = HashMap::with_capacity(detail_tris.len());
    for &t in detail_tris {
        let i0 = (detail_indices[t * 3] as usize) * 3;
        let i1 = (detail_indices[t * 3 + 1] as usize) * 3;
        let i2 = (detail_indices[t * 3 + 2] as usize) * 3;
        let a = [detail_pos[i0], detail_pos[i0 + 1], detail_pos[i0 + 2]];
        let b = [detail_pos[i1], detail_pos[i1 + 1], detail_pos[i1 + 2]];
        let c = [detail_pos[i2], detail_pos[i2 + 1], detail_pos[i2 + 2]];
        detail_normal.insert(t, normalize(cross(sub(b, a), sub(c, a))));
    }

    let (offset, max_ray) = if let (Some(off), Some(mr)) = (cage.offset, cage.max_ray) {
        (off, mr)
    } else {
        let spacing = diagonal / (CAGE_SAMPLES as f64);
        let mut outward = 0.0f64;
        let mut inward = 0.0f64;

        let mut measure = |p: Vec3, c: Vec3, q: Vec3, n: Vec3| {
            let facing = dot(c, n);
            if !(facing > -STEEP_COS) {
                return;
            }
            let d = sub(q, p);
            let s = if facing >= STEEP_COS {
                dot(d, n) / facing
            } else {
                dot(d, c)
            };
            outward = outward.max(s);
            inward = inward.max(-s);
        };

        let base_at = |bt: usize, w: [f64; 3]| -> (Vec3, Vec3) {
            let a = base.corner(bt, 0);
            let b = base.corner(bt, 1);
            let c = base.corner(bt, 2);
            let p = [
                a[0] * w[0] + b[0] * w[1] + c[0] * w[2],
                a[1] * w[0] + b[1] * w[1] + c[1] * w[2],
                a[2] * w[0] + b[2] * w[1] + c[2] * w[2],
            ];
            let dir = base.ray_direction(bt, w, direction, p, hard);
            (p, dir)
        };

        for &dt in detail_tris {
            let n = detail_normal[&dt];
            if !(length(n) > 0.0) {
                continue;
            }
            let i0 = (detail_indices[dt * 3] as usize) * 3;
            let i1 = (detail_indices[dt * 3 + 1] as usize) * 3;
            let i2 = (detail_indices[dt * 3 + 2] as usize) * 3;
            let da = [detail_pos[i0], detail_pos[i0 + 1], detail_pos[i0 + 2]];
            let db = [detail_pos[i1], detail_pos[i1 + 1], detail_pos[i1 + 2]];
            let dc = [detail_pos[i2], detail_pos[i2 + 1], detail_pos[i2 + 2]];
            tri_points(da, db, dc, spacing, |q, _| {
                if let Some(near) = base_bvh.nearest_filtered(q, f64::INFINITY, |_| true) {
                    let (p, c) = base_at(near.triangle, [1.0 - near.u - near.v, near.u, near.v]);
                    measure(p, c, q, n);
                }
            });
        }

        for &bt in base_tris {
            let ba = base.corner(bt, 0);
            let bb = base.corner(bt, 1);
            let bc = base.corner(bt, 2);
            tri_points(ba, bb, bc, spacing, |_, w| {
                let (p, c) = base_at(bt, w);
                if let Some(near) = detail_bvh.nearest_filtered(p, f64::INFINITY, |dt| {
                    dot(detail_normal[&dt], c) > FACING_MIN
                }) {
                    let dt = near.triangle;
                    let i0 = (detail_indices[dt * 3] as usize) * 3;
                    let i1 = (detail_indices[dt * 3 + 1] as usize) * 3;
                    let i2 = (detail_indices[dt * 3 + 2] as usize) * 3;
                    let w0 = 1.0 - near.u - near.v;
                    let q = [
                        w0 * detail_pos[i0] + near.u * detail_pos[i1] + near.v * detail_pos[i2],
                        w0 * detail_pos[i0 + 1]
                            + near.u * detail_pos[i1 + 1]
                            + near.v * detail_pos[i2 + 1],
                        w0 * detail_pos[i0 + 2]
                            + near.u * detail_pos[i1 + 2]
                            + near.v * detail_pos[i2 + 2],
                    ];
                    measure(p, c, q, detail_normal[&dt]);
                }
            });
        }

        let floor = CAGE_FLOOR * diagonal;
        let off = cage
            .offset
            .unwrap_or_else(|| floor.max(outward * CAGE_MARGIN));
        let depth = floor.max(inward * CAGE_MARGIN);
        let mr = cage.max_ray.unwrap_or(off + depth);
        let limit = CAGE_LIMIT * diagonal;
        if (cage.offset.is_none() && off > limit) || (cage.max_ray.is_none() && depth > limit) {
            return Err(KernelError::invalid_value(
                "cage",
                &format!(
                    "automatic cage of group '{group_id}' exceeds {:.0}% of diagonal ({off:.4} / {depth:.4} vs limit {limit:.4})",
                    CAGE_LIMIT * 100.0
                ),
            ));
        }
        (off, mr)
    };

    // Steep fraction
    let steep = if base_tris.is_empty() || detail_tris.is_empty() {
        0.0
    } else {
        let mut steep_area = 0.0f64;
        let mut total_area = 0.0f64;
        for &dt in detail_tris {
            let i0 = (detail_indices[dt * 3] as usize) * 3;
            let i1 = (detail_indices[dt * 3 + 1] as usize) * 3;
            let i2 = (detail_indices[dt * 3 + 2] as usize) * 3;
            let a = [detail_pos[i0], detail_pos[i0 + 1], detail_pos[i0 + 2]];
            let b = [detail_pos[i1], detail_pos[i1 + 1], detail_pos[i1 + 2]];
            let c = [detail_pos[i2], detail_pos[i2 + 1], detail_pos[i2 + 2]];
            let n_raw = cross(sub(b, a), sub(c, a));
            let n_len = length(n_raw);
            let area = n_len * 0.5;
            if !(area > 0.0) {
                continue;
            }
            total_area += area;
            let centroid = [
                (a[0] + b[0] + c[0]) / 3.0,
                (a[1] + b[1] + c[1]) / 3.0,
                (a[2] + b[2] + c[2]) / 3.0,
            ];
            if let Some(near) = base_bvh.nearest_filtered(centroid, f64::INFINITY, |_| true) {
                let w = [1.0 - near.u - near.v, near.u, near.v];
                let pa = base.corner(near.triangle, 0);
                let pb = base.corner(near.triangle, 1);
                let pc = base.corner(near.triangle, 2);
                let p = [
                    pa[0] * w[0] + pb[0] * w[1] + pc[0] * w[2],
                    pa[1] * w[0] + pb[1] * w[1] + pc[1] * w[2],
                    pa[2] * w[0] + pb[2] * w[1] + pc[2] * w[2],
                ];
                let ray = base.ray_direction(near.triangle, w, direction, p, hard);
                let cos_a = (dot(n_raw, ray) / n_len).abs();
                if cos_a < STEEP_COS {
                    steep_area += area;
                }
            }
        }
        if total_area > 0.0 {
            steep_area / total_area
        } else {
            0.0
        }
    };

    Ok(ResolvedCage {
        offset,
        max_ray,
        diagonal,
        steep_fraction: steep,
    })
}
