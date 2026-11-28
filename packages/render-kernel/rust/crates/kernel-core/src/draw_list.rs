//! Zero-allocation `CMD_DRAW_RENDERERS` hot loop:
//! filter -> 128-bit PsoKey lookup -> 64-bit SortKey -> in-place sort ->
//! adjacent instancing fold -> state-diffed physical command stream emission + submittedBitmap.

use crate::arena::FrameBumpArena;
use crate::cull::CullRecord;
use crate::handles::INVALID_HANDLE;
use crate::planner::{
    cmd_header, PHYS_DRAW, PHYS_DRAW_INDEXED, PHYS_SET_BIND_GROUP, PHYS_SET_IB, PHYS_SET_PSO,
    PHYS_SET_VB,
};
use crate::pso::{
    PsoKey, PsoStatus, PsoTable, BGL_SLOT_MATERIAL, BGL_SLOT_VIEW, LAYOUT_FAMILY_SCENE_4BGL,
};
use crate::scene::{RetainedRenderScene, OBJ_FLAG_CAST_SHADOW, OBJ_FLAG_GPU_DRIVEN};

pub const SORT_NONE: u8 = 0;
pub const SORT_FRONT_TO_BACK: u8 = 1;
pub const SORT_BACK_TO_FRONT: u8 = 2;
pub const SORT_MATERIAL_PSO: u8 = 3;

pub const DRAW_FLAG_INSTANCING: u16 = 1 << 0;
pub const DRAW_FLAG_GPU_DRIVEN: u16 = 1 << 1;
pub const DRAW_FLAG_SHADOW_CASTER_ONLY: u16 = 1 << 2;

pub struct DrawRenderersArgs {
    pub pass_tag: u8,
    pub sort_mode: u8,
    pub draw_flags: u16,
    pub queue_min: u16,
    pub queue_max: u16,
    pub layer_mask: u32,
    pub view_uniform_off: u32,
    pub view_uniform_len: u32,
    pub extra_bindings: u32,
    pub override_shader: u32,
    pub view_slot_mode: u32,
    pub pass_attachment_id: u16,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct DrawListStats {
    pub submitted_draws: u32,
    pub submitted_indirect: u32,
    pub pending_pipelines: u32,
    pub first_missing_object_id: u32,
    pub first_missing_submesh: u32,
}

#[derive(Clone, Copy)]
struct DrawItem {
    sort_key: u64,
    row: u32,
    pso_slot: u32,
    pso_key: PsoKey,
    mesh_id: u32,
    material_id: u32,
    layout_family_id: u16,
    first_index: u32,
    index_count: u32,
    base_vertex: i32,
    first_vertex: u32,
    vertex_count: u32,
    is_uint32_index: bool,
}

#[inline]
fn quantize_dist_sq_u16(dx: f32, dy: f32, dz: f32) -> u16 {
    let d2 = dx * dx + dy * dy + dz * dz;
    // Monotonic IEEE-754 positive float top 16 bits (fast log-precision depth key)
    let bits = d2.to_bits();
    ((bits >> 15) & 0xFFFF) as u16
}

#[allow(clippy::too_many_arguments)]
pub fn emit_draw_renderers(
    scene: &RetainedRenderScene,
    cull: &CullRecord,
    args: &DrawRenderersArgs,
    pso_table: &mut PsoTable,
    arena: &mut FrameBumpArena,
    out_phys_cmds: &mut Vec<u32>,
    out_submitted_bitmap: &mut [u32],
    out_instance_rows: &mut Vec<u32>,
    stats: &mut DrawListStats,
) {
    let visible_start = cull.visible_rows_start;
    let visible_end = visible_start + cull.visible_rows_len;
    let shadow_only = (args.draw_flags & DRAW_FLAG_SHADOW_CASTER_ONLY) != 0;
    let enable_instancing = (args.draw_flags & DRAW_FLAG_INSTANCING) != 0;

    // Collect filtered candidates (reuse Vec capacity from arena bytes or local bounded stack)
    let mut items: Vec<DrawItem> = Vec::with_capacity(cull.visible_rows_len);

    for idx in visible_start..visible_end {
        let row = arena.u32_words[idx] as usize;
        if (scene.layer_masks[row] & args.layer_mask) == 0 {
            continue;
        }
        let queue = scene.queues[row];
        if queue < args.queue_min || queue > args.queue_max {
            continue;
        }
        let flags = scene.obj_flags[row];
        if shadow_only && (flags & OBJ_FLAG_CAST_SHADOW) == 0 {
            continue;
        }

        let mesh_id = scene.mesh_ids[row];
        let material_id = scene.material_ids[row];
        let (Ok(mesh), Ok(mat)) = (scene.meshes.get(mesh_id), scene.materials.get(material_id))
        else {
            if stats.first_missing_object_id == INVALID_HANDLE {
                stats.first_missing_object_id = scene.object_ids[row];
                stats.first_missing_submesh = scene.submesh_start[row] as u32;
            }
            continue;
        };

        let shader_id = if args.override_shader != INVALID_HANDLE {
            args.override_shader
        } else {
            mat.shader_program_id
        };
        let variant_flags = mat.variant_flags
            | if (flags & OBJ_FLAG_GPU_DRIVEN) != 0 && (args.draw_flags & DRAW_FLAG_GPU_DRIVEN) != 0
            {
                0x0001
            } else {
                0
            };

        let pso_key = PsoKey::pack(
            shader_id,
            mesh.vertex_layout_id,
            args.pass_attachment_id,
            args.pass_tag,
            mat.layout_family_id,
            mat.render_state_bits,
            variant_flags,
        );
        let pso = pso_table.get_or_admit(pso_key, PsoStatus::Ready);
        if pso.status != PsoStatus::Ready {
            stats.pending_pipelines += 1;
            if stats.first_missing_object_id == INVALID_HANDLE {
                stats.first_missing_object_id = scene.object_ids[row];
                stats.first_missing_submesh = scene.submesh_start[row] as u32;
            }
            continue;
        }

        let t = &scene.transforms[row];
        let dx = t[12] - cull.camera_pos[0];
        let dy = t[13] - cull.camera_pos[1];
        let dz = t[14] - cull.camera_pos[2];
        let depth_q = quantize_dist_sq_u16(dx, dy, dz);

        let sort_key: u64 = match args.sort_mode {
            SORT_BACK_TO_FRONT => {
                // Farther first (descending depth), stable entity order tie-breaker
                let inv_depth = (0xFFFFu16 - depth_q) as u64;
                (inv_depth << 48)
                    | ((scene.entity_orders[row] as u64) << 32)
                    | ((material_id & 0xFFFF) as u64) << 16
                    | (row as u64 & 0xFFFF)
            }
            SORT_FRONT_TO_BACK => {
                (((pso.slot_id & 0xFFFF) as u64) << 48)
                    | (((material_id & 0xFFFF) as u64) << 32)
                    | ((depth_q as u64) << 16)
                    | (row as u64 & 0xFFFF)
            }
            SORT_MATERIAL_PSO => {
                (((pso.slot_id & 0xFFFF) as u64) << 48)
                    | (((mat.layout_family_id) as u64) << 32)
                    | (((material_id & 0xFFFF) as u64) << 16)
                    | ((mesh_id & 0xFFFF) as u64)
            }
            _ => row as u64,
        };

        let sub_idx = scene.submesh_start[row] as usize;
        let (first_index, index_count, base_vertex, first_vertex, vertex_count) =
            if let Some(sub) = mesh.submeshes.get(sub_idx) {
                (
                    sub.first_index,
                    sub.index_count,
                    sub.base_vertex,
                    sub.first_vertex,
                    sub.vertex_count,
                )
            } else {
                (0, mesh.index_count, 0, 0, mesh.vertex_count)
            };

        items.push(DrawItem {
            sort_key,
            row: row as u32,
            pso_slot: pso.slot_id,
            pso_key,
            mesh_id,
            material_id,
            layout_family_id: mat.layout_family_id,
            first_index,
            index_count,
            base_vertex,
            first_vertex,
            vertex_count,
            is_uint32_index: mesh.is_uint32_index,
        });

        let word_idx = row >> 5;
        if word_idx < out_submitted_bitmap.len() {
            out_submitted_bitmap[word_idx] |= 1u32 << (row & 31);
        }
    }

    if items.is_empty() {
        return;
    }

    if args.sort_mode != SORT_NONE {
        items.sort_unstable_by_key(|it| it.sort_key);
    }

    // Bind Group 0 (View UBO + optional extraBindings) once for the draw list
    out_phys_cmds.push(cmd_header(PHYS_SET_BIND_GROUP, 6));
    out_phys_cmds.push(BGL_SLOT_VIEW);
    out_phys_cmds.push(args.extra_bindings);
    out_phys_cmds.push(2); // dynamic offsets: [view_uniform_off, view_slot_mode]
    out_phys_cmds.push(args.view_uniform_off);
    out_phys_cmds.push(args.view_slot_mode);

    // State-diffed draw emission with adjacent instancing folding
    let mut cur_pso = u32::MAX;
    let mut cur_mat = u32::MAX;
    let mut cur_mesh = u32::MAX;

    let mut i = 0usize;
    while i < items.len() {
        let item = items[i];
        let mut instance_count = 1u32;
        if enable_instancing && args.sort_mode != SORT_BACK_TO_FRONT {
            while i + (instance_count as usize) < items.len() {
                let next = items[i + instance_count as usize];
                if next.pso_slot == item.pso_slot
                    && next.material_id == item.material_id
                    && next.mesh_id == item.mesh_id
                    && next.first_index == item.first_index
                    && next.index_count == item.index_count
                    && next.base_vertex == item.base_vertex
                    && next.first_vertex == item.first_vertex
                    && next.vertex_count == item.vertex_count
                {
                    instance_count += 1;
                } else {
                    break;
                }
            }
        }

        if item.pso_slot != cur_pso {
            cur_pso = item.pso_slot;
            let w = item.pso_key.to_u32x4();
            out_phys_cmds.push(cmd_header(PHYS_SET_PSO, 6));
            out_phys_cmds.extend_from_slice(&w);
            out_phys_cmds.push(item.pso_slot);
        }

        if item.material_id != cur_mat {
            cur_mat = item.material_id;
            out_phys_cmds.push(cmd_header(PHYS_SET_BIND_GROUP, 4));
            out_phys_cmds.push(BGL_SLOT_MATERIAL);
            out_phys_cmds.push(item.material_id);
            out_phys_cmds.push(0);
        }

        if item.mesh_id != cur_mesh {
            cur_mesh = item.mesh_id;
            out_phys_cmds.push(cmd_header(PHYS_SET_VB, 4));
            out_phys_cmds.push(0);
            out_phys_cmds.push(item.mesh_id);
            out_phys_cmds.push(0);
            if item.index_count > 0 {
                out_phys_cmds.push(cmd_header(PHYS_SET_IB, 4));
                out_phys_cmds.push(item.mesh_id);
                out_phys_cmds.push(u32::from(item.is_uint32_index));
                out_phys_cmds.push(0);
            }
        }

        let first_instance = if item.layout_family_id == LAYOUT_FAMILY_SCENE_4BGL {
            let base = out_instance_rows.len() as u32;
            for k in 0..instance_count as usize {
                out_instance_rows.push(items[i + k].row);
            }
            base
        } else {
            item.row
        };

        if item.index_count > 0 {
            out_phys_cmds.push(cmd_header(PHYS_DRAW_INDEXED, 6));
            out_phys_cmds.push(item.index_count);
            out_phys_cmds.push(instance_count);
            out_phys_cmds.push(item.first_index);
            out_phys_cmds.push(item.base_vertex as u32);
            out_phys_cmds.push(first_instance);
        } else {
            out_phys_cmds.push(cmd_header(PHYS_DRAW, 5));
            out_phys_cmds.push(item.vertex_count);
            out_phys_cmds.push(instance_count);
            out_phys_cmds.push(item.first_vertex);
            out_phys_cmds.push(first_instance);
        }
        stats.submitted_draws += 1;
        i += instance_count as usize;
    }
}
