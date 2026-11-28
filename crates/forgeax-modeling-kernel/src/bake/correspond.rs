//! High-to-low surface correspondence rasterization & raycasting with facing/rescue/nearest fallback.

use std::collections::HashMap;

use crate::error::KernelError;
use crate::mesh::bvh::TriSoupBvh;
use crate::mesh::geom::{cross, dot, length, normalize, sub, Vec3};
use crate::mesh::NONE;

use super::cage::{
    build_base_averaged_normals, BakeDirection, BaseTriData, HardEdgeGrid, FACING_MIN,
};

pub const OWN_SIDE_COS: f64 = 0.5;
pub const FACES_BASE_MIN: f64 = 0.0;
pub const EXTENDED_REACH: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CorrespondBranch {
    Primary = 0,
    Rescued = 1,
    Extended = 2,
    Nearest = 3,
    Miss = 4,
}

#[derive(Debug, Clone)]
pub struct BakeGroupConfig {
    pub offset: f64,
    pub max_ray: f64,
    pub diagonal: f64,
    pub direction: BakeDirection,
    pub clip_check: bool,
}

#[derive(Debug, Clone)]
pub struct DetailMeshData {
    pub positions: Vec<f64>,
    /// Per triangle-corner smooth/shading normals (`indices.len() * 3` floats) or per-vertex (`positions.len()` floats)
    pub corner_normals: Vec<f64>,
    pub face_normals: Vec<f64>,
    pub indices: Vec<u32>,
    pub tri_group: Vec<i32>,
    pub tri_slot: Vec<i32>,
    pub floater: Vec<u8>,
    pub vert_curvature: Vec<f32>,
    pub corner_colors: Vec<f32>,
    pub has_corner_colors: bool,
}

impl DetailMeshData {
    pub fn build_normals_and_face_normals(&mut self) {
        let tri_count = self.indices.len() / 3;
        if self.face_normals.len() != tri_count * 3 {
            self.face_normals.resize(tri_count * 3, 0.0);
            for t in 0..tri_count {
                let a = self.vertex_pos(self.indices[t * 3] as usize);
                let b = self.vertex_pos(self.indices[t * 3 + 1] as usize);
                let c = self.vertex_pos(self.indices[t * 3 + 2] as usize);
                let n = normalize(cross(sub(b, a), sub(c, a)));
                self.face_normals[t * 3] = n[0];
                self.face_normals[t * 3 + 1] = n[1];
                self.face_normals[t * 3 + 2] = n[2];
            }
        }
    }

    #[inline]
    pub fn vertex_pos(&self, vi: usize) -> Vec3 {
        let o = vi * 3;
        [
            self.positions[o],
            self.positions[o + 1],
            self.positions[o + 2],
        ]
    }

    #[inline]
    pub fn face_normal(&self, tri: usize) -> Vec3 {
        let o = tri * 3;
        [
            self.face_normals[o],
            self.face_normals[o + 1],
            self.face_normals[o + 2],
        ]
    }

    #[inline]
    pub fn shading_normal(&self, tri: usize, u: f64, v: f64) -> Vec3 {
        let w0 = 1.0 - u - v;
        if self.corner_normals.len() == self.indices.len() * 3 {
            let base = tri * 9;
            normalize([
                w0 * self.corner_normals[base]
                    + u * self.corner_normals[base + 3]
                    + v * self.corner_normals[base + 6],
                w0 * self.corner_normals[base + 1]
                    + u * self.corner_normals[base + 4]
                    + v * self.corner_normals[base + 7],
                w0 * self.corner_normals[base + 2]
                    + u * self.corner_normals[base + 5]
                    + v * self.corner_normals[base + 8],
            ])
        } else if self.corner_normals.len() == self.positions.len() {
            let i0 = (self.indices[tri * 3] as usize) * 3;
            let i1 = (self.indices[tri * 3 + 1] as usize) * 3;
            let i2 = (self.indices[tri * 3 + 2] as usize) * 3;
            normalize([
                w0 * self.corner_normals[i0]
                    + u * self.corner_normals[i1]
                    + v * self.corner_normals[i2],
                w0 * self.corner_normals[i0 + 1]
                    + u * self.corner_normals[i1 + 1]
                    + v * self.corner_normals[i2 + 1],
                w0 * self.corner_normals[i0 + 2]
                    + u * self.corner_normals[i1 + 2]
                    + v * self.corner_normals[i2 + 2],
            ])
        } else {
            self.face_normal(tri)
        }
    }
}

#[derive(Debug, Clone)]
pub struct BakeCorrespondInput {
    pub width: u32,
    pub height: u32,
    pub samples_per_axis: u32,
    pub base_positions: Vec<f64>,
    pub base_normals: Vec<f64>,
    pub base_tangents: Vec<f32>,
    pub base_uvs: Vec<f32>,
    pub base_indices: Vec<u32>,
    pub base_tri_face: Vec<i32>,
    pub base_tri_group: Vec<i32>,
    pub base_tri_island: Vec<i32>,
    pub base_tri_tagged: Vec<u8>,
    pub detail: DetailMeshData,
    pub groups: Vec<BakeGroupConfig>,
}

#[derive(Debug, Clone)]
pub struct BakeCorrespondCounters {
    pub ray_hits: u32,
    pub primary: u32,
    pub rescued: u32,
    pub extended: u32,
    pub nearest: u32,
    pub missed: u32,
    pub clipped: u32,
    pub covered_texels: u32,
}

#[derive(Debug, Clone)]
pub struct BakeCorrespondenceData {
    pub width: u32,
    pub height: u32,
    pub samples_per_axis: u32,
    pub count: usize,
    pub texel: Vec<u32>,
    pub sample_idx: Vec<u32>,
    pub group: Vec<i32>,
    pub tri: Vec<i32>,
    pub uv: Vec<f32>,
    pub q: Vec<f32>,
    pub nd: Vec<f32>,
    pub base_normal: Vec<f32>,
    pub base_tangent: Vec<f32>,
    pub sample_height: Vec<f32>,
    pub hit: Vec<u8>,
    pub branch: Vec<u8>,
    pub weight: Vec<u32>,
    pub island: Vec<i32>,
    pub owner: Vec<i32>,
    pub counters: BakeCorrespondCounters,
    pub detail: DetailMeshData,
    pub detail_bvhs: Vec<TriSoupBvh>,
    pub detail_solid_bvhs: Vec<TriSoupBvh>,
    pub group_diagonals: Vec<f64>,
}

#[inline]
pub fn tangent_frame_of(
    base_tangents: &[f32],
    indices: &[u32],
    t: usize,
    w: [f64; 3],
    nrm: Vec3,
) -> (Vec3, f64) {
    let i0 = indices[t * 3] as usize;
    let i1 = indices[t * 3 + 1] as usize;
    let i2 = indices[t * 3 + 2] as usize;
    let tx = w[0] * (base_tangents[i0 * 4] as f64)
        + w[1] * (base_tangents[i1 * 4] as f64)
        + w[2] * (base_tangents[i2 * 4] as f64);
    let ty = w[0] * (base_tangents[i0 * 4 + 1] as f64)
        + w[1] * (base_tangents[i1 * 4 + 1] as f64)
        + w[2] * (base_tangents[i2 * 4 + 1] as f64);
    let tz = w[0] * (base_tangents[i0 * 4 + 2] as f64)
        + w[1] * (base_tangents[i1 * 4 + 2] as f64)
        + w[2] * (base_tangents[i2 * 4 + 2] as f64);
    let d = tx * nrm[0] + ty * nrm[1] + tz * nrm[2];
    let ortho = normalize([tx - nrm[0] * d, ty - nrm[1] * d, tz - nrm[2] * d]);
    let hand = if (base_tangents[i0 * 4 + 3] as f64) < 0.0 {
        -1.0
    } else {
        1.0
    };
    (
        if length(ortho) > 1e-12 {
            ortho
        } else {
            [1.0, 0.0, 0.0]
        },
        hand,
    )
}

pub fn bake_correspond(
    mut input: BakeCorrespondInput,
) -> Result<BakeCorrespondenceData, KernelError> {
    if input.width == 0 || input.height == 0 {
        return Err(KernelError::invalid_value("resolution", "must be > 0"));
    }
    let w = input.width as usize;
    let h = input.height as usize;
    let texels = w * h;
    let grid = input.samples_per_axis.clamp(1, 4) as usize;
    let per_texel = grid * grid;

    input.detail.build_normals_and_face_normals();
    let base_tris = input.base_indices.len() / 3;
    if base_tris == 0 || input.base_uvs.len() < 2 {
        return Err(KernelError::invalid_value(
            "base",
            "requires triangles and uv0 coordinates",
        ));
    }

    // Build BaseTriData fields
    let averaged = build_base_averaged_normals(
        &input.base_positions,
        &input.base_indices,
        &input.base_tri_group,
    );
    let mut shading = vec![0.0f64; base_tris * 9];
    let mut face_n = vec![0.0f64; base_tris * 3];
    for t in 0..base_tris {
        let i0 = (input.base_indices[t * 3] as usize) * 3;
        let i1 = (input.base_indices[t * 3 + 1] as usize) * 3;
        let i2 = (input.base_indices[t * 3 + 2] as usize) * 3;
        let p0 = [
            input.base_positions[i0],
            input.base_positions[i0 + 1],
            input.base_positions[i0 + 2],
        ];
        let p1 = [
            input.base_positions[i1],
            input.base_positions[i1 + 1],
            input.base_positions[i1 + 2],
        ];
        let p2 = [
            input.base_positions[i2],
            input.base_positions[i2 + 1],
            input.base_positions[i2 + 2],
        ];
        let fn_v = normalize(cross(sub(p1, p0), sub(p2, p0)));
        face_n[t * 3] = fn_v[0];
        face_n[t * 3 + 1] = fn_v[1];
        face_n[t * 3 + 2] = fn_v[2];
        for k in 0..3 {
            let vi = (input.base_indices[t * 3 + k] as usize) * 3;
            shading[t * 9 + k * 3] = input.base_normals[vi];
            shading[t * 9 + k * 3 + 1] = input.base_normals[vi + 1];
            shading[t * 9 + k * 3 + 2] = input.base_normals[vi + 2];
        }
    }
    let base_data = BaseTriData {
        positions: input.base_positions,
        indices: input.base_indices,
        group: input.base_tri_group,
        averaged,
        shading,
        face: face_n,
        tagged: input.base_tri_tagged,
    };

    // Build per-group detail BVHs (all + solid non-floater)
    let ng = input.groups.len().max(1);
    let mut g_all: Vec<Vec<usize>> = vec![Vec::new(); ng];
    let mut g_solid: Vec<Vec<usize>> = vec![Vec::new(); ng];
    let d_tris = input.detail.indices.len() / 3;
    for t in 0..d_tris {
        let g =
            (input.detail.tri_group.get(t).copied().unwrap_or(0)).clamp(0, ng as i32 - 1) as usize;
        g_all[g].push(t);
        if input.detail.floater.get(t).copied().unwrap_or(0) == 0 {
            g_solid[g].push(t);
        }
    }
    let mut detail_bvhs = Vec::with_capacity(ng);
    let mut detail_solid_bvhs = Vec::with_capacity(ng);
    for g in 0..ng {
        detail_bvhs.push(TriSoupBvh::build(
            &input.detail.positions,
            &input.detail.indices,
            Some(&g_all[g]),
        ));
        detail_solid_bvhs.push(TriSoupBvh::build(
            &input.detail.positions,
            &input.detail.indices,
            Some(&g_solid[g]),
        ));
    }

    // Tile-bin base triangles (32x32 tiles matching BAKE_TILE)
    const TILE: usize = 32;
    let tiles_x = w.div_ceil(TILE);
    let tiles_y = h.div_ceil(TILE);
    let mut bins: Vec<Vec<usize>> = vec![Vec::new(); tiles_x * tiles_y];
    let wf = w as f64;
    let hf = h as f64;

    for t in 0..base_tris {
        let i0 = (base_data.indices[t * 3] as usize) * 2;
        let i1 = (base_data.indices[t * 3 + 1] as usize) * 2;
        let i2 = (base_data.indices[t * 3 + 2] as usize) * 2;
        let u0 = (input.base_uvs[i0] as f64) * wf;
        let v0 = (input.base_uvs[i0 + 1] as f64) * hf;
        let u1 = (input.base_uvs[i1] as f64) * wf;
        let v1 = (input.base_uvs[i1 + 1] as f64) * hf;
        let u2 = (input.base_uvs[i2] as f64) * wf;
        let v2 = (input.base_uvs[i2 + 1] as f64) * hf;

        let min_x = (u0.min(u1).min(u2).floor() as isize).clamp(0, w as isize - 1) as usize;
        let max_x = (u0.max(u1).max(u2).floor() as isize).clamp(0, w as isize - 1) as usize;
        let min_y = (v0.min(v1).min(v2).floor() as isize).clamp(0, h as isize - 1) as usize;
        let max_y = (v0.max(v1).max(v2).floor() as isize).clamp(0, h as isize - 1) as usize;

        for ty in (min_y / TILE)..=(max_y / TILE) {
            for tx in (min_x / TILE)..=(max_x / TILE) {
                bins[ty * tiles_x + tx].push(t);
            }
        }
    }

    let mut weight = vec![0u32; texels];
    let mut island = vec![NONE; texels];
    let mut owner = vec![NONE; texels];

    let mut out_texel = Vec::new();
    let mut out_sample_idx = Vec::new();
    let mut out_group = Vec::new();
    let mut out_tri = Vec::new();
    let mut out_uv = Vec::new();
    let mut out_q = Vec::new();
    let mut out_nd = Vec::new();
    let mut out_base_n = Vec::new();
    let mut out_base_t = Vec::new();
    let mut out_height = Vec::new();
    let mut out_hit = Vec::new();
    let mut out_branch = Vec::new();

    let mut counters = BakeCorrespondCounters {
        ray_hits: 0,
        primary: 0,
        rescued: 0,
        extended: 0,
        nearest: 0,
        missed: 0,
        clipped: 0,
        covered_texels: 0,
    };

    // Build optional HardEdgeGrid for any Blend group
    let max_blend_r = input
        .groups
        .iter()
        .filter_map(|g| match g.direction {
            BakeDirection::Blend { distance } => Some(distance),
            _ => None,
        })
        .fold(0.0f64, f64::max);
    let hard_grid = if max_blend_r > 0.0 {
        let mut g = HardEdgeGrid::empty(max_blend_r);
        let mut edge_faces: HashMap<(u32, u32), (usize, i32)> = HashMap::new();
        for t in 0..base_tris {
            let tg = base_data.group[t];
            let fn_t = [
                base_data.face[t * 3],
                base_data.face[t * 3 + 1],
                base_data.face[t * 3 + 2],
            ];
            for k in 0..3 {
                let a = base_data.indices[t * 3 + k];
                let b = base_data.indices[t * 3 + (k + 1) % 3];
                let key = if a < b { (a, b) } else { (b, a) };
                if let Some((ot, og)) = edge_faces.get(&key) {
                    let fn_o = [
                        base_data.face[ot * 3],
                        base_data.face[ot * 3 + 1],
                        base_data.face[ot * 3 + 2],
                    ];
                    if *og != tg || dot(fn_t, fn_o) < 1.0 - 1e-6 {
                        g.add_segment(base_data.corner(t, k), base_data.corner(t, (k + 1) % 3));
                    }
                } else {
                    edge_faces.insert(key, (t, tg));
                }
            }
        }
        Some(g)
    } else {
        None
    };

    // Row-by-row rasterization with per-tile-row claimed bitmask (prevents duplicate hits inside overlapping seams)
    for ty in 0..tiles_y {
        let y0 = ty * TILE;
        let y1 = (y0 + TILE).min(h);
        let row_texels = (y1 - y0) * w;
        let mut claimed = vec![0u16; row_texels];

        for tx in 0..tiles_x {
            let bin = &bins[ty * tiles_x + tx];
            for &t in bin {
                let g = (base_data.group[t]).clamp(0, ng as i32 - 1) as usize;
                let g_cfg = &input.groups[g];
                let bvh = &detail_bvhs[g];

                let i0 = (base_data.indices[t * 3] as usize) * 2;
                let i1 = (base_data.indices[t * 3 + 1] as usize) * 2;
                let i2 = (base_data.indices[t * 3 + 2] as usize) * 2;
                let p0 = [
                    (input.base_uvs[i0] as f64) * wf,
                    (input.base_uvs[i0 + 1] as f64) * hf,
                ];
                let p1 = [
                    (input.base_uvs[i1] as f64) * wf,
                    (input.base_uvs[i1 + 1] as f64) * hf,
                ];
                let p2 = [
                    (input.base_uvs[i2] as f64) * wf,
                    (input.base_uvs[i2 + 1] as f64) * hf,
                ];
                let area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
                if area == 0.0 {
                    continue;
                }

                let xa = ((tx * TILE).max(p0[0].min(p1[0]).min(p2[0]).floor().max(0.0) as usize))
                    .min(w - 1);
                let xb = (((tx + 1) * TILE - 1)
                    .min(p0[0].max(p1[0]).max(p2[0]).floor().max(0.0) as usize))
                .min(w - 1);
                let ya = y0
                    .max(p0[1].min(p1[1]).min(p2[1]).floor().max(0.0) as usize)
                    .min(y1 - 1);
                let yb = (y1 - 1)
                    .min(p0[1].max(p1[1]).max(p2[1]).floor().max(0.0) as usize)
                    .min(y1 - 1);

                let ba = base_data.corner(t, 0);
                let bb = base_data.corner(t, 1);
                let bc = base_data.corner(t, 2);
                let n0_idx = (base_data.indices[t * 3] as usize) * 3;
                let n1_idx = (base_data.indices[t * 3 + 1] as usize) * 3;
                let n2_idx = (base_data.indices[t * 3 + 2] as usize) * 3;
                let bn0 = [
                    input.base_normals[n0_idx],
                    input.base_normals[n0_idx + 1],
                    input.base_normals[n0_idx + 2],
                ];
                let bn1 = [
                    input.base_normals[n1_idx],
                    input.base_normals[n1_idx + 1],
                    input.base_normals[n1_idx + 2],
                ];
                let bn2 = [
                    input.base_normals[n2_idx],
                    input.base_normals[n2_idx + 1],
                    input.base_normals[n2_idx + 2],
                ];

                for y in ya..=yb {
                    for x in xa..=xb {
                        let local = (y - y0) * w + x;
                        let texel = y * w + x;
                        for s in 0..per_texel {
                            if (claimed[local] & (1u16 << s)) != 0 {
                                continue;
                            }
                            let sx = (s % grid) as f64;
                            let sy = (s / grid) as f64;
                            let px = (x as f64) + (sx + 0.5) / (grid as f64);
                            let py = (y as f64) + (sy + 0.5) / (grid as f64);
                            let w1 = ((px - p0[0]) * (p2[1] - p0[1])
                                - (p2[0] - p0[0]) * (py - p0[1]))
                                / area;
                            let w2 = ((p1[0] - p0[0]) * (py - p0[1])
                                - (px - p0[0]) * (p1[1] - p0[1]))
                                / area;
                            let w0 = 1.0 - w1 - w2;
                            if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                                continue;
                            }
                            claimed[local] |= 1u16 << s;

                            let weights = [w0, w1, w2];
                            let pos = [
                                ba[0] * w0 + bb[0] * w1 + bc[0] * w2,
                                ba[1] * w0 + bb[1] * w1 + bc[1] * w2,
                                ba[2] * w0 + bb[2] * w1 + bc[2] * w2,
                            ];
                            let nrm = normalize([
                                bn0[0] * w0 + bn1[0] * w1 + bn2[0] * w2,
                                bn0[1] * w0 + bn1[1] * w1 + bn2[1] * w2,
                                bn0[2] * w0 + bn1[2] * w1 + bn2[2] * w2,
                            ]);
                            let nrm = if length(nrm) > 1e-12 {
                                nrm
                            } else {
                                [
                                    base_data.face[t * 3],
                                    base_data.face[t * 3 + 1],
                                    base_data.face[t * 3 + 2],
                                ]
                            };
                            let (tan, hand) = tangent_frame_of(
                                &input.base_tangents,
                                &base_data.indices,
                                t,
                                weights,
                                nrm,
                            );
                            let ray = base_data.ray_direction(
                                t,
                                weights,
                                g_cfg.direction,
                                pos,
                                hard_grid.as_ref(),
                            );
                            let origin = [
                                pos[0] + ray[0] * g_cfg.offset,
                                pos[1] + ray[1] * g_cfg.offset,
                                pos[2] + ray[2] * g_cfg.offset,
                            ];
                            let inward = [-ray[0], -ray[1], -ray[2]];

                            let mut resolved_tri = 0i32;
                            let mut resolved_u = 0.0f64;
                            let mut resolved_v = 0.0f64;
                            let mut resolved_q = pos;
                            let mut resolved_nd = nrm;
                            let mut resolved_h = 0.0f64;
                            let mut is_hit = false;
                            let mut branch = CorrespondBranch::Miss;

                            // 1. Primary raycast
                            let mut hit_opt =
                                bvh.raycast_filtered(origin, inward, 0.0, g_cfg.max_ray, |_| true);
                            if let Some(h1) = hit_opt {
                                let fn_d = input.detail.face_normal(h1.triangle);
                                let cos_f = dot(fn_d, ray);
                                if cos_f >= FACING_MIN {
                                    branch = CorrespondBranch::Primary;
                                    is_hit = true;
                                } else {
                                    // Rescue: try facing-filtered raycast
                                    if let Some(h2) = bvh.raycast_filtered(
                                        origin,
                                        inward,
                                        0.0,
                                        g_cfg.max_ray,
                                        |dt| dot(input.detail.face_normal(dt), ray) >= FACING_MIN,
                                    ) {
                                        hit_opt = Some(h2);
                                        branch = CorrespondBranch::Rescued;
                                        is_hit = true;
                                    } else if cos_f >= FACES_BASE_MIN {
                                        branch = CorrespondBranch::Primary;
                                        is_hit = true;
                                    } else {
                                        hit_opt = None;
                                    }
                                }
                            }

                            if let Some(hr) = hit_opt {
                                resolved_tri = hr.triangle as i32;
                                resolved_u = hr.u;
                                resolved_v = hr.v;
                                resolved_q = [
                                    origin[0] + inward[0] * hr.t,
                                    origin[1] + inward[1] * hr.t,
                                    origin[2] + inward[2] * hr.t,
                                ];
                                resolved_nd = input.detail.shading_normal(hr.triangle, hr.u, hr.v);
                                resolved_h = g_cfg.offset - hr.t;
                                counters.ray_hits += 1;
                                if g_cfg.clip_check && hr.t < g_cfg.offset * 0.01 {
                                    counters.clipped += 1;
                                }
                            } else {
                                // 2. Extended raycast within 2 * diagonal
                                let ext_max = (g_cfg.max_ray + EXTENDED_REACH * g_cfg.diagonal)
                                    .max(g_cfg.max_ray);
                                let ext_hit =
                                    bvh.raycast_filtered(origin, inward, 0.0, ext_max, |dt| {
                                        dot(input.detail.face_normal(dt), ray) >= FACING_MIN
                                    });
                                if let Some(hr) = ext_hit {
                                    branch = CorrespondBranch::Extended;
                                    is_hit = true;
                                    resolved_tri = hr.triangle as i32;
                                    resolved_u = hr.u;
                                    resolved_v = hr.v;
                                    resolved_q = [
                                        origin[0] + inward[0] * hr.t,
                                        origin[1] + inward[1] * hr.t,
                                        origin[2] + inward[2] * hr.t,
                                    ];
                                    resolved_nd =
                                        input.detail.shading_normal(hr.triangle, hr.u, hr.v);
                                    resolved_h = g_cfg.offset - hr.t;
                                } else if let Some(nr) = bvh
                                    .nearest_filtered(pos, f64::INFINITY, |dt| {
                                        dot(input.detail.face_normal(dt), ray) > FACES_BASE_MIN
                                    })
                                    .or_else(|| bvh.nearest_filtered(pos, f64::INFINITY, |_| true))
                                {
                                    // 3. Nearest-point fallback
                                    branch = CorrespondBranch::Nearest;
                                    resolved_tri = nr.triangle as i32;
                                    resolved_u = nr.u;
                                    resolved_v = nr.v;
                                    let dt = nr.triangle;
                                    let di0 = (input.detail.indices[dt * 3] as usize) * 3;
                                    let di1 = (input.detail.indices[dt * 3 + 1] as usize) * 3;
                                    let di2 = (input.detail.indices[dt * 3 + 2] as usize) * 3;
                                    let w0_d = 1.0 - nr.u - nr.v;
                                    resolved_q = [
                                        w0_d * input.detail.positions[di0]
                                            + nr.u * input.detail.positions[di1]
                                            + nr.v * input.detail.positions[di2],
                                        w0_d * input.detail.positions[di0 + 1]
                                            + nr.u * input.detail.positions[di1 + 1]
                                            + nr.v * input.detail.positions[di2 + 1],
                                        w0_d * input.detail.positions[di0 + 2]
                                            + nr.u * input.detail.positions[di1 + 2]
                                            + nr.v * input.detail.positions[di2 + 2],
                                    ];
                                    resolved_nd = input.detail.shading_normal(dt, nr.u, nr.v);
                                    resolved_h = dot(sub(resolved_q, pos), ray);
                                    is_hit = false;
                                }
                            }

                            match branch {
                                CorrespondBranch::Primary => counters.primary += 1,
                                CorrespondBranch::Rescued => counters.rescued += 1,
                                CorrespondBranch::Extended => counters.extended += 1,
                                CorrespondBranch::Nearest => counters.nearest += 1,
                                CorrespondBranch::Miss => counters.missed += 1,
                            }

                            out_texel.push(texel as u32);
                            out_sample_idx.push((texel * 16 + s) as u32);
                            out_group.push(g as i32);
                            out_tri.push(resolved_tri);
                            out_uv.push(resolved_u as f32);
                            out_uv.push(resolved_v as f32);
                            out_q.extend_from_slice(&[
                                resolved_q[0] as f32,
                                resolved_q[1] as f32,
                                resolved_q[2] as f32,
                            ]);
                            out_nd.extend_from_slice(&[
                                resolved_nd[0] as f32,
                                resolved_nd[1] as f32,
                                resolved_nd[2] as f32,
                            ]);
                            out_base_n.extend_from_slice(&[
                                nrm[0] as f32,
                                nrm[1] as f32,
                                nrm[2] as f32,
                            ]);
                            out_base_t.extend_from_slice(&[
                                tan[0] as f32,
                                tan[1] as f32,
                                tan[2] as f32,
                                hand as f32,
                            ]);
                            out_height.push(resolved_h as f32);
                            out_hit.push(if is_hit { 1 } else { 0 });
                            out_branch.push(branch as u8);

                            weight[texel] += 1;
                            if island[texel] == NONE {
                                let isl = input.base_tri_island.get(t).copied().unwrap_or(0);
                                island[texel] = isl;
                                owner[texel] = isl;
                            }
                        }
                    }
                }
            }
        }
    }

    for &wt in &weight {
        if wt > 0 {
            counters.covered_texels += 1;
        }
    }
    if counters.covered_texels == 0 {
        return Err(KernelError::invalid_value(
            "uv0",
            "base uv0 covers zero texels in [0, 1]",
        ));
    }

    let count = out_texel.len();
    let group_diagonals = input.groups.iter().map(|g| g.diagonal).collect();
    Ok(BakeCorrespondenceData {
        width: input.width,
        height: input.height,
        samples_per_axis: input.samples_per_axis,
        count,
        texel: out_texel,
        sample_idx: out_sample_idx,
        group: out_group,
        tri: out_tri,
        uv: out_uv,
        q: out_q,
        nd: out_nd,
        base_normal: out_base_n,
        base_tangent: out_base_t,
        sample_height: out_height,
        hit: out_hit,
        branch: out_branch,
        weight,
        island,
        owner,
        counters,
        detail: input.detail,
        detail_bvhs,
        detail_solid_bvhs,
        group_diagonals,
    })
}
