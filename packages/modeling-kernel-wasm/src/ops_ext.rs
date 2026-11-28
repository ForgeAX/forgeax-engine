//! Extended C-ABI WASM exports for all modeling, atlas, high-to-low bake,
//! cleanup, simplify, remesh, voxel, lowpoly, cut, shell, deform, UV, skin, and query ops.

use std::collections::{HashMap, HashSet};

use forgeax_modeling_kernel::arena::Handle;
use forgeax_modeling_kernel::bake::cage::{
    build_base_averaged_normals, resolve_cage_group, BakeDirection, BaseTriData, CageSpec,
};
use forgeax_modeling_kernel::bake::correspond::{
    bake_correspond, BakeCorrespondInput, BakeGroupConfig, DetailMeshData,
};
use forgeax_modeling_kernel::bake::eval::{
    evaluate_bake_maps, BakeEvalOptions, BakeMapKind, BakeSlotSpec,
};
use forgeax_modeling_kernel::error::KernelError;
use forgeax_modeling_kernel::mesh::geom::{cross, normalize, sub, Vec3};
use forgeax_modeling_kernel::mesh::CornerChannelKind;
use forgeax_modeling_kernel::ops::cleanup::{
    cleanup_planar, cleanup_quads, cleanup_slivers, dissolve_edges, mark_crease, mark_float,
    mark_part_role, orient_faces, resolve_t_junctions, split_edges, triangulate_faces, PartRole,
};
use forgeax_modeling_kernel::ops::cut::{
    bridge_edges, disconnect_faces, duplicate_faces, hole_cut, loop_cut, shell_faces,
    slice_or_plane_cut,
};
use forgeax_modeling_kernel::ops::deform::{
    apply_draft, arap_deform, bend_vertices, curve_deform_vertices, implicit_smooth,
    lattice_deform, shrinkwrap_vertices, spherize_vertices, taubin_smooth, twist_vertices,
};
use forgeax_modeling_kernel::ops::lowpoly::{lowpoly_faces, LowpolyOptions};
use forgeax_modeling_kernel::ops::primitives::Attribution;
use forgeax_modeling_kernel::ops::remesh::{
    cleanup_tiling, isotropic_remesh, qem_simplify, ConstraintLevel, PreserveConstraints,
    RemeshOptions, SimplifyOptions,
};
use forgeax_modeling_kernel::ops::shapes::{
    append_cone, append_extrude_polygon, append_loft, append_pipe_network, append_polygon,
    lift_triangle_soup,
};
use forgeax_modeling_kernel::ops::voxel::{voxel_fill_holes, voxel_offset};
use forgeax_modeling_kernel::query::{hausdorff_distance, mesh_quality_metrics};
use forgeax_modeling_kernel::skin::{bind_skin_geodesic, SkinBone};
use forgeax_modeling_kernel::surface::atlas::{
    atlas_bleed_report, dilate_atlas, AtlasBufferMut, AtlasGrid,
};
use forgeax_modeling_kernel::uv::ops::{
    lightmap_uv, plan_seams, straighten_uv, swatch_uv, trim_uv, uv_overlap_pairs,
};

use super::{read_i32_slice, RT};

#[inline]
unsafe fn read_f64_slice<'a>(ptr: u32, count: u32) -> &'a [f64] {
    if count == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr as *const f64, count as usize)
    }
}

#[inline]
unsafe fn read_f32_slice<'a>(ptr: u32, count: u32) -> &'a [f32] {
    if count == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr as *const f32, count as usize)
    }
}

#[inline]
unsafe fn read_u32_slice<'a>(ptr: u32, count: u32) -> &'a [u32] {
    if count == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr as *const u32, count as usize)
    }
}

#[inline]
unsafe fn read_u8_slice<'a>(ptr: u32, count: u32) -> &'a [u8] {
    if count == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr as *const u8, count as usize)
    }
}

fn constraint_from_u8(v: u8) -> ConstraintLevel {
    match v {
        0 => ConstraintLevel::Free,
        2 => ConstraintLevel::Pin,
        _ => ConstraintLevel::Keep,
    }
}

fn parse_constraints(bits: u32) -> PreserveConstraints {
    PreserveConstraints {
        boundary: constraint_from_u8((bits & 3) as u8),
        sharp: constraint_from_u8(((bits >> 2) & 3) as u8),
        seam: constraint_from_u8(((bits >> 4) & 3) as u8),
        material: constraint_from_u8(((bits >> 6) & 3) as u8),
        label: constraint_from_u8(((bits >> 8) & 3) as u8),
    }
}

// =========================================================================
// 1. Atlas & High-to-Low Bake Atomic C-ABI
// =========================================================================

/// Batch chart-aware atlas dilation over `buf_count` packed RGBA f32 planes (`buf_count * width * height * 4`).
/// `out_meta_ptr` receives `[protect_mip, protected_bleed, pass, level_count, levels...]`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_atlas_dilate(
    width: u32,
    height: u32,
    wrap_u: u32,
    wrap_v: u32,
    gutter: u32,
    protect_mip: i32,
    buf_count: u32,
    rgba_ptr: u32,
    categorical_ptr: u32,
    covered_ptr: u32,
    owner_ptr: u32,
    frame_ptr: u32,
    out_meta_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let texels = (width as usize) * (height as usize);
        let n_bufs = buf_count as usize;
        if texels == 0 || n_bufs == 0 {
            rt.set_error(KernelError::invalid_value(
                "atlas",
                "requires non-empty grid and buffers",
            ));
            return -1;
        }
        let rgba =
            unsafe { std::slice::from_raw_parts_mut(rgba_ptr as *mut f32, n_bufs * texels * 4) };
        let cat = unsafe { read_u8_slice(categorical_ptr, buf_count) };
        let covered = unsafe { std::slice::from_raw_parts_mut(covered_ptr as *mut u8, texels) };
        let owner = unsafe { std::slice::from_raw_parts_mut(owner_ptr as *mut i32, texels) };
        let frame = unsafe { read_i32_slice(frame_ptr, texels as u32) };
        let chart_mask = covered.to_vec();

        let grid = AtlasGrid {
            width,
            height,
            wrap_u: wrap_u != 0,
            wrap_v: wrap_v != 0,
        };
        let mut bufs: Vec<AtlasBufferMut<'_>> = Vec::with_capacity(n_bufs);
        for (i, chunk) in rgba.chunks_exact_mut(texels * 4).enumerate() {
            bufs.push(AtlasBufferMut {
                data: chunk,
                categorical: cat.get(i).copied().unwrap_or(0) != 0,
            });
        }
        dilate_atlas(&mut bufs, covered, owner, frame, grid, gutter);
        let pm = if protect_mip < 0 {
            None
        } else {
            Some(protect_mip as u32)
        };
        let rep = atlas_bleed_report(owner, &chart_mask, grid, pm);
        let out = unsafe {
            std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 4 + rep.levels.len().min(16))
        };
        out[0] = rep.protect_mip;
        out[1] = rep.protected_bleed;
        out[2] = if rep.pass { 1 } else { 0 };
        out[3] = rep.levels.len() as u32;
        for (i, &lv) in rep.levels.iter().take(16).enumerate() {
            out[4 + i] = lv;
        }
        0
    })
}

/// Resolve cage `(offset, max_ray, diagonal, steep_fraction)` for a single group from triangle soups.
/// `out_f64_ptr` points to `[offset, max_ray, diagonal, steep_fraction]` (4 f64s).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_bake_resolve_cage(
    base_pos_ptr: u32,
    base_vert_count: u32,
    base_nrm_ptr: u32,
    base_idx_ptr: u32,
    base_tri_count: u32,
    detail_pos_ptr: u32,
    detail_vert_count: u32,
    detail_idx_ptr: u32,
    detail_tri_count: u32,
    offset_in: f64,
    max_ray_in: f64,
    dir_mode: u8,
    blend_dist: f64,
    out_f64_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let b_pos = unsafe { read_f64_slice(base_pos_ptr, base_vert_count * 3) }.to_vec();
        let b_nrm = unsafe { read_f64_slice(base_nrm_ptr, base_vert_count * 3) };
        let b_idx = unsafe { read_u32_slice(base_idx_ptr, base_tri_count * 3) }.to_vec();
        let d_pos = unsafe { read_f64_slice(detail_pos_ptr, detail_vert_count * 3) };
        let d_idx = unsafe { read_u32_slice(detail_idx_ptr, detail_tri_count * 3) };

        let b_tris = base_tri_count as usize;
        let d_tris = detail_tri_count as usize;
        let b_group = vec![0i32; b_tris];
        let averaged = build_base_averaged_normals(&b_pos, &b_idx, &b_group);
        let mut shading = vec![0.0f64; b_tris * 9];
        let mut face_n = vec![0.0f64; b_tris * 3];
        for t in 0..b_tris {
            let i0 = (b_idx[t * 3] as usize) * 3;
            let i1 = (b_idx[t * 3 + 1] as usize) * 3;
            let i2 = (b_idx[t * 3 + 2] as usize) * 3;
            let p0 = [b_pos[i0], b_pos[i0 + 1], b_pos[i0 + 2]];
            let p1 = [b_pos[i1], b_pos[i1 + 1], b_pos[i1 + 2]];
            let p2 = [b_pos[i2], b_pos[i2 + 1], b_pos[i2 + 2]];
            let fn_v = normalize(cross(sub(p1, p0), sub(p2, p0)));
            face_n[t * 3] = fn_v[0];
            face_n[t * 3 + 1] = fn_v[1];
            face_n[t * 3 + 2] = fn_v[2];
            for k in 0..3 {
                let vi = (b_idx[t * 3 + k] as usize) * 3;
                shading[t * 9 + k * 3] = b_nrm.get(vi).copied().unwrap_or(fn_v[0]);
                shading[t * 9 + k * 3 + 1] = b_nrm.get(vi + 1).copied().unwrap_or(fn_v[1]);
                shading[t * 9 + k * 3 + 2] = b_nrm.get(vi + 2).copied().unwrap_or(fn_v[2]);
            }
        }
        let base_data = BaseTriData {
            positions: b_pos,
            indices: b_idx,
            group: b_group,
            averaged,
            shading,
            face: face_n,
            tagged: vec![0; b_tris],
        };
        let direction = match dir_mode {
            1 => BakeDirection::Shading,
            2 => BakeDirection::Face,
            3 => BakeDirection::Blend {
                distance: blend_dist,
            },
            _ => BakeDirection::Averaged,
        };
        let cage_spec = CageSpec {
            offset: if offset_in.is_finite() && offset_in >= 0.0 {
                Some(offset_in)
            } else {
                None
            },
            max_ray: if max_ray_in.is_finite() && max_ray_in > 0.0 {
                Some(max_ray_in)
            } else {
                None
            },
        };
        let bt_idx: Vec<usize> = (0..b_tris).collect();
        let dt_idx: Vec<usize> = (0..d_tris).collect();
        match resolve_cage_group(
            cage_spec, "group", &base_data, &bt_idx, d_pos, d_idx, &dt_idx, direction, None,
        ) {
            Ok(res) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_f64_ptr as *mut f64, 4) };
                out[0] = res.offset;
                out[1] = res.max_ray;
                out[2] = res.diagonal;
                out[3] = res.steep_fraction;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_live_correspondences() -> u32 {
    RT.with(|rt| rt.borrow().correspondences.live_count() as u32)
}

#[no_mangle]
pub extern "C" fn mk_bake_correspond_dispose(handle: u64) -> i32 {
    RT.with(|rt| {
        if rt
            .borrow_mut()
            .correspondences
            .remove(Handle(handle))
            .is_some()
        {
            0
        } else {
            -1
        }
    })
}

/// High-to-low surface correspondence pass: returns opaque correspondence handle (0 on error).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_bake_correspond(
    width: u32,
    height: u32,
    samples_per_axis: u32,
    base_pos_ptr: u32,
    base_vert_count: u32,
    base_nrm_ptr: u32,
    base_tan_ptr: u32,
    base_uv_ptr: u32,
    base_idx_ptr: u32,
    base_tri_count: u32,
    base_tri_group_ptr: u32,
    base_tri_island_ptr: u32,
    detail_pos_ptr: u32,
    detail_vert_count: u32,
    detail_nrm_ptr: u32,
    detail_idx_ptr: u32,
    detail_tri_count: u32,
    detail_tri_group_ptr: u32,
    detail_tri_slot_ptr: u32,
    detail_floater_ptr: u32,
    group_count: u32,
    group_params_f64_ptr: u32, // per group: [offset, max_ray, diagonal, dir_mode, clip] (5 f64s)
    out_counters_ptr: u32, // [ray_hits, primary, rescued, extended, nearest, missed, clipped, covered_texels] (8 u32s)
) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let bv = base_vert_count as usize;
        let bt = base_tri_count as usize;
        let dv = detail_vert_count as usize;
        let dt = detail_tri_count as usize;
        let ng = (group_count as usize).max(1);

        let b_pos = unsafe { read_f64_slice(base_pos_ptr, (bv * 3) as u32) }.to_vec();
        let b_nrm = unsafe { read_f64_slice(base_nrm_ptr, (bv * 3) as u32) }.to_vec();
        let b_tan = unsafe { read_f32_slice(base_tan_ptr, (bv * 4) as u32) }.to_vec();
        let b_uv = unsafe { read_f32_slice(base_uv_ptr, (bv * 2) as u32) }.to_vec();
        let b_idx = unsafe { read_u32_slice(base_idx_ptr, (bt * 3) as u32) }.to_vec();
        let b_grp = if base_tri_group_ptr == 0 {
            vec![0i32; bt]
        } else {
            unsafe { read_i32_slice(base_tri_group_ptr, bt as u32) }.to_vec()
        };
        let b_isl = if base_tri_island_ptr == 0 {
            vec![0i32; bt]
        } else {
            unsafe { read_i32_slice(base_tri_island_ptr, bt as u32) }.to_vec()
        };

        let d_pos = unsafe { read_f64_slice(detail_pos_ptr, (dv * 3) as u32) }.to_vec();
        let d_nrm = if detail_nrm_ptr == 0 {
            Vec::new()
        } else {
            unsafe { read_f64_slice(detail_nrm_ptr, (dv * 3) as u32) }.to_vec()
        };
        let d_idx = unsafe { read_u32_slice(detail_idx_ptr, (dt * 3) as u32) }.to_vec();
        let d_grp = if detail_tri_group_ptr == 0 {
            vec![0i32; dt]
        } else {
            unsafe { read_i32_slice(detail_tri_group_ptr, dt as u32) }.to_vec()
        };
        let d_slot = if detail_tri_slot_ptr == 0 {
            vec![0i32; dt]
        } else {
            unsafe { read_i32_slice(detail_tri_slot_ptr, dt as u32) }.to_vec()
        };
        let d_float = if detail_floater_ptr == 0 {
            vec![0u8; dt]
        } else {
            unsafe { read_u8_slice(detail_floater_ptr, dt as u32) }.to_vec()
        };
        let gp = unsafe { read_f64_slice(group_params_f64_ptr, (ng * 5) as u32) };
        let mut groups = Vec::with_capacity(ng);
        for g in 0..ng {
            let off = gp.get(g * 5).copied().unwrap_or(0.05);
            let mr = gp.get(g * 5 + 1).copied().unwrap_or(0.15);
            let diag = gp.get(g * 5 + 2).copied().unwrap_or(1.0);
            let dm = gp.get(g * 5 + 3).copied().unwrap_or(0.0) as u8;
            let clip = gp.get(g * 5 + 4).copied().unwrap_or(1.0) != 0.0;
            let direction = match dm {
                1 => BakeDirection::Shading,
                2 => BakeDirection::Face,
                _ => BakeDirection::Averaged,
            };
            groups.push(BakeGroupConfig {
                offset: off,
                max_ray: mr,
                diagonal: diag,
                direction,
                clip_check: clip,
            });
        }

        let input = BakeCorrespondInput {
            width,
            height,
            samples_per_axis,
            base_positions: b_pos,
            base_normals: b_nrm,
            base_tangents: b_tan,
            base_uvs: b_uv,
            base_indices: b_idx,
            base_tri_face: (0..bt as i32).collect(),
            base_tri_group: b_grp,
            base_tri_island: b_isl,
            base_tri_tagged: vec![0u8; bt],
            detail: DetailMeshData {
                positions: d_pos,
                corner_normals: d_nrm,
                face_normals: Vec::new(),
                indices: d_idx,
                tri_group: d_grp,
                tri_slot: d_slot,
                floater: d_float,
                vert_curvature: Vec::new(),
                corner_colors: Vec::new(),
                has_corner_colors: false,
            },
            groups,
        };

        match bake_correspond(input) {
            Ok(data) => {
                if out_counters_ptr != 0 {
                    let out =
                        unsafe { std::slice::from_raw_parts_mut(out_counters_ptr as *mut u32, 8) };
                    out[0] = data.counters.ray_hits;
                    out[1] = data.counters.primary;
                    out[2] = data.counters.rescued;
                    out[3] = data.counters.extended;
                    out[4] = data.counters.nearest;
                    out[5] = data.counters.missed;
                    out[6] = data.counters.clipped;
                    out[7] = data.counters.covered_texels;
                }
                rt.correspondences.insert(data).0
            }
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

/// Evaluate requested `BakeMapKind`s from an active correspondence handle into `RT.images`.
/// `out_img_handles_ptr`: `map_count` u64s; `out_ranges_f32_ptr`: 9 floats (`curvRange`, `hMin`, `hMax`, `pMin[3]`, `pMax[3]`).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_bake_correspond_eval(
    corr_handle: u64,
    maps_ptr: u32,
    map_count: u32,
    slots_f32_ptr: u32, // per slot: 9 f32s [r,g,b,a, rough, metal, er, eg, eb]
    slot_count: u32,
    gutter: u32,
    ao_samples: u32,
    ao_cone: f64,
    ao_distance: f64,
    ao_bias: f64,
    out_img_handles_ptr: u32,
    out_ranges_f32_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let map_ids = unsafe { read_u8_slice(maps_ptr, map_count) };
        let mut maps = Vec::with_capacity(map_ids.len());
        for &id in map_ids {
            let Some(kind) = BakeMapKind::from_u8(id) else {
                rt.set_error(KernelError::invalid_value("maps", "unknown BakeMapKind"));
                return -1;
            };
            maps.push(kind);
        }
        let slots_raw = unsafe { read_f32_slice(slots_f32_ptr, slot_count * 9) };
        let mut slots = Vec::with_capacity(slot_count as usize);
        for ch in slots_raw.chunks_exact(9) {
            slots.push(BakeSlotSpec {
                base_color: [ch[0], ch[1], ch[2], ch[3]],
                roughness: ch[4],
                metallic: ch[5],
                emissive: [ch[6], ch[7], ch[8]],
            });
        }

        let eval_res = {
            let Some(corr) = rt.correspondences.get(Handle(corr_handle)) else {
                rt.set_error(KernelError::invalid_handle());
                return -1;
            };
            evaluate_bake_maps(
                corr,
                &BakeEvalOptions {
                    maps,
                    slots,
                    gutter,
                    ao_samples,
                    ao_cone,
                    ao_distance: if ao_distance.is_finite() && ao_distance > 0.0 {
                        Some(ao_distance)
                    } else {
                        None
                    },
                    ao_bias: if ao_bias > 0.0 { ao_bias } else { 1e-4 },
                    ..Default::default()
                },
            )
        };
        match eval_res {
            Ok(res) => {
                let out_h = unsafe {
                    std::slice::from_raw_parts_mut(
                        out_img_handles_ptr as *mut u64,
                        res.buffers.len(),
                    )
                };
                for (i, (_, img)) in res.buffers.into_iter().enumerate() {
                    out_h[i] = rt.images.insert(img).0;
                }
                if out_ranges_f32_ptr != 0 {
                    let r = unsafe {
                        std::slice::from_raw_parts_mut(out_ranges_f32_ptr as *mut f32, 9)
                    };
                    r[0] = res.curvature_range;
                    r[1] = res.height_range[0];
                    r[2] = res.height_range[1];
                    r[3] = res.position_min[0];
                    r[4] = res.position_min[1];
                    r[5] = res.position_min[2];
                    r[6] = res.position_max[0];
                    r[7] = res.position_max[1];
                    r[8] = res.position_max[2];
                }
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

// =========================================================================
// 2. Flags, Cleanup, Repair & Attributes on EditMesh
// =========================================================================

#[no_mangle]
pub extern "C" fn mk_mesh_mark_part_role(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    role_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(role) = PartRole::from_u8(role_id) else {
            rt.set_error(KernelError::invalid_value("role", "invalid part role"));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        mark_part_role(m, &faces, role) as i32
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_mark_float(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    floating: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        mark_float(m, &faces, floating != 0) as i32
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_mark_crease(
    handle: u64,
    edges_ptr: u32,
    edge_count: u32,
    sharpness: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let edges = unsafe { read_i32_slice(edges_ptr, edge_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match mark_crease(m, &edges, sharpness) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_orient(handle: u64, faces_ptr: u32, face_count: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match orient_faces(m, &faces) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_triangulate(handle: u64, faces_ptr: u32, face_count: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match triangulate_faces(m, &faces) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_dissolve(
    handle: u64,
    edges_ptr: u32,
    edge_count: u32,
    out_counts_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let edges = unsafe { read_i32_slice(edges_ptr, edge_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match dissolve_edges(m, &edges) {
            Ok((d, mg)) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 2) };
                out[0] = d as u32;
                out[1] = mg as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_split_edges(handle: u64, edges_ptr: u32, edge_count: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let edges = unsafe { read_i32_slice(edges_ptr, edge_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match split_edges(m, &edges) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_cleanup_planar(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    tolerance: f64,
    out_counts_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match cleanup_planar(m, &faces, tolerance) {
            Ok((mg, rv)) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 2) };
                out[0] = mg as u32;
                out[1] = rv as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_cleanup_quads(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    max_angle_deg: f64,
    max_planarity: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match cleanup_quads(m, &faces, max_angle_deg, max_planarity) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_cleanup_slivers(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    width: f64,
    tolerance: f64,
    out_counts_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match cleanup_slivers(m, &faces, width, tolerance) {
            Ok((rem, kept)) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 2) };
                out[0] = rem as u32;
                out[1] = kept as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_resolve_t_junctions(handle: u64, distance: f64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match resolve_t_junctions(m, distance) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

// =========================================================================
// 3. Simplify, Remesh, Voxel, Lowpoly
// =========================================================================

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_simplify(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    target_faces: i32,
    max_error: f64,
    constraint_bits: u32,
    silhouette_eyes_ptr: u32,
    silhouette_eye_count: u32,
    silhouette_weight: f64,
    out_err_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let eyes_raw = unsafe { read_f64_slice(silhouette_eyes_ptr, silhouette_eye_count * 3) };
        let eyes: Vec<Vec3> = eyes_raw
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let opts = SimplifyOptions {
            target_faces: if target_faces >= 0 {
                Some(target_faces as usize)
            } else {
                None
            },
            max_error: if max_error.is_finite() && max_error > 0.0 {
                Some(max_error)
            } else {
                None
            },
            volume_preserving: true,
            max_aspect: None,
            max_valence: None,
            constraints: parse_constraints(constraint_bits),
            silhouette_weight,
        };
        match qem_simplify(m, &faces, &opts, &eyes) {
            Ok((tris, max_e)) => {
                if out_err_ptr != 0 {
                    let out = unsafe { std::slice::from_raw_parts_mut(out_err_ptr as *mut f64, 1) };
                    out[0] = max_e;
                }
                tris as i32
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_remesh(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    target_edge_length: f64,
    iterations: u32,
    smooth_weight: f64,
    constraint_bits: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match isotropic_remesh(
            m,
            &faces,
            &RemeshOptions {
                target_edge_length,
                iterations: iterations as usize,
                smooth_weight,
                constraints: parse_constraints(constraint_bits),
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_cleanup_tiling(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    max_aspect: f64,
    max_error: f64,
    iterations: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match cleanup_tiling(m, &faces, max_aspect, max_error, iterations as usize) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_lowpoly(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    target_faces: u32,
    hard_angle_deg: f64,
    max_error: f64,
    roles_form_only: u32,
    auto_uv_flag: u32,
    uv_resolution: u32,
    uv_padding: f64,
    preserve_groups: u32,
    prefix_ptr: u32,
    prefix_len: u32,
    tolerance: f64,
    out_counts_ptr: u32, // [triangles, quads, components, charts, used_voxel]
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let group_prefix = if prefix_ptr != 0 && prefix_len > 0 {
            let bs = unsafe { read_u8_slice(prefix_ptr, prefix_len) };
            String::from_utf8_lossy(bs).to_string()
        } else {
            "part_".to_string()
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match lowpoly_faces(
            m,
            &faces,
            &LowpolyOptions {
                target_faces: target_faces as usize,
                hard_angle_deg,
                max_error: if max_error.is_finite() && max_error > 0.0 {
                    Some(max_error)
                } else {
                    None
                },
                roles_form_only: roles_form_only != 0,
                auto_uv: auto_uv_flag != 0,
                uv_resolution: uv_resolution.max(64),
                uv_padding_texels: uv_padding,
                group_prefix,
                preserve_groups: preserve_groups != 0,
                tolerance,
                ..Default::default()
            },
        ) {
            Ok(rep) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 5) };
                out[0] = rep.triangles as u32;
                out[1] = rep.quads as u32;
                out[2] = rep.components as u32;
                out[3] = rep.charts as u32;
                out[4] = if rep.used_voxel_fallback { 1 } else { 0 };
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_voxel_remesh(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    mode: u8, // 0 = fill_holes / union, 1 = offset
    distance: f64,
    voxel_size: f64,
    band: u32,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let attr = Attribution {
            label,
            material,
            tag,
        };
        let res = if mode == 1 {
            voxel_offset(m, &faces, distance, voxel_size, band, attr)
        } else {
            voxel_fill_holes(m, &faces, voxel_size, band, attr)
        };
        match res {
            Ok(next_m) => {
                let n = next_m.face_count();
                *m = next_m;
                n as i32
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

// =========================================================================
// 4. Cut, Shell, Shapes, Deformers
// =========================================================================

#[no_mangle]
pub extern "C" fn mk_mesh_duplicate(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    label: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match duplicate_faces(
            m,
            &faces,
            Attribution {
                label,
                material: 0,
                tag,
            },
        ) {
            Ok(v) => v.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_disconnect(handle: u64, faces_ptr: u32, face_count: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match disconnect_faces(m, &faces) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_bridge(
    handle: u64,
    edges_ptr: u32,
    edge_count: u32,
    segments: u32,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let edges = unsafe { read_i32_slice(edges_ptr, edge_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match bridge_edges(
            m,
            &edges,
            segments as usize,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_loop_cut(handle: u64, edges_ptr: u32, edge_count: u32, cuts: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let edges = unsafe { read_i32_slice(edges_ptr, edge_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match loop_cut(m, &edges, cuts as usize) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_plane_cut(
    handle: u64,
    px: f64,
    py: f64,
    pz: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    positive_only: u32,
    fill_holes_cap: u32,
    tolerance: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match slice_or_plane_cut(
            m,
            [px, py, pz],
            [nx, ny, nz],
            positive_only != 0,
            fill_holes_cap != 0,
            tolerance,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_shell(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    thickness: f64,
    direction: i8,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match shell_faces(
            m,
            &faces,
            thickness,
            direction,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_hole(
    handle: u64,
    face: i32,
    centers_ptr: u32,
    center_count: u32,
    diameter: f64,
    depth: f64,
    segments: u32,
    label: i32,
    material: i32,
    tag: i32,
    tolerance: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let c_raw = unsafe { read_f64_slice(centers_ptr, center_count * 2) };
        let centers: Vec<[f64; 2]> = c_raw.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match hole_cut(
            m,
            face,
            &centers,
            diameter,
            depth,
            segments,
            Attribution {
                label,
                material,
                tag,
            },
            tolerance,
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_polygon(
    handle: u64,
    pts_ptr: u32,
    pt_count: u32,
    flip: u32,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let raw = unsafe { read_f64_slice(pts_ptr, pt_count * 2) };
        let pts: Vec<[f64; 2]> = raw.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_polygon(
            m,
            &pts,
            flip != 0,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(v) => v.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_cone(
    handle: u64,
    radius: f64,
    height: f64,
    radial_segments: u32,
    open_ended: u32,
    cx: f64,
    cy: f64,
    cz: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_cone(
            m,
            radius,
            height,
            radial_segments,
            open_ended != 0,
            [cx, cy, cz],
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(v) => v.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_extrude_polygon(
    handle: u64,
    pts_ptr: u32,
    pt_count: u32,
    depth: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let raw = unsafe { read_f64_slice(pts_ptr, pt_count * 2) };
        let pts: Vec<[f64; 2]> = raw.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_extrude_polygon(
            m,
            &pts,
            depth,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(v) => v.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_loft(
    handle: u64,
    pts_ptr: u32,
    ring_lens_ptr: u32,
    ring_count: u32,
    capped: u32,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let lens = unsafe { read_u32_slice(ring_lens_ptr, ring_count) };
        let total_pts: u32 = lens.iter().sum();
        let raw = unsafe { read_f64_slice(pts_ptr, total_pts * 3) };
        let mut sections = Vec::with_capacity(ring_count as usize);
        let mut off = 0usize;
        for &len in lens {
            let l = len as usize;
            let ring = (0..l)
                .map(|i| {
                    [
                        raw[(off + i) * 3],
                        raw[(off + i) * 3 + 1],
                        raw[(off + i) * 3 + 2],
                    ]
                })
                .collect();
            sections.push(ring);
            off += l;
        }
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_loft(
            m,
            &sections,
            capped != 0,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(v) => v.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_pipe_network(
    handle: u64,
    nodes_ptr: u32,
    node_count: u32,
    edges_ptr: u32,
    edge_count: u32,
    radius: f64,
    segments: u32,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let n_raw = unsafe { read_f64_slice(nodes_ptr, node_count * 3) };
        let e_raw = unsafe { read_u32_slice(edges_ptr, edge_count * 2) };
        let nodes: Vec<Vec3> = n_raw.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        let edges: Vec<(usize, usize)> = e_raw
            .chunks_exact(2)
            .map(|c| (c[0] as usize, c[1] as usize))
            .collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_pipe_network(
            m,
            &nodes,
            &edges,
            radius,
            segments,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(v) => v.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_lift(
    handle: u64,
    pos_ptr: u32,
    vert_count: u32,
    idx_ptr: u32,
    idx_count: u32,
    uv_ptr: u32,
    crease_angle_deg: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let pos = unsafe { read_f32_slice(pos_ptr, vert_count * 3) }.to_vec();
        let idx = unsafe { read_u32_slice(idx_ptr, idx_count) }.to_vec();
        let uvs = if uv_ptr == 0 {
            None
        } else {
            Some(unsafe { read_f32_slice(uv_ptr, vert_count * 2) }.to_vec())
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match lift_triangle_soup(
            m,
            &pos,
            &idx,
            uvs.as_deref(),
            crease_angle_deg,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_bend(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    axis: u32,
    toward: u8,
    angle_deg: f64,
    has_range: u32,
    r0: f64,
    r1: f64,
    has_orig: u32,
    ox: f64,
    oy: f64,
    oz: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match bend_vertices(
            m,
            &verts,
            axis as usize,
            toward,
            angle_deg,
            if has_range != 0 { Some([r0, r1]) } else { None },
            if has_orig != 0 {
                Some([ox, oy, oz])
            } else {
                None
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_twist(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    axis: u32,
    angle_deg: f64,
    has_range: u32,
    r0: f64,
    r1: f64,
    has_orig: u32,
    ox: f64,
    oy: f64,
    oz: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match twist_vertices(
            m,
            &verts,
            axis as usize,
            angle_deg,
            if has_range != 0 { Some([r0, r1]) } else { None },
            if has_orig != 0 {
                Some([ox, oy, oz])
            } else {
                None
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_lattice(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    nx: u32,
    ny: u32,
    nz: u32,
    off_idx_ptr: u32, // [i,j,k] per entry
    off_vec_ptr: u32, // [dx,dy,dz] per entry
    off_count: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let idx_raw = unsafe { read_u32_slice(off_idx_ptr, off_count * 3) };
        let vec_raw = unsafe { read_f64_slice(off_vec_ptr, off_count * 3) };
        let offsets: Vec<([usize; 3], Vec3)> = (0..off_count as usize)
            .map(|i| {
                (
                    [
                        idx_raw[i * 3] as usize,
                        idx_raw[i * 3 + 1] as usize,
                        idx_raw[i * 3 + 2] as usize,
                    ],
                    [vec_raw[i * 3], vec_raw[i * 3 + 1], vec_raw[i * 3 + 2]],
                )
            })
            .collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match lattice_deform(
            m,
            &verts,
            [nx as usize, ny as usize, nz as usize],
            None,
            &offsets,
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_apply_draft(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    px: f64,
    py: f64,
    pz: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    angle_deg: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match apply_draft(m, &faces, [nx, ny, nz], [px, py, pz], angle_deg) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_spherize(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    factor: f64,
    radius: f64,
    has_center: u32,
    cx: f64,
    cy: f64,
    cz: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match spherize_vertices(
            m,
            &verts,
            factor,
            if radius > 0.0 { Some(radius) } else { None },
            if has_center != 0 {
                Some([cx, cy, cz])
            } else {
                None
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_curve_deform(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    path_ptr: u32,
    path_count: u32,
    axis: u32,
    has_origin: u32,
    ox: f64,
    oy: f64,
    oz: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let p_raw = unsafe { read_f64_slice(path_ptr, path_count * 3) };
        let path: Vec<Vec3> = p_raw.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match curve_deform_vertices(
            m,
            &verts,
            &path,
            axis as usize,
            if has_origin != 0 {
                Some([ox, oy, oz])
            } else {
                None
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_smooth(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    lambda: f64,
    mu: f64,
    iterations: u32,
    pin_boundary: u32,
    pin_sharp: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match taubin_smooth(
            m,
            &verts,
            lambda,
            mu,
            iterations as usize,
            pin_boundary != 0,
            pin_sharp != 0,
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_implicit_smooth(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    lambda: f64,
    iterations: u32,
    pins_ptr: u32,
    pin_count: u32,
    pin_boundary: u32,
    pin_sharp: u32,
    preserve_volume: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let extra_pins: HashSet<i32> = unsafe { read_i32_slice(pins_ptr, pin_count) }
            .iter()
            .copied()
            .collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match implicit_smooth(
            m,
            &verts,
            lambda,
            iterations as usize,
            &extra_pins,
            pin_boundary != 0,
            pin_sharp != 0,
            preserve_volume != 0,
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_arap(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    constraint_ids_ptr: u32,
    constraint_pos_ptr: u32,
    constraint_count: u32,
    iterations: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let ids = unsafe { read_i32_slice(constraint_ids_ptr, constraint_count) };
        let pos = unsafe { read_f64_slice(constraint_pos_ptr, constraint_count * 3) };
        let mut constraints: HashMap<i32, Vec3> = HashMap::with_capacity(constraint_count as usize);
        for i in 0..constraint_count as usize {
            constraints.insert(ids[i], [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
        }
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match arap_deform(m, &verts, &constraints, iterations as usize) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_shrinkwrap(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    target_pos_ptr: u32,
    target_vert_count: u32,
    target_idx_ptr: u32,
    target_tri_count: u32,
    has_dir: u32,
    dx: f64,
    dy: f64,
    dz: f64,
    offset: f64,
    max_distance: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let t_pos = unsafe { read_f64_slice(target_pos_ptr, target_vert_count * 3) }.to_vec();
        let t_idx = unsafe { read_u32_slice(target_idx_ptr, target_tri_count * 3) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match shrinkwrap_vertices(
            m,
            &verts,
            &t_pos,
            &t_idx,
            if has_dir != 0 {
                Some([dx, dy, dz])
            } else {
                None
            },
            offset,
            if max_distance.is_finite() && max_distance > 0.0 {
                Some(max_distance)
            } else {
                None
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

// =========================================================================
// 5. Extended UV, Skin, Query
// =========================================================================

#[no_mangle]
pub extern "C" fn mk_mesh_uv_plan_seams(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    max_angle_deg: f64,
    respect_sharp: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match plan_seams(m, &faces, max_angle_deg, respect_sharp != 0) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_uv_straighten(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    channel_id: u8,
    max_angle_deg: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value("channel", "invalid channel"));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match straighten_uv(m, &faces, ch, max_angle_deg) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_uv_lightmap(
    handle: u64,
    resolution: u32,
    padding_texels: f64,
    channel_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value("channel", "invalid channel"));
            return -1;
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match lightmap_uv(m, resolution, padding_texels, ch) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_uv_trim(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    u0: f64,
    u1: f64,
    v0: f64,
    v1: f64,
    tile_u: u32,
    channel_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value("channel", "invalid channel"));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match trim_uv(m, &faces, [u0, u1], [v0, v1], tile_u != 0, ch) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_uv_swatch(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    u0: f64,
    u1: f64,
    v0: f64,
    v1: f64,
    channel_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value("channel", "invalid channel"));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match swatch_uv(m, &faces, [u0, u1], [v0, v1], ch) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_uv_overlaps(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    channel_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value("channel", "invalid channel"));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) };
        let Some(m) = rt.meshes.get(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let pairs = uv_overlap_pairs(m, faces, ch);
        let count = pairs.len();
        let byte_len = count * 8;
        if rt.scratch.len() < byte_len {
            rt.scratch.resize(byte_len.next_power_of_two(), 0);
        }
        for (i, &[a, b]) in pairs.iter().enumerate() {
            rt.scratch[i * 8..i * 8 + 4].copy_from_slice(&a.to_le_bytes());
            rt.scratch[i * 8 + 4..i * 8 + 8].copy_from_slice(&b.to_le_bytes());
        }
        count as i32
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_skin_bind(
    handle: u64,
    roots_ptr: u32,      // 3 f64s per bone
    tips_ptr: u32,       // 3 f64s per tip
    tip_counts_ptr: u32, // u32 per bone
    bone_count: u32,
    falloff: f64,
    grid_res: u32,
    out_joints_ptr: u32,  // 4 u16s per vertHighWater
    out_weights_ptr: u32, // 4 f32s per vertHighWater
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let nb = bone_count as usize;
        let roots = unsafe { read_f64_slice(roots_ptr, (nb * 3) as u32) };
        let tip_counts = unsafe { read_u32_slice(tip_counts_ptr, bone_count) };
        let total_tips: u32 = tip_counts.iter().sum();
        let tips_raw = unsafe { read_f64_slice(tips_ptr, total_tips * 3) };
        let mut bones = Vec::with_capacity(nb);
        let mut t_off = 0usize;
        for b in 0..nb {
            let tc = tip_counts[b] as usize;
            let tips = (0..tc)
                .map(|i| {
                    [
                        tips_raw[(t_off + i) * 3],
                        tips_raw[(t_off + i) * 3 + 1],
                        tips_raw[(t_off + i) * 3 + 2],
                    ]
                })
                .collect();
            bones.push(SkinBone {
                root: [roots[b * 3], roots[b * 3 + 1], roots[b * 3 + 2]],
                tips,
            });
            t_off += tc;
        }
        let res = {
            let Some(m) = rt.meshes.get(Handle(handle)) else {
                rt.set_error(KernelError::invalid_handle());
                return -1;
            };
            bind_skin_geodesic(m, &bones, falloff, grid_res as usize)
        };
        match res {
            Ok(sw) => {
                let oj = unsafe {
                    std::slice::from_raw_parts_mut(out_joints_ptr as *mut u16, sw.joints.len())
                };
                let ow = unsafe {
                    std::slice::from_raw_parts_mut(out_weights_ptr as *mut f32, sw.weights.len())
                };
                oj.copy_from_slice(&sw.joints);
                ow.copy_from_slice(&sw.weights);
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_hausdorff(
    handle_a: u64,
    faces_a_ptr: u32,
    face_count_a: u32,
    handle_b: u64,
    faces_b_ptr: u32,
    face_count_b: u32,
    out_f64_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let fa = unsafe { read_i32_slice(faces_a_ptr, face_count_a) };
        let fb = unsafe { read_i32_slice(faces_b_ptr, face_count_b) };
        let Some(ma) = rt.meshes.get(Handle(handle_a)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let Some(mb) = rt.meshes.get(Handle(handle_b)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let rep = hausdorff_distance(ma, fa, mb, fb);
        let out = unsafe { std::slice::from_raw_parts_mut(out_f64_ptr as *mut f64, 2) };
        out[0] = rep.max;
        out[1] = rep.mean;
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_quality(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    out_f64_ptr: u32, // [verts, faces, boundaryEdges, nonManifoldEdges, degenerateFaces, minEdge, maxEdge, maxAspect]
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) };
        let Some(m) = rt.meshes.get(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let q = mesh_quality_metrics(m, faces);
        let out = unsafe { std::slice::from_raw_parts_mut(out_f64_ptr as *mut f64, 8) };
        out[0] = q.vertices as f64;
        out[1] = q.faces as f64;
        out[2] = q.boundary_edges as f64;
        out[3] = q.non_manifold_edges as f64;
        out[4] = q.degenerate_faces as f64;
        out[5] = q.min_edge;
        out[6] = q.max_edge;
        out[7] = q.max_aspect;
        0
    })
}
