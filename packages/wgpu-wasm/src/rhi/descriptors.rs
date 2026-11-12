//! Private JSON descriptors and wgpu conversion mirrors for the RHI facade.

use super::leak_str;
use serde::Deserialize;
use wgpu;

// ============================================================================
// Mirror descriptor structs (w3) — serde-wasm-bindgen bridge.
// ============================================================================
// Each mirror struct maps JS camelCase fields to Rust snake_case via serde.
// wgpu types with serde support (TextureFormat, AddressMode, etc.) are used
// directly since the "serde" feature is enabled on the wgpu dependency.
// Labels: String -> Option<&'static str> via Box::leak.

// ============================================================================
// Mirror enum types — kebab-case serde bridges for wgpu enums
// ============================================================================
// These Js-prefixed enums mirror wgpu types that either use PascalCase serde by
// default or have struct variants incompatible with flat kebab-case strings.
// They accept WebGPU-spec-compliant kebab-case strings from JS and convert to
// native wgpu enum values via into_wgpu().

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum BufferBindingTypeJs {
    Uniform,
    Storage,
    ReadOnlyStorage,
}
impl BufferBindingTypeJs {
    fn into_wgpu(&self) -> wgpu::BufferBindingType {
        match self {
            BufferBindingTypeJs::Uniform => wgpu::BufferBindingType::Uniform,
            BufferBindingTypeJs::Storage => wgpu::BufferBindingType::Storage { read_only: false },
            BufferBindingTypeJs::ReadOnlyStorage => {
                wgpu::BufferBindingType::Storage { read_only: true }
            }
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum TextureSampleTypeJs {
    Float,
    UnfilterableFloat,
    Depth,
    Sint,
    Uint,
}
impl TextureSampleTypeJs {
    fn into_wgpu(&self) -> wgpu::TextureSampleType {
        match self {
            TextureSampleTypeJs::Float => wgpu::TextureSampleType::Float { filterable: true },
            TextureSampleTypeJs::UnfilterableFloat => {
                wgpu::TextureSampleType::Float { filterable: false }
            }
            TextureSampleTypeJs::Depth => wgpu::TextureSampleType::Depth,
            TextureSampleTypeJs::Sint => wgpu::TextureSampleType::Sint,
            TextureSampleTypeJs::Uint => wgpu::TextureSampleType::Uint,
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum SamplerBorderColorJs {
    TransparentBlack,
    OpaqueBlack,
    OpaqueWhite,
}
impl SamplerBorderColorJs {
    fn into_wgpu(&self) -> wgpu::SamplerBorderColor {
        match self {
            SamplerBorderColorJs::TransparentBlack => wgpu::SamplerBorderColor::TransparentBlack,
            SamplerBorderColorJs::OpaqueBlack => wgpu::SamplerBorderColor::OpaqueBlack,
            SamplerBorderColorJs::OpaqueWhite => wgpu::SamplerBorderColor::OpaqueWhite,
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum PresentModeJs {
    Fifo,
    FifoRelaxed,
    Immediate,
    Mailbox,
    AutoVsync,
    AutoNoVsync,
}
impl PresentModeJs {
    pub(super) fn into_wgpu(&self) -> wgpu::PresentMode {
        match self {
            PresentModeJs::Fifo => wgpu::PresentMode::Fifo,
            PresentModeJs::FifoRelaxed => wgpu::PresentMode::FifoRelaxed,
            PresentModeJs::Immediate => wgpu::PresentMode::Immediate,
            PresentModeJs::Mailbox => wgpu::PresentMode::Mailbox,
            PresentModeJs::AutoVsync => wgpu::PresentMode::AutoVsync,
            PresentModeJs::AutoNoVsync => wgpu::PresentMode::AutoNoVsync,
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum QueryTypeJs {
    Occlusion,
    Timestamp,
}
impl QueryTypeJs {
    pub(super) fn into_wgpu(&self) -> wgpu::QueryType {
        match self {
            QueryTypeJs::Occlusion => wgpu::QueryType::Occlusion,
            QueryTypeJs::Timestamp => wgpu::QueryType::Timestamp,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShaderModuleDescriptorJs {
    pub(super) code: String,
    #[serde(default)]
    pub(super) label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Extent3dJs {
    width: u32,
    height: u32,
    #[serde(default = "one")]
    depth_or_array_layers: u32,
}
const fn one() -> u32 {
    1
}
impl Extent3dJs {
    fn into_wgpu(&self) -> wgpu::Extent3d {
        wgpu::Extent3d {
            width: self.width,
            height: self.height,
            depth_or_array_layers: self.depth_or_array_layers,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TextureDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    size: Extent3dJs,
    #[serde(default = "one")]
    mip_level_count: u32,
    #[serde(default = "one")]
    sample_count: u32,
    dimension: Option<wgpu::TextureDimension>,
    format: wgpu::TextureFormat,
    usage: u32,
    #[serde(default)]
    view_formats: Vec<wgpu::TextureFormat>,
    // WebGPU compatibility-mode field. wgpu 30's native TextureDescriptor
    // has no equivalent, but the standard path carries the actual binding
    // dimension through TextureViewDescriptor, so parsing this field is
    // sufficient. Keep it in the JS mirror to reject malformed values rather
    // than silently accepting an unknown enum member.
    #[serde(default)]
    texture_binding_view_dimension: Option<wgpu::TextureViewDimension>,
}
impl TextureDescriptorJs {
    pub(super) fn into_wgpu(&self) -> wgpu::TextureDescriptor<'static> {
        let vf: &'static [wgpu::TextureFormat] = if self.view_formats.is_empty() {
            &[]
        } else {
            Box::leak(self.view_formats.clone().into_boxed_slice())
        };
        wgpu::TextureDescriptor {
            label: self.label.as_ref().map(|s| leak_str(s.clone())),
            size: self.size.into_wgpu(),
            mip_level_count: self.mip_level_count,
            sample_count: self.sample_count,
            dimension: self.dimension.unwrap_or(wgpu::TextureDimension::D2),
            format: self.format,
            usage: wgpu::TextureUsages::from_bits_truncate(self.usage),
            view_formats: vf,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SamplerDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    #[serde(default, rename = "addressModeU")]
    address_mode_u: Option<wgpu::AddressMode>,
    #[serde(default, rename = "addressModeV")]
    address_mode_v: Option<wgpu::AddressMode>,
    #[serde(default, rename = "addressModeW")]
    address_mode_w: Option<wgpu::AddressMode>,
    #[serde(default)]
    mag_filter: Option<wgpu::FilterMode>,
    #[serde(default)]
    min_filter: Option<wgpu::FilterMode>,
    #[serde(default)]
    mipmap_filter: Option<wgpu::MipmapFilterMode>,
    #[serde(default)]
    lod_min_clamp: Option<f32>,
    #[serde(default)]
    lod_max_clamp: Option<f32>,
    #[serde(default)]
    compare: Option<wgpu::CompareFunction>,
    #[serde(default)]
    max_anisotropy: Option<u16>,
    #[serde(default)]
    border_color: Option<SamplerBorderColorJs>,
}
impl SamplerDescriptorJs {
    pub(super) fn into_wgpu(&self) -> wgpu::SamplerDescriptor<'_> {
        wgpu::SamplerDescriptor {
            label: self.label.as_deref(),
            address_mode_u: self
                .address_mode_u
                .unwrap_or(wgpu::AddressMode::ClampToEdge),
            address_mode_v: self
                .address_mode_v
                .unwrap_or(wgpu::AddressMode::ClampToEdge),
            address_mode_w: self
                .address_mode_w
                .unwrap_or(wgpu::AddressMode::ClampToEdge),
            mag_filter: self.mag_filter.unwrap_or(wgpu::FilterMode::Nearest),
            min_filter: self.min_filter.unwrap_or(wgpu::FilterMode::Nearest),
            mipmap_filter: self
                .mipmap_filter
                .unwrap_or(wgpu::MipmapFilterMode::Nearest),
            lod_min_clamp: self.lod_min_clamp.unwrap_or(0.0),
            lod_max_clamp: self.lod_max_clamp.unwrap_or(32.0),
            compare: self.compare,
            anisotropy_clamp: self.max_anisotropy.unwrap_or(1),
            border_color: self.border_color.as_ref().map(|bc| bc.into_wgpu()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BindGroupLayoutDescriptorJs {
    #[serde(default)]
    pub(super) label: Option<String>,
    pub(super) entries: Vec<BindGroupLayoutEntryJs>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BindGroupLayoutEntryJs {
    binding: u32,
    visibility: u32,
    #[serde(default)]
    buffer: Option<BufferBindingLayoutJs>,
    #[serde(default)]
    sampler: Option<SamplerBindingLayoutJs>,
    #[serde(default)]
    texture: Option<TextureBindingLayoutJs>,
    #[serde(default, rename = "storageTexture")]
    storage_texture: Option<StorageTextureBindingLayoutJs>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BufferBindingLayoutJs {
    #[serde(default, rename = "type")]
    ty: Option<BufferBindingTypeJs>,
    #[serde(default)]
    has_dynamic_offset: bool,
    #[serde(default)]
    min_binding_size: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SamplerBindingLayoutJs {
    #[serde(default, rename = "type")]
    ty: Option<wgpu::SamplerBindingType>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureBindingLayoutJs {
    #[serde(default)]
    sample_type: Option<TextureSampleTypeJs>,
    #[serde(default, rename = "viewDimension")]
    view_dimension: Option<wgpu::TextureViewDimension>,
    #[serde(default)]
    multisampled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageTextureBindingLayoutJs {
    #[serde(default)]
    access: Option<wgpu::StorageTextureAccess>,
    format: wgpu::TextureFormat,
    #[serde(default, rename = "viewDimension")]
    view_dimension: Option<wgpu::TextureViewDimension>,
}
impl BindGroupLayoutEntryJs {
    pub(super) fn into_wgpu(&self) -> wgpu::BindGroupLayoutEntry {
        let ty = if let Some(ref buf) = self.buffer {
            wgpu::BindingType::Buffer {
                ty: buf
                    .ty
                    .as_ref()
                    .map_or(wgpu::BufferBindingType::Uniform, |t| t.into_wgpu()),
                has_dynamic_offset: buf.has_dynamic_offset,
                min_binding_size: buf.min_binding_size.and_then(core::num::NonZeroU64::new),
            }
        } else if let Some(ref s) = self.sampler {
            wgpu::BindingType::Sampler(s.ty.unwrap_or(wgpu::SamplerBindingType::Filtering))
        } else if let Some(ref t) = self.texture {
            wgpu::BindingType::Texture {
                sample_type: t
                    .sample_type
                    .as_ref()
                    .map_or(wgpu::TextureSampleType::Float { filterable: true }, |st| {
                        st.into_wgpu()
                    }),
                view_dimension: t.view_dimension.unwrap_or(wgpu::TextureViewDimension::D2),
                multisampled: t.multisampled,
            }
        } else if let Some(ref st) = self.storage_texture {
            wgpu::BindingType::StorageTexture {
                access: st.access.unwrap_or(wgpu::StorageTextureAccess::WriteOnly),
                format: st.format,
                view_dimension: st.view_dimension.unwrap_or(wgpu::TextureViewDimension::D2),
            }
        } else {
            wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            }
        };
        wgpu::BindGroupLayoutEntry {
            binding: self.binding,
            visibility: wgpu::ShaderStages::from_bits_truncate(self.visibility),
            ty,
            count: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PipelineLayoutDescriptorJs {
    #[serde(default)]
    pub(super) label: Option<String>,
    #[serde(default = "one_u32")]
    pipeline_push_constant_size: u32,
    #[serde(default)]
    pub(super) immediate_size: u32,
}
pub(super) const fn one_u32() -> u32 {
    1
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BufferDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    size: u64,
    usage: u32,
    #[serde(default)]
    mapped_at_creation: bool,
}
impl BufferDescriptorJs {
    fn into_wgpu(&self) -> wgpu::BufferDescriptor<'static> {
        wgpu::BufferDescriptor {
            label: self.label.as_ref().map(|s| leak_str(s.clone())),
            size: self.size,
            usage: wgpu::BufferUsages::from_bits_truncate(self.usage),
            mapped_at_creation: self.mapped_at_creation,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SurfaceConfigurationJs {
    /// Resolved to wgpu::Device reference at call site via RhiWgpuDevice
    #[serde(skip)]
    device: (),
    pub(super) usage: u32,
    pub(super) format: wgpu::TextureFormat,
    #[serde(default = "one_u32")]
    pub(super) width: u32,
    #[serde(default = "one_u32")]
    pub(super) height: u32,
    #[serde(default = "surface_default_present_mode")]
    pub(super) present_mode: PresentModeJs,
    #[serde(default)]
    pub(super) desired_maximum_frame_latency: Option<u32>,
    #[serde(default)]
    pub(super) alpha_mode: Option<wgpu::CompositeAlphaMode>,
    #[serde(default)]
    pub(super) view_formats: Vec<wgpu::TextureFormat>,
}

const fn surface_default_present_mode() -> PresentModeJs {
    PresentModeJs::Fifo
}

// ============================================================================
// Mirror structs for RenderPipeline sub-descriptors (w4)
// ============================================================================

/// bug-20260610: WebGPU spec `cullMode` is `'none' | 'front' | 'back'` but
/// wgpu's `Face` is `Front | Back` only — "no culling" is `cull_mode: None`
/// in Rust. Mirror the spec value set as a separate enum and project to
/// `Option<wgpu::Face>` at conversion time so descriptors that pass
/// `cullMode: 'none'` (e.g. tonemap, FXAA, fullscreen post-process passes)
/// don't blow up at deserialization.
#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CullModeJs {
    None,
    Front,
    Back,
}
impl CullModeJs {
    fn into_wgpu(self) -> Option<wgpu::Face> {
        match self {
            CullModeJs::None => None,
            CullModeJs::Front => Some(wgpu::Face::Front),
            CullModeJs::Back => Some(wgpu::Face::Back),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrimitiveStateJs {
    #[serde(default)]
    topology: Option<wgpu::PrimitiveTopology>,
    #[serde(default)]
    strip_index_format: Option<wgpu::IndexFormat>,
    #[serde(default)]
    front_face: Option<wgpu::FrontFace>,
    #[serde(default)]
    cull_mode: Option<CullModeJs>,
    #[serde(default)]
    unclipped_depth: Option<bool>,
    #[serde(default)]
    polygon_mode: Option<wgpu::PolygonMode>,
    #[serde(default)]
    conservative: Option<bool>,
}
impl PrimitiveStateJs {
    pub(super) fn into_wgpu(self) -> wgpu::PrimitiveState {
        wgpu::PrimitiveState {
            topology: self
                .topology
                .unwrap_or(wgpu::PrimitiveTopology::TriangleList),
            strip_index_format: self.strip_index_format,
            front_face: self.front_face.unwrap_or(wgpu::FrontFace::Ccw),
            cull_mode: self.cull_mode.and_then(|c| c.into_wgpu()),
            unclipped_depth: self.unclipped_depth.unwrap_or(false),
            polygon_mode: self.polygon_mode.unwrap_or(wgpu::PolygonMode::Fill),
            conservative: self.conservative.unwrap_or(false),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DepthStencilStateJs {
    format: wgpu::TextureFormat,
    #[serde(default)]
    depth_write_enabled: bool,
    #[serde(default)]
    depth_compare: Option<wgpu::CompareFunction>,
    // GPUDepthStencilState keeps the stencil face states and masks at the
    // top level. The RHI descriptor mirrors that WebGPU shape; nesting these
    // fields under `stencil` silently dropped every custom stencil state on
    // the WebGL2/WASM fallback path.
    #[serde(default)]
    stencil_front: Option<StencilFaceStateJs>,
    #[serde(default)]
    stencil_back: Option<StencilFaceStateJs>,
    #[serde(default)]
    stencil_read_mask: Option<u32>,
    #[serde(default)]
    stencil_write_mask: Option<u32>,
    // GPUDepthStencilState keeps depth bias as three top-level fields. The
    // RHI descriptor mirrors that WebGPU shape; nesting them under `bias`
    // silently drops every authored depth-bias value on the WebGL2 fallback.
    #[serde(default)]
    depth_bias: Option<i32>,
    #[serde(default)]
    depth_bias_slope_scale: Option<f32>,
    #[serde(default)]
    depth_bias_clamp: Option<f32>,
}
impl DepthStencilStateJs {
    pub(super) fn into_wgpu(self) -> wgpu::DepthStencilState {
        wgpu::DepthStencilState {
            format: self.format,
            depth_write_enabled: Some(self.depth_write_enabled),
            depth_compare: self.depth_compare,
            stencil: wgpu::StencilState {
                front: self
                    .stencil_front
                    .map(|f| f.into_wgpu())
                    .unwrap_or_default(),
                back: self.stencil_back.map(|b| b.into_wgpu()).unwrap_or_default(),
                read_mask: self.stencil_read_mask.unwrap_or(u32::MAX),
                write_mask: self.stencil_write_mask.unwrap_or(u32::MAX),
            },
            bias: wgpu::DepthBiasState {
                constant: self.depth_bias.unwrap_or(0),
                slope_scale: self.depth_bias_slope_scale.unwrap_or(0.0),
                clamp: self.depth_bias_clamp.unwrap_or(0.0),
            },
        }
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StencilFaceStateJs {
    #[serde(default)]
    compare: Option<wgpu::CompareFunction>,
    #[serde(default)]
    fail_op: Option<wgpu::StencilOperation>,
    #[serde(default)]
    depth_fail_op: Option<wgpu::StencilOperation>,
    #[serde(default)]
    pass_op: Option<wgpu::StencilOperation>,
}
impl StencilFaceStateJs {
    fn into_wgpu(self) -> wgpu::StencilFaceState {
        wgpu::StencilFaceState {
            compare: self.compare.unwrap_or(wgpu::CompareFunction::Always),
            fail_op: self.fail_op.unwrap_or(wgpu::StencilOperation::Keep),
            depth_fail_op: self.depth_fail_op.unwrap_or(wgpu::StencilOperation::Keep),
            pass_op: self.pass_op.unwrap_or(wgpu::StencilOperation::Keep),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MultisampleStateJs {
    #[serde(default = "one_u32")]
    count: u32,
    #[serde(default)]
    mask: Option<u64>,
    #[serde(default)]
    alpha_to_coverage_enabled: Option<bool>,
}
impl MultisampleStateJs {
    pub(super) fn into_wgpu(self) -> wgpu::MultisampleState {
        wgpu::MultisampleState {
            count: self.count,
            mask: self.mask.unwrap_or(u64::MAX),
            alpha_to_coverage_enabled: self.alpha_to_coverage_enabled.unwrap_or(false),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BlendStateJs {
    color: BlendComponentJs,
    alpha: BlendComponentJs,
}
impl BlendStateJs {
    pub(super) fn into_wgpu(self) -> wgpu::BlendState {
        wgpu::BlendState {
            color: self.color.into_wgpu(),
            alpha: self.alpha.into_wgpu(),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlendComponentJs {
    #[serde(default)]
    operation: Option<wgpu::BlendOperation>,
    #[serde(default)]
    src_factor: Option<wgpu::BlendFactor>,
    #[serde(default)]
    dst_factor: Option<wgpu::BlendFactor>,
}
impl BlendComponentJs {
    fn into_wgpu(self) -> wgpu::BlendComponent {
        wgpu::BlendComponent {
            operation: self.operation.unwrap_or(wgpu::BlendOperation::Add),
            src_factor: self.src_factor.unwrap_or(wgpu::BlendFactor::One),
            dst_factor: self.dst_factor.unwrap_or(wgpu::BlendFactor::Zero),
        }
    }
}

// ============================================================================
// RenderPass descriptor mirror structs (w10)
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenderPassDescriptorJs {
    #[serde(default)]
    pub(super) label: Option<String>,
    #[serde(default)]
    pub(super) color_attachments: Vec<RenderPassColorAttachmentJs>,
    #[serde(default)]
    pub(super) depth_stencil_attachment: Option<RenderPassDepthStencilAttachmentJs>,
}

/// bug-20260610: WebGPU spec ships `loadOp` / `storeOp` as separate kebab-case
/// strings + `clearValue` as a flat `{r,g,b,a}` dict, not a tagged enum
/// payload. The earlier `Option<wgpu::LoadOp<wgpu::Color>>` deserialization
/// blew up with "invalid type: unit value, expected f32 / wgpu::Color"
/// because serde tried to fill the `Clear` variant's payload from the bare
/// string `"clear"`. We mirror the spec shape and reassemble `wgpu::LoadOp`
/// at the call site.
#[derive(Debug, PartialEq, Default)]
pub(super) enum LoadOpStrJs {
    #[default]
    Load,
    Clear,
}
impl<'de> serde::Deserialize<'de> for LoadOpStrJs {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <String as serde::Deserialize>::deserialize(d)?;
        match s.as_str() {
            "load" => Ok(LoadOpStrJs::Load),
            "clear" => Ok(LoadOpStrJs::Clear),
            other => Err(serde::de::Error::custom(format!(
                "unknown loadOp '{other}' (expected 'load' | 'clear')"
            ))),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenderPassColorAttachmentJs {
    /// Borrowed JS handle resolved to an owned temporary clone for pass creation.
    #[serde(skip)]
    pub(super) view: Option<wgpu::TextureView>,
    #[serde(default)]
    pub(super) depth_slice: Option<u32>,
    #[serde(skip)]
    pub(super) resolve_target: Option<wgpu::TextureView>,
    #[serde(default)]
    pub(super) load_op: Option<LoadOpStrJs>,
    #[serde(default)]
    pub(super) store_op: Option<wgpu::StoreOp>,
    #[serde(default)]
    pub(super) clear_value: Option<wgpu::Color>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenderPassDepthStencilAttachmentJs {
    #[serde(skip)]
    pub(super) view: Option<wgpu::TextureView>,
    #[serde(default)]
    pub(super) depth_load_op: Option<LoadOpStrJs>,
    #[serde(default)]
    pub(super) depth_store_op: Option<wgpu::StoreOp>,
    #[serde(default)]
    pub(super) depth_clear_value: Option<f32>,
    #[serde(default)]
    pub(super) stencil_load_op: Option<LoadOpStrJs>,
    #[serde(default)]
    pub(super) stencil_store_op: Option<wgpu::StoreOp>,
    #[serde(default)]
    pub(super) stencil_clear_value: Option<u32>,
    #[serde(default)]
    pub(super) depth_read_only: bool,
    #[serde(default)]
    pub(super) stencil_read_only: bool,
}
