// Shared Standard raster bindings and reflected host packing layout.
#define_import_path forgeax_standard::cluster_layout
#ifdef STORAGE_BUFFER_AVAILABLE
#import forgeax_view::common::{DirectLightSlot}
#endif

struct ClusterUniform {
  grid         : vec4<u32>,
  near_far_log : vec4<f32>,
  // Optional no-storage AO region: base word, logical width/height, row stride.
  ao           : vec4<u32>,
  // Independently controlled AO attenuation for direct Forward lighting.
  direct_ao    : vec4<f32>,
  // No-storage Cluster texture addressing: slot texels, grid word offset,
  // index-list word offset, and physical texture width.
  texture      : vec4<u32>,
  // x/y: producer-owned grid offset/count pair stride and count-word offset
  // (u32 words); z: screen-data base word; w: additional DirectionalLights in
  // slots [grid.w, grid.w + w), shaded outside the grid.
  cluster_layout : vec4<u32>,
};

#ifdef STORAGE_BUFFER_AVAILABLE
@group(0) @binding(30) var<storage, read> light_data : array<DirectLightSlot, 1024>;
#endif
@group(0) @binding(33) var<uniform> cluster_uniform : ClusterUniform;
