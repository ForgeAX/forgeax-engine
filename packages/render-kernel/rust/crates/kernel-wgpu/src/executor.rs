//! Native wgpu 30 physical GPU resource owner and `PHYS_*` command stream executor.
//! Mirrors `RhiPhysicalExecutor` opcode-for-opcode with zero JS overhead.

use crate::scene_gpu::{Scene4BglState, SceneSyncStats};
use crate::types::{
    bytes_per_pixel, decode_format_code, format_to_webgpu_str, parse_address_mode,
    parse_compare_function, parse_filter_mode, parse_mipmap_filter_mode, parse_texture_format,
    parse_vertex_format, NativeBufferDesc, NativeKernelError, NativeMaterialDesc, NativeMeshDesc,
    NativeSamplerDesc, NativeShaderProgramDesc, NativeTextureDesc,
};
use forgeax_render_kernel_core::planner::{
    PHYS_BEGIN_COMPUTE_PASS, PHYS_BEGIN_RENDER_PASS, PHYS_COPY_BUFFER, PHYS_COPY_TEXTURE,
    PHYS_DEF_BINDING_SET, PHYS_DISPATCH, PHYS_DISPATCH_INDIRECT, PHYS_DRAW, PHYS_DRAW_FULLSCREEN,
    PHYS_DRAW_INDEXED, PHYS_DRAW_INDIRECT, PHYS_END_COMPUTE_PASS, PHYS_END_RENDER_PASS,
    PHYS_ENSURE_POOL_TEX, PHYS_GENERATE_MIPS, PHYS_REQUEST_READBACK, PHYS_RETIRE_POOL_TEX,
    PHYS_SET_BIND_GROUP, PHYS_SET_IB, PHYS_SET_PSO, PHYS_SET_SCISSOR, PHYS_SET_VB,
    PHYS_SET_VIEWPORT, TEMP_TEXTURE_TAG_BIT,
};
use forgeax_render_kernel_core::pso::{
    BGL_SLOT_MATERIAL, BGL_SLOT_VIEW, LAYOUT_FAMILY_SCENE_4BGL, SURFACE_SWAPCHAIN_HANDLE,
};
use forgeax_render_kernel_core::scene::RetainedRenderScene;
use std::collections::HashMap;
use std::num::NonZeroU64;

const BINDING_KIND_TEXTURE: u32 = 0;
const BINDING_KIND_DYNAMIC_TEXTURE: u32 = 1;
const BINDING_KIND_TEMP_TEXTURE: u32 = 2;
const BINDING_KIND_BUFFER: u32 = 3;
const BINDING_KIND_SAMPLER: u32 = 4;
const BINDING_KIND_UNIFORM_SLICE: u32 = 5;
const BINDING_TEX_SUBRESOURCE_FLAG: u32 = 1 << 30;
const LOAD_OP_LOAD: u32 = 1;
const STORE_OP_DISCARD: u32 = 1;

const MIPGEN_WGSL: &str = r#"
@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var src_smp: sampler;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(src_tex, src_smp, in.uv);
}
"#;

struct PendingReadback {
    staging: wgpu::Buffer,
    width: u32,
    height: u32,
    unpadded_row: u32,
    padded_row: u32,
    format: wgpu::TextureFormat,
}

fn align4_bytes(bytes: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    let aligned = (bytes.len() + 3) & !3;
    if aligned == bytes.len() {
        std::borrow::Cow::Borrowed(bytes)
    } else {
        let mut padded = vec![0u8; aligned];
        padded[..bytes.len()].copy_from_slice(bytes);
        std::borrow::Cow::Owned(padded)
    }
}

struct NativeMesh {
    vb: wgpu::Buffer,
    ib: Option<wgpu::Buffer>,
}

struct NativeTex {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    samples: u32,
    mip_level_count: u32,
    array_layer_count: u32,
}

struct NativeShader {
    module: wgpu::ShaderModule,
    desc: NativeShaderProgramDesc,
    fullscreen_pipeline: Option<wgpu::RenderPipeline>,
    compute_pipeline: Option<wgpu::ComputePipeline>,
}

struct NativeMaterial {
    uniform_buffer: wgpu::Buffer,
    uniform_size: u64,
    base_color_texture_id: Option<u32>,
    normal_texture_id: Option<u32>,
    metallic_roughness_texture_id: Option<u32>,
    emissive_texture_id: Option<u32>,
    occlusion_texture_id: Option<u32>,
    sampler_id: Option<u32>,
    bind_group: Option<wgpu::BindGroup>,
}

fn parse_blend_mode(mode: Option<&str>) -> Option<wgpu::BlendState> {
    match mode {
        Some("alpha") => Some(wgpu::BlendState::ALPHA_BLENDING),
        Some("premultiplied") => Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
        Some("additive") => Some(wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
        }),
        _ => None,
    }
}

fn parse_primitive_topology(name: Option<&str>) -> wgpu::PrimitiveTopology {
    match name {
        Some("line-list") => wgpu::PrimitiveTopology::LineList,
        Some("line-strip") => wgpu::PrimitiveTopology::LineStrip,
        Some("triangle-strip") => wgpu::PrimitiveTopology::TriangleStrip,
        Some("point-list") => wgpu::PrimitiveTopology::PointList,
        _ => wgpu::PrimitiveTopology::TriangleList,
    }
}

fn parse_cull_mode(name: Option<&str>) -> Option<wgpu::Face> {
    match name {
        Some("front") => Some(wgpu::Face::Front),
        Some("back") => Some(wgpu::Face::Back),
        _ => None,
    }
}

fn parse_front_face(name: Option<&str>) -> wgpu::FrontFace {
    match name {
        Some("cw") => wgpu::FrontFace::Cw,
        _ => wgpu::FrontFace::Ccw,
    }
}

fn decode_binding_subresource_view(tex: &NativeTex, packed: u32) -> Option<wgpu::TextureView> {
    if (packed & BINDING_TEX_SUBRESOURCE_FLAG) == 0 {
        return None;
    }
    let base_mip = (packed & 0xFF).min(tex.mip_level_count.saturating_sub(1));
    let raw_mip_count = (packed >> 8) & 0xFF;
    let mip_level_count = if raw_mip_count == 0 {
        None
    } else {
        Some(raw_mip_count.min(tex.mip_level_count.saturating_sub(base_mip).max(1)))
    };
    let base_layer = ((packed >> 16) & 0xFFF).min(tex.array_layer_count.saturating_sub(1));
    let aspect = match (packed >> 28) & 0x3 {
        1 => wgpu::TextureAspect::DepthOnly,
        2 => wgpu::TextureAspect::StencilOnly,
        _ => wgpu::TextureAspect::All,
    };
    let dimension = if tex.array_layer_count > 1 {
        Some(wgpu::TextureViewDimension::D2)
    } else {
        None
    };
    let array_layer_count = if tex.array_layer_count > 1 {
        Some(1)
    } else {
        None
    };
    Some(tex.texture.create_view(&wgpu::TextureViewDescriptor {
        label: Some("kernel.subresource-view"),
        format: None,
        dimension,
        usage: None,
        aspect,
        base_mip_level: base_mip,
        mip_level_count,
        base_array_layer: base_layer,
        array_layer_count,
    }))
}

fn create_attachment_subresource_view(
    tex: &NativeTex,
    mip_level: u32,
    array_layer: u32,
) -> Option<wgpu::TextureView> {
    if mip_level == 0
        && array_layer == 0
        && tex.mip_level_count <= 1
        && tex.array_layer_count <= 1
    {
        return None;
    }
    let base_mip = mip_level.min(tex.mip_level_count.saturating_sub(1));
    let base_layer = array_layer.min(tex.array_layer_count.saturating_sub(1));
    Some(tex.texture.create_view(&wgpu::TextureViewDescriptor {
        label: Some("kernel.attachment-view"),
        format: None,
        dimension: Some(wgpu::TextureViewDimension::D2),
        usage: None,
        aspect: wgpu::TextureAspect::All,
        base_mip_level: base_mip,
        mip_level_count: Some(1),
        base_array_layer: base_layer,
        array_layer_count: Some(1),
    }))
}

struct NativeSurfaceState {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    format: wgpu::TextureFormat,
}

fn format_to_webgpu_name(format: wgpu::TextureFormat) -> String {
    match format {
        wgpu::TextureFormat::Bgra8Unorm => "bgra8unorm",
        wgpu::TextureFormat::Bgra8UnormSrgb => "bgra8unorm-srgb",
        wgpu::TextureFormat::Rgba8Unorm => "rgba8unorm",
        wgpu::TextureFormat::Rgba8UnormSrgb => "rgba8unorm-srgb",
        wgpu::TextureFormat::Rgba16Float => "rgba16float",
        _ => "bgra8unorm",
    }
    .to_owned()
}

fn stream_uses_swapchain(phys_cmds: &[u32]) -> bool {
    let mut cursor = 0usize;
    while cursor < phys_cmds.len() {
        let hdr = phys_cmds[cursor];
        let opcode = (hdr & 0xFFFF) as u16;
        let word_len = (hdr >> 16) as usize;
        if word_len == 0 || cursor + word_len > phys_cmds.len() {
            return false;
        }
        match opcode {
            PHYS_BEGIN_RENDER_PASS if word_len >= 3 => {
                let color_count = (phys_cmds[cursor + 2] & 0xFF) as usize;
                for c in 0..color_count {
                    let base = cursor + 3 + c * 8;
                    if base + 1 < cursor + word_len
                        && (phys_cmds[base] == SURFACE_SWAPCHAIN_HANDLE
                            || phys_cmds[base + 1] == SURFACE_SWAPCHAIN_HANDLE)
                    {
                        return true;
                    }
                }
            }
            PHYS_COPY_TEXTURE if word_len >= 4 => {
                if phys_cmds[cursor + 3] == SURFACE_SWAPCHAIN_HANDLE {
                    return true;
                }
            }
            _ => {}
        }
        cursor += word_len;
    }
    false
}

#[derive(Clone, Copy)]
struct FrameBindingEntry {
    slot: u32,
    kind: u32,
    handle: u32,
    offset: u32,
}

/// Native wgpu 30 executor owning Device, Queue, persistent GPU buffers/textures,
/// fixed 4-BGL scene GPU state, optional native swapchain surface, lazy PSO cache,
/// and transient RT pool. Executes resolved `PHYS_*` streams directly with zero JS.
pub struct WgpuKernelExecutor {
    adapter: Option<wgpu::Adapter>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_name: String,
    pub backend_name: String,
    scene_4bgl: Option<Scene4BglState>,
    surface: Option<NativeSurfaceState>,
    surface_presents: u64,
    device_generation: u64,
    recovery_count: u64,
    meshes: HashMap<u32, NativeMesh>,
    textures: HashMap<u32, NativeTex>,
    dynamic_textures: HashMap<u32, NativeTex>,
    buffers: HashMap<u32, wgpu::Buffer>,
    samplers: HashMap<u32, wgpu::Sampler>,
    shaders: HashMap<u32, NativeShader>,
    materials: HashMap<u32, NativeMaterial>,
    pool_textures: HashMap<u32, NativeTex>,
    pso_by_key: HashMap<[u32; 4], (wgpu::RenderPipeline, bool)>,
    pso_by_slot: HashMap<u32, (wgpu::RenderPipeline, bool)>,
    frame_binding_sets: HashMap<u32, Vec<FrameBindingEntry>>,
    frame_uniform_buffer: Option<wgpu::Buffer>,
    frame_uniform_capacity: u64,
    mipgen_shader: Option<wgpu::ShaderModule>,
    mipgen_sampler: Option<wgpu::Sampler>,
    mipgen_pipelines: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    pending_readbacks: HashMap<u32, PendingReadback>,
}

impl WgpuKernelExecutor {
    #[inline]
    fn poll_device_on(device: &wgpu::Device) {
        #[cfg(not(target_arch = "wasm32"))]
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        #[cfg(target_arch = "wasm32")]
        let _ = device.poll(wgpu::PollType::Poll);
    }

    #[inline]
    fn poll_device_sync(&self) {
        Self::poll_device_on(&self.device);
    }

    fn init_scene_4bgl(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<Scene4BglState> {
        if device.limits().max_storage_buffers_per_shader_stage >= 4 {
            Some(Scene4BglState::new(device, queue))
        } else {
            None
        }
    }

    pub fn from_device_and_queue(
        device: wgpu::Device,
        queue: wgpu::Queue,
        adapter_name: String,
        backend_name: String,
    ) -> Self {
        let scene_4bgl = Self::init_scene_4bgl(&device, &queue);
        Self {
            adapter: None,
            device,
            queue,
            adapter_name,
            backend_name,
            scene_4bgl,
            surface: None,
            surface_presents: 0,
            device_generation: 1,
            recovery_count: 0,
            meshes: HashMap::new(),
            textures: HashMap::new(),
            dynamic_textures: HashMap::new(),
            buffers: HashMap::new(),
            samplers: HashMap::new(),
            shaders: HashMap::new(),
            materials: HashMap::new(),
            pool_textures: HashMap::new(),
            pso_by_key: HashMap::new(),
            pso_by_slot: HashMap::new(),
            frame_binding_sets: HashMap::new(),
            frame_uniform_buffer: None,
            frame_uniform_capacity: 0,
            mipgen_shader: None,
            mipgen_sampler: None,
            mipgen_pipelines: HashMap::new(),
            pending_readbacks: HashMap::new(),
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_headless() -> Result<Self, NativeKernelError> {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
            ..Default::default()
        }))
        .map_err(|_| NativeKernelError::AdapterUnavailable)?;
        Self::from_adapter(adapter, None)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_with_surface(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, NativeKernelError> {
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            ..Default::default()
        }))
        .map_err(|_| NativeKernelError::AdapterUnavailable)?;
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .or_else(|| caps.formats.first().copied())
            .ok_or_else(|| {
                NativeKernelError::SurfaceError("surface reported no supported formats".to_owned())
            })?;
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Opaque)
        };
        let present_mode = if caps.present_modes.contains(&wgpu::PresentMode::Fifo) {
            wgpu::PresentMode::Fifo
        } else {
            caps.present_modes
                .first()
                .copied()
                .unwrap_or(wgpu::PresentMode::Fifo)
        };
        let usage = (wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST)
            & caps.usages;
        let usage = if usage.contains(wgpu::TextureUsages::RENDER_ATTACHMENT) {
            usage
        } else {
            wgpu::TextureUsages::RENDER_ATTACHMENT
        };
        let mut config = surface
            .get_default_config(&adapter, width.max(1), height.max(1))
            .ok_or_else(|| {
                NativeKernelError::SurfaceError(
                    "adapter cannot present to the native surface".to_owned(),
                )
            })?;
        config.usage = usage;
        config.format = format;
        config.present_mode = present_mode;
        config.desired_maximum_frame_latency = 2;
        config.alpha_mode = alpha_mode;
        config.view_formats = vec![];
        Self::from_adapter(adapter, Some((surface, config)))
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn from_adapter(
        adapter: wgpu::Adapter,
        surface_init: Option<(wgpu::Surface<'static>, wgpu::SurfaceConfiguration)>,
    ) -> Result<Self, NativeKernelError> {
        let info = adapter.get_info();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("forgeax-render-kernel-native"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
            ..Default::default()
        }))
        .map_err(|e| NativeKernelError::DeviceCreation(e.to_string()))?;

        let surface = surface_init.map(|(surface, config)| {
            let format = config.format;
            surface.configure(&device, &config);
            NativeSurfaceState {
                surface,
                config,
                format,
            }
        });
        let scene_4bgl = Self::init_scene_4bgl(&device, &queue);

        Ok(Self {
            adapter: Some(adapter),
            device,
            queue,
            adapter_name: info.name,
            backend_name: format!("{:?}", info.backend),
            scene_4bgl,
            surface,
            surface_presents: 0,
            device_generation: 1,
            recovery_count: 0,
            meshes: HashMap::new(),
            textures: HashMap::new(),
            dynamic_textures: HashMap::new(),
            buffers: HashMap::new(),
            samplers: HashMap::new(),
            shaders: HashMap::new(),
            materials: HashMap::new(),
            pool_textures: HashMap::new(),
            pso_by_key: HashMap::new(),
            pso_by_slot: HashMap::new(),
            frame_binding_sets: HashMap::new(),
            frame_uniform_buffer: None,
            frame_uniform_capacity: 0,
            mipgen_shader: None,
            mipgen_sampler: None,
            mipgen_pipelines: HashMap::new(),
            pending_readbacks: HashMap::new(),
        })
    }

    pub fn resize_surface(&mut self, width: u32, height: u32) -> Result<(), NativeKernelError> {
        if let Some(ref mut s) = self.surface {
            if width == 0 || height == 0 {
                // Minimized window (especially Windows DXGI): pause presentation without error.
                s.config.width = 0;
                s.config.height = 0;
                return Ok(());
            }
            // Drain GPU work before reconfiguring swapchain (required on Windows DX12/DXGI).
            Self::poll_device_on(&self.device);
            s.config.width = width;
            s.config.height = height;
            s.surface.configure(&self.device, &s.config);
        }
        Ok(())
    }

    pub fn detach_surface(&mut self) {
        self.surface = None;
    }

    pub fn surface_format_name(&self) -> Option<String> {
        self.surface.as_ref().map(|s| format_to_webgpu_name(s.format))
    }

    pub fn surface_presents(&self) -> u64 {
        self.surface_presents
    }

    pub fn device_generation(&self) -> u64 {
        self.device_generation
    }

    pub fn recovery_count(&self) -> u64 {
        self.recovery_count
    }

    fn tex_bytes(t: &NativeTex) -> u64 {
        (t.width as u64)
            .saturating_mul(t.height as u64)
            .saturating_mul(bytes_per_pixel(t.format) as u64)
            .saturating_mul(t.samples.max(1) as u64)
    }

    pub fn pool_memory_bytes(&self) -> u64 {
        self.pool_textures.values().map(Self::tex_bytes).sum()
    }

    pub fn gpu_memory_bytes(&self) -> u64 {
        let mesh_bytes: u64 = self
            .meshes
            .values()
            .map(|m| m.vb.size() + m.ib.as_ref().map_or(0, |b| b.size()))
            .sum();
        let tex_bytes: u64 = self.textures.values().map(Self::tex_bytes).sum();
        let dyn_tex_bytes: u64 = self.dynamic_textures.values().map(Self::tex_bytes).sum();
        let buf_bytes: u64 = self.buffers.values().map(|b| b.size()).sum();
        let mat_bytes: u64 = self.materials.values().map(|m| m.uniform_size).sum();
        mesh_bytes + tex_bytes + dyn_tex_bytes + buf_bytes + mat_bytes + self.pool_memory_bytes()
    }

    /// Drops all cached transient render-target pool textures and returns the bytes freed.
    /// Subsequent frames re-allocate only the pool slots they actively reference.
    pub fn trim_pool_textures(&mut self) -> u64 {
        self.poll_device_sync();
        let freed = self.pool_memory_bytes();
        self.pool_textures.clear();
        freed
    }

    /// Recreates `wgpu::Device`, `wgpu::Queue`, `Scene4BglState`, and reconfigures any attached
    /// swapchain surface from the retained adapter after a device loss. Clears all old GPU handles
    /// and returns the incremented `device_generation`.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn recover_device(&mut self) -> Result<u64, NativeKernelError> {
        self.poll_device_sync();
        let adapter = self.adapter.as_ref().ok_or_else(|| {
            NativeKernelError::DeviceCreation("no adapter retained for recovery".to_owned())
        })?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("forgeax-render-kernel-native-recovered"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                ..Default::default()
            }))
            .map_err(|e| NativeKernelError::DeviceCreation(e.to_string()))?;

        self.meshes.clear();
        self.textures.clear();
        self.dynamic_textures.clear();
        self.buffers.clear();
        self.samplers.clear();
        self.shaders.clear();
        self.materials.clear();
        self.pool_textures.clear();
        self.pso_by_key.clear();
        self.pso_by_slot.clear();
        self.frame_binding_sets.clear();
        self.frame_uniform_buffer = None;
        self.frame_uniform_capacity = 0;
        self.mipgen_shader = None;
        self.mipgen_sampler = None;
        self.mipgen_pipelines.clear();
        self.pending_readbacks.clear();

        self.scene_4bgl = Self::init_scene_4bgl(&device, &queue);
        if let Some(ref mut s) = self.surface {
            if s.config.width > 0 && s.config.height > 0 {
                s.surface.configure(&device, &s.config);
            }
        }
        self.device = device;
        self.queue = queue;
        self.device_generation += 1;
        self.recovery_count += 1;
        Ok(self.device_generation)
    }

    /// Incrementally synchronizes dirty scene object transforms, lights, instance-row
    /// indirections, and dirty material UBOs into native GPU buffers.
    pub fn sync_scene_gpu_buffers(
        &mut self,
        scene: &mut RetainedRenderScene,
        instance_rows: &[u32],
    ) -> SceneSyncStats {
        let mut stats = match self.scene_4bgl.as_mut() {
            Some(s4) => s4.sync_scene_and_instances(&self.device, &self.queue, scene, instance_rows),
            None => SceneSyncStats {
                dirty_rows_uploaded: 0,
                dirty_range_writes: 0,
                material_uploads: 0,
            },
        };
        let device = &self.device;
        let queue = &self.queue;
        let scene_4bgl = self.scene_4bgl.as_ref();
        let textures = &self.textures;
        let dynamic_textures = &self.dynamic_textures;
        let samplers = &self.samplers;
        let materials = &mut self.materials;
        scene.materials.for_each_live_mut(|mat_id, mat| {
            if !mat.param_dirty {
                return;
            }
            if let Some(native_mat) = materials.get_mut(&mat_id) {
                let needed = ((mat.param_bytes.len() + 15) & !15).max(16) as u64;
                if needed > native_mat.uniform_size {
                    let buf = device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("kernel.material.ubo.resized"),
                        size: needed,
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    });
                    let resolve_mat_view = |id: Option<u32>| {
                        id.and_then(|tid| {
                            textures
                                .get(&tid)
                                .or_else(|| dynamic_textures.get(&tid))
                                .map(|t| &t.view)
                        })
                    };
                    let tex_view = resolve_mat_view(native_mat.base_color_texture_id);
                    let normal_view = resolve_mat_view(native_mat.normal_texture_id);
                    let mr_view = resolve_mat_view(native_mat.metallic_roughness_texture_id);
                    let emissive_view = resolve_mat_view(native_mat.emissive_texture_id);
                    let occlusion_view = resolve_mat_view(native_mat.occlusion_texture_id);
                    let sampler = native_mat.sampler_id.and_then(|sid| samplers.get(&sid));
                    native_mat.bind_group = scene_4bgl.map(|s4| {
                        s4.create_material_bind_group(
                            device,
                            &buf,
                            tex_view,
                            sampler,
                            normal_view,
                            mr_view,
                            emissive_view,
                            occlusion_view,
                        )
                    });
                    native_mat.uniform_buffer = buf;
                    native_mat.uniform_size = needed;
                }
                if !mat.param_bytes.is_empty() {
                    queue.write_buffer(
                        &native_mat.uniform_buffer,
                        0,
                        &align4_bytes(&mat.param_bytes),
                    );
                }
                stats.material_uploads += 1;
            }
            mat.param_dirty = false;
        });
        stats
    }

    pub fn create_mesh(
        &mut self,
        mesh_id: u32,
        desc: &NativeMeshDesc,
        vertex_bytes: &[u8],
        index_bytes: Option<&[u8]>,
    ) {
        let vb_size = ((vertex_bytes.len() + 3) & !3).max(4) as u64;
        let vb_label = desc
            .label
            .as_deref()
            .map(|l| format!("{l}.vb"))
            .unwrap_or_else(|| "kernel.mesh.vb".to_owned());
        let vb = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&vb_label),
            size: vb_size,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        if !vertex_bytes.is_empty() {
            self.queue.write_buffer(&vb, 0, &align4_bytes(vertex_bytes));
        }

        let ib = index_bytes.and_then(|ib_bytes| {
            if ib_bytes.is_empty() {
                return None;
            }
            let ib_size = ((ib_bytes.len() + 3) & !3).max(4) as u64;
            let ib_label = desc
                .label
                .as_deref()
                .map(|l| format!("{l}.ib"))
                .unwrap_or_else(|| "kernel.mesh.ib".to_owned());
            let buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(&ib_label),
                size: ib_size,
                usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.queue.write_buffer(&buf, 0, &align4_bytes(ib_bytes));
            Some(buf)
        });

        self.meshes.insert(mesh_id, NativeMesh { vb, ib });
    }

    pub fn register_mesh_buffers(
        &mut self,
        mesh_id: u32,
        vb: wgpu::Buffer,
        ib: Option<wgpu::Buffer>,
    ) {
        self.meshes.insert(mesh_id, NativeMesh { vb, ib });
    }

    pub fn destroy_mesh(&mut self, mesh_id: u32) {
        self.meshes.remove(&mesh_id);
    }

    pub fn create_texture(
        &mut self,
        tex_id: u32,
        desc: &NativeTextureDesc,
        initial_bytes: Option<&[u8]>,
    ) {
        let format = decode_format_code(desc.format_code);
        let width = desc.width.max(1);
        let height = desc.height.max(1);
        let samples = desc.sample_count.max(1);
        let layers = desc.array_layer_count.max(1);
        let mips = desc.mip_level_count.max(1);
        let usage = wgpu::TextureUsages::from_bits_truncate(desc.usage)
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::COPY_SRC;
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: desc.label.as_deref().or(Some("kernel.tex")),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: layers,
            },
            mip_level_count: mips,
            sample_count: samples,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        });
        if let Some(bytes) = initial_bytes {
            if !bytes.is_empty() {
                let bpp = bytes_per_pixel(format);
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    bytes,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(width * bpp),
                        rows_per_image: Some(height),
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.textures.insert(
            tex_id,
            NativeTex {
                texture,
                view,
                width,
                height,
                format,
                samples,
                mip_level_count: mips,
                array_layer_count: layers,
            },
        );
    }

    pub fn destroy_texture(&mut self, tex_id: u32) {
        self.textures.remove(&tex_id);
    }

    pub fn create_dynamic_texture(&mut self, tex_id: u32, width: u32, height: u32, format_code: u8) {
        let format = decode_format_code(format_code);
        let width = width.max(1);
        let height = height.max(1);
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kernel.dynamic-tex"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.dynamic_textures.insert(
            tex_id,
            NativeTex {
                texture,
                view,
                width,
                height,
                format,
                samples: 1,
                mip_level_count: 1,
                array_layer_count: 1,
            },
        );
    }

    pub fn upload_dynamic_texture(
        &mut self,
        tex_id: u32,
        width: u32,
        height: u32,
        reallocated: bool,
        bytes: &[u8],
    ) -> Result<(), NativeKernelError> {
        let width = width.max(1);
        let height = height.max(1);
        let format = self
            .dynamic_textures
            .get(&tex_id)
            .map(|t| t.format)
            .ok_or_else(|| NativeKernelError::ResourceNotFound(format!("dynamic texture {tex_id}")))?;
        let need_realloc = reallocated
            || self
                .dynamic_textures
                .get(&tex_id)
                .map(|t| t.width != width || t.height != height)
                .unwrap_or(true);
        if need_realloc {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("kernel.dynamic-tex"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.dynamic_textures.insert(
                tex_id,
                NativeTex {
                    texture,
                    view,
                    width,
                    height,
                    format,
                    samples: 1,
                    mip_level_count: 1,
                    array_layer_count: 1,
                },
            );
        }
        if !bytes.is_empty() {
            if let Some(tex) = self.dynamic_textures.get(&tex_id) {
                let bpp = bytes_per_pixel(tex.format);
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &tex.texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    bytes,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(width * bpp),
                        rows_per_image: Some(height),
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }
        Ok(())
    }

    pub fn destroy_dynamic_texture(&mut self, tex_id: u32) {
        self.dynamic_textures.remove(&tex_id);
    }

    pub fn create_buffer(
        &mut self,
        buf_id: u32,
        desc: &NativeBufferDesc,
        initial_bytes: Option<&[u8]>,
    ) {
        let size = ((desc.size as usize + 3) & !3).max(4) as u64;
        let usage = wgpu::BufferUsages::from_bits_truncate(desc.usage) | wgpu::BufferUsages::COPY_DST;
        let buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: desc.label.as_deref().or(Some("kernel.buffer")),
            size,
            usage,
            mapped_at_creation: false,
        });
        if let Some(bytes) = initial_bytes {
            if !bytes.is_empty() {
                self.queue.write_buffer(&buf, 0, &align4_bytes(bytes));
            }
        }
        self.buffers.insert(buf_id, buf);
    }

    pub fn write_buffer(
        &mut self,
        buf_id: u32,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), NativeKernelError> {
        let buf = self
            .buffers
            .get(&buf_id)
            .ok_or_else(|| NativeKernelError::ResourceNotFound(format!("buffer {buf_id}")))?;
        if !bytes.is_empty() {
            self.queue.write_buffer(buf, offset, &align4_bytes(bytes));
        }
        Ok(())
    }

    pub fn destroy_buffer(&mut self, buf_id: u32) {
        self.buffers.remove(&buf_id);
    }

    pub fn create_sampler(&mut self, sampler_id: u32, desc: &NativeSamplerDesc) {
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: desc.label.as_deref().or(Some("kernel.sampler")),
            address_mode_u: parse_address_mode(desc.address_mode_u.as_deref()),
            address_mode_v: parse_address_mode(desc.address_mode_v.as_deref()),
            address_mode_w: parse_address_mode(desc.address_mode_w.as_deref()),
            mag_filter: parse_filter_mode(desc.mag_filter.as_deref()),
            min_filter: parse_filter_mode(desc.min_filter.as_deref()),
            mipmap_filter: parse_mipmap_filter_mode(desc.mipmap_filter.as_deref()),
            compare: parse_compare_function(desc.compare.as_deref()),
            ..Default::default()
        });
        self.samplers.insert(sampler_id, sampler);
    }

    pub fn destroy_sampler(&mut self, sampler_id: u32) {
        self.samplers.remove(&sampler_id);
    }

    pub fn register_shader_program(&mut self, shader_id: u32, desc: NativeShaderProgramDesc) {
        let label = desc
            .label
            .clone()
            .unwrap_or_else(|| format!("kernel.shader.{shader_id}"));
        let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(&label),
            source: wgpu::ShaderSource::Wgsl(desc.code.as_str().into()),
        });
        self.shaders.insert(
            shader_id,
            NativeShader {
                module,
                desc,
                fullscreen_pipeline: None,
                compute_pipeline: None,
            },
        );
    }

    pub fn destroy_shader_program(&mut self, shader_id: u32) {
        self.shaders.remove(&shader_id);
        self.pso_by_key
            .retain(|key, _| ((key[1] >> 8) & 0x00FF_FFFF) != shader_id);
        self.pso_by_slot.clear();
    }

    pub fn create_material(
        &mut self,
        mat_id: u32,
        desc: &NativeMaterialDesc,
        initial_param_bytes: &[u8],
    ) {
        let size = ((initial_param_bytes.len() + 15) & !15).max(16) as u64;
        let label = desc
            .label
            .as_deref()
            .map(|l| format!("{l}.ubo"))
            .unwrap_or_else(|| format!("kernel.material.{mat_id}.ubo"));
        let uniform_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&label),
            size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        if !initial_param_bytes.is_empty() {
            self.queue
                .write_buffer(&uniform_buffer, 0, &align4_bytes(initial_param_bytes));
        }
        let tex_view = desc
            .base_color_texture_id
            .and_then(|tid| self.resolve_tex(tid).map(|t| &t.view));
        let normal_view = desc
            .normal_texture_id
            .and_then(|tid| self.resolve_tex(tid).map(|t| &t.view));
        let mr_view = desc
            .metallic_roughness_texture_id
            .and_then(|tid| self.resolve_tex(tid).map(|t| &t.view));
        let emissive_view = desc
            .emissive_texture_id
            .and_then(|tid| self.resolve_tex(tid).map(|t| &t.view));
        let occlusion_view = desc
            .occlusion_texture_id
            .and_then(|tid| self.resolve_tex(tid).map(|t| &t.view));
        let sampler = desc.sampler_id.and_then(|sid| self.samplers.get(&sid));
        let bind_group = self.scene_4bgl.as_ref().map(|s4| {
            s4.create_material_bind_group(
                &self.device,
                &uniform_buffer,
                tex_view,
                sampler,
                normal_view,
                mr_view,
                emissive_view,
                occlusion_view,
            )
        });
        self.materials.insert(
            mat_id,
            NativeMaterial {
                uniform_buffer,
                uniform_size: size,
                base_color_texture_id: desc.base_color_texture_id,
                normal_texture_id: desc.normal_texture_id,
                metallic_roughness_texture_id: desc.metallic_roughness_texture_id,
                emissive_texture_id: desc.emissive_texture_id,
                occlusion_texture_id: desc.occlusion_texture_id,
                sampler_id: desc.sampler_id,
                bind_group,
            },
        );
    }

    pub fn destroy_material(&mut self, mat_id: u32) {
        self.materials.remove(&mat_id);
    }

    pub fn register_pipeline(&mut self, slot_id: u32, pso: wgpu::RenderPipeline) {
        self.pso_by_slot.insert(slot_id, (pso, false));
    }

    pub fn pool_texture(&self, slot_id: u32) -> Option<&wgpu::Texture> {
        self.pool_textures.get(&slot_id).map(|t| &t.texture)
    }

    fn resolve_tex(&self, handle: u32) -> Option<&NativeTex> {
        if handle == 0 {
            return None;
        }
        if (handle & TEMP_TEXTURE_TAG_BIT) != 0 {
            let slot = handle & !TEMP_TEXTURE_TAG_BIT;
            return self.pool_textures.get(&slot);
        }
        self.textures
            .get(&handle)
            .or_else(|| self.dynamic_textures.get(&handle))
    }

    fn ensure_render_pipeline(&mut self, w0: u32, w1: u32, w2: u32, w3: u32, slot_id: u32) {
        if self.pso_by_slot.contains_key(&slot_id) {
            return;
        }
        let key = [w0, w1, w2, w3];
        if let Some((existing, is_4bgl)) = self.pso_by_key.get(&key) {
            self.pso_by_slot
                .insert(slot_id, (existing.clone(), *is_4bgl));
            return;
        }
        let shader_id = (w1 >> 8) & 0x00FF_FFFF;
        let layout_family_id = ((w3 >> 16) & 0xFFFF) as u16;
        let render_state_bits = (w2 >> 16) | ((w3 & 0xFFFF) << 16);
        let Some(shader) = self.shaders.get(&shader_id) else {
            return;
        };
        let is_4bgl = layout_family_id == LAYOUT_FAMILY_SCENE_4BGL
            || shader.desc.layout_family_id == LAYOUT_FAMILY_SCENE_4BGL as u32;
        let is_depth_only = shader.desc.fragment_entry_point.is_none()
            && shader.desc.color_formats.is_empty()
            && shader.desc.color_targets.is_empty()
            && (shader.desc.depth_format.is_some() || shader.desc.depth_stencil.is_some());
        let blend_state = parse_blend_mode(shader.desc.blend_mode.as_deref()).or_else(|| {
            if (render_state_bits & (1 << 5)) != 0 {
                Some(wgpu::BlendState::ALPHA_BLENDING)
            } else {
                None
            }
        });
        let topology = parse_primitive_topology(shader.desc.primitive_topology.as_deref());
        let default_color_fmt = self
            .surface
            .as_ref()
            .map(|s| s.format)
            .unwrap_or(wgpu::TextureFormat::Rgba8Unorm);
        let color_targets: Vec<Option<wgpu::ColorTargetState>> = if is_depth_only {
            Vec::new()
        } else if !shader.desc.color_targets.is_empty() {
            shader
                .desc
                .color_targets
                .iter()
                .map(|ct| {
                    let ct_blend = match ct.blend_mode.as_deref() {
                        Some("none") => None,
                        Some(mode) => parse_blend_mode(Some(mode)),
                        None => blend_state,
                    };
                    let write_mask = ct
                        .write_mask
                        .map(wgpu::ColorWrites::from_bits_truncate)
                        .unwrap_or(wgpu::ColorWrites::ALL);
                    Some(wgpu::ColorTargetState {
                        format: parse_texture_format(&ct.format),
                        blend: ct_blend,
                        write_mask,
                    })
                })
                .collect()
        } else if shader.desc.color_formats.is_empty() {
            vec![Some(wgpu::ColorTargetState {
                format: default_color_fmt,
                blend: blend_state,
                write_mask: wgpu::ColorWrites::ALL,
            })]
        } else {
            shader
                .desc
                .color_formats
                .iter()
                .map(|fmt| {
                    Some(wgpu::ColorTargetState {
                        format: parse_texture_format(fmt),
                        blend: blend_state,
                        write_mask: wgpu::ColorWrites::ALL,
                    })
                })
                .collect()
        };

        let owned_attrs: Vec<Vec<wgpu::VertexAttribute>> = shader
            .desc
            .vertex_buffer_layouts
            .iter()
            .map(|vb| {
                vb.attributes
                    .iter()
                    .map(|a| wgpu::VertexAttribute {
                        format: parse_vertex_format(&a.format),
                        offset: a.offset,
                        shader_location: a.shader_location,
                    })
                    .collect()
            })
            .collect();
        let vb_layouts: Vec<Option<wgpu::VertexBufferLayout<'_>>> = shader
            .desc
            .vertex_buffer_layouts
            .iter()
            .enumerate()
            .map(|(idx, vb)| {
                Some(wgpu::VertexBufferLayout {
                    array_stride: vb.array_stride,
                    step_mode: match vb.step_mode.as_deref() {
                        Some("instance") => wgpu::VertexStepMode::Instance,
                        _ => wgpu::VertexStepMode::Vertex,
                    },
                    attributes: &owned_attrs[idx],
                })
            })
            .collect();

        let depth_write = render_state_bits == 0 || (render_state_bits & 1) != 0;
        let depth_compare = match (render_state_bits >> 1) & 0x3 {
            1 => wgpu::CompareFunction::GreaterEqual,
            2 => wgpu::CompareFunction::Less,
            3 => wgpu::CompareFunction::Always,
            _ => wgpu::CompareFunction::LessEqual,
        };
        let cull_mode = shader
            .desc
            .cull_mode
            .as_deref()
            .map(|m| parse_cull_mode(Some(m)))
            .unwrap_or_else(|| match (render_state_bits >> 3) & 0x3 {
                1 => Some(wgpu::Face::Back),
                2 => Some(wgpu::Face::Front),
                _ => None,
            });
        let front_face = parse_front_face(shader.desc.front_face.as_deref());
        let depth_stencil = if let Some(ref ds) = shader.desc.depth_stencil {
            Some(wgpu::DepthStencilState {
                format: parse_texture_format(&ds.format),
                depth_write_enabled: Some(ds.depth_write_enabled.unwrap_or(depth_write)),
                depth_compare: Some(
                    ds.depth_compare
                        .as_deref()
                        .and_then(|c| parse_compare_function(Some(c)))
                        .unwrap_or(depth_compare),
                ),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState {
                    constant: ds.depth_bias.unwrap_or(if is_depth_only { 2 } else { 0 }),
                    slope_scale: ds
                        .depth_bias_slope_scale
                        .unwrap_or(if is_depth_only { 2.0 } else { 0.0 }),
                    clamp: ds.depth_bias_clamp.unwrap_or(0.0),
                },
            })
        } else {
            shader
                .desc
                .depth_format
                .as_deref()
                .map(|df| wgpu::DepthStencilState {
                    format: parse_texture_format(df),
                    depth_write_enabled: Some(depth_write),
                    depth_compare: Some(depth_compare),
                    stencil: wgpu::StencilState::default(),
                    bias: if is_depth_only {
                        wgpu::DepthBiasState {
                            constant: 2,
                            slope_scale: 2.0,
                            clamp: 0.0,
                        }
                    } else {
                        wgpu::DepthBiasState::default()
                    },
                })
        };

        let pso_label = shader
            .desc
            .label
            .as_deref()
            .map(|l| format!("{l}.pso.{slot_id}"))
            .unwrap_or_else(|| format!("kernel.pso.{slot_id}"));

        let layout = if is_4bgl {
            let Some(ref s4) = self.scene_4bgl else {
                return;
            };
            Some(&s4.pipeline_layout)
        } else {
            None
        };

        let pso = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(&pso_label),
                layout,
                vertex: wgpu::VertexState {
                    module: &shader.module,
                    entry_point: Some(
                        shader
                            .desc
                            .vertex_entry_point
                            .as_deref()
                            .unwrap_or("vs_main"),
                    ),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &vb_layouts,
                },
                fragment: if is_depth_only {
                    None
                } else {
                    Some(wgpu::FragmentState {
                        module: &shader.module,
                        entry_point: Some(
                            shader
                                .desc
                                .fragment_entry_point
                                .as_deref()
                                .unwrap_or("fs_main"),
                        ),
                        compilation_options: wgpu::PipelineCompilationOptions::default(),
                        targets: &color_targets,
                    })
                },
                primitive: wgpu::PrimitiveState {
                    topology,
                    front_face,
                    cull_mode,
                    ..Default::default()
                },
                depth_stencil,
                multisample: wgpu::MultisampleState {
                    count: shader.desc.sample_count.max(1),
                    mask: !0,
                    alpha_to_coverage_enabled: false,
                },
                multiview_mask: None,
                cache: None,
            });
        self.pso_by_key.insert(key, (pso.clone(), is_4bgl));
        self.pso_by_slot.insert(slot_id, (pso, is_4bgl));
    }

    fn ensure_fullscreen_pipeline(&mut self, shader_id: u32) {
        let needs = self
            .shaders
            .get(&shader_id)
            .map(|s| s.fullscreen_pipeline.is_none())
            .unwrap_or(false);
        if !needs {
            return;
        }
        let Some(shader) = self.shaders.get(&shader_id) else {
            return;
        };
        let default_color_fmt = self
            .surface
            .as_ref()
            .map(|s| s.format)
            .unwrap_or(wgpu::TextureFormat::Rgba8Unorm);
        let fs_blend = parse_blend_mode(shader.desc.blend_mode.as_deref());
        let color_targets: Vec<Option<wgpu::ColorTargetState>> =
            if !shader.desc.color_targets.is_empty() {
                shader
                    .desc
                    .color_targets
                    .iter()
                    .map(|ct| {
                        let ct_blend = match ct.blend_mode.as_deref() {
                            Some("none") => None,
                            Some(mode) => parse_blend_mode(Some(mode)),
                            None => fs_blend,
                        };
                        let write_mask = ct
                            .write_mask
                            .map(wgpu::ColorWrites::from_bits_truncate)
                            .unwrap_or(wgpu::ColorWrites::ALL);
                        Some(wgpu::ColorTargetState {
                            format: parse_texture_format(&ct.format),
                            blend: ct_blend,
                            write_mask,
                        })
                    })
                    .collect()
            } else if shader.desc.color_formats.is_empty() {
                vec![Some(wgpu::ColorTargetState {
                    format: default_color_fmt,
                    blend: fs_blend,
                    write_mask: wgpu::ColorWrites::ALL,
                })]
            } else {
                shader
                    .desc
                    .color_formats
                    .iter()
                    .map(|fmt| {
                        Some(wgpu::ColorTargetState {
                            format: parse_texture_format(fmt),
                            blend: fs_blend,
                            write_mask: wgpu::ColorWrites::ALL,
                        })
                    })
                    .collect()
            };
        let depth_stencil = if let Some(ref ds) = shader.desc.depth_stencil {
            Some(wgpu::DepthStencilState {
                format: parse_texture_format(&ds.format),
                depth_write_enabled: Some(ds.depth_write_enabled.unwrap_or(false)),
                depth_compare: Some(
                    ds.depth_compare
                        .as_deref()
                        .and_then(|c| parse_compare_function(Some(c)))
                        .unwrap_or(wgpu::CompareFunction::Always),
                ),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            })
        } else {
            shader
                .desc
                .depth_format
                .as_deref()
                .map(|df| wgpu::DepthStencilState {
                    format: parse_texture_format(df),
                    depth_write_enabled: Some(false),
                    depth_compare: Some(wgpu::CompareFunction::Always),
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                })
        };
        let label = shader
            .desc
            .label
            .as_deref()
            .map(|l| format!("{l}.fullscreen"))
            .unwrap_or_else(|| format!("kernel.fs.{shader_id}"));
        let pso = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(&label),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &shader.module,
                    entry_point: Some(
                        shader
                            .desc
                            .vertex_entry_point
                            .as_deref()
                            .unwrap_or("vs_main"),
                    ),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader.module,
                    entry_point: Some(
                        shader
                            .desc
                            .fragment_entry_point
                            .as_deref()
                            .unwrap_or("fs_main"),
                    ),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &color_targets,
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil,
                multisample: wgpu::MultisampleState {
                    count: shader.desc.sample_count.max(1),
                    mask: !0,
                    alpha_to_coverage_enabled: false,
                },
                multiview_mask: None,
                cache: None,
            });
        if let Some(s) = self.shaders.get_mut(&shader_id) {
            s.fullscreen_pipeline = Some(pso);
        }
    }

    fn ensure_compute_pipeline(&mut self, shader_id: u32) {
        let needs = self
            .shaders
            .get(&shader_id)
            .map(|s| s.compute_pipeline.is_none())
            .unwrap_or(false);
        if !needs {
            return;
        }
        let Some(shader) = self.shaders.get(&shader_id) else {
            return;
        };
        let label = shader
            .desc
            .label
            .as_deref()
            .map(|l| format!("{l}.compute"))
            .unwrap_or_else(|| format!("kernel.cs.{shader_id}"));
        let pso = self
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(&label),
                layout: None,
                module: &shader.module,
                entry_point: Some(
                    shader
                        .desc
                        .compute_entry_point
                        .as_deref()
                        .unwrap_or("cs_main"),
                ),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                cache: None,
            });
        if let Some(s) = self.shaders.get_mut(&shader_id) {
            s.compute_pipeline = Some(pso);
        }
    }

    fn upload_frame_uniforms_ring(&mut self, uniform_data: &[u8]) {
        if uniform_data.is_empty() {
            return;
        }
        let aligned = align4_bytes(uniform_data);
        let needed = aligned.len() as u64;
        if self.frame_uniform_buffer.is_none() || self.frame_uniform_capacity < needed {
            let cap = needed.next_power_of_two().max(4096);
            self.frame_uniform_buffer = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("kernel.frame-uniform-ring"),
                size: cap,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
            self.frame_uniform_capacity = cap;
        }
        if let Some(ref buf) = self.frame_uniform_buffer {
            self.queue.write_buffer(buf, 0, &aligned);
        }
    }

    fn ensure_mipgen_pipeline(&mut self, format: wgpu::TextureFormat) {
        if self.mipgen_pipelines.contains_key(&format) {
            return;
        }
        if self.mipgen_shader.is_none() {
            self.mipgen_shader = Some(self.device.create_shader_module(
                wgpu::ShaderModuleDescriptor {
                    label: Some("kernel.mipgen.shader"),
                    source: wgpu::ShaderSource::Wgsl(MIPGEN_WGSL.into()),
                },
            ));
        }
        if self.mipgen_sampler.is_none() {
            self.mipgen_sampler = Some(self.device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("kernel.mipgen.sampler"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Linear,
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                ..Default::default()
            }));
        }
        let Some(ref module) = self.mipgen_shader else {
            return;
        };
        let pso = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("kernel.mipgen.pso"),
                layout: None,
                vertex: wgpu::VertexState {
                    module,
                    entry_point: Some("vs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module,
                    entry_point: Some("fs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
        self.mipgen_pipelines.insert(format, pso);
    }

    fn create_frame_bind_group(
        &self,
        layout: &wgpu::BindGroupLayout,
        set_id: u32,
    ) -> Option<wgpu::BindGroup> {
        if set_id == 0 {
            return None;
        }
        let entries_spec = self.frame_binding_sets.get(&set_id)?;
        if entries_spec.is_empty() {
            return None;
        }
        // Build owned subresource views first so they outlive the `BindGroupEntry` borrows.
        let mut owned_views: Vec<(usize, wgpu::TextureView)> = Vec::new();
        for (idx, e) in entries_spec.iter().enumerate() {
            if matches!(e.kind, BINDING_KIND_TEXTURE | BINDING_KIND_TEMP_TEXTURE) {
                if let Some(tex) = self.resolve_tex(e.handle) {
                    if let Some(view) = decode_binding_subresource_view(tex, e.offset) {
                        owned_views.push((idx, view));
                    }
                }
            }
        }
        let mut entries: Vec<wgpu::BindGroupEntry<'_>> = Vec::with_capacity(entries_spec.len());
        for (idx, e) in entries_spec.iter().enumerate() {
            match e.kind {
                BINDING_KIND_DYNAMIC_TEXTURE => {
                    if let Some(tex) = self.dynamic_textures.get(&e.handle) {
                        entries.push(wgpu::BindGroupEntry {
                            binding: e.slot,
                            resource: wgpu::BindingResource::TextureView(&tex.view),
                        });
                    }
                }
                BINDING_KIND_TEXTURE | BINDING_KIND_TEMP_TEXTURE => {
                    if let Some((_, sub_view)) = owned_views.iter().find(|(i, _)| *i == idx) {
                        entries.push(wgpu::BindGroupEntry {
                            binding: e.slot,
                            resource: wgpu::BindingResource::TextureView(sub_view),
                        });
                    } else if let Some(tex) = self.resolve_tex(e.handle) {
                        entries.push(wgpu::BindGroupEntry {
                            binding: e.slot,
                            resource: wgpu::BindingResource::TextureView(&tex.view),
                        });
                    }
                }
                BINDING_KIND_BUFFER => {
                    if let Some(buf) = self.buffers.get(&e.handle) {
                        entries.push(wgpu::BindGroupEntry {
                            binding: e.slot,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: buf,
                                offset: e.offset as u64,
                                size: None,
                            }),
                        });
                    }
                }
                BINDING_KIND_SAMPLER => {
                    if let Some(sampler) = self.samplers.get(&e.handle) {
                        entries.push(wgpu::BindGroupEntry {
                            binding: e.slot,
                            resource: wgpu::BindingResource::Sampler(sampler),
                        });
                    }
                }
                BINDING_KIND_UNIFORM_SLICE => {
                    if let Some(ref buf) = self.frame_uniform_buffer {
                        let size = NonZeroU64::new(e.offset as u64);
                        entries.push(wgpu::BindGroupEntry {
                            binding: e.slot,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: buf,
                                offset: e.handle as u64,
                                size,
                            }),
                        });
                    }
                }
                _ => {}
            }
        }
        if entries.is_empty() {
            return None;
        }
        Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kernel.frame-bg"),
            layout,
            entries: &entries,
        }))
    }

    /// Pre-warms every pipeline referenced inside a physical command stream so the
    /// render/compute pass recording borrows `self` immutably with zero borrow conflicts.
    fn prewarm_stream_pipelines(&mut self, phys_cmds: &[u32]) -> Result<(), NativeKernelError> {
        let mut cursor = 0usize;
        while cursor < phys_cmds.len() {
            let hdr = phys_cmds[cursor];
            let opcode = (hdr & 0xFFFF) as u16;
            let word_len = (hdr >> 16) as usize;
            if word_len == 0 || cursor + word_len > phys_cmds.len() {
                return Err(NativeKernelError::MalformedPhysicalStream(
                    "invalid word length during pipeline prewarm".to_owned(),
                ));
            }
            match opcode {
                PHYS_SET_PSO if word_len >= 6 => {
                    self.ensure_render_pipeline(
                        phys_cmds[cursor + 1],
                        phys_cmds[cursor + 2],
                        phys_cmds[cursor + 3],
                        phys_cmds[cursor + 4],
                        phys_cmds[cursor + 5],
                    );
                }
                PHYS_DRAW_FULLSCREEN if word_len >= 3 => {
                    self.ensure_fullscreen_pipeline(phys_cmds[cursor + 1]);
                }
                PHYS_DISPATCH | PHYS_DISPATCH_INDIRECT if word_len >= 3 => {
                    self.ensure_compute_pipeline(phys_cmds[cursor + 1]);
                }
                _ => {}
            }
            cursor += word_len;
        }
        Ok(())
    }

    /// Executes one resolved physical command stream and submits a single `wgpu::CommandBuffer`.
    /// When the stream targets `SURFACE_SWAPCHAIN_HANDLE`, acquires and presents the attached
    /// native `wgpu::Surface` directly on this render thread.
    pub fn execute_physical_stream(
        &mut self,
        phys_cmds: &[u32],
        uniform_data: &[u8],
    ) -> Result<u32, NativeKernelError> {
        self.execute_physical_stream_with_target(phys_cmds, uniform_data, None)
    }

    pub fn execute_physical_stream_with_target(
        &mut self,
        phys_cmds: &[u32],
        uniform_data: &[u8],
        external_swapchain_view: Option<&wgpu::TextureView>,
    ) -> Result<u32, NativeKernelError> {
        self.upload_frame_uniforms_ring(uniform_data);
        if let Some(ref mut s4) = self.scene_4bgl {
            s4.upload_frame_uniforms(&self.device, &self.queue, uniform_data);
        }

        self.frame_binding_sets.clear();
        self.prewarm_stream_pipelines(phys_cmds)?;

        let swapchain_frame: Option<(wgpu::SurfaceTexture, wgpu::TextureView)> =
            if stream_uses_swapchain(phys_cmds) && external_swapchain_view.is_none() {
                let s = self.surface.as_ref().ok_or_else(|| {
                    NativeKernelError::SurfaceError(
                        "command stream targets SURFACE_SWAPCHAIN_HANDLE but no surface is attached"
                            .to_owned(),
                    )
                })?;
                if s.config.width == 0 || s.config.height == 0 {
                    // Window is minimized; skip presentation cleanly without faulting DXGI/Metal.
                    return Ok(0);
                }
                let frame = match s.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(f) => f,
                    wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                    wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                        return Ok(0);
                    }
                    wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Outdated => {
                        self.poll_device_sync();
                        s.surface.configure(&self.device, &s.config);
                        match s.surface.get_current_texture() {
                            wgpu::CurrentSurfaceTexture::Success(f)
                            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                            wgpu::CurrentSurfaceTexture::Timeout
                            | wgpu::CurrentSurfaceTexture::Occluded => return Ok(0),
                            other => {
                                return Err(NativeKernelError::SurfaceError(format!(
                                    "swapchain re-acquire failed: {other:?}"
                                )));
                            }
                        }
                    }
                    other => {
                        return Err(NativeKernelError::SurfaceError(format!(
                            "swapchain acquire failed: {other:?}"
                        )));
                    }
                };
                let view = frame
                    .texture
                    .create_view(&wgpu::TextureViewDescriptor::default());
                Some((frame, view))
            } else {
                None
            };
        let swapchain_view = external_swapchain_view
            .or_else(|| swapchain_frame.as_ref().map(|(_, v)| v));

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax-kernel-frame"),
            });
        let mut cursor = 0usize;
        let mut executed_passes = 0u32;

        while cursor < phys_cmds.len() {
            let hdr = phys_cmds[cursor];
            let opcode = (hdr & 0xFFFF) as u16;
            let word_len = (hdr >> 16) as usize;
            if word_len == 0 || cursor + word_len > phys_cmds.len() {
                return Err(NativeKernelError::MalformedPhysicalStream(
                    "command word length out of bounds".to_owned(),
                ));
            }

            match opcode {
                PHYS_ENSURE_POOL_TEX => {
                    let slot_id = phys_cmds[cursor + 1];
                    let fsd = phys_cmds[cursor + 2];
                    let format = decode_format_code((fsd & 0xFF) as u8);
                    let samples = ((fsd >> 8) & 0xFF).max(1);
                    let width = phys_cmds[cursor + 3].max(1);
                    let height = phys_cmds[cursor + 4].max(1);
                    let layers = (phys_cmds[cursor + 5] & 0xFFFF).max(1);
                    let mips = ((phys_cmds[cursor + 5] >> 16) & 0xFFFF).max(1);
                    let usage = wgpu::TextureUsages::from_bits_truncate(phys_cmds[cursor + 6])
                        | wgpu::TextureUsages::COPY_SRC
                        | wgpu::TextureUsages::RENDER_ATTACHMENT;

                    let needs_alloc = match self.pool_textures.get(&slot_id) {
                        Some(existing) => {
                            existing.width != width
                                || existing.height != height
                                || existing.format != format
                                || existing.samples != samples
                                || existing.mip_level_count != mips
                                || existing.array_layer_count != layers
                        }
                        None => true,
                    };
                    if needs_alloc {
                        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                            label: Some("kernel-pool-tex"),
                            size: wgpu::Extent3d {
                                width,
                                height,
                                depth_or_array_layers: layers,
                            },
                            mip_level_count: mips,
                            sample_count: samples,
                            dimension: wgpu::TextureDimension::D2,
                            format,
                            usage,
                            view_formats: &[],
                        });
                        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                        self.pool_textures.insert(
                            slot_id,
                            NativeTex {
                                texture,
                                view,
                                width,
                                height,
                                format,
                                samples,
                                mip_level_count: mips,
                                array_layer_count: layers,
                            },
                        );
                    }
                }
                PHYS_RETIRE_POOL_TEX => {
                    let slot_id = phys_cmds[cursor + 1];
                    self.pool_textures.remove(&slot_id);
                }
                PHYS_DEF_BINDING_SET => {
                    let set_id = phys_cmds[cursor + 1];
                    let count = phys_cmds[cursor + 2] as usize;
                    let mut entries = Vec::with_capacity(count);
                    for i in 0..count {
                        let b = cursor + 3 + i * 3;
                        let sk = phys_cmds[b];
                        entries.push(FrameBindingEntry {
                            slot: sk & 0xFFFF,
                            kind: sk >> 16,
                            handle: phys_cmds[b + 1],
                            offset: phys_cmds[b + 2],
                        });
                    }
                    self.frame_binding_sets.insert(set_id, entries);
                }
                PHYS_BEGIN_RENDER_PASS => {
                    executed_passes += 1;
                    let meta = phys_cmds[cursor + 2];
                    let color_count = (meta & 0xFF) as usize;
                    let has_depth = ((meta >> 8) & 1) != 0;

                    let mut color_specs: Vec<(u32, u32, u32, u32, u32, u32, [f64; 4])> =
                        Vec::with_capacity(color_count);
                    let mut owned_att_views: Vec<wgpu::TextureView> = Vec::new();
                    let mut color_view_indices: Vec<(Option<usize>, Option<usize>)> =
                        Vec::with_capacity(color_count);
                    for c in 0..color_count {
                        let base = cursor + 3 + c * 8;
                        let tex_handle = phys_cmds[base];
                        let resolve_handle = phys_cmds[base + 1];
                        let mip_layer = phys_cmds[base + 2];
                        let mip = mip_layer & 0xFFFF;
                        let layer = (mip_layer >> 16) & 0xFFFF;
                        let ls = phys_cmds[base + 3];
                        let load_op = ls & 0xFF;
                        let store_op = (ls >> 8) & 0xFF;
                        let clear = [
                            f32::from_bits(phys_cmds[base + 4]) as f64,
                            f32::from_bits(phys_cmds[base + 5]) as f64,
                            f32::from_bits(phys_cmds[base + 6]) as f64,
                            f32::from_bits(phys_cmds[base + 7]) as f64,
                        ];
                        let sub_idx = if tex_handle != SURFACE_SWAPCHAIN_HANDLE {
                            self.resolve_tex(tex_handle)
                                .and_then(|t| create_attachment_subresource_view(t, mip, layer))
                                .map(|v| {
                                    let idx = owned_att_views.len();
                                    owned_att_views.push(v);
                                    idx
                                })
                        } else {
                            None
                        };
                        let res_idx = if resolve_handle != 0
                            && resolve_handle != SURFACE_SWAPCHAIN_HANDLE
                        {
                            self.resolve_tex(resolve_handle)
                                .and_then(|t| create_attachment_subresource_view(t, mip, layer))
                                .map(|v| {
                                    let idx = owned_att_views.len();
                                    owned_att_views.push(v);
                                    idx
                                })
                        } else {
                            None
                        };
                        color_view_indices.push((sub_idx, res_idx));
                        color_specs.push((
                            tex_handle,
                            resolve_handle,
                            mip,
                            layer,
                            load_op,
                            store_op,
                            clear,
                        ));
                    }

                    let mut depth_view_idx: Option<usize> = None;
                    let depth_spec = if has_depth {
                        let base = cursor + 3 + color_count * 8;
                        let tex_handle = phys_cmds[base];
                        let mip_layer = phys_cmds[base + 1];
                        let mip = mip_layer & 0xFFFF;
                        let layer = (mip_layer >> 16) & 0xFFFF;
                        let lsr = phys_cmds[base + 2];
                        let load_op = lsr & 0xFF;
                        let store_op = (lsr >> 8) & 0xFF;
                        let read_only = ((lsr >> 16) & 1) != 0;
                        let clear_val = f32::from_bits(phys_cmds[base + 3]);
                        depth_view_idx = self
                            .resolve_tex(tex_handle)
                            .and_then(|t| create_attachment_subresource_view(t, mip, layer))
                            .map(|v| {
                                let idx = owned_att_views.len();
                                owned_att_views.push(v);
                                idx
                            });
                        Some((tex_handle, load_op, store_op, read_only, clear_val))
                    } else {
                        None
                    };

                    cursor += word_len;

                    let color_attachments: Vec<Option<wgpu::RenderPassColorAttachment<'_>>> =
                        color_specs
                            .iter()
                            .enumerate()
                            .map(|(i, (tex_h, res_h, _mip, _layer, load_op, store_op, clear))| {
                                let (sub_idx, res_idx) = color_view_indices[i];
                                let target_view: Option<&wgpu::TextureView> =
                                    if *tex_h == SURFACE_SWAPCHAIN_HANDLE {
                                        swapchain_view
                                    } else if let Some(idx) = sub_idx {
                                        Some(&owned_att_views[idx])
                                    } else {
                                        self.resolve_tex(*tex_h).map(|pt| &pt.view)
                                    };
                                target_view.map(|view| {
                                    let resolve_target = if *res_h == SURFACE_SWAPCHAIN_HANDLE {
                                        swapchain_view
                                    } else if let Some(idx) = res_idx {
                                        Some(&owned_att_views[idx])
                                    } else {
                                        self.resolve_tex(*res_h).map(|rt| &rt.view)
                                    };
                                    wgpu::RenderPassColorAttachment {
                                        view,
                                        depth_slice: None,
                                        resolve_target,
                                        ops: wgpu::Operations {
                                            load: if *load_op == LOAD_OP_LOAD {
                                                wgpu::LoadOp::Load
                                            } else {
                                                wgpu::LoadOp::Clear(wgpu::Color {
                                                    r: clear[0],
                                                    g: clear[1],
                                                    b: clear[2],
                                                    a: clear[3],
                                                })
                                            },
                                            store: if *store_op == STORE_OP_DISCARD {
                                                wgpu::StoreOp::Discard
                                            } else {
                                                wgpu::StoreOp::Store
                                            },
                                        },
                                    }
                                })
                            })
                            .collect();

                    let depth_attachment = depth_spec.and_then(
                        |(tex_h, load_op, store_op, read_only, clear_val)| {
                            let dview = if let Some(idx) = depth_view_idx {
                                Some(&owned_att_views[idx])
                            } else {
                                self.resolve_tex(tex_h).map(|dt| &dt.view)
                            };
                            dview.map(|view| wgpu::RenderPassDepthStencilAttachment {
                                view,
                                depth_ops: if read_only {
                                    None
                                } else {
                                    Some(wgpu::Operations {
                                        load: if load_op == LOAD_OP_LOAD {
                                            wgpu::LoadOp::Load
                                        } else {
                                            wgpu::LoadOp::Clear(clear_val)
                                        },
                                        store: if store_op == STORE_OP_DISCARD {
                                            wgpu::StoreOp::Discard
                                        } else {
                                            wgpu::StoreOp::Store
                                        },
                                    })
                                },
                                stencil_ops: None,
                            })
                        },
                    );

                    // Pre-create fullscreen bind groups, per-pass shadow-map Group 2 bind groups,
                    // and general non-4BGL custom pipeline bind groups so they outlive the pass.
                    let mut fullscreen_bgs: Vec<(usize, wgpu::BindGroup)> = Vec::new();
                    let mut extra_shadow_bgs: Vec<(usize, wgpu::BindGroup)> = Vec::new();
                    let mut custom_render_bgs: Vec<(usize, u32, wgpu::BindGroup)> = Vec::new();
                    {
                        let mut scan = cursor;
                        let mut scan_pso_slot: Option<u32> = None;
                        let mut scan_pso_is_4bgl = false;
                        while scan < phys_cmds.len() {
                            let shdr = phys_cmds[scan];
                            let sop = (shdr & 0xFFFF) as u16;
                            let slen = (shdr >> 16) as usize;
                            if slen == 0 || scan + slen > phys_cmds.len() {
                                break;
                            }
                            if sop == PHYS_END_RENDER_PASS {
                                break;
                            }
                            if sop == PHYS_SET_PSO && slen >= 6 {
                                let slot_id = phys_cmds[scan + 5];
                                scan_pso_slot = Some(slot_id);
                                scan_pso_is_4bgl = self
                                    .pso_by_slot
                                    .get(&slot_id)
                                    .map(|(_, is_4bgl)| *is_4bgl)
                                    .unwrap_or(false);
                            } else if sop == PHYS_SET_BIND_GROUP && slen >= 3 {
                                let slot = phys_cmds[scan + 1];
                                let set_id = phys_cmds[scan + 2];
                                if scan_pso_slot.is_none() || scan_pso_is_4bgl {
                                    if slot == BGL_SLOT_VIEW && set_id != 0 {
                                        if let Some(entries) = self.frame_binding_sets.get(&set_id) {
                                            if let Some(shadow_entry) = entries.iter().find(|e| {
                                                e.slot == 0
                                                    && matches!(
                                                        e.kind,
                                                        BINDING_KIND_TEXTURE
                                                            | BINDING_KIND_DYNAMIC_TEXTURE
                                                            | BINDING_KIND_TEMP_TEXTURE
                                                    )
                                            }) {
                                                if let (Some(tex), Some(ref s4)) = (
                                                    self.resolve_tex(shadow_entry.handle),
                                                    &self.scene_4bgl,
                                                ) {
                                                    let bg = s4
                                                        .create_mesh_scene_bind_group_with_shadow(
                                                            &self.device,
                                                            &tex.view,
                                                        );
                                                    extra_shadow_bgs.push((scan, bg));
                                                }
                                            }
                                        }
                                    }
                                } else if set_id != 0 {
                                    if let Some(pso_slot) = scan_pso_slot {
                                        if let Some((pso, _)) = self.pso_by_slot.get(&pso_slot) {
                                            let layout = pso.get_bind_group_layout(slot);
                                            if let Some(bg) =
                                                self.create_frame_bind_group(&layout, set_id)
                                            {
                                                custom_render_bgs.push((scan, slot, bg));
                                            }
                                        }
                                    }
                                }
                            } else if sop == PHYS_DRAW_FULLSCREEN && slen >= 3 {
                                scan_pso_slot = None;
                                scan_pso_is_4bgl = false;
                                let shader_id = phys_cmds[scan + 1];
                                let binding_set_id = phys_cmds[scan + 2];
                                if binding_set_id != 0 {
                                    if let Some(pso) = self
                                        .shaders
                                        .get(&shader_id)
                                        .and_then(|s| s.fullscreen_pipeline.as_ref())
                                    {
                                        let layout = pso.get_bind_group_layout(0);
                                        if let Some(bg) =
                                            self.create_frame_bind_group(&layout, binding_set_id)
                                        {
                                            fullscreen_bgs.push((scan, bg));
                                        }
                                    }
                                }
                            }
                            scan += slen;
                        }
                    }

                    {
                        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("kernel-raster-pass"),
                            color_attachments: &color_attachments,
                            depth_stencil_attachment: depth_attachment,
                            timestamp_writes: None,
                            occlusion_query_set: None,
                            multiview_mask: None,
                        });

                        let mut bg_cursor = 0usize;
                        let mut shadow_bg_cursor = 0usize;
                        let mut custom_bg_cursor = 0usize;
                        let mut active_shadow_bg_idx: Option<usize> = None;
                        let mut active_pso_is_4bgl = false;
                        let mut bound_scene_groups = false;
                        let mut current_view_offset = 0u32;
                        let mut current_material_id = 0u32;
                        while cursor < phys_cmds.len() {
                            let chdr = phys_cmds[cursor];
                            let cop = (chdr & 0xFFFF) as u16;
                            let clen = (chdr >> 16) as usize;
                            if clen == 0 || cursor + clen > phys_cmds.len() {
                                return Err(NativeKernelError::MalformedPhysicalStream(
                                    "render pass inner command out of bounds".to_owned(),
                                ));
                            }
                            match cop {
                                PHYS_END_RENDER_PASS => {
                                    cursor += clen;
                                    break;
                                }
                                PHYS_SET_PSO => {
                                    let slot_id = phys_cmds[cursor + 5];
                                    if let Some((pso, is_4bgl)) = self.pso_by_slot.get(&slot_id) {
                                        rpass.set_pipeline(pso);
                                        active_pso_is_4bgl = *is_4bgl;
                                        if active_pso_is_4bgl {
                                            if let Some(ref s4) = self.scene_4bgl {
                                                rpass.set_bind_group(
                                                    0,
                                                    &s4.view_bind_group,
                                                    &[current_view_offset],
                                                );
                                                if current_material_id != 0 {
                                                    if let Some(mat) =
                                                        self.materials.get(&current_material_id)
                                                    {
                                                        if let Some(ref bg) = mat.bind_group {
                                                            rpass.set_bind_group(1, bg, &[]);
                                                        }
                                                    }
                                                }
                                                if !bound_scene_groups {
                                                    let g2 = match active_shadow_bg_idx {
                                                        Some(idx) => &extra_shadow_bgs[idx].1,
                                                        None => &s4.mesh_scene_bind_group,
                                                    };
                                                    rpass.set_bind_group(2, g2, &[]);
                                                    rpass.set_bind_group(
                                                        3,
                                                        &s4.instances_bind_group,
                                                        &[],
                                                    );
                                                    bound_scene_groups = true;
                                                }
                                            }
                                        } else {
                                            bound_scene_groups = false;
                                        }
                                    }
                                }
                                PHYS_SET_BIND_GROUP => {
                                    let slot = phys_cmds[cursor + 1];
                                    let mut handled_custom = false;
                                    if !active_pso_is_4bgl {
                                        if let Some((pos, bg_slot, bg)) =
                                            custom_render_bgs.get(custom_bg_cursor)
                                        {
                                            if *pos == cursor {
                                                let dyn_len = if clen >= 4 {
                                                    phys_cmds[cursor + 3] as usize
                                                } else {
                                                    0
                                                };
                                                let dyn_slice = if dyn_len > 0
                                                    && cursor + 4 + dyn_len <= phys_cmds.len()
                                                {
                                                    &phys_cmds[cursor + 4..cursor + 4 + dyn_len]
                                                } else {
                                                    &[]
                                                };
                                                rpass.set_bind_group(*bg_slot, bg, dyn_slice);
                                                custom_bg_cursor += 1;
                                                handled_custom = true;
                                            }
                                        }
                                    }
                                    if !handled_custom {
                                        if slot == BGL_SLOT_VIEW && clen >= 5 {
                                            current_view_offset = phys_cmds[cursor + 4];
                                            if let Some((pos, _)) =
                                                extra_shadow_bgs.get(shadow_bg_cursor)
                                            {
                                                if *pos == cursor {
                                                    active_shadow_bg_idx = Some(shadow_bg_cursor);
                                                    shadow_bg_cursor += 1;
                                                    bound_scene_groups = false;
                                                }
                                            } else if phys_cmds[cursor + 2] == 0
                                                && active_shadow_bg_idx.is_some()
                                            {
                                                active_shadow_bg_idx = None;
                                                bound_scene_groups = false;
                                            }
                                            if active_pso_is_4bgl {
                                                if let Some(ref s4) = self.scene_4bgl {
                                                    rpass.set_bind_group(
                                                        0,
                                                        &s4.view_bind_group,
                                                        &[current_view_offset],
                                                    );
                                                    if !bound_scene_groups {
                                                        let g2 = match active_shadow_bg_idx {
                                                            Some(idx) => &extra_shadow_bgs[idx].1,
                                                            None => &s4.mesh_scene_bind_group,
                                                        };
                                                        rpass.set_bind_group(2, g2, &[]);
                                                        rpass.set_bind_group(
                                                            3,
                                                            &s4.instances_bind_group,
                                                            &[],
                                                        );
                                                        bound_scene_groups = true;
                                                    }
                                                }
                                            }
                                        } else if slot == BGL_SLOT_MATERIAL && clen >= 3 {
                                            current_material_id = phys_cmds[cursor + 2];
                                            if active_pso_is_4bgl {
                                                if let Some(mat) =
                                                    self.materials.get(&current_material_id)
                                                {
                                                    if let Some(ref bg) = mat.bind_group {
                                                        rpass.set_bind_group(1, bg, &[]);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                PHYS_SET_VB => {
                                    let slot = phys_cmds[cursor + 1];
                                    let mesh_or_buf = phys_cmds[cursor + 2];
                                    let off = phys_cmds[cursor + 3] as u64;
                                    if let Some(mesh) = self.meshes.get(&mesh_or_buf) {
                                        rpass.set_vertex_buffer(slot, mesh.vb.slice(off..));
                                    } else if let Some(buf) = self.buffers.get(&mesh_or_buf) {
                                        rpass.set_vertex_buffer(slot, buf.slice(off..));
                                    }
                                }
                                PHYS_SET_IB => {
                                    let mesh_or_buf = phys_cmds[cursor + 1];
                                    let is_u32 = phys_cmds[cursor + 2] != 0;
                                    let off = phys_cmds[cursor + 3] as u64;
                                    let fmt = if is_u32 {
                                        wgpu::IndexFormat::Uint32
                                    } else {
                                        wgpu::IndexFormat::Uint16
                                    };
                                    if let Some(Some(ib)) =
                                        self.meshes.get(&mesh_or_buf).map(|m| m.ib.as_ref())
                                    {
                                        rpass.set_index_buffer(ib.slice(off..), fmt);
                                    } else if let Some(buf) = self.buffers.get(&mesh_or_buf) {
                                        rpass.set_index_buffer(buf.slice(off..), fmt);
                                    }
                                }
                                PHYS_DRAW => {
                                    let vc = phys_cmds[cursor + 1];
                                    let ic = phys_cmds[cursor + 2];
                                    let fv = phys_cmds[cursor + 3];
                                    let fi = phys_cmds[cursor + 4];
                                    rpass.draw(fv..fv + vc, fi..fi + ic);
                                }
                                PHYS_DRAW_INDEXED => {
                                    let icount = phys_cmds[cursor + 1];
                                    let inst = phys_cmds[cursor + 2];
                                    let fi = phys_cmds[cursor + 3];
                                    let bv = phys_cmds[cursor + 4] as i32;
                                    let finst = phys_cmds[cursor + 5];
                                    rpass.draw_indexed(fi..fi + icount, bv, finst..finst + inst);
                                }
                                PHYS_DRAW_INDIRECT => {
                                    let buf_id = phys_cmds[cursor + 1];
                                    let off = phys_cmds[cursor + 2] as u64;
                                    if let Some(buf) = self.buffers.get(&buf_id) {
                                        rpass.draw_indirect(buf, off);
                                    }
                                }
                                PHYS_SET_VIEWPORT => {
                                    let x = f32::from_bits(phys_cmds[cursor + 1]);
                                    let y = f32::from_bits(phys_cmds[cursor + 2]);
                                    let w = f32::from_bits(phys_cmds[cursor + 3]);
                                    let h = f32::from_bits(phys_cmds[cursor + 4]);
                                    let min_d = f32::from_bits(phys_cmds[cursor + 5]);
                                    let max_d = f32::from_bits(phys_cmds[cursor + 6]);
                                    rpass.set_viewport(x, y, w, h, min_d, max_d);
                                }
                                PHYS_SET_SCISSOR => {
                                    let x = phys_cmds[cursor + 1];
                                    let y = phys_cmds[cursor + 2];
                                    let w = phys_cmds[cursor + 3];
                                    let h = phys_cmds[cursor + 4];
                                    rpass.set_scissor_rect(x, y, w, h);
                                }
                                PHYS_DRAW_FULLSCREEN => {
                                    let shader_id = phys_cmds[cursor + 1];
                                    if let Some(pso) = self
                                        .shaders
                                        .get(&shader_id)
                                        .and_then(|s| s.fullscreen_pipeline.as_ref())
                                    {
                                        active_pso_is_4bgl = false;
                                        bound_scene_groups = false;
                                        rpass.set_pipeline(pso);
                                        if let Some((pos, bg)) = fullscreen_bgs.get(bg_cursor) {
                                            if *pos == cursor {
                                                rpass.set_bind_group(0, bg, &[]);
                                                bg_cursor += 1;
                                            }
                                        }
                                        rpass.draw(0..3, 0..1);
                                    }
                                }
                                _ => {}
                            }
                            cursor += clen;
                        }
                    }
                    continue;
                }
                PHYS_BEGIN_COMPUTE_PASS => {
                    executed_passes += 1;
                    cursor += word_len;

                    // Pre-build bind groups for dispatches in this compute pass.
                    let mut compute_bgs: Vec<(usize, wgpu::BindGroup)> = Vec::new();
                    {
                        let mut scan = cursor;
                        while scan < phys_cmds.len() {
                            let shdr = phys_cmds[scan];
                            let sop = (shdr & 0xFFFF) as u16;
                            let slen = (shdr >> 16) as usize;
                            if slen == 0 || scan + slen > phys_cmds.len() {
                                break;
                            }
                            if sop == PHYS_END_COMPUTE_PASS {
                                break;
                            }
                            if (sop == PHYS_DISPATCH || sop == PHYS_DISPATCH_INDIRECT) && slen >= 3
                            {
                                let shader_id = phys_cmds[scan + 1];
                                let binding_set_id = phys_cmds[scan + 2];
                                if binding_set_id != 0 {
                                    if let Some(pso) = self
                                        .shaders
                                        .get(&shader_id)
                                        .and_then(|s| s.compute_pipeline.as_ref())
                                    {
                                        let layout = pso.get_bind_group_layout(0);
                                        if let Some(bg) =
                                            self.create_frame_bind_group(&layout, binding_set_id)
                                        {
                                            compute_bgs.push((scan, bg));
                                        }
                                    }
                                }
                            }
                            scan += slen;
                        }
                    }

                    {
                        let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                            label: Some("kernel-compute-pass"),
                            timestamp_writes: None,
                        });
                        let mut bg_cursor = 0usize;
                        while cursor < phys_cmds.len() {
                            let chdr = phys_cmds[cursor];
                            let cop = (chdr & 0xFFFF) as u16;
                            let clen = (chdr >> 16) as usize;
                            if clen == 0 || cursor + clen > phys_cmds.len() {
                                return Err(NativeKernelError::MalformedPhysicalStream(
                                    "compute pass inner command out of bounds".to_owned(),
                                ));
                            }
                            match cop {
                                PHYS_END_COMPUTE_PASS => {
                                    cursor += clen;
                                    break;
                                }
                                PHYS_DISPATCH => {
                                    let shader_id = phys_cmds[cursor + 1];
                                    if let Some(pso) = self
                                        .shaders
                                        .get(&shader_id)
                                        .and_then(|s| s.compute_pipeline.as_ref())
                                    {
                                        cpass.set_pipeline(pso);
                                        if let Some((pos, bg)) = compute_bgs.get(bg_cursor) {
                                            if *pos == cursor {
                                                cpass.set_bind_group(0, bg, &[]);
                                                bg_cursor += 1;
                                            }
                                        }
                                        cpass.dispatch_workgroups(
                                            phys_cmds[cursor + 5],
                                            phys_cmds[cursor + 6],
                                            phys_cmds[cursor + 7],
                                        );
                                    }
                                }
                                PHYS_DISPATCH_INDIRECT => {
                                    let shader_id = phys_cmds[cursor + 1];
                                    let buf_id = phys_cmds[cursor + 3];
                                    let off = phys_cmds[cursor + 4] as u64;
                                    if let (Some(pso), Some(buf)) = (
                                        self.shaders
                                            .get(&shader_id)
                                            .and_then(|s| s.compute_pipeline.as_ref()),
                                        self.buffers.get(&buf_id),
                                    ) {
                                        cpass.set_pipeline(pso);
                                        if let Some((pos, bg)) = compute_bgs.get(bg_cursor) {
                                            if *pos == cursor {
                                                cpass.set_bind_group(0, bg, &[]);
                                                bg_cursor += 1;
                                            }
                                        }
                                        cpass.dispatch_workgroups_indirect(buf, off);
                                    }
                                }
                                _ => {}
                            }
                            cursor += clen;
                        }
                    }
                    continue;
                }
                PHYS_COPY_TEXTURE => {
                    let src_h = phys_cmds[cursor + 1];
                    let src_mip = phys_cmds[cursor + 2] & 0xFFFF;
                    let src_layer = (phys_cmds[cursor + 2] >> 16) & 0xFFFF;
                    let dst_h = phys_cmds[cursor + 3];
                    let dst_mip = phys_cmds[cursor + 4] & 0xFFFF;
                    let dst_layer = (phys_cmds[cursor + 4] >> 16) & 0xFFFF;
                    let w = phys_cmds[cursor + 5].max(1);
                    let h = phys_cmds[cursor + 6].max(1);
                    let d = phys_cmds[cursor + 7].max(1);
                    let dst_tex: Option<&wgpu::Texture> = if dst_h == SURFACE_SWAPCHAIN_HANDLE {
                        swapchain_frame.as_ref().map(|(f, _)| &f.texture)
                    } else {
                        self.resolve_tex(dst_h).map(|t| &t.texture)
                    };
                    if let (Some(src), Some(dst)) = (self.resolve_tex(src_h), dst_tex) {
                        encoder.copy_texture_to_texture(
                            wgpu::TexelCopyTextureInfo {
                                texture: &src.texture,
                                mip_level: src_mip,
                                origin: wgpu::Origin3d {
                                    x: 0,
                                    y: 0,
                                    z: src_layer,
                                },
                                aspect: wgpu::TextureAspect::All,
                            },
                            wgpu::TexelCopyTextureInfo {
                                texture: dst,
                                mip_level: dst_mip,
                                origin: wgpu::Origin3d {
                                    x: 0,
                                    y: 0,
                                    z: dst_layer,
                                },
                                aspect: wgpu::TextureAspect::All,
                            },
                            wgpu::Extent3d {
                                width: w,
                                height: h,
                                depth_or_array_layers: d,
                            },
                        );
                    }
                }
                PHYS_COPY_BUFFER => {
                    let src_h = phys_cmds[cursor + 1];
                    let src_off = phys_cmds[cursor + 2] as u64;
                    let dst_h = phys_cmds[cursor + 3];
                    let dst_off = phys_cmds[cursor + 4] as u64;
                    let size = phys_cmds[cursor + 5] as u64;
                    if let (Some(src), Some(dst)) = (self.buffers.get(&src_h), self.buffers.get(&dst_h)) {
                        encoder.copy_buffer_to_buffer(src, src_off, dst, dst_off, size);
                    }
                }
                PHYS_GENERATE_MIPS => {
                    let tex_h = phys_cmds[cursor + 1];
                    if let Some((fmt, mip_count, layer_count)) = self
                        .resolve_tex(tex_h)
                        .map(|t| (t.format, t.mip_level_count, t.array_layer_count))
                    {
                        if mip_count > 1 {
                            self.ensure_mipgen_pipeline(fmt);
                            if let (Some(tex), Some(pso), Some(smp)) = (
                                self.resolve_tex(tex_h),
                                self.mipgen_pipelines.get(&fmt),
                                self.mipgen_sampler.as_ref(),
                            ) {
                                let layout = pso.get_bind_group_layout(0);
                                for layer in 0..layer_count {
                                    for mip in 1..mip_count {
                                        let src_view = tex.texture.create_view(
                                            &wgpu::TextureViewDescriptor {
                                                label: Some("kernel.mipgen.src"),
                                                format: None,
                                                dimension: Some(wgpu::TextureViewDimension::D2),
                                                usage: None,
                                                aspect: wgpu::TextureAspect::All,
                                                base_mip_level: mip - 1,
                                                mip_level_count: Some(1),
                                                base_array_layer: layer,
                                                array_layer_count: Some(1),
                                            },
                                        );
                                        let dst_view = tex.texture.create_view(
                                            &wgpu::TextureViewDescriptor {
                                                label: Some("kernel.mipgen.dst"),
                                                format: None,
                                                dimension: Some(wgpu::TextureViewDimension::D2),
                                                usage: None,
                                                aspect: wgpu::TextureAspect::All,
                                                base_mip_level: mip,
                                                mip_level_count: Some(1),
                                                base_array_layer: layer,
                                                array_layer_count: Some(1),
                                            },
                                        );
                                        let bg = self.device.create_bind_group(
                                            &wgpu::BindGroupDescriptor {
                                                label: Some("kernel.mipgen.bg"),
                                                layout: &layout,
                                                entries: &[
                                                    wgpu::BindGroupEntry {
                                                        binding: 0,
                                                        resource:
                                                            wgpu::BindingResource::TextureView(
                                                                &src_view,
                                                            ),
                                                    },
                                                    wgpu::BindGroupEntry {
                                                        binding: 1,
                                                        resource: wgpu::BindingResource::Sampler(
                                                            smp,
                                                        ),
                                                    },
                                                ],
                                            },
                                        );
                                        let mut pass = encoder.begin_render_pass(
                                            &wgpu::RenderPassDescriptor {
                                                label: Some("kernel.mipgen.pass"),
                                                color_attachments: &[Some(
                                                    wgpu::RenderPassColorAttachment {
                                                        view: &dst_view,
                                                        depth_slice: None,
                                                        resolve_target: None,
                                                        ops: wgpu::Operations {
                                                            load: wgpu::LoadOp::Clear(
                                                                wgpu::Color::TRANSPARENT,
                                                            ),
                                                            store: wgpu::StoreOp::Store,
                                                        },
                                                    },
                                                )],
                                                depth_stencil_attachment: None,
                                                timestamp_writes: None,
                                                occlusion_query_set: None,
                                                multiview_mask: None,
                                            },
                                        );
                                        pass.set_pipeline(pso);
                                        pass.set_bind_group(0, &bg, &[]);
                                        pass.draw(0..3, 0..1);
                                        executed_passes += 1;
                                    }
                                }
                            }
                        }
                    }
                }
                PHYS_REQUEST_READBACK => {
                    let tex_h = phys_cmds[cursor + 1];
                    let ticket_id = phys_cmds[cursor + 2];
                    let layer_mip = phys_cmds[cursor + 3];
                    let mip = layer_mip & 0xFFFF;
                    let layer = (layer_mip >> 16) & 0xFFFF;
                    if let Some(tex) = self.resolve_tex(tex_h) {
                        let w = (tex.width >> mip).max(1);
                        let h = (tex.height >> mip).max(1);
                        let bpp = bytes_per_pixel(tex.format);
                        let unpadded_row = w * bpp;
                        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
                        let padded_row = ((unpadded_row + align - 1) / align) * align;
                        let buffer_size = (padded_row as u64) * (h as u64);
                        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
                            label: Some("kernel.ticket-readback"),
                            size: buffer_size.max(4),
                            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                            mapped_at_creation: false,
                        });
                        encoder.copy_texture_to_buffer(
                            wgpu::TexelCopyTextureInfo {
                                texture: &tex.texture,
                                mip_level: mip,
                                origin: wgpu::Origin3d {
                                    x: 0,
                                    y: 0,
                                    z: layer,
                                },
                                aspect: wgpu::TextureAspect::All,
                            },
                            wgpu::TexelCopyBufferInfo {
                                buffer: &staging,
                                layout: wgpu::TexelCopyBufferLayout {
                                    offset: 0,
                                    bytes_per_row: Some(padded_row),
                                    rows_per_image: Some(h),
                                },
                            },
                            wgpu::Extent3d {
                                width: w,
                                height: h,
                                depth_or_array_layers: 1,
                            },
                        );
                        self.pending_readbacks.insert(
                            ticket_id,
                            PendingReadback {
                                staging,
                                width: w,
                                height: h,
                                unpadded_row,
                                padded_row,
                                format: tex.format,
                            },
                        );
                    }
                }
                _ => {}
            }

            cursor += word_len;
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        if let Some((frame, _view)) = swapchain_frame {
            self.queue.present(frame);
            self.surface_presents += 1;
        }
        Ok(executed_passes)
    }

    /// Reads back pixels queued by `PHYS_REQUEST_READBACK` for `ticket_id`.
    /// Works on both native Metal/DX12/Vulkan and wasm32 WebGL2.
    pub fn readback_ticket(
        &mut self,
        ticket_id: u32,
    ) -> Result<(u32, u32, String, Vec<u8>), NativeKernelError> {
        let pending = self.pending_readbacks.remove(&ticket_id).ok_or_else(|| {
            NativeKernelError::ResourceNotFound(format!("readback ticket {ticket_id}"))
        })?;
        let slice = pending.staging.slice(..);
        let status = std::sync::Arc::new(std::sync::Mutex::new(None::<Result<(), wgpu::BufferAsyncError>>));
        let status_cb = std::sync::Arc::clone(&status);
        slice.map_async(wgpu::MapMode::Read, move |res| {
            if let Ok(mut guard) = status_cb.lock() {
                *guard = Some(res);
            }
        });
        self.poll_device_sync();
        let map_res = status
            .lock()
            .ok()
            .and_then(|mut g| g.take())
            .ok_or_else(|| NativeKernelError::ReadbackFailed("ticket map did not complete".to_owned()))?;
        map_res.map_err(|e| NativeKernelError::ReadbackFailed(format!("ticket map failed: {e}")))?;

        let mapped = slice.get_mapped_range().map_err(|e| {
            NativeKernelError::ReadbackFailed(format!("ticket get_mapped_range failed: {e}"))
        })?;
        let mut out = vec![0u8; (pending.unpadded_row * pending.height) as usize];
        for row in 0..pending.height as usize {
            let src_off = row * pending.padded_row as usize;
            let dst_off = row * pending.unpadded_row as usize;
            out[dst_off..dst_off + pending.unpadded_row as usize]
                .copy_from_slice(&mapped[src_off..src_off + pending.unpadded_row as usize]);
        }
        drop(mapped);
        pending.staging.unmap();
        Ok((
            pending.width,
            pending.height,
            format_to_webgpu_str(pending.format).to_owned(),
            out,
        ))
    }

    /// Reads back a transient pool texture into tightly packed pixel bytes (handling
    /// wgpu's 256-byte row alignment automatically).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn readback_pool_texture(
        &self,
        slot_id: u32,
    ) -> Result<(u32, u32, Vec<u8>), NativeKernelError> {
        let tex = self
            .pool_textures
            .get(&slot_id)
            .ok_or_else(|| NativeKernelError::ResourceNotFound(format!("pool texture {slot_id}")))?;
        let width = tex.width;
        let height = tex.height;
        let bpp = bytes_per_pixel(tex.format);
        let unpadded_row = width * bpp;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_row = ((unpadded_row + align - 1) / align) * align;
        let buffer_size = (padded_row as u64) * (height as u64);

        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kernel.readback-staging"),
            size: buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("kernel.readback-encoder"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &tex.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(std::iter::once(encoder.finish()));

        let slice = staging.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv()
            .map_err(|_| NativeKernelError::ReadbackFailed("map callback dropped".to_owned()))?
            .map_err(|e| NativeKernelError::ReadbackFailed(format!("buffer map failed: {e}")))?;

        let mapped = slice
            .get_mapped_range()
            .map_err(|e| NativeKernelError::ReadbackFailed(format!("get_mapped_range failed: {e}")))?;
        let mut out = vec![0u8; (unpadded_row * height) as usize];
        for row in 0..height as usize {
            let src_off = row * padded_row as usize;
            let dst_off = row * unpadded_row as usize;
            out[dst_off..dst_off + unpadded_row as usize]
                .copy_from_slice(&mapped[src_off..src_off + unpadded_row as usize]);
        }
        drop(mapped);
        staging.unmap();
        Ok((width, height, out))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn readback_buffer(
        &self,
        buf_id: u32,
        offset: u64,
        size: u64,
    ) -> Result<Vec<u8>, NativeKernelError> {
        let src = self
            .buffers
            .get(&buf_id)
            .ok_or_else(|| NativeKernelError::ResourceNotFound(format!("buffer {buf_id}")))?;
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kernel.buf-readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("kernel.buf-readback-enc"),
            });
        encoder.copy_buffer_to_buffer(src, offset, &staging, 0, size);
        self.queue.submit(std::iter::once(encoder.finish()));

        let slice = staging.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv()
            .map_err(|_| NativeKernelError::ReadbackFailed("buffer map callback dropped".to_owned()))?
            .map_err(|e| NativeKernelError::ReadbackFailed(format!("buffer map failed: {e}")))?;
        let data = slice
            .get_mapped_range()
            .map_err(|e| NativeKernelError::ReadbackFailed(format!("get_mapped_range failed: {e}")))?
            .to_vec();
        staging.unmap();
        Ok(data)
    }
}
