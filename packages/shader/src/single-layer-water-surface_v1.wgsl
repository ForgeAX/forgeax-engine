#define_import_path forgeax_material::single_layer_water_surface_v1

struct SingleLayerWaterSurfaceInput {
  positionOS: vec3<f32>, positionWS: vec3<f32>, geometricNormalWS: vec3<f32>,
  tangentWS: vec4<f32>, viewDirectionWS: vec3<f32>,
  uv0: vec2<f32>, uv1: vec2<f32>, uv2: vec2<f32>, uv3: vec2<f32>,
  uv4: vec2<f32>, uv5: vec2<f32>, uv6: vec2<f32>, uv7: vec2<f32>,
  vertexColor: vec4<f32>, frontFacing: bool, frameTime: f32,
  instanceIndex: u32, eventRangeStart: u32, eventRangeCount: u32,
  pixelDepthM: f32,
  originalNormalWS: vec3<f32>,
  originalPositionWS: vec3<f32>,
  // Linear camera-axis meters. A cleared no-water depth sample is the view far plane.
  sceneDepthWithoutWaterM: f32,
  // Vertex-decoded world-XZ flow; magnitude is scaled by the material's maximum flow velocity.
  vertexFlowXZ: vec2<f32>,
  // Wrapped in fragment from small interpolated tile coverage, excluding WPO.
  wavePhaseXZ: vec2<f32>,
};
// Distortion uses the authored refraction attribute. Optical IOR comes from F0.
struct SingleLayerWaterSurfaceData {
  normalWS: vec3<f32>, roughness: f32, coverage: f32, foam: f32,
  absorption: vec3<f32>, scattering: vec3<f32>, physicalIor: f32, phaseG: f32,
  maxDistanceMeters: f32, refractionPixelNormalStrength: f32, refractionDepthBias: f32,
  colorScaleBehindWater: vec3<f32>,
  baseColor: vec3<f32>, opacity: f32, emissive: vec3<f32>,
};
