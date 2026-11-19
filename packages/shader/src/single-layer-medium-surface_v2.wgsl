#define_import_path forgeax_material::single_layer_medium_surface_v2

// Engine-owned Surface ABI for a single uniform medium layer. Surface authors
// provide these facts; the template/renderer owns optical integration and
// background/depth pairing.
struct SingleLayerMediumSurfaceInput {
  positionOS : vec3<f32>,
  positionWS : vec3<f32>,
  geometricNormalWS : vec3<f32>,
  tangentWS : vec4<f32>,
  viewDirectionWS : vec3<f32>,
  uv0 : vec2<f32>,
  uv1 : vec2<f32>,
  uv2 : vec2<f32>,
  uv3 : vec2<f32>,
  uv4 : vec2<f32>,
  uv5 : vec2<f32>,
  uv6 : vec2<f32>,
  uv7 : vec2<f32>,
  vertexColor : vec4<f32>,
  frontFacing : bool,
  frameTime : f32,
  instanceIndex : u32,
  eventRangeStart : u32,
  eventRangeCount : u32,
  pixelPosition:vec4<f32>,
  backgroundDistanceMeters:f32,
  backgroundValid:bool,
};
struct SingleLayerMediumSurfaceData {
  normalWS : vec3<f32>,
  roughness : f32,
  coverage : f32,
  foam : f32,
  absorption : vec3<f32>,
  scattering : vec3<f32>,
  ior : f32,
  phaseG : f32,
  // Finite, model-authored propagation distance used when the paired depth
  // producer reports a sky miss. Cook/load carries this fact with the Surface
  // ABI so the integration never relies on an unconnected shader constant.
  maxDistanceMeters : f32,
  emission:vec3<f32>,
  foamColor:vec3<f32>,
  bodyAlbedo:vec3<f32>,
  bodyDiffuse:f32,
  waveHeight:f32,
  sssStrength:f32,
  glintStrength:f32,
  sunSpecular:f32,
  sunSpecularMax:f32,
  reflectionStrength:f32,
  transmissionEmission:vec3<f32>,
  transmissionTint:vec3<f32>,
  transmissionTintWeight:f32,
};
