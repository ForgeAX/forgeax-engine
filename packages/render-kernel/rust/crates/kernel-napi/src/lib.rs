//! Node-API (napi-rs v3) binding exposing `DedicatedNativeRenderThread` (Rust `kernel-core`
//! + native `wgpu 30` Metal/DX12/Vulkan executor on a dedicated OS thread) to Node.js.
//! Every export uses `catch_unwind` so Rust errors convert cleanly into JS exceptions.

mod window;

use forgeax_render_kernel_wgpu::{
    DedicatedNativeRenderThread, NativeBufferDesc, NativeColorTargetDesc, NativeCullRequest,
    NativeDepthStencilDesc, NativeKernelError, NativeMaterialDesc, NativeMeshDesc,
    NativeSamplerDesc, NativeShaderProgramDesc, NativeSubmeshDesc, NativeTextureDesc,
    NativeVertexAttribute, NativeVertexBufferLayout,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use window::{JsWindowEvent, JsWindowFacts, KernelNativeWindow, NativeWindowOptions};

fn map_err(err: NativeKernelError) -> Error {
    Error::from_reason(err.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsSubmeshDesc {
    #[serde(default)]
    first_index: u32,
    #[serde(default)]
    index_count: u32,
    #[serde(default)]
    base_vertex: i32,
    #[serde(default)]
    first_vertex: u32,
    #[serde(default)]
    vertex_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsMeshDesc {
    vertex_layout_id: u32,
    vertex_count: u32,
    index_count: u32,
    #[serde(default)]
    is_uint32_index: bool,
    #[serde(default)]
    topology: u8,
    #[serde(default)]
    submeshes: Vec<JsSubmeshDesc>,
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsTextureDesc {
    width: u32,
    height: u32,
    format: u8,
    #[serde(default)]
    usage: u32,
    #[serde(default = "default_one")]
    mip_level_count: u32,
    #[serde(default = "default_one")]
    array_layer_count: u32,
    #[serde(default = "default_one")]
    sample_count: u32,
    label: Option<String>,
}

fn default_one() -> u32 {
    1
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsBufferDesc {
    size: u32,
    usage: u32,
    label: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JsSamplerDesc {
    mag_filter: Option<String>,
    min_filter: Option<String>,
    mipmap_filter: Option<String>,
    address_mode_u: Option<String>,
    address_mode_v: Option<String>,
    address_mode_w: Option<String>,
    compare: Option<String>,
    label: Option<String>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsShaderProgramDesc {
    code: String,
    vertex_entry_point: Option<String>,
    fragment_entry_point: Option<String>,
    compute_entry_point: Option<String>,
    layout_family_id: u32,
    #[serde(default)]
    vertex_buffer_layouts: Vec<JsVertexBufferLayout>,
    #[serde(default)]
    color_formats: Vec<String>,
    #[serde(default)]
    color_targets: Vec<JsColorTargetDesc>,
    depth_format: Option<String>,
    #[serde(default)]
    depth_stencil: Option<JsDepthStencilDesc>,
    #[serde(default = "default_one")]
    sample_count: u32,
    #[serde(default)]
    blend_mode: Option<String>,
    #[serde(default)]
    cull_mode: Option<String>,
    #[serde(default)]
    front_face: Option<String>,
    #[serde(default)]
    primitive_topology: Option<String>,
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsMaterialDesc {
    shader_program_id: u32,
    layout_family_id: u32,
    render_state_bits: u32,
    #[serde(default)]
    variant_flags: u32,
    #[serde(default = "default_queue")]
    queue: u16,
    #[serde(default)]
    base_color_texture_id: Option<u32>,
    #[serde(default)]
    normal_texture_id: Option<u32>,
    #[serde(default)]
    metallic_roughness_texture_id: Option<u32>,
    #[serde(default)]
    emissive_texture_id: Option<u32>,
    #[serde(default)]
    occlusion_texture_id: Option<u32>,
    #[serde(default)]
    sampler_id: Option<u32>,
    label: Option<String>,
}

fn default_queue() -> u16 {
    2000
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsCullItem {
    view_proj: Vec<f32>,
    camera_pos: [f32; 3],
    #[serde(default = "default_mask")]
    layer_mask: u32,
    #[serde(default)]
    flags: u32,
    #[serde(default)]
    lod_bias: f32,
}

fn default_mask() -> u32 {
    0xFFFF_FFFF
}

#[napi(object)]
pub struct JsVisibleLight {
    pub light_id: u32,
    pub kind: u32,
    pub cast_shadow: bool,
    pub cascade_count: u32,
    pub screen_coverage: f64,
}

#[napi(object)]
pub struct JsCullSummary {
    pub cull_id: u32,
    pub candidate_count: u32,
    pub visible_opaque_count: u32,
    pub visible_masked_count: u32,
    pub visible_transparent_count: u32,
    pub visible_shadow_caster_count: u32,
    pub visible_bounds_min: Vec<f64>,
    pub visible_bounds_max: Vec<f64>,
    pub visible_lights: Vec<JsVisibleLight>,
}

#[napi(object)]
pub struct JsFrameReceipt {
    pub frame_id: f64,
    pub scene_revision: u32,
    pub submitted_pass_count: u32,
    pub merged_pass_count: u32,
    pub submitted_draw_count: u32,
    pub submitted_indirect_count: u32,
    pub pending_pipeline_count: u32,
    pub first_missing_object_id: u32,
    pub first_missing_submesh: u32,
    pub pool_texture_count: u32,
    pub pool_allocations: u32,
    pub pool_reuses: u32,
    pub executed_passes: u32,
    pub plan_us: f64,
    pub encode_submit_us: f64,
    pub resolved_physical_commands: Uint32Array,
    pub submitted_bitmap: Uint32Array,
}

#[napi(object)]
pub struct JsReadbackTexture {
    pub width: u32,
    pub height: u32,
    pub pixels: Buffer,
}

#[napi(object)]
pub struct JsReadbackTicket {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub pixels: Buffer,
}

#[napi(object)]
pub struct JsThreadStats {
    pub submitted_frames: f64,
    pub completed_frames: f64,
    pub last_completed_frame_id: f64,
    pub in_flight_frames: f64,
    pub total_plan_us: f64,
    pub total_encode_submit_us: f64,
    pub last_plan_us: f64,
    pub last_encode_submit_us: f64,
    pub dirty_rows_uploaded: f64,
    pub dirty_range_writes: f64,
    pub material_uploads: f64,
    pub surface_presents: f64,
    pub gpu_memory_bytes: f64,
    pub pool_memory_bytes: f64,
    pub device_generation: f64,
    pub recovery_count: f64,
    pub surface_format: Option<String>,
    pub adapter_name: String,
    pub backend_name: String,
}

#[napi]
pub fn native_kernel_version() -> String {
    "forgeax-render-kernel-wgpu/30.0.1".to_owned()
}

#[napi]
pub struct NativeRenderKernelHandle {
    // Field drop order is safety-critical: `thread` MUST drop (releasing wgpu::Surface)
    // before `window` drops `Arc<winit::window::Window>`.
    thread: Option<DedicatedNativeRenderThread>,
    window: Option<KernelNativeWindow>,
}

impl NativeRenderKernelHandle {
    fn rt(&self) -> Result<&DedicatedNativeRenderThread> {
        self.thread
            .as_ref()
            .ok_or_else(|| Error::from_reason("NativeRenderKernelHandle has been disposed"))
    }
}

#[napi]
impl NativeRenderKernelHandle {
    #[napi(constructor, catch_unwind)]
    pub fn new(max_in_flight: Option<u32>, window_options_json: Option<String>) -> Result<Self> {
        let depth = max_in_flight.unwrap_or(2) as usize;
        if let Some(win_json) = window_options_json {
            let win_opts: NativeWindowOptions = serde_json::from_str(&win_json)
                .map_err(|e| Error::from_reason(format!("invalid window options: {e}")))?;
            let (win, instance, surface, width, height) = KernelNativeWindow::open(win_opts)?;
            let thread = DedicatedNativeRenderThread::spawn_with_surface(
                &instance, surface, width, height, depth,
            )
            .map_err(map_err)?;
            Ok(Self {
                thread: Some(thread),
                window: Some(win),
            })
        } else {
            let thread = DedicatedNativeRenderThread::spawn_headless(depth).map_err(map_err)?;
            Ok(Self {
                thread: Some(thread),
                window: None,
            })
        }
    }

    #[napi(catch_unwind)]
    pub fn poll_window_events(&self) -> Result<Vec<JsWindowEvent>> {
        let Some(win) = self.window.as_ref() else {
            return Ok(Vec::new());
        };
        let events = win.poll_events()?;
        // Auto-reconfigure swapchain surface on the render thread when OS resizes the window.
        for ev in &events {
            if ev.kind == "resized" {
                if let (Some(w), Some(h)) = (ev.width, ev.height) {
                    if w > 0 && h > 0 {
                        let _ = self.rt()?.resize_surface(w, h);
                    }
                }
            }
        }
        Ok(events)
    }

    #[napi(catch_unwind)]
    pub fn resize_window(&self, width: u32, height: u32) -> Result<()> {
        let (pw, ph) = if let Some(win) = self.window.as_ref() {
            win.resize(width, height)?
        } else {
            (width, height)
        };
        self.rt()?.resize_surface(pw, ph).map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn window_size(&self) -> Vec<u32> {
        let (w, h) = self
            .window
            .as_ref()
            .map(|win| win.physical_size())
            .unwrap_or((0, 0));
        vec![w, h]
    }

    #[napi(catch_unwind)]
    pub fn window_facts(&self) -> JsWindowFacts {
        self.window
            .as_ref()
            .map(|win| win.facts())
            .unwrap_or(JsWindowFacts {
                width: 0,
                height: 0,
                scale_factor: 1.0,
                visible: false,
            })
    }

    #[napi(catch_unwind)]
    pub fn request_redraw(&self) {
        if let Some(win) = self.window.as_ref() {
            win.request_redraw();
        }
    }

    #[napi(catch_unwind)]
    pub fn set_pointer_lock(&self, locked: bool) -> bool {
        self.window
            .as_ref()
            .map(|win| win.set_pointer_lock(locked))
            .unwrap_or(false)
    }

    #[napi(catch_unwind)]
    pub fn set_ime_area(&self, area: Option<Vec<f64>>) -> u32 {
        let parsed = area.and_then(|v| {
            if v.len() >= 4 {
                Some([v[0], v[1], v[2], v[3]])
            } else {
                None
            }
        });
        self.window
            .as_ref()
            .map(|win| win.set_ime_area(parsed))
            .unwrap_or(0)
    }

    #[napi(catch_unwind)]
    pub fn create_mesh(
        &self,
        desc_json: String,
        vertex_bytes: Uint8Array,
        index_bytes: Option<Uint8Array>,
    ) -> Result<u32> {
        let d: JsMeshDesc = serde_json::from_str(&desc_json)
            .map_err(|e| Error::from_reason(format!("invalid mesh descriptor: {e}")))?;
        self.rt()?
            .create_mesh(
                NativeMeshDesc {
                    vertex_layout_id: d.vertex_layout_id,
                    vertex_count: d.vertex_count,
                    index_count: d.index_count,
                    is_uint32_index: d.is_uint32_index,
                    topology: d.topology,
                    submeshes: d
                        .submeshes
                        .into_iter()
                        .map(|s| NativeSubmeshDesc {
                            first_index: s.first_index,
                            index_count: s.index_count,
                            base_vertex: s.base_vertex,
                            first_vertex: s.first_vertex,
                            vertex_count: s.vertex_count,
                        })
                        .collect(),
                    label: d.label,
                },
                vertex_bytes.as_ref().to_vec(),
                index_bytes.map(|b| b.as_ref().to_vec()),
            )
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn destroy_mesh(&self, id: u32) -> Result<()> {
        self.rt()?.destroy_mesh(id).map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn create_texture(
        &self,
        desc_json: String,
        initial_bytes: Option<Uint8Array>,
    ) -> Result<u32> {
        let d: JsTextureDesc = serde_json::from_str(&desc_json)
            .map_err(|e| Error::from_reason(format!("invalid texture descriptor: {e}")))?;
        self.rt()?
            .create_texture(
                NativeTextureDesc {
                    width: d.width,
                    height: d.height,
                    format_code: d.format,
                    usage: d.usage,
                    mip_level_count: d.mip_level_count,
                    array_layer_count: d.array_layer_count,
                    sample_count: d.sample_count,
                    label: d.label,
                },
                initial_bytes.map(|b| b.as_ref().to_vec()),
            )
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn destroy_texture(&self, id: u32) -> Result<()> {
        self.rt()?.destroy_texture(id).map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn create_dynamic_texture(&self, width: u32, height: u32, format_code: u32) -> Result<u32> {
        self.rt()?
            .create_dynamic_texture(width, height, format_code as u8)
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn upload_dynamic_texture(
        &self,
        id: u32,
        revision: u32,
        width: u32,
        height: u32,
        bytes: Uint8Array,
    ) -> Result<bool> {
        self.rt()?
            .upload_dynamic_texture(id, revision, width, height, bytes.as_ref().to_vec())
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn destroy_dynamic_texture(&self, id: u32) -> Result<()> {
        self.rt()?.destroy_dynamic_texture(id).map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn create_buffer(
        &self,
        desc_json: String,
        initial_bytes: Option<Uint8Array>,
    ) -> Result<u32> {
        let d: JsBufferDesc = serde_json::from_str(&desc_json)
            .map_err(|e| Error::from_reason(format!("invalid buffer descriptor: {e}")))?;
        self.rt()?
            .create_buffer(
                NativeBufferDesc {
                    size: d.size,
                    usage: d.usage,
                    label: d.label,
                },
                initial_bytes.map(|b| b.as_ref().to_vec()),
            )
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn write_buffer(&self, id: u32, offset: u32, bytes: Uint8Array) -> Result<()> {
        self.rt()?
            .write_buffer(id, offset as u64, bytes.as_ref().to_vec())
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn destroy_buffer(&self, id: u32) -> Result<()> {
        self.rt()?.destroy_buffer(id).map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn create_sampler(&self, desc_json: String) -> Result<u32> {
        let d: JsSamplerDesc = serde_json::from_str(&desc_json)
            .map_err(|e| Error::from_reason(format!("invalid sampler descriptor: {e}")))?;
        self.rt()?
            .create_sampler(NativeSamplerDesc {
                mag_filter: d.mag_filter,
                min_filter: d.min_filter,
                mipmap_filter: d.mipmap_filter,
                address_mode_u: d.address_mode_u,
                address_mode_v: d.address_mode_v,
                address_mode_w: d.address_mode_w,
                compare: d.compare,
                label: d.label,
            })
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn destroy_sampler(&self, id: u32) -> Result<()> {
        self.rt()?.destroy_sampler(id).map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn register_shader_program(&self, desc_json: String) -> Result<u32> {
        let d: JsShaderProgramDesc = serde_json::from_str(&desc_json)
            .map_err(|e| Error::from_reason(format!("invalid shader descriptor: {e}")))?;
        self.rt()?
            .register_shader_program(NativeShaderProgramDesc {
                code: d.code,
                vertex_entry_point: d.vertex_entry_point,
                fragment_entry_point: d.fragment_entry_point,
                compute_entry_point: d.compute_entry_point,
                layout_family_id: d.layout_family_id,
                vertex_buffer_layouts: d
                    .vertex_buffer_layouts
                    .into_iter()
                    .map(|vb| NativeVertexBufferLayout {
                        array_stride: vb.array_stride,
                        step_mode: vb.step_mode,
                        attributes: vb
                            .attributes
                            .into_iter()
                            .map(|a| NativeVertexAttribute {
                                format: a.format,
                                offset: a.offset,
                                shader_location: a.shader_location,
                            })
                            .collect(),
                    })
                    .collect(),
                color_formats: d.color_formats,
                color_targets: d
                    .color_targets
                    .into_iter()
                    .map(|ct| NativeColorTargetDesc {
                        format: ct.format,
                        blend_mode: ct.blend_mode,
                        write_mask: ct.write_mask,
                    })
                    .collect(),
                depth_format: d.depth_format,
                depth_stencil: d.depth_stencil.map(|ds| NativeDepthStencilDesc {
                    format: ds.format,
                    depth_write_enabled: ds.depth_write_enabled,
                    depth_compare: ds.depth_compare,
                    depth_bias: ds.depth_bias,
                    depth_bias_slope_scale: ds.depth_bias_slope_scale,
                    depth_bias_clamp: ds.depth_bias_clamp,
                }),
                sample_count: d.sample_count,
                blend_mode: d.blend_mode,
                cull_mode: d.cull_mode,
                front_face: d.front_face,
                primitive_topology: d.primitive_topology,
                label: d.label,
            })
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn destroy_shader_program(&self, id: u32) -> Result<()> {
        self.rt()?.destroy_shader_program(id).map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn create_material(
        &self,
        desc_json: String,
        initial_param_bytes: Uint8Array,
    ) -> Result<u32> {
        let d: JsMaterialDesc = serde_json::from_str(&desc_json)
            .map_err(|e| Error::from_reason(format!("invalid material descriptor: {e}")))?;
        self.rt()?
            .create_material(
                NativeMaterialDesc {
                    shader_program_id: d.shader_program_id,
                    layout_family_id: d.layout_family_id,
                    render_state_bits: d.render_state_bits,
                    variant_flags: d.variant_flags,
                    queue: d.queue,
                    base_color_texture_id: d.base_color_texture_id,
                    normal_texture_id: d.normal_texture_id,
                    metallic_roughness_texture_id: d.metallic_roughness_texture_id,
                    emissive_texture_id: d.emissive_texture_id,
                    occlusion_texture_id: d.occlusion_texture_id,
                    sampler_id: d.sampler_id,
                    label: d.label,
                },
                initial_param_bytes.as_ref().to_vec(),
            )
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn destroy_material(&self, id: u32) -> Result<()> {
        self.rt()?.destroy_material(id).map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn commit_scene_delta(&self, bytes: Uint8Array) -> Result<u32> {
        self.rt()?
            .commit_scene_delta(bytes.as_ref().to_vec())
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn begin_frame(&self, frame_id: f64, width: u32, height: u32) -> Result<()> {
        self.rt()?
            .begin_frame(frame_id as u64, width, height)
            .map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn cull(
        &self,
        view_proj: Float32Array,
        camera_pos: Float32Array,
        layer_mask: u32,
        flags: u32,
        lod_bias: f64,
    ) -> Result<JsCullSummary> {
        let vp_slice = view_proj.as_ref();
        let cam_slice = camera_pos.as_ref();
        if vp_slice.len() < 16 || cam_slice.len() < 3 {
            return Err(Error::from_reason(
                "cull requires 16-float viewProj and 3-float cameraPos",
            ));
        }
        let mut vp = [0.0f32; 16];
        vp.copy_from_slice(&vp_slice[..16]);
        let cam = [cam_slice[0], cam_slice[1], cam_slice[2]];
        let s = self
            .rt()?
            .cull(NativeCullRequest {
                view_proj: vp,
                camera_pos: cam,
                layer_mask,
                flags,
                lod_bias: lod_bias as f32,
            })
            .map_err(map_err)?;
        Ok(JsCullSummary {
            cull_id: s.cull_id,
            candidate_count: s.candidate_count,
            visible_opaque_count: s.visible_opaque_count,
            visible_masked_count: s.visible_masked_count,
            visible_transparent_count: s.visible_transparent_count,
            visible_shadow_caster_count: s.visible_shadow_caster_count,
            visible_bounds_min: s.visible_bounds_min.iter().map(|&v| v as f64).collect(),
            visible_bounds_max: s.visible_bounds_max.iter().map(|&v| v as f64).collect(),
            visible_lights: s
                .visible_lights
                .into_iter()
                .map(|l| JsVisibleLight {
                    light_id: l.light_id,
                    kind: l.kind as u32,
                    cast_shadow: l.cast_shadow,
                    cascade_count: l.cascade_count as u32,
                    screen_coverage: l.screen_coverage as f64,
                })
                .collect(),
        })
    }

    #[napi(catch_unwind)]
    pub fn submit_frame_sync(
        &self,
        input_cmds: Uint32Array,
        uniform_bytes: Uint8Array,
    ) -> Result<JsFrameReceipt> {
        let r = self
            .rt()?
            .submit_frame_sync(input_cmds.as_ref().to_vec(), uniform_bytes.as_ref().to_vec())
            .map_err(map_err)?;
        Ok(JsFrameReceipt {
            frame_id: r.frame_id as f64,
            scene_revision: r.scene_revision,
            submitted_pass_count: r.submitted_pass_count,
            merged_pass_count: r.merged_pass_count,
            submitted_draw_count: r.submitted_draw_count,
            submitted_indirect_count: r.submitted_indirect_count,
            pending_pipeline_count: r.pending_pipeline_count,
            first_missing_object_id: r.first_missing_object_id,
            first_missing_submesh: r.first_missing_submesh,
            pool_texture_count: r.pool_texture_count,
            pool_allocations: r.pool_allocations,
            pool_reuses: r.pool_reuses,
            executed_passes: r.executed_passes,
            plan_us: r.plan_us,
            encode_submit_us: r.encode_submit_us,
            resolved_physical_commands: Uint32Array::new(r.resolved_physical_commands),
            submitted_bitmap: Uint32Array::new(r.submitted_bitmap),
        })
    }

    /// Fire-and-forget pipelined frame handoff to the dedicated OS render thread.
    /// Returns immediately once queued (bounded by `max_in_flight`) so JS gameplay/ECS
    /// overlaps with Rust culling, pass planning, and native wgpu encoding/submission.
    #[napi(catch_unwind)]
    pub fn submit_pipelined_frame_async(
        &self,
        frame_id: f64,
        width: u32,
        height: u32,
        delta_bytes: Option<Uint8Array>,
        culls_json: String,
        input_cmds: Uint32Array,
        uniform_bytes: Uint8Array,
    ) -> Result<f64> {
        let js_culls: Vec<JsCullItem> = if culls_json.is_empty() || culls_json == "[]" {
            Vec::new()
        } else {
            serde_json::from_str(&culls_json)
                .map_err(|e| Error::from_reason(format!("invalid culls json: {e}")))?
        };
        let mut culls = Vec::with_capacity(js_culls.len());
        for c in js_culls {
            if c.view_proj.len() < 16 {
                return Err(Error::from_reason("cull item viewProj must have 16 floats"));
            }
            let mut vp = [0.0f32; 16];
            vp.copy_from_slice(&c.view_proj[..16]);
            culls.push(NativeCullRequest {
                view_proj: vp,
                camera_pos: c.camera_pos,
                layer_mask: c.layer_mask,
                flags: c.flags,
                lod_bias: c.lod_bias,
            });
        }
        let seq = self
            .rt()?
            .submit_pipelined_frame_async(
                frame_id as u64,
                width,
                height,
                delta_bytes.map(|b| b.as_ref().to_vec()),
                culls,
                input_cmds.as_ref().to_vec(),
                uniform_bytes.as_ref().to_vec(),
            )
            .map_err(map_err)?;
        Ok(seq as f64)
    }

    #[napi(catch_unwind)]
    pub fn readback_pool_texture(&self, slot_id: u32) -> Result<JsReadbackTexture> {
        let (width, height, pixels) = self.rt()?.readback_pool_texture(slot_id).map_err(map_err)?;
        Ok(JsReadbackTexture {
            width,
            height,
            pixels: Buffer::from(pixels),
        })
    }

    #[napi(catch_unwind)]
    pub fn readback_buffer(&self, buf_id: u32, offset: u32, size: u32) -> Result<Buffer> {
        let bytes = self
            .rt()?
            .readback_buffer(buf_id, offset as u64, size as u64)
            .map_err(map_err)?;
        Ok(Buffer::from(bytes))
    }

    #[napi(catch_unwind)]
    pub fn readback_ticket(&self, ticket_id: u32) -> Result<JsReadbackTicket> {
        let (width, height, format, pixels) =
            self.rt()?.readback_ticket(ticket_id).map_err(map_err)?;
        Ok(JsReadbackTicket {
            width,
            height,
            format,
            pixels: Buffer::from(pixels),
        })
    }

    #[napi(catch_unwind)]
    pub fn flush(&self) -> Result<()> {
        self.rt()?.flush().map_err(map_err)
    }

    #[napi(catch_unwind)]
    pub fn trim_pool_textures(&self) -> Result<f64> {
        let freed = self.rt()?.trim_pool_textures().map_err(map_err)?;
        Ok(freed as f64)
    }

    #[napi(catch_unwind)]
    pub fn recover_device(&self) -> Result<f64> {
        let gen = self.rt()?.recover_device().map_err(map_err)?;
        Ok(gen as f64)
    }

    #[napi(catch_unwind)]
    pub fn stats(&self) -> Result<JsThreadStats> {
        let s = self.rt()?.stats();
        Ok(JsThreadStats {
            submitted_frames: s.submitted_frames as f64,
            completed_frames: s.completed_frames as f64,
            last_completed_frame_id: s.last_completed_frame_id as f64,
            in_flight_frames: s.in_flight_frames as f64,
            total_plan_us: s.total_plan_us,
            total_encode_submit_us: s.total_encode_submit_us,
            last_plan_us: s.last_plan_us,
            last_encode_submit_us: s.last_encode_submit_us,
            dirty_rows_uploaded: s.dirty_rows_uploaded as f64,
            dirty_range_writes: s.dirty_range_writes as f64,
            material_uploads: s.material_uploads as f64,
            surface_presents: s.surface_presents as f64,
            gpu_memory_bytes: s.gpu_memory_bytes as f64,
            pool_memory_bytes: s.pool_memory_bytes as f64,
            device_generation: s.device_generation as f64,
            recovery_count: s.recovery_count as f64,
            surface_format: s.surface_format,
            adapter_name: s.adapter_name,
            backend_name: s.backend_name,
        })
    }

    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        if let Some(rt) = self.thread.as_ref() {
            let _ = rt.detach_surface();
        }
        self.thread.take();
        self.window.take();
    }
}
