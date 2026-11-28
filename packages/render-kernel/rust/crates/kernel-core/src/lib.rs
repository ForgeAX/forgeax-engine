//! ForgeAX RenderKernel Core (backend-agnostic Rust core compiled to both wasm32 and native).

pub mod arena;
pub mod batch_accel;
pub mod cull;
pub mod draw_list;
pub mod handles;
pub mod planner;
pub mod pso;
pub mod scene;

use crate::arena::FrameBumpArena;
use crate::cull::{execute_cull, CullParams, CullRecord};
use crate::handles::HandleError;
use crate::planner::{plan_and_lower_frame, PlanError, PlanResultStats, TransientTexturePool};
use crate::pso::PsoTable;
use crate::scene::{
    DeltaError, DynamicTextureMeta, MaterialMeta, MeshMeta, RetainedRenderScene,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelCoreError {
    Handle(HandleError),
    Delta(DeltaError),
    Plan(PlanError),
    FrameNotActive,
    FrameAlreadyActive,
}

impl From<HandleError> for KernelCoreError {
    fn from(e: HandleError) -> Self {
        Self::Handle(e)
    }
}
impl From<DeltaError> for KernelCoreError {
    fn from(e: DeltaError) -> Self {
        Self::Delta(e)
    }
}
impl From<PlanError> for KernelCoreError {
    fn from(e: PlanError) -> Self {
        Self::Plan(e)
    }
}

/// Complete backend-agnostic RenderKernel state machine.
pub struct RenderKernelCore {
    pub scene: RetainedRenderScene,
    pub pso_table: PsoTable,
    pub rt_pool: TransientTexturePool,
    pub arena: FrameBumpArena,
    pub culls: Vec<CullRecord>,
    pub resolved_phys_cmds: Vec<u32>,
    pub submitted_bitmap: Vec<u32>,
    pub draw_instance_rows: Vec<u32>,
    pub active_frame_id: Option<u64>,
    pub surface_width: u32,
    pub surface_height: u32,
    next_cull_id: u32,
}

impl Default for RenderKernelCore {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderKernelCore {
    pub fn new() -> Self {
        Self {
            scene: RetainedRenderScene::new(),
            pso_table: PsoTable::new(),
            rt_pool: TransientTexturePool::new(),
            arena: FrameBumpArena::with_capacity(16384, 4096, 16384, 65536),
            culls: Vec::with_capacity(16),
            resolved_phys_cmds: Vec::with_capacity(8192),
            submitted_bitmap: Vec::with_capacity(128),
            draw_instance_rows: Vec::with_capacity(4096),
            active_frame_id: None,
            surface_width: 1,
            surface_height: 1,
            next_cull_id: 1,
        }
    }

    pub fn register_mesh(&mut self, meta: MeshMeta) -> Result<u32, KernelCoreError> {
        Ok(self.scene.meshes.insert(meta)?)
    }

    pub fn destroy_mesh(&mut self, id: u32) -> Result<(), KernelCoreError> {
        self.scene.meshes.remove(id)?;
        Ok(())
    }

    pub fn register_texture(&mut self, width: u32, height: u32, format: u8) -> Result<u32, KernelCoreError> {
        Ok(self.scene.textures.insert((width, height, format))?)
    }

    pub fn destroy_texture(&mut self, id: u32) -> Result<(), KernelCoreError> {
        self.scene.textures.remove(id)?;
        Ok(())
    }

    pub fn register_dynamic_texture(
        &mut self,
        width: u32,
        height: u32,
        format: u8,
    ) -> Result<u32, KernelCoreError> {
        Ok(self.scene.dynamic_textures.insert(DynamicTextureMeta {
            width,
            height,
            format,
            revision: 0,
            view_generation: 1,
            in_place_updates: 0,
            reallocations: 0,
        })?)
    }

    pub fn update_dynamic_texture(
        &mut self,
        id: u32,
        revision: u32,
        width: u32,
        height: u32,
    ) -> Result<bool, KernelCoreError> {
        Ok(self.scene.update_dynamic_texture(id, revision, width, height)?)
    }

    pub fn destroy_dynamic_texture(&mut self, id: u32) -> Result<(), KernelCoreError> {
        self.scene.dynamic_textures.remove(id)?;
        Ok(())
    }

    pub fn register_buffer(&mut self, byte_size: u32) -> Result<u32, KernelCoreError> {
        Ok(self.scene.buffers.insert(byte_size)?)
    }

    pub fn destroy_buffer(&mut self, id: u32) -> Result<(), KernelCoreError> {
        self.scene.buffers.remove(id)?;
        Ok(())
    }

    pub fn register_sampler(&mut self, hash: u32) -> Result<u32, KernelCoreError> {
        Ok(self.scene.samplers.insert(hash)?)
    }

    pub fn destroy_sampler(&mut self, id: u32) -> Result<(), KernelCoreError> {
        self.scene.samplers.remove(id)?;
        Ok(())
    }

    pub fn register_shader(&mut self, layout_family_id: u32) -> Result<u32, KernelCoreError> {
        Ok(self.scene.shaders.insert(layout_family_id)?)
    }

    pub fn destroy_shader(&mut self, id: u32) -> Result<(), KernelCoreError> {
        self.scene.shaders.remove(id)?;
        Ok(())
    }

    pub fn register_material(&mut self, meta: MaterialMeta) -> Result<u32, KernelCoreError> {
        Ok(self.scene.materials.insert(meta)?)
    }

    pub fn destroy_material(&mut self, id: u32) -> Result<(), KernelCoreError> {
        self.scene.materials.remove(id)?;
        Ok(())
    }

    pub fn commit_scene_delta(&mut self, bytes: &[u8]) -> Result<u32, KernelCoreError> {
        Ok(self.scene.apply_scene_delta(bytes)?)
    }

    pub fn begin_frame(
        &mut self,
        frame_id: u64,
        surface_width: u32,
        surface_height: u32,
    ) -> Result<(), KernelCoreError> {
        if self.active_frame_id.is_some() {
            return Err(KernelCoreError::FrameAlreadyActive);
        }
        self.active_frame_id = Some(frame_id);
        self.surface_width = surface_width.max(1);
        self.surface_height = surface_height.max(1);
        self.arena.reset();
        self.culls.clear();
        self.next_cull_id = 1;
        Ok(())
    }

    pub fn cull(&mut self, params: &CullParams) -> Result<&CullRecord, KernelCoreError> {
        if self.active_frame_id.is_none() {
            return Err(KernelCoreError::FrameNotActive);
        }
        let cull_id = self.next_cull_id;
        self.next_cull_id += 1;
        let rec = execute_cull(cull_id, &self.scene, params, &mut self.arena);
        self.culls.push(rec);
        Ok(self.culls.last().unwrap())
    }

    pub fn submit_frame(&mut self, input_cmds: &[u32]) -> Result<PlanResultStats, KernelCoreError> {
        let frame_id = self
            .active_frame_id
            .take()
            .ok_or(KernelCoreError::FrameNotActive)?;
        let stats = plan_and_lower_frame(
            frame_id,
            self.surface_width,
            self.surface_height,
            input_cmds,
            &self.scene,
            &self.culls,
            &mut self.pso_table,
            &mut self.rt_pool,
            &mut self.arena,
            &mut self.resolved_phys_cmds,
            &mut self.submitted_bitmap,
            &mut self.draw_instance_rows,
        )?;
        Ok(stats)
    }

    pub fn is_object_submitted(&self, row: usize) -> bool {
        let w = row >> 5;
        if w >= self.submitted_bitmap.len() {
            return false;
        }
        (self.submitted_bitmap[w] & (1u32 << (row & 31))) != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cull::{CULL_FLAG_COMPUTE_VISIBLE_BOUNDS, CULL_FLAG_CULL_LIGHTS};
    use crate::draw_list::{DRAW_FLAG_INSTANCING, SORT_MATERIAL_PSO};
    use crate::planner::{
        cmd_header, CMD_ACQUIRE_TEMP_TEX, CMD_BEGIN_RENDER_PASS, CMD_DRAW_RENDERERS,
        CMD_END_RENDER_PASS, PHYS_DRAW_INDEXED, PHYS_ENSURE_POOL_TEX, TEMP_TEXTURE_TAG_BIT,
    };
    use crate::scene::{
        DELTA_FLAG_BASELINE, OBJ_FLAG_CAST_SHADOW, OBJ_FLAG_FRUSTUM_CULLED, OBJ_FLAG_VISIBLE,
        OP_REMOVE_OBJECTS, OP_SET_TRANSFORMS, OP_UPSERT_OBJECTS, SCENE_DELTA_HEADER_BYTES,
        SCENE_DELTA_MAGIC, SCENE_DELTA_VERSION,
    };

    fn push_u32(buf: &mut Vec<u8>, v: u32) {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    fn push_f32(buf: &mut Vec<u8>, v: f32) {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    fn push_f64(buf: &mut Vec<u8>, v: f64) {
        buf.extend_from_slice(&v.to_le_bytes());
    }

    #[test]
    fn generational_handle_rejects_stale_and_double_destroy() {
        let mut core = RenderKernelCore::new();
        let h1 = core
            .register_mesh(MeshMeta {
                vertex_layout_id: 1,
                index_count: 36,
                vertex_count: 24,
                is_uint32_index: false,
                topology: 0,
                submeshes: Vec::new(),
            })
            .unwrap();
        core.destroy_mesh(h1).unwrap();
        assert!(core.destroy_mesh(h1).is_err());
        let h2 = core
            .register_mesh(MeshMeta {
                vertex_layout_id: 1,
                index_count: 36,
                vertex_count: 24,
                is_uint32_index: false,
                topology: 0,
                submeshes: Vec::new(),
            })
            .unwrap();
        assert_ne!(h1, h2);
        assert!(core.destroy_mesh(h1).is_err());
    }

    #[test]
    fn dynamic_texture_same_size_update_preserves_view_generation() {
        let mut core = RenderKernelCore::new();
        let dt = core.register_dynamic_texture(256, 256, 1).unwrap();
        assert_eq!(core.update_dynamic_texture(dt, 1, 256, 256).unwrap(), false);
        assert_eq!(core.update_dynamic_texture(dt, 2, 256, 256).unwrap(), false);
        let meta = core.scene.dynamic_textures.get(dt).unwrap();
        assert_eq!(meta.view_generation, 1);
        assert_eq!(meta.in_place_updates, 2);
        // Resize triggers view_generation bump
        assert_eq!(core.update_dynamic_texture(dt, 3, 512, 512).unwrap(), true);
        let meta = core.scene.dynamic_textures.get(dt).unwrap();
        assert_eq!(meta.view_generation, 2);
        assert_eq!(meta.reallocations, 1);
    }

    #[test]
    fn full_frame_delta_cull_instancing_and_rt_pooling() {
        let mut core = RenderKernelCore::new();
        let mesh = core
            .register_mesh(MeshMeta {
                vertex_layout_id: 1,
                index_count: 36,
                vertex_count: 24,
                is_uint32_index: false,
                topology: 0,
                submeshes: Vec::new(),
            })
            .unwrap();
        let shader = core.register_shader(1).unwrap();
        let mat = core
            .register_material(MaterialMeta {
                shader_program_id: shader,
                layout_family_id: 1,
                render_state_bits: 0x01,
                variant_flags: 0,
                queue: 1000,
                param_bytes: vec![0; 64],
                param_dirty: false,
                dynamic_tex_refs: vec![],
                bind_group_generation: 1,
            })
            .unwrap();

        // Build FXK1 baseline SceneDelta with 2 identical objects inside frustum + 1 outside
        let mut payload = Vec::new();
        push_u32(&mut payload, OP_UPSERT_OBJECTS as u32);
        push_u32(&mut payload, 3);
        for oid in 1u32..=3 {
            push_u32(&mut payload, oid);
            push_u32(&mut payload, mesh);
            push_u32(&mut payload, 1); // sub_start=0, sub_count=1
            push_u32(&mut payload, mat);
            push_u32(&mut payload, 0xFFFF_FFFF);
            push_u32(
                &mut payload,
                OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
            );
            push_u32(&mut payload, 0);
            push_u32(&mut payload, (1000u32 << 16) | oid);
            for v in [-0.5f32, -0.5, -0.5, 0.5, 0.5, 0.5] {
                push_f32(&mut payload, v);
            }
        }
        push_u32(&mut payload, OP_SET_TRANSFORMS as u32);
        push_u32(&mut payload, 3);
        push_u32(&mut payload, 1);
        push_u32(&mut payload, 2);
        push_u32(&mut payload, 3);
        let mats = [
            [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.5, 1.0],
            [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.2, 0.0, 0.5, 1.0],
            [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 50.0, 0.0, 0.5, 1.0],
        ];
        for m in mats {
            for f in m {
                push_f32(&mut payload, f);
            }
        }

        let mut delta = Vec::with_capacity(SCENE_DELTA_HEADER_BYTES + payload.len());
        push_u32(&mut delta, SCENE_DELTA_MAGIC);
        push_u32(&mut delta, SCENE_DELTA_VERSION);
        push_u32(&mut delta, 1); // epoch
        push_u32(&mut delta, 1); // revision
        push_u32(&mut delta, 0); // base
        push_u32(&mut delta, DELTA_FLAG_BASELINE);
        push_u32(&mut delta, 2); // op_count
        push_u32(&mut delta, payload.len() as u32);
        push_f64(&mut delta, 0.016);
        push_f64(&mut delta, 0.016);
        push_f64(&mut delta, 0.016);
        push_u32(&mut delta, 0);
        push_u32(&mut delta, 0);
        delta.extend_from_slice(&payload);

        assert_eq!(core.commit_scene_delta(&delta).unwrap(), 1);
        core.begin_frame(1, 1280, 800).unwrap();

        // Identity VP: NDC x,y in [-1,1], z in [0,1]
        let vp = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let cull = core
            .cull(&CullParams {
                view_proj: vp,
                camera_pos: [0.0, 0.0, 0.0],
                layer_mask: 0xFFFF_FFFF,
                flags: CULL_FLAG_CULL_LIGHTS | CULL_FLAG_COMPUTE_VISIBLE_BOUNDS,
                lod_bias: 0.0,
            })
            .unwrap();
        assert_eq!(cull.candidate_count, 3);
        assert_eq!(cull.visible_opaque_count, 2);
        let cull_id = cull.cull_id;

        // Record temp RT + render pass + drawRenderers (instancing folds 2 identical objects into 1 draw!)
        let mut cmds = Vec::new();
        let temp_rt = TEMP_TEXTURE_TAG_BIT | 1;
        cmds.extend_from_slice(&[
            cmd_header(CMD_ACQUIRE_TEMP_TEX, 7),
            temp_rt,
            1 | (1 << 8),
            0,
            0,
            1 | (1 << 16),
            0x10,
        ]);
        cmds.extend_from_slice(&[
            cmd_header(CMD_BEGIN_RENDER_PASS, 11),
            1,
            1, // 1 color, no depth
            temp_rt,
            0,
            0,
            0, // clear
            0,
            0,
            0,
            0x3F80_0000,
        ]);
        cmds.extend_from_slice(&[
            cmd_header(CMD_DRAW_RENDERERS, 11),
            cull_id,
            ((DRAW_FLAG_INSTANCING as u32) << 16) | ((SORT_MATERIAL_PSO as u32) << 8),
            (2499u32 << 16) | 0,
            0xFFFF_FFFF,
            0,
            1392,
            0,
            0,
            0,
            1,
        ]);
        cmds.push(cmd_header(CMD_END_RENDER_PASS, 1));

        let stats = core.submit_frame(&cmds).unwrap();
        assert_eq!(stats.submitted_pass_count, 1);
        assert_eq!(stats.submitted_draw_count, 1); // Folded 2 instances into 1 drawIndexed!
        assert_eq!(stats.pool_allocations, 1);
        assert!(core.resolved_phys_cmds.iter().any(|&w| (w & 0xFFFF) as u16 == PHYS_ENSURE_POOL_TEX));
        assert!(core.resolved_phys_cmds.iter().any(|&w| (w & 0xFFFF) as u16 == PHYS_DRAW_INDEXED));
    }

    #[test]
    fn dirty_rows_dedup_swap_remove_and_trim_idle_scratch() {
        let mut scene = RetainedRenderScene::new();
        let mut payload = Vec::new();
        push_u32(&mut payload, OP_UPSERT_OBJECTS as u32);
        push_u32(&mut payload, 3);
        for oid in [10u32, 20u32, 30u32] {
            push_u32(&mut payload, oid);
            push_u32(&mut payload, 1);
            push_u32(&mut payload, 1);
            push_u32(&mut payload, 1);
            push_u32(&mut payload, 0xFFFF_FFFF);
            push_u32(&mut payload, OBJ_FLAG_VISIBLE);
            push_u32(&mut payload, 0);
            push_u32(&mut payload, oid);
            for v in [-1.0f32, -1.0, -1.0, 1.0, 1.0, 1.0] {
                push_f32(&mut payload, v);
            }
        }

        let mut delta = Vec::new();
        push_u32(&mut delta, SCENE_DELTA_MAGIC);
        push_u32(&mut delta, SCENE_DELTA_VERSION);
        push_u32(&mut delta, 1);
        push_u32(&mut delta, 1);
        push_u32(&mut delta, 0);
        push_u32(&mut delta, DELTA_FLAG_BASELINE);
        push_u32(&mut delta, 1);
        push_u32(&mut delta, payload.len() as u32);
        push_f64(&mut delta, 0.016);
        push_f64(&mut delta, 0.016);
        push_f64(&mut delta, 0.016);
        push_u32(&mut delta, 0);
        push_u32(&mut delta, 0);
        delta.extend_from_slice(&payload);
        assert_eq!(scene.apply_scene_delta(&delta).unwrap(), 1);

        // Repeat OP_SET_TRANSFORMS for row 2 (id=30), then remove id=10 (row 0 swap-removes row 2 -> row 0).
        // Verify dedup and out-of-bounds removed tail filtering in merged_dirty_ranges.
        let mut p2 = Vec::new();
        push_u32(&mut p2, OP_SET_TRANSFORMS as u32);
        push_u32(&mut p2, 2);
        push_u32(&mut p2, 30);
        push_u32(&mut p2, 30);
        for _ in 0..2 {
            for &v in &[
                1.0f32, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 5.0, 0.0, 0.0, 1.0,
            ] {
                push_f32(&mut p2, v);
            }
        }
        push_u32(&mut p2, OP_REMOVE_OBJECTS as u32);
        push_u32(&mut p2, 1);
        push_u32(&mut p2, 10);

        let mut d2 = Vec::new();
        push_u32(&mut d2, SCENE_DELTA_MAGIC);
        push_u32(&mut d2, SCENE_DELTA_VERSION);
        push_u32(&mut d2, 1);
        push_u32(&mut d2, 2);
        push_u32(&mut d2, 1);
        push_u32(&mut d2, 0);
        push_u32(&mut d2, 2);
        push_u32(&mut d2, p2.len() as u32);
        push_f64(&mut d2, 0.032);
        push_f64(&mut d2, 0.016);
        push_f64(&mut d2, 0.032);
        push_u32(&mut d2, 0);
        push_u32(&mut d2, 0);
        d2.extend_from_slice(&p2);
        assert_eq!(scene.apply_scene_delta(&d2).unwrap(), 2);
        assert_eq!(scene.object_count(), 2);
        assert_eq!(scene.transform_dirty_rows, vec![2, 0]);

        let mut ranges = Vec::new();
        scene.merged_dirty_ranges(&mut ranges);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start_row, 0);
        assert_eq!(ranges[0].row_count, 1);

        scene.clear_objects();
        assert_eq!(scene.object_count(), 0);
        assert!(scene.transform_dirty_rows.is_empty());
    }
}
