//! Procedural texture synthesis & standard PBR material stack (`mod surface`).

pub mod atlas;
pub mod buffer;
pub mod filters;
pub mod generators;
pub mod pbr;

pub use atlas::{
    atlas_bleed_report, atlas_neighbor, dilate_atlas, dominant_source, mip_bleed, AtlasBleedReport,
    AtlasBufferMut, AtlasGrid, MIXED, UNOWNED,
};
pub use buffer::{encode_normal_rgba8, linear_to_srgb, pack_orm_rgba8, quantize_u8, ImageBuffer};
pub use filters::{
    blend, blend_normals_rnm, blur_gaussian, dilate_uv_gutter, height_to_normal, invert, levels,
    BlendMode,
};
pub use generators::{gen_brick, gen_brushed, gen_perlin_fbm, gen_wood, gen_worley, WorleyMode};
pub use pbr::{PbrSurfaceStack, StandardPbrTextures};
