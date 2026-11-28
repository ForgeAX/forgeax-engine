//! Lightweight pure-compute WASM bindings for ForgeAX RenderKernel.
//! Zero wgpu dependency: compiles to a tiny WASM binary (~60-120 KB) and exposes
//! linear memory pointers for zero-copy JS TypedArray views.

use forgeax_render_kernel_core::batch_accel::{
    batch_cull_world_aabbs, batch_sort_transparent_into, batch_transform_and_cull,
};
use forgeax_render_kernel_core::cull::CullParams;
use forgeax_render_kernel_core::scene::{MaterialMeta, MeshMeta};
use forgeax_render_kernel_core::{KernelCoreError, RenderKernelCore};
use wasm_bindgen::prelude::*;

fn map_err(e: KernelCoreError) -> JsValue {
    let code = match e {
        KernelCoreError::Handle(h) => match h {
            forgeax_render_kernel_core::handles::HandleError::Invalid => "kernel-handle-invalid",
            forgeax_render_kernel_core::handles::HandleError::StaleGeneration => {
                "kernel-handle-stale-generation"
            }
            forgeax_render_kernel_core::handles::HandleError::AlreadyDestroyed => {
                "kernel-handle-already-destroyed"
            }
            forgeax_render_kernel_core::handles::HandleError::CapacityExceeded => {
                "kernel-budget-exceeded"
            }
        },
        KernelCoreError::Delta(d) => match d {
            forgeax_render_kernel_core::scene::DeltaError::MalformedHeader
            | forgeax_render_kernel_core::scene::DeltaError::MalformedPayload => {
                "kernel-delta-malformed"
            }
            forgeax_render_kernel_core::scene::DeltaError::VersionMismatch => {
                "kernel-protocol-version-mismatch"
            }
            forgeax_render_kernel_core::scene::DeltaError::BaseMismatch => {
                "kernel-delta-base-mismatch"
            }
            forgeax_render_kernel_core::scene::DeltaError::InvalidHandle(_) => {
                "kernel-handle-invalid"
            }
        },
        KernelCoreError::Plan(p) => match p {
            forgeax_render_kernel_core::planner::PlanError::MalformedStream => {
                "kernel-command-stream-malformed"
            }
            forgeax_render_kernel_core::planner::PlanError::PassResourceConflict => {
                "kernel-pass-resource-conflict"
            }
            forgeax_render_kernel_core::planner::PlanError::TempTextureOutOfScope => {
                "kernel-temp-texture-out-of-scope"
            }
            forgeax_render_kernel_core::planner::PlanError::InvalidCullHandle => {
                "kernel-handle-invalid"
            }
        },
        KernelCoreError::FrameNotActive | KernelCoreError::FrameAlreadyActive => {
            "kernel-command-stream-malformed"
        }
    };
    JsValue::from_str(code)
}

#[wasm_bindgen]
pub struct WasmRenderKernel {
    core: RenderKernelCore,
    // Persistent zero-copy scratch buffers exposed via raw ptr + len to JS views
    delta_buf: Vec<u8>,
    cmd_buf: Vec<u32>,
    cull_vp_buf: [f32; 16],
    // Flat output summary buffer for cull() (12 u32/f32 words + visible lights table)
    cull_summary_words: [u32; 14],
    cull_lights_words: Vec<u32>,
    // Flat output receipt buffer for submit_frame() (10 u32 words)
    receipt_words: [u32; 10],
    // Packed GPU buffers for 4-BGL RHI replay (96B/object, 64B/light)
    scene_objects_gpu: Vec<u8>,
    scene_lights_gpu: Vec<u8>,
}

#[wasm_bindgen]
impl WasmRenderKernel {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            core: RenderKernelCore::new(),
            delta_buf: vec![0u8; 64 * 1024],
            cmd_buf: vec![0u32; 8192],
            cull_vp_buf: [0.0; 16],
            cull_summary_words: [0; 14],
            cull_lights_words: Vec::with_capacity(256),
            receipt_words: [0; 10],
            scene_objects_gpu: Vec::new(),
            scene_lights_gpu: Vec::new(),
        }
    }

    pub fn register_mesh(
        &mut self,
        vertex_layout_id: u16,
        index_count: u32,
        vertex_count: u32,
        is_uint32_index: bool,
        topology: u8,
    ) -> Result<u32, JsValue> {
        self.core
            .register_mesh(MeshMeta {
                vertex_layout_id,
                index_count,
                vertex_count,
                is_uint32_index,
                topology,
                submeshes: Vec::new(),
            })
            .map_err(map_err)
    }

    /// Sets submesh ranges for a registered mesh (packed 5 u32 words per submesh:
    /// `[first_index, index_count, base_vertex_bits, first_vertex, vertex_count]`).
    pub fn set_mesh_submeshes(&mut self, id: u32, packed: &[u32]) -> Result<(), JsValue> {
        let mesh = self
            .core
            .scene
            .meshes
            .get_mut(id)
            .map_err(|_| JsValue::from_str("kernel-handle-invalid"))?;
        mesh.submeshes.clear();
        for chunk in packed.chunks_exact(5) {
            mesh.submeshes.push(forgeax_render_kernel_core::scene::SubmeshRange {
                first_index: chunk[0],
                index_count: chunk[1],
                base_vertex: chunk[2] as i32,
                first_vertex: chunk[3],
                vertex_count: chunk[4],
            });
        }
        Ok(())
    }

    pub fn destroy_mesh(&mut self, id: u32) -> Result<(), JsValue> {
        self.core.destroy_mesh(id).map_err(map_err)
    }

    pub fn register_texture(&mut self, width: u32, height: u32, format: u8) -> Result<u32, JsValue> {
        self.core
            .register_texture(width, height, format)
            .map_err(map_err)
    }

    pub fn destroy_texture(&mut self, id: u32) -> Result<(), JsValue> {
        self.core.destroy_texture(id).map_err(map_err)
    }

    pub fn register_dynamic_texture(
        &mut self,
        width: u32,
        height: u32,
        format: u8,
    ) -> Result<u32, JsValue> {
        self.core
            .register_dynamic_texture(width, height, format)
            .map_err(map_err)
    }

    pub fn update_dynamic_texture(
        &mut self,
        id: u32,
        revision: u32,
        width: u32,
        height: u32,
    ) -> Result<bool, JsValue> {
        self.core
            .update_dynamic_texture(id, revision, width, height)
            .map_err(map_err)
    }

    pub fn destroy_dynamic_texture(&mut self, id: u32) -> Result<(), JsValue> {
        self.core.destroy_dynamic_texture(id).map_err(map_err)
    }

    pub fn register_buffer(&mut self, byte_size: u32) -> Result<u32, JsValue> {
        self.core.register_buffer(byte_size).map_err(map_err)
    }

    pub fn destroy_buffer(&mut self, id: u32) -> Result<(), JsValue> {
        self.core.destroy_buffer(id).map_err(map_err)
    }

    pub fn register_sampler(&mut self, hash: u32) -> Result<u32, JsValue> {
        self.core.register_sampler(hash).map_err(map_err)
    }

    pub fn destroy_sampler(&mut self, id: u32) -> Result<(), JsValue> {
        self.core.destroy_sampler(id).map_err(map_err)
    }

    pub fn register_shader(&mut self, layout_family_id: u32) -> Result<u32, JsValue> {
        self.core.register_shader(layout_family_id).map_err(map_err)
    }

    pub fn destroy_shader(&mut self, id: u32) -> Result<(), JsValue> {
        self.core.destroy_shader(id).map_err(map_err)
    }

    pub fn register_material(
        &mut self,
        shader_program_id: u32,
        layout_family_id: u16,
        render_state_bits: u32,
        variant_flags: u16,
        queue: u16,
        param_bytes_len: u32,
    ) -> Result<u32, JsValue> {
        self.core
            .register_material(MaterialMeta {
                shader_program_id,
                layout_family_id,
                render_state_bits,
                variant_flags,
                queue,
                param_bytes: vec![0u8; param_bytes_len as usize],
                param_dirty: false,
                dynamic_tex_refs: Vec::new(),
                bind_group_generation: 1,
            })
            .map_err(map_err)
    }

    pub fn destroy_material(&mut self, id: u32) -> Result<(), JsValue> {
        self.core.destroy_material(id).map_err(map_err)
    }

    /// Ensures delta staging buffer has at least `min_bytes` and returns its linear memory pointer.
    pub fn ensure_delta_buffer(&mut self, min_bytes: usize) -> *mut u8 {
        if self.delta_buf.len() < min_bytes {
            let next = min_bytes.next_power_of_two().max(64 * 1024);
            self.delta_buf.resize(next, 0);
        }
        self.delta_buf.as_mut_ptr()
    }

    pub fn delta_buffer_capacity(&self) -> usize {
        self.delta_buf.len()
    }

    pub fn commit_scene_delta_len(&mut self, byte_len: usize) -> Result<u32, JsValue> {
        let len = byte_len.min(self.delta_buf.len());
        self.core
            .commit_scene_delta(&self.delta_buf[..len])
            .map_err(map_err)
    }

    pub fn begin_frame(
        &mut self,
        frame_id: u32,
        surface_width: u32,
        surface_height: u32,
    ) -> Result<(), JsValue> {
        self.core
            .begin_frame(frame_id as u64, surface_width, surface_height)
            .map_err(map_err)
    }

    pub fn cull_vp_ptr(&mut self) -> *mut f32 {
        self.cull_vp_buf.as_mut_ptr()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cull(
        &mut self,
        cam_x: f32,
        cam_y: f32,
        cam_z: f32,
        layer_mask: u32,
        flags: u32,
        lod_bias: f32,
    ) -> Result<u32, JsValue> {
        let params = CullParams {
            view_proj: self.cull_vp_buf,
            camera_pos: [cam_x, cam_y, cam_z],
            layer_mask,
            flags,
            lod_bias,
        };
        let rec = self.core.cull(&params).map_err(map_err)?;
        self.cull_summary_words[0] = rec.cull_id;
        self.cull_summary_words[1] = rec.candidate_count;
        self.cull_summary_words[2] = rec.visible_opaque_count;
        self.cull_summary_words[3] = rec.visible_masked_count;
        self.cull_summary_words[4] = rec.visible_transparent_count;
        self.cull_summary_words[5] = rec.visible_shadow_caster_count;
        self.cull_summary_words[6] = rec.visible_bounds_min[0].to_bits();
        self.cull_summary_words[7] = rec.visible_bounds_min[1].to_bits();
        self.cull_summary_words[8] = rec.visible_bounds_min[2].to_bits();
        self.cull_summary_words[9] = rec.visible_bounds_max[0].to_bits();
        self.cull_summary_words[10] = rec.visible_bounds_max[1].to_bits();
        self.cull_summary_words[11] = rec.visible_bounds_max[2].to_bits();
        self.cull_summary_words[12] = rec.visible_lights.len() as u32;
        self.cull_summary_words[13] = rec.visible_rows_len as u32;

        self.cull_lights_words.clear();
        for l in &rec.visible_lights {
            self.cull_lights_words.push(l.light_id);
            self.cull_lights_words.push(
                (l.kind as u32)
                    | ((u32::from(l.cast_shadow)) << 8)
                    | ((l.cascade_count as u32) << 16),
            );
            self.cull_lights_words.push(l.screen_coverage.to_bits());
        }
        Ok(rec.cull_id)
    }

    pub fn cull_summary_ptr(&self) -> *const u32 {
        self.cull_summary_words.as_ptr()
    }

    pub fn cull_lights_ptr(&self) -> *const u32 {
        self.cull_lights_words.as_ptr()
    }

    pub fn ensure_cmd_buffer(&mut self, min_words: usize) -> *mut u32 {
        if self.cmd_buf.len() < min_words {
            let next = min_words.next_power_of_two().max(8192);
            self.cmd_buf.resize(next, 0);
        }
        self.cmd_buf.as_mut_ptr()
    }

    pub fn cmd_buffer_capacity(&self) -> usize {
        self.cmd_buf.len()
    }

    pub fn submit_frame_words(&mut self, word_len: usize) -> Result<usize, JsValue> {
        let len = word_len.min(self.cmd_buf.len());
        let stats = self
            .core
            .submit_frame(&self.cmd_buf[..len])
            .map_err(map_err)?;
        self.receipt_words[0] = stats.submitted_pass_count;
        self.receipt_words[1] = stats.merged_pass_count;
        self.receipt_words[2] = stats.submitted_draw_count;
        self.receipt_words[3] = stats.submitted_indirect_count;
        self.receipt_words[4] = stats.pending_pipeline_count;
        self.receipt_words[5] = stats.first_missing_object_id;
        self.receipt_words[6] = stats.first_missing_submesh;
        self.receipt_words[7] = stats.pool_texture_count;
        self.receipt_words[8] = stats.pool_allocations;
        self.receipt_words[9] = stats.pool_reuses;
        Ok(self.core.resolved_phys_cmds.len())
    }

    pub fn resolved_cmds_ptr(&self) -> *const u32 {
        self.core.resolved_phys_cmds.as_ptr()
    }

    pub fn resolved_cmds_len(&self) -> usize {
        self.core.resolved_phys_cmds.len()
    }

    pub fn receipt_ptr(&self) -> *const u32 {
        self.receipt_words.as_ptr()
    }

    pub fn submitted_bitmap_ptr(&self) -> *const u32 {
        self.core.submitted_bitmap.as_ptr()
    }

    pub fn submitted_bitmap_len(&self) -> usize {
        self.core.submitted_bitmap.len()
    }

    pub fn object_count(&self) -> usize {
        self.core.scene.object_count()
    }

    pub fn instance_rows_ptr(&self) -> *const u32 {
        self.core.draw_instance_rows.as_ptr()
    }

    pub fn instance_rows_len(&self) -> usize {
        self.core.draw_instance_rows.len()
    }

    /// Packs live scene objects into 96-byte GPU rows matching `kernel-wgpu/src/scene_gpu.rs`.
    pub fn pack_scene_objects_gpu(&mut self) -> usize {
        let count = self.core.scene.object_count();
        self.scene_objects_gpu.clear();
        self.scene_objects_gpu.reserve(count * 96);
        for row in 0..count {
            let world = &self.core.scene.transforms[row];
            let dp = &self.core.scene.draw_params[row];
            let skin_slot = self.core.scene.skin_slots[row];
            for &v in world {
                self.scene_objects_gpu.extend_from_slice(&v.to_le_bytes());
            }
            for &v in &dp[0..4] {
                self.scene_objects_gpu.extend_from_slice(&v.to_le_bytes());
            }
            for &v in &dp[4..7] {
                self.scene_objects_gpu.extend_from_slice(&v.to_le_bytes());
            }
            let p7 = if skin_slot != 0 { skin_slot as f32 } else { dp[7] };
            self.scene_objects_gpu.extend_from_slice(&p7.to_le_bytes());
        }
        self.scene_objects_gpu.len()
    }

    pub fn scene_objects_gpu_ptr(&self) -> *const u8 {
        self.scene_objects_gpu.as_ptr()
    }

    /// Packs live scene lights into 64-byte GPU records matching `kernel-wgpu/src/scene_gpu.rs`.
    pub fn pack_scene_lights_gpu(&mut self) -> usize {
        let lights = &self.core.scene.lights;
        self.scene_lights_gpu.clear();
        self.scene_lights_gpu.reserve(lights.len() * 64);
        for l in lights {
            let floats = [
                l.position[0],
                l.position[1],
                l.position[2],
                l.range,
                l.direction[0],
                l.direction[1],
                l.direction[2],
                l.intensity,
                l.color[0],
                l.color[1],
                l.color[2],
                l.outer_cone_cos,
            ];
            for v in floats {
                self.scene_lights_gpu.extend_from_slice(&v.to_le_bytes());
            }
            let meta = [
                l.kind as u32,
                u32::from(l.cast_shadow),
                l.cascade_count as u32,
                l.layer_mask,
            ];
            for m in meta {
                self.scene_lights_gpu.extend_from_slice(&m.to_le_bytes());
            }
        }
        self.scene_lights_gpu.len()
    }

    pub fn scene_lights_gpu_ptr(&self) -> *const u8 {
        self.scene_lights_gpu.as_ptr()
    }
}

/// Standalone zero-GC bulk numerical hot-path accelerator for direct integration into `@forgeax/engine-render`.
#[wasm_bindgen]
pub struct WasmHotPathAccel {
    local_aabbs: Vec<f32>,
    world_matrices: Vec<f32>,
    flags: Vec<u32>,
    layer_masks: Vec<u32>,
    camera_vp: [f32; 16],
    out_visible: Vec<u32>,
    out_world_aabbs: Vec<f32>,
    sort_positions: Vec<f32>,
    sort_layers: Vec<i32>,
    sort_ties: Vec<u32>,
    out_sort_order: Vec<u32>,
    sort_scratch: Vec<(i32, u32, u32, u32)>,
    world_aabbs: Vec<f32>,
    frustum_planes: Vec<f32>,
    out_vis_bits: Vec<u32>,
}

#[wasm_bindgen]
impl WasmHotPathAccel {
    #[wasm_bindgen(constructor)]
    pub fn new(initial_capacity: usize) -> Self {
        let cap = initial_capacity.max(256);
        let vis_words = cap.div_ceil(32);
        Self {
            local_aabbs: vec![0.0; cap * 6],
            world_matrices: vec![0.0; cap * 16],
            flags: vec![0; cap],
            layer_masks: vec![0; cap],
            camera_vp: [0.0; 16],
            out_visible: vec![0; cap],
            out_world_aabbs: vec![0.0; cap * 6],
            sort_positions: vec![0.0; cap * 3],
            sort_layers: vec![0; cap],
            sort_ties: vec![0; cap],
            out_sort_order: vec![0; cap],
            sort_scratch: Vec::with_capacity(cap),
            world_aabbs: vec![0.0; cap * 6],
            frustum_planes: vec![0.0; 8 * 24],
            out_vis_bits: vec![0; vis_words],
        }
    }

    pub fn ensure_capacity(&mut self, count: usize) {
        if count <= self.flags.len() {
            return;
        }
        let cap = count.next_power_of_two();
        let vis_words = cap.div_ceil(32);
        self.local_aabbs.resize(cap * 6, 0.0);
        self.world_matrices.resize(cap * 16, 0.0);
        self.flags.resize(cap, 0);
        self.layer_masks.resize(cap, 0);
        self.out_visible.resize(cap, 0);
        self.out_world_aabbs.resize(cap * 6, 0.0);
        self.sort_positions.resize(cap * 3, 0.0);
        self.sort_layers.resize(cap, 0);
        self.sort_ties.resize(cap, 0);
        self.out_sort_order.resize(cap, 0);
        self.world_aabbs.resize(cap * 6, 0.0);
        self.out_vis_bits.resize(vis_words, 0);
    }

    pub fn ensure_frustum_cameras(&mut self, camera_count: usize) {
        let needed = camera_count.max(1) * 24;
        if needed > self.frustum_planes.len() {
            self.frustum_planes.resize(needed.next_power_of_two(), 0.0);
        }
    }

    pub fn local_aabbs_ptr(&mut self) -> *mut f32 {
        self.local_aabbs.as_mut_ptr()
    }
    pub fn world_matrices_ptr(&mut self) -> *mut f32 {
        self.world_matrices.as_mut_ptr()
    }
    pub fn flags_ptr(&mut self) -> *mut u32 {
        self.flags.as_mut_ptr()
    }
    pub fn layer_masks_ptr(&mut self) -> *mut u32 {
        self.layer_masks.as_mut_ptr()
    }
    pub fn camera_vp_ptr(&mut self) -> *mut f32 {
        self.camera_vp.as_mut_ptr()
    }
    pub fn out_visible_ptr(&self) -> *const u32 {
        self.out_visible.as_ptr()
    }
    pub fn out_world_aabbs_ptr(&self) -> *const f32 {
        self.out_world_aabbs.as_ptr()
    }
    pub fn world_aabbs_ptr(&mut self) -> *mut f32 {
        self.world_aabbs.as_mut_ptr()
    }
    pub fn frustum_planes_ptr(&mut self) -> *mut f32 {
        self.frustum_planes.as_mut_ptr()
    }
    pub fn out_vis_bits_ptr(&self) -> *const u32 {
        self.out_vis_bits.as_ptr()
    }

    pub fn run_cull_world_aabbs(&mut self, count: usize, camera_count: usize) -> usize {
        self.ensure_capacity(count);
        self.ensure_frustum_cameras(camera_count);
        let words = count.div_ceil(32);
        batch_cull_world_aabbs(
            count,
            &self.world_aabbs[..count * 6],
            camera_count,
            &self.frustum_planes[..camera_count * 24],
            &mut self.out_vis_bits[..words],
        )
    }

    pub fn run_transform_and_cull(
        &mut self,
        count: usize,
        camera_layer_mask: u32,
        shadow_caster_only: bool,
        write_world_aabbs: bool,
    ) -> usize {
        self.ensure_capacity(count);
        let aabb_slice: &mut [f32] = if write_world_aabbs {
            &mut self.out_world_aabbs[..count * 6]
        } else {
            &mut []
        };
        batch_transform_and_cull(
            count,
            &self.local_aabbs[..count * 6],
            &self.world_matrices[..count * 16],
            &self.flags[..count],
            &self.layer_masks[..count],
            &self.camera_vp,
            camera_layer_mask,
            shadow_caster_only,
            &mut self.out_visible[..count],
            aabb_slice,
        )
    }

    pub fn sort_positions_ptr(&mut self) -> *mut f32 {
        self.sort_positions.as_mut_ptr()
    }
    pub fn sort_layers_ptr(&mut self) -> *mut i32 {
        self.sort_layers.as_mut_ptr()
    }
    pub fn sort_ties_ptr(&mut self) -> *mut u32 {
        self.sort_ties.as_mut_ptr()
    }
    pub fn out_sort_order_ptr(&self) -> *const u32 {
        self.out_sort_order.as_ptr()
    }

    pub fn run_sort_transparent(&mut self, count: usize, eye_x: f32, eye_y: f32, eye_z: f32) {
        self.ensure_capacity(count);
        batch_sort_transparent_into(
            count,
            &self.sort_positions[..count * 3],
            &self.sort_layers[..count],
            &self.sort_ties[..count],
            [eye_x, eye_y, eye_z],
            &mut self.out_sort_order[..count],
            &mut self.sort_scratch,
        );
    }
}

/// Exposes WASM linear memory so JS can construct zero-copy TypedArray views.
#[wasm_bindgen]
pub fn wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}
