//! POD descriptors sent by the TypeScript GPU as JSON. Field names and enum strings follow the
//! WebGPU IDL; object references are table ids. The TypeScript side normalises dictionary
//! shapes (`GPUExtent3D` arrays, `GPUColor` objects) before sending.

use serde::Deserialize;
use std::collections::HashMap;
use wgpu::{
    AddressMode, BlendFactor, BlendOperation, CompareFunction, FilterMode, FrontFace, IndexFormat,
    MipmapFilterMode, PrimitiveTopology, StencilOperation, StorageTextureAccess, TextureAspect,
    TextureDimension, TextureFormat, TextureViewDimension, VertexFormat, VertexStepMode,
};

pub type Id = u32;

#[derive(Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct Extent {
    pub width: u32,
    #[serde(default = "one")]
    pub height: u32,
    #[serde(default = "one")]
    pub depth_or_array_layers: u32,
}

#[derive(Deserialize, Clone, Copy, Default)]
pub struct Origin {
    #[serde(default)]
    pub x: u32,
    #[serde(default)]
    pub y: u32,
    #[serde(default)]
    pub z: u32,
}

fn one() -> u32 {
    1
}

impl From<Extent> for wgpu::Extent3d {
    fn from(e: Extent) -> Self {
        wgpu::Extent3d {
            width: e.width,
            height: e.height,
            depth_or_array_layers: e.depth_or_array_layers,
        }
    }
}

impl From<Origin> for wgpu::Origin3d {
    fn from(o: Origin) -> Self {
        wgpu::Origin3d {
            x: o.x,
            y: o.y,
            z: o.z,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDesc {
    pub label: Option<String>,
    #[serde(default)]
    pub required_features: Vec<String>,
    #[serde(default)]
    pub required_limits: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferDesc {
    pub label: Option<String>,
    pub size: u64,
    pub usage: u32,
    #[serde(default)]
    pub mapped_at_creation: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureDesc {
    pub label: Option<String>,
    pub size: Extent,
    #[serde(default = "one")]
    pub mip_level_count: u32,
    #[serde(default = "one")]
    pub sample_count: u32,
    pub dimension: Option<TextureDimension>,
    pub format: TextureFormat,
    pub usage: u32,
    #[serde(default)]
    pub view_formats: Vec<TextureFormat>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewDesc {
    pub label: Option<String>,
    pub format: Option<TextureFormat>,
    pub dimension: Option<TextureViewDimension>,
    pub usage: Option<u32>,
    pub aspect: Option<TextureAspect>,
    #[serde(default)]
    pub base_mip_level: u32,
    pub mip_level_count: Option<u32>,
    #[serde(default)]
    pub base_array_layer: u32,
    pub array_layer_count: Option<u32>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SamplerDesc {
    pub label: Option<String>,
    pub address_mode_u: Option<AddressMode>,
    pub address_mode_v: Option<AddressMode>,
    pub address_mode_w: Option<AddressMode>,
    pub mag_filter: Option<FilterMode>,
    pub min_filter: Option<FilterMode>,
    pub mipmap_filter: Option<MipmapFilterMode>,
    pub lod_min_clamp: Option<f32>,
    pub lod_max_clamp: Option<f32>,
    pub compare: Option<CompareFunction>,
    pub max_anisotropy: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BglDesc {
    pub label: Option<String>,
    pub entries: Vec<BglEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BglEntry {
    pub binding: u32,
    pub visibility: u32,
    pub buffer: Option<BufferLayout>,
    pub sampler: Option<SamplerLayout>,
    pub texture: Option<TextureLayout>,
    pub storage_texture: Option<StorageTextureLayout>,
    pub acceleration_structure: Option<serde_json::Value>,
    pub external_texture: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferLayout {
    #[serde(rename = "type")]
    pub ty: Option<String>,
    #[serde(default)]
    pub has_dynamic_offset: bool,
    #[serde(default)]
    pub min_binding_size: u64,
}

#[derive(Deserialize)]
pub struct SamplerLayout {
    #[serde(rename = "type")]
    pub ty: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureLayout {
    pub sample_type: Option<String>,
    pub view_dimension: Option<TextureViewDimension>,
    #[serde(default)]
    pub multisampled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTextureLayout {
    pub access: Option<StorageTextureAccess>,
    pub format: TextureFormat,
    pub view_dimension: Option<TextureViewDimension>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineLayoutDesc {
    pub label: Option<String>,
    pub bind_group_layouts: Vec<Option<Id>>,
    #[serde(default)]
    pub immediate_size: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindGroupDesc {
    pub label: Option<String>,
    pub layout: Id,
    pub entries: Vec<BindGroupEntry>,
}

#[derive(Deserialize)]
pub struct BindGroupEntry {
    pub binding: u32,
    pub resource: BindingResource,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BindingResource {
    Buffer {
        id: Id,
        #[serde(default)]
        offset: u64,
        size: Option<u64>,
    },
    Sampler {
        id: Id,
    },
    TextureView {
        id: Id,
    },
    AccelerationStructure {
        id: Id,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgrammableStage {
    pub module: Id,
    pub entry_point: Option<String>,
    #[serde(default)]
    pub constants: HashMap<String, f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexAttribute {
    pub format: VertexFormat,
    pub offset: u64,
    pub shader_location: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexBufferLayout {
    pub array_stride: u64,
    pub step_mode: Option<VertexStepMode>,
    pub attributes: Vec<VertexAttribute>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexState {
    #[serde(flatten)]
    pub stage: ProgrammableStage,
    #[serde(default)]
    pub buffers: Vec<Option<VertexBufferLayout>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveState {
    pub topology: Option<PrimitiveTopology>,
    pub strip_index_format: Option<IndexFormat>,
    pub front_face: Option<FrontFace>,
    pub cull_mode: Option<String>,
    #[serde(default)]
    pub unclipped_depth: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StencilFace {
    pub compare: Option<CompareFunction>,
    pub fail_op: Option<StencilOperation>,
    pub depth_fail_op: Option<StencilOperation>,
    pub pass_op: Option<StencilOperation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthStencilState {
    pub format: TextureFormat,
    pub depth_write_enabled: Option<bool>,
    pub depth_compare: Option<CompareFunction>,
    #[serde(default)]
    pub stencil_front: StencilFace,
    #[serde(default)]
    pub stencil_back: StencilFace,
    pub stencil_read_mask: Option<u32>,
    pub stencil_write_mask: Option<u32>,
    #[serde(default)]
    pub depth_bias: i32,
    #[serde(default)]
    pub depth_bias_slope_scale: f32,
    #[serde(default)]
    pub depth_bias_clamp: f32,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MultisampleState {
    pub count: Option<u32>,
    pub mask: Option<u64>,
    #[serde(default)]
    pub alpha_to_coverage_enabled: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlendComponent {
    pub operation: Option<BlendOperation>,
    pub src_factor: Option<BlendFactor>,
    pub dst_factor: Option<BlendFactor>,
}

#[derive(Deserialize)]
pub struct BlendState {
    #[serde(default)]
    pub color: BlendComponent,
    #[serde(default)]
    pub alpha: BlendComponent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorTarget {
    pub format: TextureFormat,
    pub blend: Option<BlendState>,
    pub write_mask: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentState {
    #[serde(flatten)]
    pub stage: ProgrammableStage,
    pub targets: Vec<Option<ColorTarget>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPipelineDesc {
    pub label: Option<String>,
    pub layout: Option<Id>,
    pub vertex: VertexState,
    #[serde(default)]
    pub primitive: PrimitiveState,
    pub depth_stencil: Option<DepthStencilState>,
    #[serde(default)]
    pub multisample: MultisampleState,
    pub fragment: Option<FragmentState>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePipelineDesc {
    pub label: Option<String>,
    pub layout: Option<Id>,
    pub compute: ProgrammableStage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySetDesc {
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub ty: String,
    pub count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleEncoderDesc {
    pub label: Option<String>,
    pub color_formats: Vec<Option<TextureFormat>>,
    pub depth_stencil_format: Option<TextureFormat>,
    #[serde(default = "one")]
    pub sample_count: u32,
    #[serde(default)]
    pub depth_read_only: bool,
    #[serde(default)]
    pub stencil_read_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlasGeometrySize {
    pub vertex_count: u32,
    pub index: Option<BlasIndexSize>,
}

#[derive(Deserialize)]
pub struct BlasIndexSize {
    pub format: IndexFormat,
    pub count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlasDesc {
    pub label: Option<String>,
    pub geometries: Vec<BlasGeometrySize>,
    pub preference: Option<String>,
    pub update_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlasDesc {
    pub label: Option<String>,
    pub max_instances: u32,
    pub preference: Option<String>,
    pub update_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TexelCopyBuffer {
    pub buffer: Id,
    #[serde(default)]
    pub offset: u64,
    pub bytes_per_row: Option<u32>,
    pub rows_per_image: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TexelCopyTexture {
    pub texture: Id,
    #[serde(default)]
    pub mip_level: u32,
    #[serde(default)]
    pub origin: Origin,
    pub aspect: Option<TextureAspect>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextureDesc {
    pub destination: TexelCopyTexture,
    #[serde(default)]
    pub offset: u64,
    pub bytes_per_row: Option<u32>,
    pub rows_per_image: Option<u32>,
    pub size: Extent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorAttachment {
    pub view: Id,
    pub depth_slice: Option<u32>,
    pub resolve_target: Option<Id>,
    pub clear_value: Option<[f64; 4]>,
    pub load_op: String,
    pub store_op: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthStencilAttachment {
    pub view: Id,
    pub depth_clear_value: Option<f32>,
    pub depth_load_op: Option<String>,
    pub depth_store_op: Option<String>,
    #[serde(default)]
    pub depth_read_only: bool,
    #[serde(default)]
    pub stencil_clear_value: u32,
    pub stencil_load_op: Option<String>,
    pub stencil_store_op: Option<String>,
    #[serde(default)]
    pub stencil_read_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimestampWrites {
    pub query_set: Id,
    pub beginning_of_pass_write_index: Option<u32>,
    pub end_of_pass_write_index: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPassDesc {
    pub label: Option<String>,
    pub color_attachments: Vec<Option<ColorAttachment>>,
    pub depth_stencil_attachment: Option<DepthStencilAttachment>,
    pub occlusion_query_set: Option<Id>,
    pub timestamp_writes: Option<TimestampWrites>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePassDesc {
    pub label: Option<String>,
    pub timestamp_writes: Option<TimestampWrites>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlasGeometry {
    pub vertex_buffer: Id,
    #[serde(default)]
    pub first_vertex: u32,
    pub vertex_stride: u64,
    pub index_buffer: Option<Id>,
    pub first_index: Option<u32>,
}

#[derive(Deserialize)]
pub struct BlasBuild {
    pub blas: Id,
    pub geometries: Vec<BlasGeometry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlasInstance {
    pub blas: Id,
    pub transform: [f32; 12],
    pub custom_index: u32,
    pub mask: u8,
}

#[derive(Deserialize)]
pub struct TlasBuild {
    pub tlas: Id,
    pub instances: Vec<TlasInstance>,
}

/// One recorded command. Pass-scoped commands appear between a `begin*Pass` and `end`.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Command {
    BeginRenderPass(RenderPassDesc),
    BeginComputePass(ComputePassDesc),
    End,
    #[serde(rename_all = "camelCase")]
    SetPipeline {
        id: Id,
    },
    #[serde(rename_all = "camelCase")]
    SetBindGroup {
        index: u32,
        id: Option<Id>,
        #[serde(default)]
        offsets: Vec<u32>,
    },
    #[serde(rename_all = "camelCase")]
    SetVertexBuffer {
        slot: u32,
        id: Option<Id>,
        #[serde(default)]
        offset: u64,
        size: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    SetIndexBuffer {
        id: Id,
        format: IndexFormat,
        #[serde(default)]
        offset: u64,
        size: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Draw {
        vertex_count: u32,
        instance_count: u32,
        first_vertex: u32,
        first_instance: u32,
    },
    #[serde(rename_all = "camelCase")]
    DrawIndexed {
        index_count: u32,
        instance_count: u32,
        first_index: u32,
        base_vertex: i32,
        first_instance: u32,
    },
    DrawIndirect {
        id: Id,
        offset: u64,
    },
    DrawIndexedIndirect {
        id: Id,
        offset: u64,
    },
    SetViewport {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        min: f32,
        max: f32,
    },
    SetScissorRect {
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    },
    SetBlendConstant {
        color: [f64; 4],
    },
    SetStencilReference {
        reference: u32,
    },
    BeginOcclusionQuery {
        index: u32,
    },
    EndOcclusionQuery,
    ExecuteBundles {
        ids: Vec<Id>,
    },
    Dispatch {
        x: u32,
        y: u32,
        z: u32,
    },
    DispatchIndirect {
        id: Id,
        offset: u64,
    },
    PushDebugGroup {
        label: String,
    },
    PopDebugGroup,
    InsertDebugMarker {
        label: String,
    },
    #[serde(rename_all = "camelCase")]
    CopyBufferToBuffer {
        source: Id,
        source_offset: u64,
        destination: Id,
        destination_offset: u64,
        size: Option<u64>,
    },
    CopyBufferToTexture {
        source: TexelCopyBuffer,
        destination: TexelCopyTexture,
        size: Extent,
    },
    CopyTextureToBuffer {
        source: TexelCopyTexture,
        destination: TexelCopyBuffer,
        size: Extent,
    },
    CopyTextureToTexture {
        source: TexelCopyTexture,
        destination: TexelCopyTexture,
        size: Extent,
    },
    ClearBuffer {
        id: Id,
        offset: u64,
        size: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    ResolveQuerySet {
        query_set: Id,
        first_query: u32,
        query_count: u32,
        destination: Id,
        destination_offset: u64,
    },
    BuildAccelerationStructures {
        blas: Vec<BlasBuild>,
        tlas: Vec<TlasBuild>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderRecording {
    pub label: Option<String>,
    pub commands: Vec<Command>,
}
