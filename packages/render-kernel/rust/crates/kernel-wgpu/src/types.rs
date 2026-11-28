//! Data types, descriptors, and error enums for the native wgpu RenderKernel backend.

use forgeax_render_kernel_core::cull::VisibleLightSummary;

#[derive(Debug, Clone)]
pub enum NativeKernelError {
    AdapterUnavailable,
    DeviceCreation(String),
    CoreError(String),
    MalformedPhysicalStream(String),
    ResourceNotFound(String),
    ReadbackFailed(String),
    SurfaceError(String),
    ChannelClosed,
}

impl std::fmt::Display for NativeKernelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AdapterUnavailable => write!(f, "no native wgpu adapter available"),
            Self::DeviceCreation(msg) => write!(f, "wgpu device creation failed: {msg}"),
            Self::CoreError(msg) => write!(f, "render kernel core error: {msg}"),
            Self::MalformedPhysicalStream(msg) => write!(f, "malformed physical stream: {msg}"),
            Self::ResourceNotFound(msg) => write!(f, "resource not found: {msg}"),
            Self::ReadbackFailed(msg) => write!(f, "texture readback failed: {msg}"),
            Self::SurfaceError(msg) => write!(f, "native surface error: {msg}"),
            Self::ChannelClosed => write!(f, "dedicated native render thread channel closed"),
        }
    }
}

impl std::error::Error for NativeKernelError {}

#[derive(Debug, Clone, Copy, Default)]
pub struct NativeSubmeshDesc {
    pub first_index: u32,
    pub index_count: u32,
    pub base_vertex: i32,
    pub first_vertex: u32,
    pub vertex_count: u32,
}

#[derive(Debug, Clone)]
pub struct NativeMeshDesc {
    pub vertex_layout_id: u32,
    pub vertex_count: u32,
    pub index_count: u32,
    pub is_uint32_index: bool,
    pub topology: u8,
    pub submeshes: Vec<NativeSubmeshDesc>,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeTextureDesc {
    pub width: u32,
    pub height: u32,
    pub format_code: u8,
    pub usage: u32,
    pub mip_level_count: u32,
    pub array_layer_count: u32,
    pub sample_count: u32,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeBufferDesc {
    pub size: u32,
    pub usage: u32,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NativeSamplerDesc {
    pub mag_filter: Option<String>,
    pub min_filter: Option<String>,
    pub mipmap_filter: Option<String>,
    pub address_mode_u: Option<String>,
    pub address_mode_v: Option<String>,
    pub address_mode_w: Option<String>,
    pub compare: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeVertexAttribute {
    pub format: String,
    pub offset: u64,
    pub shader_location: u32,
}

#[derive(Debug, Clone)]
pub struct NativeVertexBufferLayout {
    pub array_stride: u64,
    pub step_mode: Option<String>,
    pub attributes: Vec<NativeVertexAttribute>,
}

#[derive(Debug, Clone)]
pub struct NativeColorTargetDesc {
    pub format: String,
    pub blend_mode: Option<String>,
    pub write_mask: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct NativeDepthStencilDesc {
    pub format: String,
    pub depth_write_enabled: Option<bool>,
    pub depth_compare: Option<String>,
    pub depth_bias: Option<i32>,
    pub depth_bias_slope_scale: Option<f32>,
    pub depth_bias_clamp: Option<f32>,
}

#[derive(Debug, Clone, Default)]
pub struct NativeShaderProgramDesc {
    pub code: String,
    pub vertex_entry_point: Option<String>,
    pub fragment_entry_point: Option<String>,
    pub compute_entry_point: Option<String>,
    pub layout_family_id: u32,
    pub vertex_buffer_layouts: Vec<NativeVertexBufferLayout>,
    pub color_formats: Vec<String>,
    pub color_targets: Vec<NativeColorTargetDesc>,
    pub depth_format: Option<String>,
    pub depth_stencil: Option<NativeDepthStencilDesc>,
    pub sample_count: u32,
    pub blend_mode: Option<String>,
    pub cull_mode: Option<String>,
    pub front_face: Option<String>,
    pub primitive_topology: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeMaterialDesc {
    pub shader_program_id: u32,
    pub layout_family_id: u32,
    pub render_state_bits: u32,
    pub variant_flags: u32,
    pub queue: u16,
    pub base_color_texture_id: Option<u32>,
    pub normal_texture_id: Option<u32>,
    pub metallic_roughness_texture_id: Option<u32>,
    pub emissive_texture_id: Option<u32>,
    pub occlusion_texture_id: Option<u32>,
    pub sampler_id: Option<u32>,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeCullRequest {
    pub view_proj: [f32; 16],
    pub camera_pos: [f32; 3],
    pub layer_mask: u32,
    pub flags: u32,
    pub lod_bias: f32,
}

#[derive(Debug, Clone)]
pub struct NativeCullSummary {
    pub cull_id: u32,
    pub candidate_count: u32,
    pub visible_opaque_count: u32,
    pub visible_masked_count: u32,
    pub visible_transparent_count: u32,
    pub visible_shadow_caster_count: u32,
    pub visible_bounds_min: [f32; 3],
    pub visible_bounds_max: [f32; 3],
    pub visible_lights: Vec<VisibleLightSummary>,
}

#[derive(Debug, Clone)]
pub struct NativeFrameReceipt {
    pub frame_id: u64,
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
    pub resolved_physical_commands: Vec<u32>,
    pub submitted_bitmap: Vec<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct NativeThreadStats {
    pub submitted_frames: u64,
    pub completed_frames: u64,
    pub last_completed_frame_id: u64,
    pub in_flight_frames: u64,
    pub total_plan_us: f64,
    pub total_encode_submit_us: f64,
    pub last_plan_us: f64,
    pub last_encode_submit_us: f64,
    pub dirty_rows_uploaded: u64,
    pub dirty_range_writes: u64,
    pub material_uploads: u64,
    pub surface_presents: u64,
    pub gpu_memory_bytes: u64,
    pub pool_memory_bytes: u64,
    pub device_generation: u64,
    pub recovery_count: u64,
    pub surface_format: Option<String>,
    pub adapter_name: String,
    pub backend_name: String,
}

pub fn decode_format_code(code: u8) -> wgpu::TextureFormat {
    match code {
        1 => wgpu::TextureFormat::Rgba8Unorm,
        2 => wgpu::TextureFormat::Rgba8UnormSrgb,
        3 => wgpu::TextureFormat::Bgra8Unorm,
        4 => wgpu::TextureFormat::Bgra8UnormSrgb,
        5 => wgpu::TextureFormat::Rgba16Float,
        6 => wgpu::TextureFormat::Depth32Float,
        7 => wgpu::TextureFormat::Rg11b10Ufloat,
        8 => wgpu::TextureFormat::R8Unorm,
        9 => wgpu::TextureFormat::Rg8Unorm,
        10 => wgpu::TextureFormat::R16Float,
        11 => wgpu::TextureFormat::Rg16Float,
        12 => wgpu::TextureFormat::R32Float,
        13 => wgpu::TextureFormat::Rgba32Float,
        14 => wgpu::TextureFormat::Depth24Plus,
        15 => wgpu::TextureFormat::Depth24PlusStencil8,
        16 => wgpu::TextureFormat::Rgb10a2Unorm,
        17 => wgpu::TextureFormat::Rg32Float,
        _ => wgpu::TextureFormat::Rgba8Unorm,
    }
}

pub fn parse_texture_format(name: &str) -> wgpu::TextureFormat {
    match name {
        "rgba8unorm" => wgpu::TextureFormat::Rgba8Unorm,
        "rgba8unorm-srgb" => wgpu::TextureFormat::Rgba8UnormSrgb,
        "bgra8unorm" => wgpu::TextureFormat::Bgra8Unorm,
        "bgra8unorm-srgb" => wgpu::TextureFormat::Bgra8UnormSrgb,
        "rgba16float" => wgpu::TextureFormat::Rgba16Float,
        "rgba32float" => wgpu::TextureFormat::Rgba32Float,
        "rg11b10ufloat" => wgpu::TextureFormat::Rg11b10Ufloat,
        "rgb10a2unorm" => wgpu::TextureFormat::Rgb10a2Unorm,
        "depth32float" => wgpu::TextureFormat::Depth32Float,
        "depth24plus" => wgpu::TextureFormat::Depth24Plus,
        "depth24plus-stencil8" => wgpu::TextureFormat::Depth24PlusStencil8,
        "r8unorm" => wgpu::TextureFormat::R8Unorm,
        "rg8unorm" => wgpu::TextureFormat::Rg8Unorm,
        "r16float" => wgpu::TextureFormat::R16Float,
        "rg16float" => wgpu::TextureFormat::Rg16Float,
        "r32float" => wgpu::TextureFormat::R32Float,
        "rg32float" => wgpu::TextureFormat::Rg32Float,
        _ => wgpu::TextureFormat::Rgba8Unorm,
    }
}

pub fn format_to_webgpu_str(format: wgpu::TextureFormat) -> &'static str {
    match format {
        wgpu::TextureFormat::Rgba8Unorm => "rgba8unorm",
        wgpu::TextureFormat::Rgba8UnormSrgb => "rgba8unorm-srgb",
        wgpu::TextureFormat::Bgra8Unorm => "bgra8unorm",
        wgpu::TextureFormat::Bgra8UnormSrgb => "bgra8unorm-srgb",
        wgpu::TextureFormat::Rgba16Float => "rgba16float",
        wgpu::TextureFormat::Rgba32Float => "rgba32float",
        wgpu::TextureFormat::Rg11b10Ufloat => "rg11b10ufloat",
        wgpu::TextureFormat::Rgb10a2Unorm => "rgb10a2unorm",
        wgpu::TextureFormat::Depth32Float => "depth32float",
        wgpu::TextureFormat::Depth24Plus => "depth24plus",
        wgpu::TextureFormat::Depth24PlusStencil8 => "depth24plus-stencil8",
        wgpu::TextureFormat::R8Unorm => "r8unorm",
        wgpu::TextureFormat::Rg8Unorm => "rg8unorm",
        wgpu::TextureFormat::R16Float => "r16float",
        wgpu::TextureFormat::Rg16Float => "rg16float",
        wgpu::TextureFormat::R32Float => "r32float",
        wgpu::TextureFormat::Rg32Float => "rg32float",
        _ => "rgba8unorm",
    }
}

pub fn bytes_per_pixel(format: wgpu::TextureFormat) -> u32 {
    match format {
        wgpu::TextureFormat::R8Unorm => 1,
        wgpu::TextureFormat::Rg8Unorm | wgpu::TextureFormat::R16Float => 2,
        wgpu::TextureFormat::Rgba8Unorm
        | wgpu::TextureFormat::Rgba8UnormSrgb
        | wgpu::TextureFormat::Bgra8Unorm
        | wgpu::TextureFormat::Bgra8UnormSrgb
        | wgpu::TextureFormat::Rg11b10Ufloat
        | wgpu::TextureFormat::Rgb10a2Unorm
        | wgpu::TextureFormat::R32Float
        | wgpu::TextureFormat::Rg16Float
        | wgpu::TextureFormat::Depth32Float
        | wgpu::TextureFormat::Depth24Plus
        | wgpu::TextureFormat::Depth24PlusStencil8 => 4,
        wgpu::TextureFormat::Rgba16Float | wgpu::TextureFormat::Rg32Float => 8,
        wgpu::TextureFormat::Rgba32Float => 16,
        _ => 4,
    }
}

pub fn parse_vertex_format(name: &str) -> wgpu::VertexFormat {
    match name {
        "float32" => wgpu::VertexFormat::Float32,
        "float32x2" => wgpu::VertexFormat::Float32x2,
        "float32x3" => wgpu::VertexFormat::Float32x3,
        "float32x4" => wgpu::VertexFormat::Float32x4,
        "uint32" => wgpu::VertexFormat::Uint32,
        "uint32x2" => wgpu::VertexFormat::Uint32x2,
        "uint32x3" => wgpu::VertexFormat::Uint32x3,
        "uint32x4" => wgpu::VertexFormat::Uint32x4,
        "sint32" => wgpu::VertexFormat::Sint32,
        "sint32x2" => wgpu::VertexFormat::Sint32x2,
        "sint32x3" => wgpu::VertexFormat::Sint32x3,
        "sint32x4" => wgpu::VertexFormat::Sint32x4,
        "unorm8x4" => wgpu::VertexFormat::Unorm8x4,
        "uint8x4" => wgpu::VertexFormat::Uint8x4,
        "unorm16x2" => wgpu::VertexFormat::Unorm16x2,
        "unorm16x4" => wgpu::VertexFormat::Unorm16x4,
        "float16x2" => wgpu::VertexFormat::Float16x2,
        "float16x4" => wgpu::VertexFormat::Float16x4,
        _ => wgpu::VertexFormat::Float32x3,
    }
}

pub fn parse_filter_mode(name: Option<&str>) -> wgpu::FilterMode {
    match name {
        Some("linear") => wgpu::FilterMode::Linear,
        _ => wgpu::FilterMode::Nearest,
    }
}

pub fn parse_mipmap_filter_mode(name: Option<&str>) -> wgpu::MipmapFilterMode {
    match name {
        Some("linear") => wgpu::MipmapFilterMode::Linear,
        _ => wgpu::MipmapFilterMode::Nearest,
    }
}

pub fn parse_address_mode(name: Option<&str>) -> wgpu::AddressMode {
    match name {
        Some("repeat") => wgpu::AddressMode::Repeat,
        Some("mirror-repeat") => wgpu::AddressMode::MirrorRepeat,
        _ => wgpu::AddressMode::ClampToEdge,
    }
}

pub fn parse_compare_function(name: Option<&str>) -> Option<wgpu::CompareFunction> {
    match name? {
        "never" => Some(wgpu::CompareFunction::Never),
        "less" => Some(wgpu::CompareFunction::Less),
        "equal" => Some(wgpu::CompareFunction::Equal),
        "less-equal" => Some(wgpu::CompareFunction::LessEqual),
        "greater" => Some(wgpu::CompareFunction::Greater),
        "not-equal" => Some(wgpu::CompareFunction::NotEqual),
        "greater-equal" => Some(wgpu::CompareFunction::GreaterEqual),
        "always" => Some(wgpu::CompareFunction::Always),
        _ => None,
    }
}
