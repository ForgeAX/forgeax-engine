pub mod layout;
pub mod normals_tangent;
pub mod staging;

pub use layout::{AttributeFormat, AttributeKind, LayoutEntry, VertexLayoutSpec};
pub use normals_tangent::{
    area_weighted_normals, compute_tangent_vec4, decode_tangent_frame32, encode_tangent_frame32,
    frame_normals, normal_plane_tangent,
};
pub use staging::{
    build_from_channels, BuiltMesh, ChannelBuffer, IndexOutput, MeshBuilderState, OutputMode,
    PrimitiveTopology, SubmeshInput, SubmeshOutput,
};
