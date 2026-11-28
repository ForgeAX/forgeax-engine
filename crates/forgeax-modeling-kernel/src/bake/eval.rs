//! Multi-map PBR evaluation from stored `BakeCorrespondenceData` records:
//! computes normal, normalObject, ao, bent normal, thickness, height, position,
//! curvature (vertex or texture-space Sobel), edgeWear, cavity, ormh, baseColor,
//! emissive, materialId, opacity, crease-aware spline prefiltering, AO denoising,
//! and chart-aware UV atlas gutter dilation.

use crate::error::KernelError;
use crate::mesh::geom::{cross, dot, normalize, sub, Vec3};
use crate::surface::atlas::{
    atlas_bleed_report, dilate_atlas, AtlasBleedReport, AtlasBufferMut, AtlasGrid,
};
use crate::surface::buffer::ImageBuffer;

use super::correspond::BakeCorrespondenceData;

pub const MATERIAL_ID_PALETTE: [[f32; 3]; 8] = [
    [0.9, 0.12, 0.1],
    [0.1, 0.65, 0.15],
    [0.12, 0.25, 0.9],
    [0.95, 0.8, 0.1],
    [0.75, 0.15, 0.8],
    [0.1, 0.8, 0.8],
    [0.95, 0.45, 0.1],
    [0.5, 0.5, 0.5],
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BakeMapKind {
    Normal = 0,
    NormalObject = 1,
    Ao = 2,
    Height = 3,
    Position = 4,
    Curvature = 5,
    EdgeWear = 6,
    Cavity = 7,
    Ormh = 8,
    BaseColor = 9,
    Emissive = 10,
    MaterialId = 11,
    Thickness = 12,
    Opacity = 13,
}

impl BakeMapKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Normal),
            1 => Some(Self::NormalObject),
            2 => Some(Self::Ao),
            3 => Some(Self::Height),
            4 => Some(Self::Position),
            5 => Some(Self::Curvature),
            6 => Some(Self::EdgeWear),
            7 => Some(Self::Cavity),
            8 => Some(Self::Ormh),
            9 => Some(Self::BaseColor),
            10 => Some(Self::Emissive),
            11 => Some(Self::MaterialId),
            12 => Some(Self::Thickness),
            13 => Some(Self::Opacity),
            _ => None,
        }
    }

    pub fn is_curvature_family(self) -> bool {
        matches!(self, Self::Curvature | Self::EdgeWear | Self::Cavity)
    }
}

#[derive(Debug, Clone)]
pub struct BakeSlotSpec {
    pub base_color: [f32; 4],
    pub roughness: f32,
    pub metallic: f32,
    pub emissive: [f32; 3],
}

impl Default for BakeSlotSpec {
    fn default() -> Self {
        Self {
            base_color: [1.0, 1.0, 1.0, 1.0],
            roughness: 0.5,
            metallic: 0.0,
            emissive: [0.0, 0.0, 0.0],
        }
    }
}

#[derive(Debug, Clone)]
pub struct BakeEvalOptions {
    pub maps: Vec<BakeMapKind>,
    pub slots: Vec<BakeSlotSpec>,
    pub fallback_slot: BakeSlotSpec,
    pub gutter: u32,
    pub ao_samples: u32,
    pub ao_cone: f64,
    pub ao_distance: Option<f64>,
    pub ao_bias: f64,
    pub ao_denoise: bool,
    pub texture_curvature: bool,
    pub spline_filter: bool,
    pub thickness_samples: u32,
    pub thickness_distance: Option<f64>,
    pub edge_wear_range: [f32; 2],
    pub edge_wear_noise_scale: f32,
    pub edge_wear_noise_amount: f32,
    pub edge_wear_noise_seed: u32,
    pub cavity_range: [f32; 2],
    pub height_range: Option<[f32; 2]>,
    pub wrap_u: bool,
    pub wrap_v: bool,
}

impl Default for BakeEvalOptions {
    fn default() -> Self {
        Self {
            maps: vec![BakeMapKind::Normal, BakeMapKind::Ao],
            slots: Vec::new(),
            fallback_slot: BakeSlotSpec::default(),
            gutter: 8,
            ao_samples: 16,
            ao_cone: 0.0,
            ao_distance: None,
            ao_bias: 1e-4,
            ao_denoise: false,
            texture_curvature: true,
            spline_filter: false,
            thickness_samples: 8,
            thickness_distance: None,
            edge_wear_range: [0.15, 0.6],
            edge_wear_noise_scale: 8.0,
            edge_wear_noise_amount: 0.0,
            edge_wear_noise_seed: 1,
            cavity_range: [0.1, 0.5],
            height_range: None,
            wrap_u: false,
            wrap_v: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EvaluatedBakeResult {
    pub buffers: Vec<(BakeMapKind, ImageBuffer)>,
    pub curvature_range: f32,
    pub height_range: [f32; 2],
    pub position_min: [f32; 3],
    pub position_max: [f32; 3],
    pub bleed: AtlasBleedReport,
}

#[inline]
fn radical_inverse(mut bits: u32) -> f64 {
    bits = bits.rotate_right(16);
    bits = ((bits & 0x5555_5555) << 1) | ((bits & 0xaaaa_aaaa) >> 1);
    bits = ((bits & 0x3333_3333) << 2) | ((bits & 0xcccc_cccc) >> 2);
    bits = ((bits & 0x0f0f_0f0f) << 4) | ((bits & 0xf0f0_f0f0) >> 4);
    bits = ((bits & 0x00ff_00ff) << 8) | ((bits & 0xff00_ff00) >> 8);
    (bits as f64) / 4294967296.0
}

#[inline]
fn hash2(x: u32, y: u32) -> f64 {
    let mut h = x.wrapping_mul(0x27d4_eb2d) ^ y.wrapping_mul(0x1656_67b1);
    h = (h ^ (h >> 15)).wrapping_mul(0x85eb_ca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2_ae35);
    ((h ^ (h >> 16)) as f64) / 4294967296.0
}

#[inline]
fn hash3(x: i32, y: i32, z: i32, seed: u32) -> f64 {
    let mut h = (x as u32).wrapping_mul(0x27d4_eb2d)
        ^ (y as u32).wrapping_mul(0x1656_67b1)
        ^ (z as u32).wrapping_mul(0x85eb_ca6b)
        ^ seed.wrapping_mul(0xc2b2_ae35);
    h = (h ^ (h >> 15)).wrapping_mul(0x27d4_eb2d);
    h = (h ^ (h >> 13)).wrapping_mul(0x1656_67b1);
    ((h ^ (h >> 16)) as f64) / 4294967296.0
}

fn value_noise3(p: [f64; 3], scale: f64, seed: u32) -> f64 {
    let x = p[0] * scale;
    let y = p[1] * scale;
    let z = p[2] * scale;
    let ix = x.floor() as i32;
    let iy = y.floor() as i32;
    let iz = z.floor() as i32;
    let fx = x - (ix as f64);
    let fy = y - (iy as f64);
    let fz = z - (iz as f64);
    let u = fx * fx * (3.0 - 2.0 * fx);
    let v = fy * fy * (3.0 - 2.0 * fy);
    let w = fz * fz * (3.0 - 2.0 * fz);
    let c000 = hash3(ix, iy, iz, seed);
    let c100 = hash3(ix + 1, iy, iz, seed);
    let c010 = hash3(ix, iy + 1, iz, seed);
    let c110 = hash3(ix + 1, iy + 1, iz, seed);
    let c001 = hash3(ix, iy, iz + 1, seed);
    let c101 = hash3(ix + 1, iy, iz + 1, seed);
    let c011 = hash3(ix, iy + 1, iz + 1, seed);
    let c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
    let x00 = c000 + (c100 - c000) * u;
    let x10 = c010 + (c110 - c010) * u;
    let x01 = c001 + (c101 - c001) * u;
    let x11 = c011 + (c111 - c011) * u;
    let y0 = x00 + (x10 - x00) * v;
    let y1 = x01 + (x11 - x01) * v;
    y0 + (y1 - y0) * w
}

fn build_cone_rays(count: u32, cone: f64) -> Vec<Vec3> {
    let n = count.max(1) as usize;
    let mut rays = Vec::with_capacity(n);
    let sin_limit = (1.0 - cone * cone).max(0.0);
    for k in 0..n {
        let u = ((k as f64) + 0.5) / (n as f64);
        let r = (u * sin_limit).sqrt();
        let z = (1.0 - r * r).max(0.0).sqrt();
        let phi = std::f64::consts::TAU * radical_inverse(k as u32);
        rays.push([r * phi.cos(), r * phi.sin(), z]);
    }
    rays
}

#[inline]
fn ortho_basis(n: Vec3) -> (Vec3, Vec3) {
    let ref_v = if n[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let t = normalize(cross(ref_v, n));
    let b = cross(n, t);
    (t, b)
}

#[inline]
fn smoothstep(lo: f32, hi: f32, x: f32) -> f32 {
    let t = ((x - lo) / (hi - lo).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn map_background(kind: BakeMapKind, fallback: &BakeSlotSpec) -> [f32; 4] {
    match kind {
        BakeMapKind::Normal | BakeMapKind::NormalObject => [0.5, 0.5, 1.0, 1.0],
        BakeMapKind::Ao | BakeMapKind::Thickness => [1.0, 1.0, 1.0, 1.0],
        BakeMapKind::Opacity => [0.0, 0.0, 0.0, 0.0],
        BakeMapKind::Ormh => [1.0, fallback.roughness, fallback.metallic, 0.5],
        BakeMapKind::BaseColor => fallback.base_color,
        BakeMapKind::Emissive
        | BakeMapKind::Cavity
        | BakeMapKind::EdgeWear
        | BakeMapKind::MaterialId => [0.0, 0.0, 0.0, 1.0],
        BakeMapKind::Height | BakeMapKind::Curvature | BakeMapKind::Position => {
            [0.5, 0.5, 0.5, 1.0]
        }
    }
}

pub fn evaluate_bake_maps(
    corr: &BakeCorrespondenceData,
    opts: &BakeEvalOptions,
) -> Result<EvaluatedBakeResult, KernelError> {
    if opts.maps.is_empty() {
        return Err(KernelError::invalid_value(
            "maps",
            "at least one BakeMapKind is required",
        ));
    }
    let w = corr.width as usize;
    let h = corr.height as usize;
    let texels = w * h;
    let want_ao = opts
        .maps
        .iter()
        .any(|m| matches!(m, BakeMapKind::Ao | BakeMapKind::Ormh));
    let want_thick = opts.maps.contains(&BakeMapKind::Thickness);
    let want_curv = opts.maps.iter().any(|m| m.is_curvature_family());
    let need_tex_curv = want_curv && opts.texture_curvature;
    let opacity_idx = opts.maps.iter().position(|m| *m == BakeMapKind::Opacity);

    // Determine global position bounds & height range from correspondence hits
    let mut pos_min = [f32::INFINITY; 3];
    let mut pos_max = [f32::NEG_INFINITY; 3];
    let mut h_min = f32::INFINITY;
    let mut h_max = f32::NEG_INFINITY;
    for k in 0..corr.count {
        let q = &corr.q[k * 3..k * 3 + 3];
        for c in 0..3 {
            pos_min[c] = pos_min[c].min(q[c]);
            pos_max[c] = pos_max[c].max(q[c]);
        }
        let hv = corr.sample_height[k];
        h_min = h_min.min(hv);
        h_max = h_max.max(hv);
    }
    if !pos_min[0].is_finite() {
        pos_min = [0.0; 3];
        pos_max = [1.0; 3];
    }
    let height_range = opts.height_range.unwrap_or_else(|| {
        if !h_min.is_finite() || (h_max - h_min).abs() < 1e-6 {
            [-0.1, 0.1]
        } else {
            [h_min, h_max]
        }
    });

    let ao_rays = if want_ao {
        build_cone_rays(opts.ao_samples.max(1), opts.ao_cone)
    } else {
        Vec::new()
    };
    let thick_rays = if want_thick {
        build_cone_rays(opts.thickness_samples.max(1), 0.2)
    } else {
        Vec::new()
    };

    let mut sums: Vec<Vec<f64>> = opts.maps.iter().map(|_| vec![0.0f64; texels * 4]).collect();
    let mut point_sum = if need_tex_curv {
        vec![0.0f64; texels * 3]
    } else {
        Vec::new()
    };
    let mut normal_sum = if need_tex_curv {
        vec![0.0f64; texels * 3]
    } else {
        Vec::new()
    };
    let mut hits = if opacity_idx.is_some() {
        vec![0u32; texels]
    } else {
        Vec::new()
    };

    let mat_idx = opts.maps.iter().position(|m| *m == BakeMapKind::MaterialId);
    let mut mat_written = if mat_idx.is_some() {
        vec![false; texels]
    } else {
        Vec::new()
    };

    for k in 0..corr.count {
        let texel = corr.texel[k] as usize;
        let is_hit = corr.hit[k] != 0;
        let opaque = opacity_idx.is_none() || is_hit;
        if opacity_idx.is_some() && opaque {
            hits[texel] += 1;
        }
        let tri = corr.tri[k].max(0) as usize;
        let u = corr.uv[k * 2] as f64;
        let v = corr.uv[k * 2 + 1] as f64;
        let w0 = 1.0 - u - v;
        let q = [
            corr.q[k * 3] as f64,
            corr.q[k * 3 + 1] as f64,
            corr.q[k * 3 + 2] as f64,
        ];
        let nd = [
            corr.nd[k * 3] as f64,
            corr.nd[k * 3 + 1] as f64,
            corr.nd[k * 3 + 2] as f64,
        ];
        let bn = [
            corr.base_normal[k * 3] as f64,
            corr.base_normal[k * 3 + 1] as f64,
            corr.base_normal[k * 3 + 2] as f64,
        ];
        let bt = [
            corr.base_tangent[k * 4] as f64,
            corr.base_tangent[k * 4 + 1] as f64,
            corr.base_tangent[k * 4 + 2] as f64,
        ];
        let hand = corr.base_tangent[k * 4 + 3] as f64;
        let grp = (corr.group[k].max(0) as usize).min(corr.detail_bvhs.len().saturating_sub(1));
        let slot_idx = corr.detail.tri_slot.get(tri).copied().unwrap_or(0).max(0) as usize;
        let slot = opts.slots.get(slot_idx).unwrap_or(&opts.fallback_slot);

        let ao_val = if want_ao && opaque {
            let bvh = &corr.detail_solid_bvhs[grp];
            let diag = corr.group_diagonals.get(grp).copied().unwrap_or(1.0);
            let max_d = opts
                .ao_distance
                .unwrap_or_else(|| (0.1 * diag).min(0.5))
                .max(1e-4);
            let bias = opts.ao_bias.max(1e-6);
            let origin = [
                q[0] + nd[0] * bias,
                q[1] + nd[1] * bias,
                q[2] + nd[2] * bias,
            ];
            let (t_ax, b_ax) = ortho_basis(nd);
            let rot = hash2(corr.sample_idx[k], 0) * std::f64::consts::TAU;
            let cr = rot.cos();
            let sr = rot.sin();
            let mut occ = 0usize;
            for &lr in &ao_rays {
                let rx = lr[0] * cr - lr[1] * sr;
                let ry = lr[0] * sr + lr[1] * cr;
                let dir = normalize([
                    t_ax[0] * rx + b_ax[0] * ry + nd[0] * lr[2],
                    t_ax[1] * rx + b_ax[1] * ry + nd[1] * lr[2],
                    t_ax[2] * rx + b_ax[2] * ry + nd[2] * lr[2],
                ]);
                if bvh.is_occluded_filtered(origin, dir, bias, max_d, |dt| dt != tri) {
                    occ += 1;
                }
            }
            1.0 - (occ as f64) / (ao_rays.len().max(1) as f64)
        } else {
            1.0
        };

        let thick_val = if want_thick && opaque {
            let bvh = &corr.detail_bvhs[grp];
            let diag = corr.group_diagonals.get(grp).copied().unwrap_or(1.0);
            let max_d = opts.thickness_distance.unwrap_or(0.1 * diag).max(1e-4);
            let bias = opts.ao_bias.max(1e-6);
            let neg_nd = [-nd[0], -nd[1], -nd[2]];
            let origin = [
                q[0] + neg_nd[0] * bias,
                q[1] + neg_nd[1] * bias,
                q[2] + neg_nd[2] * bias,
            ];
            let (t_ax, b_ax) = ortho_basis(neg_nd);
            let mut sum_t = 0.0f64;
            let mut cnt = 0usize;
            for &lr in &thick_rays {
                let dir = normalize([
                    t_ax[0] * lr[0] + b_ax[0] * lr[1] + neg_nd[0] * lr[2],
                    t_ax[1] * lr[0] + b_ax[1] * lr[1] + neg_nd[1] * lr[2],
                    t_ax[2] * lr[0] + b_ax[2] * lr[1] + neg_nd[2] * lr[2],
                ]);
                if let Some(rh) = bvh.raycast_filtered(origin, dir, bias, max_d, |dt| dt != tri) {
                    sum_t += rh.t.min(max_d);
                    cnt += 1;
                }
            }
            if cnt > 0 {
                (sum_t / (cnt as f64)) / max_d
            } else {
                1.0
            }
        } else {
            1.0
        };

        let mut sample_curv = 0.0f64;
        if want_curv && !opts.texture_curvature && opaque && !corr.detail.vert_curvature.is_empty()
        {
            let di0 = corr.detail.indices[tri * 3] as usize;
            let di1 = corr.detail.indices[tri * 3 + 1] as usize;
            let di2 = corr.detail.indices[tri * 3 + 2] as usize;
            let c0 = corr.detail.vert_curvature.get(di0).copied().unwrap_or(0.0) as f64;
            let c1 = corr.detail.vert_curvature.get(di1).copied().unwrap_or(0.0) as f64;
            let c2 = corr.detail.vert_curvature.get(di2).copied().unwrap_or(0.0) as f64;
            sample_curv = w0 * c0 + u * c1 + v * c2;
        }

        if need_tex_curv && opaque {
            point_sum[texel * 3] += q[0];
            point_sum[texel * 3 + 1] += q[1];
            point_sum[texel * 3 + 2] += q[2];
            normal_sum[texel * 3] += nd[0];
            normal_sum[texel * 3 + 1] += nd[1];
            normal_sum[texel * 3 + 2] += nd[2];
        }

        for (mi, &kind) in opts.maps.iter().enumerate() {
            if !opaque && kind != BakeMapKind::Opacity {
                continue;
            }
            let sum = &mut sums[mi];
            let o = texel * 4;
            match kind {
                BakeMapKind::Normal => {
                    let b = cross(bn, bt);
                    let bitan = [b[0] * hand, b[1] * hand, b[2] * hand];
                    let ts = normalize([dot(nd, bt), dot(nd, bitan), dot(nd, bn)]);
                    sum[o] += ts[0];
                    sum[o + 1] += ts[1];
                    sum[o + 2] += ts[2];
                    sum[o + 3] += 1.0;
                }
                BakeMapKind::NormalObject => {
                    sum[o] += nd[0];
                    sum[o + 1] += nd[1];
                    sum[o + 2] += nd[2];
                    sum[o + 3] += 1.0;
                }
                BakeMapKind::Ao => {
                    sum[o] += ao_val;
                    sum[o + 1] += ao_val;
                    sum[o + 2] += ao_val;
                    sum[o + 3] += 1.0;
                }
                BakeMapKind::Height => {
                    let hv = corr.sample_height[k] as f64;
                    sum[o] += hv;
                    sum[o + 1] += hv;
                    sum[o + 2] += hv;
                    sum[o + 3] += 1.0;
                }
                BakeMapKind::Position => {
                    sum[o] += q[0];
                    sum[o + 1] += q[1];
                    sum[o + 2] += q[2];
                    sum[o + 3] += 1.0;
                }
                BakeMapKind::Curvature | BakeMapKind::EdgeWear | BakeMapKind::Cavity => {
                    sum[o] += sample_curv;
                    sum[o + 1] += q[0];
                    sum[o + 2] += q[1];
                    sum[o + 3] += q[2];
                }
                BakeMapKind::Ormh => {
                    sum[o] += ao_val;
                    sum[o + 1] += slot.roughness as f64;
                    sum[o + 2] += slot.metallic as f64;
                    sum[o + 3] += corr.sample_height[k] as f64;
                }
                BakeMapKind::BaseColor => {
                    let mut bc = slot.base_color;
                    if corr.detail.has_corner_colors
                        && corr.detail.corner_colors.len() >= (tri + 1) * 12
                    {
                        let cb = tri * 12;
                        for ch in 0..4 {
                            bc[ch] *= (w0 * (corr.detail.corner_colors[cb + ch] as f64)
                                + u * (corr.detail.corner_colors[cb + 4 + ch] as f64)
                                + v * (corr.detail.corner_colors[cb + 8 + ch] as f64))
                                as f32;
                        }
                    }
                    sum[o] += bc[0] as f64;
                    sum[o + 1] += bc[1] as f64;
                    sum[o + 2] += bc[2] as f64;
                    sum[o + 3] += bc[3] as f64;
                }
                BakeMapKind::Emissive => {
                    sum[o] += slot.emissive[0] as f64;
                    sum[o + 1] += slot.emissive[1] as f64;
                    sum[o + 2] += slot.emissive[2] as f64;
                    sum[o + 3] += 1.0;
                }
                BakeMapKind::MaterialId => {
                    if !mat_written[texel] {
                        mat_written[texel] = true;
                        let pal = MATERIAL_ID_PALETTE[slot_idx % MATERIAL_ID_PALETTE.len()];
                        sum[o] = pal[0] as f64;
                        sum[o + 1] = pal[1] as f64;
                        sum[o + 2] = pal[2] as f64;
                        sum[o + 3] = 1.0;
                    }
                }
                BakeMapKind::Thickness => {
                    sum[o] += thick_val;
                    sum[o + 1] += thick_val;
                    sum[o + 2] += thick_val;
                    sum[o + 3] += 1.0;
                }
                BakeMapKind::Opacity => {
                    let op = if is_hit { 1.0 } else { 0.0 };
                    sum[o] += op;
                    sum[o + 1] += op;
                    sum[o + 2] += op;
                    sum[o + 3] += op;
                }
            }
        }
    }

    // Divide per-texel sample sums by sample weight
    let mut tex_weight = vec![0.0f64; texels];
    for t in 0..texels {
        let wt = if opacity_idx.is_some() {
            hits[t]
        } else {
            corr.weight[t]
        };
        tex_weight[t] = wt as f64;
        if wt == 0 {
            continue;
        }
        let inv = 1.0 / (wt as f64);
        for (mi, &kind) in opts.maps.iter().enumerate() {
            if kind == BakeMapKind::MaterialId {
                continue;
            }
            let denom = if kind == BakeMapKind::Opacity {
                corr.weight[t].max(1) as f64
            } else {
                1.0 / inv
            };
            let inv_k = 1.0 / denom;
            let sum = &mut sums[mi];
            let o = t * 4;
            sum[o] *= inv_k;
            sum[o + 1] *= inv_k;
            sum[o + 2] *= inv_k;
            sum[o + 3] *= inv_k;
        }
        if need_tex_curv {
            point_sum[t * 3] *= inv;
            point_sum[t * 3 + 1] *= inv;
            point_sum[t * 3 + 2] *= inv;
            let n = normalize([
                normal_sum[t * 3],
                normal_sum[t * 3 + 1],
                normal_sum[t * 3 + 2],
            ]);
            normal_sum[t * 3] = n[0];
            normal_sum[t * 3 + 1] = n[1];
            normal_sum[t * 3 + 2] = n[2];
        }
    }

    // Texture-space Sobel finite-difference curvature when requested
    if need_tex_curv {
        let mut raw_curv = vec![0.0f64; texels];
        for y in 0..h {
            for x in 0..w {
                let c = y * w + x;
                if tex_weight[c] <= 0.0 {
                    continue;
                }
                let isl = corr.island[c];
                let sample_diff = |nx: isize, ny: isize| -> Option<(Vec3, Vec3)> {
                    if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                        return None;
                    }
                    let j = (ny as usize) * w + (nx as usize);
                    if tex_weight[j] <= 0.0 || corr.island[j] != isl {
                        return None;
                    }
                    Some((
                        [point_sum[j * 3], point_sum[j * 3 + 1], point_sum[j * 3 + 2]],
                        [
                            normal_sum[j * 3],
                            normal_sum[j * 3 + 1],
                            normal_sum[j * 3 + 2],
                        ],
                    ))
                };
                let pc = [point_sum[c * 3], point_sum[c * 3 + 1], point_sum[c * 3 + 2]];
                let nc = [
                    normal_sum[c * 3],
                    normal_sum[c * 3 + 1],
                    normal_sum[c * 3 + 2],
                ];
                let mut acc = 0.0f64;
                let mut count = 0usize;
                for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                    if let Some((pn, nn)) = sample_diff(x as isize + dx, y as isize + dy) {
                        let d = sub(pn, pc);
                        let d2 = dot(d, d);
                        if d2 > 1e-18 {
                            acc += 2.0 * dot(sub(nn, nc), d) / d2;
                            count += 1;
                        }
                    }
                }
                if count > 0 {
                    raw_curv[c] = acc / (count as f64);
                }
            }
        }
        for (mi, &kind) in opts.maps.iter().enumerate() {
            if !kind.is_curvature_family() {
                continue;
            }
            for t in 0..texels {
                if tex_weight[t] > 0.0 {
                    sums[mi][t * 4] = raw_curv[t];
                    sums[mi][t * 4 + 1] = point_sum[t * 3];
                    sums[mi][t * 4 + 2] = point_sum[t * 3 + 1];
                    sums[mi][t * 4 + 3] = point_sum[t * 3 + 2];
                }
            }
        }
    }

    // Curvature 95th-percentile normalization scale
    let mut curvature_range = 1.0f32;
    if let Some((ci, _)) = opts
        .maps
        .iter()
        .enumerate()
        .find(|(_, k)| k.is_curvature_family())
    {
        let mut mags: Vec<f64> = Vec::new();
        for t in 0..texels {
            if tex_weight[t] > 0.0 {
                mags.push(sums[ci][t * 4].abs());
            }
        }
        if !mags.is_empty() {
            mags.sort_by(|a, b| a.total_cmp(b));
            let p95 = mags[((mags.len() - 1) as f64 * 0.95).floor() as usize];
            if p95 > 0.0 {
                curvature_range = p95 as f32;
            }
        }
    }

    // Convert into f32 ImageBuffers in [0, 1]
    let h_span = (height_range[1] - height_range[0]).max(1e-6);
    let inv_h_span = 1.0 / h_span;
    let p_ext = [
        (pos_max[0] - pos_min[0]).max(1e-6),
        (pos_max[1] - pos_min[1]).max(1e-6),
        (pos_max[2] - pos_min[2]).max(1e-6),
    ];
    let inv_c_range = 1.0f32 / curvature_range.max(1e-6);

    let mut out_imgs: Vec<(BakeMapKind, Vec<f32>)> = opts
        .maps
        .iter()
        .map(|&k| (k, vec![0.0f32; texels * 4]))
        .collect();

    for (mi, (kind, buf)) in out_imgs.iter_mut().enumerate() {
        let sum = &sums[mi];
        let bg = map_background(*kind, &opts.fallback_slot);
        for t in 0..texels {
            let o = t * 4;
            if tex_weight[t] <= 0.0 {
                buf[o] = bg[0];
                buf[o + 1] = bg[1];
                buf[o + 2] = bg[2];
                buf[o + 3] = bg[3];
                continue;
            }
            match kind {
                BakeMapKind::Normal | BakeMapKind::NormalObject => {
                    let nx = sum[o];
                    let ny = sum[o + 1];
                    let nz = sum[o + 2];
                    let len = (nx * nx + ny * ny + nz * nz).sqrt();
                    if len > 0.0 {
                        let inv = 0.5 / len;
                        buf[o] = (nx * inv + 0.5) as f32;
                        buf[o + 1] = (ny * inv + 0.5) as f32;
                        buf[o + 2] = (nz * inv + 0.5) as f32;
                    } else {
                        buf[o] = 0.5;
                        buf[o + 1] = 0.5;
                        buf[o + 2] = if *kind == BakeMapKind::Normal {
                            1.0
                        } else {
                            0.5
                        };
                    }
                    buf[o + 3] = 1.0;
                }
                BakeMapKind::Height => {
                    let v = (((sum[o] as f32) - height_range[0]) * inv_h_span).clamp(0.0, 1.0);
                    buf[o] = v;
                    buf[o + 1] = v;
                    buf[o + 2] = v;
                    buf[o + 3] = 1.0;
                }
                BakeMapKind::Position => {
                    buf[o] = (((sum[o] as f32) - pos_min[0]) / p_ext[0]).clamp(0.0, 1.0);
                    buf[o + 1] = (((sum[o + 1] as f32) - pos_min[1]) / p_ext[1]).clamp(0.0, 1.0);
                    buf[o + 2] = (((sum[o + 2] as f32) - pos_min[2]) / p_ext[2]).clamp(0.0, 1.0);
                    buf[o + 3] = 1.0;
                }
                BakeMapKind::Curvature => {
                    let k = ((sum[o] as f32) * inv_c_range).clamp(-1.0, 1.0) * 0.5 + 0.5;
                    buf[o] = k;
                    buf[o + 1] = k;
                    buf[o + 2] = k;
                    buf[o + 3] = 1.0;
                }
                BakeMapKind::EdgeWear => {
                    let k_pos = ((sum[o] as f32) * inv_c_range).clamp(0.0, 1.0);
                    let mut mask =
                        smoothstep(opts.edge_wear_range[0], opts.edge_wear_range[1], k_pos);
                    if opts.edge_wear_noise_amount > 0.0 {
                        let p = [sum[o + 1], sum[o + 2], sum[o + 3]];
                        let n = value_noise3(
                            p,
                            opts.edge_wear_noise_scale as f64,
                            opts.edge_wear_noise_seed,
                        ) as f32;
                        mask = (mask * (1.0 - opts.edge_wear_noise_amount * (1.0 - n)))
                            .clamp(0.0, 1.0);
                    }
                    buf[o] = mask;
                    buf[o + 1] = mask;
                    buf[o + 2] = mask;
                    buf[o + 3] = 1.0;
                }
                BakeMapKind::Cavity => {
                    let k_neg = (-(sum[o] as f32) * inv_c_range).clamp(0.0, 1.0);
                    let c = 1.0 - smoothstep(opts.cavity_range[0], opts.cavity_range[1], k_neg);
                    buf[o] = c;
                    buf[o + 1] = c;
                    buf[o + 2] = c;
                    buf[o + 3] = 1.0;
                }
                BakeMapKind::Ormh => {
                    buf[o] = (sum[o] as f32).clamp(0.0, 1.0);
                    buf[o + 1] = (sum[o + 1] as f32).clamp(0.0, 1.0);
                    buf[o + 2] = (sum[o + 2] as f32).clamp(0.0, 1.0);
                    buf[o + 3] =
                        (((sum[o + 3] as f32) - height_range[0]) * inv_h_span).clamp(0.0, 1.0);
                }
                BakeMapKind::Ao
                | BakeMapKind::BaseColor
                | BakeMapKind::Emissive
                | BakeMapKind::MaterialId
                | BakeMapKind::Thickness
                | BakeMapKind::Opacity => {
                    buf[o] = (sum[o] as f32).clamp(0.0, 1.0);
                    buf[o + 1] = (sum[o + 1] as f32).clamp(0.0, 1.0);
                    buf[o + 2] = (sum[o + 2] as f32).clamp(0.0, 1.0);
                    buf[o + 3] = (sum[o + 3] as f32).clamp(0.0, 1.0);
                }
            }
        }
    }

    // Optional chart-aware gutter dilation via surface::atlas
    let mut covered: Vec<u8> = corr
        .weight
        .iter()
        .map(|&wt| if wt > 0 { 1 } else { 0 })
        .collect();
    let chart_mask = covered.clone();
    let mut owner = corr.owner.clone();
    let frame = corr.island.clone();
    let grid = AtlasGrid {
        width: corr.width,
        height: corr.height,
        wrap_u: opts.wrap_u,
        wrap_v: opts.wrap_v,
    };

    if opts.gutter > 0 {
        let mut atlas_bufs: Vec<AtlasBufferMut<'_>> = out_imgs
            .iter_mut()
            .map(|(k, data)| AtlasBufferMut {
                data: data.as_mut_slice(),
                categorical: *k == BakeMapKind::MaterialId,
            })
            .collect();
        dilate_atlas(
            &mut atlas_bufs,
            &mut covered,
            &mut owner,
            &frame,
            grid,
            opts.gutter,
        );
    }

    let bleed = atlas_bleed_report(&owner, &chart_mask, grid, None);
    let buffers = out_imgs
        .into_iter()
        .map(|(kind, data)| {
            (
                kind,
                ImageBuffer {
                    width: corr.width,
                    height: corr.height,
                    channels: 4,
                    data,
                },
            )
        })
        .collect();

    Ok(EvaluatedBakeResult {
        buffers,
        curvature_range,
        height_range,
        position_min: pos_min,
        position_max: pos_max,
        bleed,
    })
}
