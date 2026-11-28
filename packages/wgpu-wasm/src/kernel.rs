//! In-WASM RenderKernel + wgpu-executor closure (`RenderKernelCore` + `WgpuKernelExecutor`).
//! Eliminates the JS <-> WASM double-bounce on WebGL2 (`rhi-wgpu`) by executing
//! `SceneDelta`, `cull`, and `PHYS_*` replay in a single WASM crossing directly against
//! the shared `wgpu::Device` / `wgpu::Queue` inside `wgpu-wasm`.

use crate::rhi::{lookup_device, lookup_texture_view};
use forgeax_render_kernel_core::cull::CullParams;
use forgeax_render_kernel_core::scene::{MaterialMeta, MeshMeta};
use forgeax_render_kernel_core::{KernelCoreError, RenderKernelCore};
use forgeax_render_kernel_wgpu::types::{
    NativeBufferDesc, NativeColorTargetDesc, NativeDepthStencilDesc, NativeKernelError,
    NativeMaterialDesc, NativeMeshDesc, NativeSamplerDesc, NativeShaderProgramDesc,
    NativeSubmeshDesc, NativeTextureDesc, NativeVertexAttribute, NativeVertexBufferLayout,
};
use forgeax_render_kernel_wgpu::WgpuKernelExecutor;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsColorTargetDesc {
    format: String,
    #[serde(default)]
    blend_mode: Option<String>,
    #[serde(default)]
    write_mask: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsDepthStencilDesc {
    format: String,
    #[serde(default)]
    depth_write_enabled: Option<bool>,
    #[serde(default)]
    depth_compare: Option<String>,
    #[serde(default)]
    depth_bias: Option<i32>,
    #[serde(default)]
    depth_bias_slope_scale: Option<f32>,
    #[serde(default)]
    depth_bias_clamp: Option<f32>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JsExtraPipelineState {
    #[serde(default)]
    color_targets: Vec<JsColorTargetDesc>,
    #[serde(default)]
    depth_stencil: Option<JsDepthStencilDesc>,
    #[serde(default)]
    cull_mode: Option<String>,
    #[serde(default)]
    front_face: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsVertexAttribute {
    format: String,
    offset: u64,
    shader_location: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsVertexBufferLayout {
    array_stride: u64,
    step_mode: Option<String>,
    attributes: Vec<JsVertexAttribute>,
}

fn map_core_err(e: KernelCoreError) -> JsValue {
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

fn read_forgeax_token(js: &JsValue) -> Option<u32> {
    if js.is_null() || js.is_undefined() {
        return None;
    }
    if let Some(n) = js.as_f64() {
        let tok = n as u32;
        return if tok == 0 { None } else { Some(tok) };
    }
    let val = js_sys::Reflect::get(js, &JsValue::from_str("forgeaxToken")).ok()?;
    let tok = val.as_f64()? as u32;
    if tok == 0 {
        None
    } else {
        Some(tok)
    }
}

fn map_exec_err(e: NativeKernelError) -> JsValue {
    JsValue::from_str(&format!("kernel-wgpu-exec-error:{e}"))
}

#[wasm_bindgen]
pub struct WasmWgpuRenderKernel {
    core: RenderKernelCore,
    executor: WgpuKernelExecutor,
    delta_buf: Vec<u8>,
    cmd_buf: Vec<u32>,
    cull_vp_buf: [f32; 16],
    cull_summary_words: [u32; 14],
    cull_lights_words: Vec<u32>,
    receipt_words: [u32; 10],
    capture_resolved: bool,
}

#[wasm_bindgen]
impl WasmWgpuRenderKernel {
    /// Creates an in-WASM `RenderKernelCore` + `WgpuKernelExecutor` borrowing the
    /// underlying `wgpu::Device` and `wgpu::Queue` from a live `RhiWgpuDevice` handle.
    #[wasm_bindgen(constructor)]
    pub fn new(
        raw_device: &JsValue,
        adapter_name: Option<String>,
        backend_name: Option<String>,
    ) -> Result<WasmWgpuRenderKernel, JsValue> {
        let token = read_forgeax_token(raw_device)
            .ok_or_else(|| JsValue::from_str("kernel-wgpu-missing-device-token"))?;
        let (device, queue) = lookup_device(token)
            .ok_or_else(|| JsValue::from_str("kernel-wgpu-invalid-device"))?;
        let executor = WgpuKernelExecutor::from_device_and_queue(
            device,
            queue,
            adapter_name.unwrap_or_else(|| "wgpu-wasm-webgl".to_owned()),
            backend_name.unwrap_or_else(|| "Gl".to_owned()),
        );
        Ok(Self {
            core: RenderKernelCore::new(),
            executor,
            delta_buf: vec![0u8; 64 * 1024],
            cmd_buf: vec![0u32; 8192],
            cull_vp_buf: [0.0; 16],
            cull_summary_words: [0; 14],
            cull_lights_words: Vec::with_capacity(256),
            receipt_words: [0; 10],
            capture_resolved: false,
        })
    }

    pub fn set_capture_resolved(&mut self, enabled: bool) {
        self.capture_resolved = enabled;
    }

    pub fn supports_scene_4bgl(&self) -> bool {
        self.executor.device.limits().max_storage_buffers_per_shader_stage >= 4
    }

    pub fn gpu_memory_bytes(&self) -> f64 {
        self.executor.gpu_memory_bytes() as f64
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_mesh(
        &mut self,
        vertex_layout_id: u32,
        vertex_data: &[u8],
        index_data: Option<Vec<u8>>,
        index_count: u32,
        vertex_count: u32,
        is_uint32_index: bool,
        topology: u8,
        label: Option<String>,
    ) -> Result<u32, JsValue> {
        let id = self
            .core
            .register_mesh(MeshMeta {
                vertex_layout_id: vertex_layout_id as u16,
                index_count,
                vertex_count,
                is_uint32_index,
                topology,
                submeshes: Vec::new(),
            })
            .map_err(map_core_err)?;
        let desc = NativeMeshDesc {
            vertex_layout_id,
            vertex_count,
            index_count,
            is_uint32_index,
            topology,
            submeshes: vec![NativeSubmeshDesc {
                first_index: 0,
                index_count,
                base_vertex: 0,
                first_vertex: 0,
                vertex_count,
            }],
            label,
        };
        self.executor
            .create_mesh(id, &desc, vertex_data, index_data.as_deref());
        Ok(id)
    }

    pub fn destroy_mesh(&mut self, id: u32) {
        self.executor.destroy_mesh(id);
        let _ = self.core.destroy_mesh(id);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_texture(
        &mut self,
        width: u32,
        height: u32,
        format_code: u8,
        usage: u32,
        data: Option<Vec<u8>>,
        mip_level_count: u32,
        array_layer_count: u32,
        sample_count: u32,
        label: Option<String>,
    ) -> Result<u32, JsValue> {
        let id = self
            .core
            .register_texture(width, height, format_code)
            .map_err(map_core_err)?;
        let desc = NativeTextureDesc {
            width,
            height,
            format_code,
            usage,
            mip_level_count: mip_level_count.max(1),
            array_layer_count: array_layer_count.max(1),
            sample_count: sample_count.max(1),
            label,
        };
        self.executor.create_texture(id, &desc, data.as_deref());
        Ok(id)
    }

    pub fn destroy_texture(&mut self, id: u32) {
        self.executor.destroy_texture(id);
        let _ = self.core.destroy_texture(id);
    }

    pub fn create_dynamic_texture(
        &mut self,
        width: u32,
        height: u32,
        format_code: u8,
    ) -> Result<u32, JsValue> {
        let id = self
            .core
            .register_dynamic_texture(width, height, format_code)
            .map_err(map_core_err)?;
        self.executor
            .create_dynamic_texture(id, width, height, format_code);
        Ok(id)
    }

    pub fn upload_dynamic_texture(
        &mut self,
        id: u32,
        revision: u32,
        width: u32,
        height: u32,
        data: &[u8],
    ) -> Result<bool, JsValue> {
        let reallocated = self
            .core
            .update_dynamic_texture(id, revision, width, height)
            .map_err(map_core_err)?;
        self.executor
            .upload_dynamic_texture(id, width, height, reallocated, data)
            .map_err(map_exec_err)?;
        Ok(reallocated)
    }

    pub fn destroy_dynamic_texture(&mut self, id: u32) {
        self.executor.destroy_dynamic_texture(id);
        let _ = self.core.destroy_dynamic_texture(id);
    }

    pub fn create_buffer(
        &mut self,
        size: u32,
        usage: u32,
        data: Option<Vec<u8>>,
        label: Option<String>,
    ) -> Result<u32, JsValue> {
        let id = self.core.register_buffer(size).map_err(map_core_err)?;
        let desc = NativeBufferDesc { size, usage, label };
        self.executor.create_buffer(id, &desc, data.as_deref());
        Ok(id)
    }

    pub fn write_buffer(&mut self, id: u32, offset: u32, data: &[u8]) -> Result<(), JsValue> {
        self.executor
            .write_buffer(id, offset as u64, data)
            .map_err(map_exec_err)
    }

    pub fn destroy_buffer(&mut self, id: u32) {
        self.executor.destroy_buffer(id);
        let _ = self.core.destroy_buffer(id);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_sampler(
        &mut self,
        hash: u32,
        address_mode_u: Option<String>,
        address_mode_v: Option<String>,
        address_mode_w: Option<String>,
        mag_filter: Option<String>,
        min_filter: Option<String>,
        mipmap_filter: Option<String>,
        compare: Option<String>,
        label: Option<String>,
    ) -> Result<u32, JsValue> {
        let id = self.core.register_sampler(hash).map_err(map_core_err)?;
        let desc = NativeSamplerDesc {
            mag_filter,
            min_filter,
            mipmap_filter,
            address_mode_u,
            address_mode_v,
            address_mode_w,
            compare,
            label,
        };
        self.executor.create_sampler(id, &desc);
        Ok(id)
    }

    pub fn destroy_sampler(&mut self, id: u32) {
        self.executor.destroy_sampler(id);
        let _ = self.core.destroy_sampler(id);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register_shader_program(
        &mut self,
        code: &str,
        vertex_entry_point: Option<String>,
        fragment_entry_point: Option<String>,
        compute_entry_point: Option<String>,
        layout_family_id: u32,
        vertex_layouts_json: Option<String>,
        color_formats_json: Option<String>,
        depth_format: Option<String>,
        sample_count: u32,
        blend_mode: Option<String>,
        primitive_topology: Option<String>,
        label: Option<String>,
        extra_state_json: Option<String>,
    ) -> Result<u32, JsValue> {
        let extra: JsExtraPipelineState = match extra_state_json {
            Some(ref s) if !s.is_empty() => serde_json::from_str(s)
                .map_err(|e| JsValue::from_str(&format!("kernel-wgpu-bad-extra-state:{e}")))?,
            _ => JsExtraPipelineState::default(),
        };
        let vertex_buffer_layouts: Vec<NativeVertexBufferLayout> = match vertex_layouts_json {
            Some(ref s) if !s.is_empty() => {
                let parsed: Vec<JsVertexBufferLayout> = serde_json::from_str(s)
                    .map_err(|e| JsValue::from_str(&format!("kernel-wgpu-bad-vertex-layout:{e}")))?;
                parsed
                    .into_iter()
                    .map(|l| NativeVertexBufferLayout {
                        array_stride: l.array_stride,
                        step_mode: l.step_mode,
                        attributes: l
                            .attributes
                            .into_iter()
                            .map(|a| NativeVertexAttribute {
                                format: a.format,
                                offset: a.offset,
                                shader_location: a.shader_location,
                            })
                            .collect(),
                    })
                    .collect()
            }
            _ => Vec::new(),
        };
        let color_formats: Vec<String> = match color_formats_json {
            Some(ref s) if !s.is_empty() => serde_json::from_str(s)
                .map_err(|e| JsValue::from_str(&format!("kernel-wgpu-bad-color-formats:{e}")))?,
            _ => Vec::new(),
        };

        let id = self
            .core
            .register_shader(layout_family_id)
            .map_err(map_core_err)?;
        let desc = NativeShaderProgramDesc {
            code: code.to_owned(),
            vertex_entry_point,
            fragment_entry_point,
            compute_entry_point,
            layout_family_id,
            vertex_buffer_layouts,
            color_formats,
            color_targets: extra
                .color_targets
                .into_iter()
                .map(|ct| NativeColorTargetDesc {
                    format: ct.format,
                    blend_mode: ct.blend_mode,
                    write_mask: ct.write_mask,
                })
                .collect(),
            depth_format,
            depth_stencil: extra.depth_stencil.map(|ds| NativeDepthStencilDesc {
                format: ds.format,
                depth_write_enabled: ds.depth_write_enabled,
                depth_compare: ds.depth_compare,
                depth_bias: ds.depth_bias,
                depth_bias_slope_scale: ds.depth_bias_slope_scale,
                depth_bias_clamp: ds.depth_bias_clamp,
            }),
            sample_count: sample_count.max(1),
            blend_mode,
            cull_mode: extra.cull_mode,
            front_face: extra.front_face,
            primitive_topology,
            label,
        };
        self.executor.register_shader_program(id, desc);
        Ok(id)
    }

    pub fn destroy_shader_program(&mut self, id: u32) {
        self.executor.destroy_shader_program(id);
        let _ = self.core.destroy_shader(id);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_material(
        &mut self,
        shader_program_id: u32,
        layout_family_id: u16,
        render_state_bits: u32,
        variant_flags: u16,
        queue: u16,
        param_bytes: &[u8],
        base_color_texture_id: u32,
        normal_texture_id: u32,
        metallic_roughness_texture_id: u32,
        emissive_texture_id: u32,
        occlusion_texture_id: u32,
        sampler_id: u32,
        label: Option<String>,
    ) -> Result<u32, JsValue> {
        let id = self
            .core
            .register_material(MaterialMeta {
                shader_program_id,
                layout_family_id,
                render_state_bits,
                variant_flags,
                queue,
                param_bytes: param_bytes.to_vec(),
                param_dirty: false,
                dynamic_tex_refs: Vec::new(),
                bind_group_generation: 1,
            })
            .map_err(map_core_err)?;
        let opt = |v: u32| if v == 0 { None } else { Some(v) };
        let desc = NativeMaterialDesc {
            shader_program_id,
            layout_family_id: u32::from(layout_family_id),
            render_state_bits,
            variant_flags: u32::from(variant_flags),
            queue,
            base_color_texture_id: opt(base_color_texture_id),
            normal_texture_id: opt(normal_texture_id),
            metallic_roughness_texture_id: opt(metallic_roughness_texture_id),
            emissive_texture_id: opt(emissive_texture_id),
            occlusion_texture_id: opt(occlusion_texture_id),
            sampler_id: opt(sampler_id),
            label,
        };
        self.executor.create_material(id, &desc, param_bytes);
        Ok(id)
    }

    pub fn destroy_material(&mut self, id: u32) {
        self.executor.destroy_material(id);
        let _ = self.core.destroy_material(id);
    }

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
            .map_err(map_core_err)
    }

    pub fn begin_frame(
        &mut self,
        frame_id: u32,
        surface_width: u32,
        surface_height: u32,
    ) -> Result<(), JsValue> {
        self.core
            .begin_frame(frame_id as u64, surface_width, surface_height)
            .map_err(map_core_err)
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
        let rec = self.core.cull(&params).map_err(map_core_err)?;
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

    /// Executes `RenderKernelCore::submit_frame` + `WgpuKernelExecutor::sync_scene_gpu_buffers`
    /// + `WgpuKernelExecutor::execute_physical_stream_with_target` in a single WASM call.
    pub fn submit_frame_words(
        &mut self,
        word_len: usize,
        uniform_data: &[u8],
        target_view: &JsValue,
    ) -> Result<u32, JsValue> {
        let len = word_len.min(self.cmd_buf.len());
        let stats = self
            .core
            .submit_frame(&self.cmd_buf[..len])
            .map_err(map_core_err)?;
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

        self.executor
            .sync_scene_gpu_buffers(&mut self.core.scene, &self.core.draw_instance_rows);

        let external_view: Option<wgpu::TextureView> =
            if target_view.is_null() || target_view.is_undefined() {
                None
            } else {
                let token = read_forgeax_token(target_view)
                    .ok_or_else(|| JsValue::from_str("kernel-wgpu-missing-target-view-token"))?;
                Some(
                    lookup_texture_view(token)
                        .ok_or_else(|| JsValue::from_str("kernel-wgpu-invalid-target-view"))?,
                )
            };

        self.executor
            .execute_physical_stream_with_target(
                &self.core.resolved_phys_cmds,
                uniform_data,
                external_view.as_ref(),
            )
            .map_err(map_exec_err)
    }

    pub fn resolved_cmds_ptr(&self) -> *const u32 {
        self.core.resolved_phys_cmds.as_ptr()
    }

    pub fn resolved_cmds_len(&self) -> usize {
        if self.capture_resolved {
            self.core.resolved_phys_cmds.len()
        } else {
            0
        }
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

    pub fn readback_ticket(&mut self, ticket_id: u32) -> Result<JsValue, JsValue> {
        let (width, height, format, pixels) = self
            .executor
            .readback_ticket(ticket_id)
            .map_err(map_exec_err)?;
        let obj = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("width"), &JsValue::from(width));
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("height"), &JsValue::from(height));
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("format"), &JsValue::from_str(&format));
        let arr = js_sys::Uint8Array::from(pixels.as_slice());
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("pixels"), &arr);
        Ok(obj.into())
    }
}

/// Exposes the wgpu-wasm linear WebAssembly.Memory for zero-copy TypedArray views in JS.
#[wasm_bindgen(js_name = kernelWasmMemory)]
pub fn kernel_wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}
