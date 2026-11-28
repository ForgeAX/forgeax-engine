//! Synchronous frustum culling over contiguous SoA world AABBs + lightweight summary.

use crate::arena::FrameBumpArena;
use crate::scene::{
    RetainedRenderScene, LIGHT_KIND_DIRECTIONAL, OBJ_FLAG_CAST_SHADOW, OBJ_FLAG_FRUSTUM_CULLED,
    OBJ_FLAG_MASKED, OBJ_FLAG_TRANSPARENT, OBJ_FLAG_VISIBLE,
};

pub const CULL_FLAG_CULL_LIGHTS: u32 = 1 << 0;
pub const CULL_FLAG_COMPUTE_VISIBLE_BOUNDS: u32 = 1 << 1;
pub const CULL_FLAG_INCLUDE_SHADOW_ONLY: u32 = 1 << 2;

#[derive(Debug, Clone, Copy)]
pub struct CullParams {
    pub view_proj: [f32; 16],
    pub camera_pos: [f32; 3],
    pub layer_mask: u32,
    pub flags: u32,
    pub lod_bias: f32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct VisibleLightSummary {
    pub light_id: u32,
    pub kind: u8,
    pub cast_shadow: bool,
    pub cascade_count: u8,
    pub screen_coverage: f32,
}

#[derive(Debug, Clone)]
pub struct CullRecord {
    pub cull_id: u32,
    pub camera_pos: [f32; 3],
    pub candidate_count: u32,
    pub visible_opaque_count: u32,
    pub visible_masked_count: u32,
    pub visible_transparent_count: u32,
    pub visible_shadow_caster_count: u32,
    pub visible_bounds_min: [f32; 3],
    pub visible_bounds_max: [f32; 3],
    /// Range into `FrameBumpArena::u32_words` holding visible scene row indices.
    pub visible_rows_start: usize,
    pub visible_rows_len: usize,
    pub visible_lights: Vec<VisibleLightSummary>,
}

/// Extracts 6 normalized frustum planes (Gribb-Hartmann, WebGPU depth [0, 1] or [-1, 1] safe) from column-major VP.
#[inline]
pub fn extract_frustum_planes(m: &[f32; 16]) -> [[f32; 4]; 6] {
    // Column-major: row r = [m[r], m[4+r], m[8+r], m[12+r]]
    let r0 = [m[0], m[4], m[8], m[12]];
    let r1 = [m[1], m[5], m[9], m[13]];
    let r2 = [m[2], m[6], m[10], m[14]];
    let r3 = [m[3], m[7], m[11], m[15]];

    let raw = [
        [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]], // Left
        [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]], // Right
        [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]], // Bottom
        [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]], // Top
        [r2[0], r2[1], r2[2], r2[3]],                                  // Near (z >= 0 for WebGPU NDC [0,1])
        [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]], // Far
    ];
    let mut out = [[0.0f32; 4]; 6];
    for i in 0..6 {
        let p = raw[i];
        let len = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        if len > 1e-12 {
            let inv = 1.0 / len;
            out[i] = [p[0] * inv, p[1] * inv, p[2] * inv, p[3] * inv];
        } else {
            out[i] = p;
        }
    }
    out
}

#[inline]
pub fn aabb_intersects_frustum(min: [f32; 3], max: [f32; 3], planes: &[[f32; 4]; 6]) -> bool {
    for p in planes {
        let px = if p[0] >= 0.0 { max[0] } else { min[0] };
        let py = if p[1] >= 0.0 { max[1] } else { min[1] };
        let pz = if p[2] >= 0.0 { max[2] } else { min[2] };
        if p[0] * px + p[1] * py + p[2] * pz + p[3] < 0.0 {
            return false;
        }
    }
    true
}

#[inline]
pub fn sphere_intersects_frustum(center: [f32; 3], radius: f32, planes: &[[f32; 4]; 6]) -> bool {
    for p in planes {
        if p[0] * center[0] + p[1] * center[1] + p[2] * center[2] + p[3] < -radius {
            return false;
        }
    }
    true
}

pub fn execute_cull(
    cull_id: u32,
    scene: &RetainedRenderScene,
    params: &CullParams,
    arena: &mut FrameBumpArena,
) -> CullRecord {
    let planes = extract_frustum_planes(&params.view_proj);
    let rows_start = arena.u32_words.len();
    let count = scene.object_count();
    let compute_bounds = (params.flags & CULL_FLAG_COMPUTE_VISIBLE_BOUNDS) != 0;
    let include_shadow = (params.flags & CULL_FLAG_INCLUDE_SHADOW_ONLY) != 0;

    let mut candidate_count = 0u32;
    let mut visible_opaque_count = 0u32;
    let mut visible_masked_count = 0u32;
    let mut visible_transparent_count = 0u32;
    let mut visible_shadow_caster_count = 0u32;
    let mut bmin = [f32::INFINITY; 3];
    let mut bmax = [f32::NEG_INFINITY; 3];

    for row in 0..count {
        let flags = scene.obj_flags[row];
        if (flags & OBJ_FLAG_VISIBLE) == 0 {
            continue;
        }
        if (scene.layer_masks[row] & params.layer_mask) == 0 {
            continue;
        }
        if include_shadow && (flags & OBJ_FLAG_CAST_SHADOW) == 0 {
            continue;
        }
        candidate_count += 1;

        let wmin = scene.world_aabb_min[row];
        let wmax = scene.world_aabb_max[row];
        if (flags & OBJ_FLAG_FRUSTUM_CULLED) != 0 && !aabb_intersects_frustum(wmin, wmax, &planes) {
            continue;
        }

        arena.u32_words.push(row as u32);
        if (flags & OBJ_FLAG_TRANSPARENT) != 0 {
            visible_transparent_count += 1;
        } else if (flags & OBJ_FLAG_MASKED) != 0 {
            visible_masked_count += 1;
        } else {
            visible_opaque_count += 1;
        }
        if (flags & OBJ_FLAG_CAST_SHADOW) != 0 {
            visible_shadow_caster_count += 1;
        }
        if compute_bounds {
            bmin[0] = bmin[0].min(wmin[0]);
            bmin[1] = bmin[1].min(wmin[1]);
            bmin[2] = bmin[2].min(wmin[2]);
            bmax[0] = bmax[0].max(wmax[0]);
            bmax[1] = bmax[1].max(wmax[1]);
            bmax[2] = bmax[2].max(wmax[2]);
        }
    }

    if !compute_bounds || !bmin[0].is_finite() {
        bmin = [0.0; 3];
        bmax = [0.0; 3];
    }

    let mut visible_lights = Vec::new();
    if (params.flags & CULL_FLAG_CULL_LIGHTS) != 0 {
        for light in &scene.lights {
            if (light.layer_mask & params.layer_mask) == 0 {
                continue;
            }
            let visible = if light.kind == LIGHT_KIND_DIRECTIONAL || !light.range.is_finite() {
                true
            } else {
                sphere_intersects_frustum(light.position, light.range, &planes)
            };
            if visible {
                visible_lights.push(VisibleLightSummary {
                    light_id: light.light_id,
                    kind: light.kind,
                    cast_shadow: light.cast_shadow,
                    cascade_count: light.cascade_count,
                    screen_coverage: 1.0,
                });
            }
        }
    }

    let visible_rows_len = arena.u32_words.len() - rows_start;
    CullRecord {
        cull_id,
        camera_pos: params.camera_pos,
        candidate_count,
        visible_opaque_count,
        visible_masked_count,
        visible_transparent_count,
        visible_shadow_caster_count,
        visible_bounds_min: bmin,
        visible_bounds_max: bmax,
        visible_rows_start: rows_start,
        visible_rows_len,
        visible_lights,
    }
}
