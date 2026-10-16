#define_import_path forgeax_material::surface_v1

// Engine-owned input ABI for authored Standard material surfaces.
struct SurfaceInput {
  positionOS : vec3<f32>,
  positionWS : vec3<f32>,
  // Triangle orientation is independent of the interpolated shading basis.
  geometricNormalWS : vec3<f32>,
  vertexNormalWS : vec3<f32>,
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
  // Conservative UV diameters for explicit ray-cone filtering; raster uses derivatives.
  uvFootprint0 : vec4<f32>,
  uvFootprint1 : vec4<f32>,
  // Linear object-to-world basis: object-space projection and normal maps.
  objectToWorld : mat3x3<f32>,
  // Renderer frame elapsed seconds; ray hit shading without a View uses zero.
  frameTime : f32,
};

// Surface output is consumed by the Standard BRDF and pass family.
struct SurfaceData {
  baseColor : vec3<f32>,
  normalWS : vec3<f32>,
  metallic : f32,
  roughness : f32,
  emissive : vec3<f32>,
  occlusion : f32,
  opacity : f32,
  alphaClipThreshold : f32,
};

// Scaling each edge before the cross preserves the plane normal at every
// representable world scale, including magnified microscopic geometry.
// Raster callers evaluate derivatives before clipping or alpha discard.
fn surfaceGeometryNormal(dx : vec3<f32>, dy : vec3<f32>, fallback : vec3<f32>) -> vec3<f32> {
  let scaleX = max(max(abs(dx.x), abs(dx.y)), abs(dx.z));
  let scaleY = max(max(abs(dy.x), abs(dy.y)), abs(dy.z));
  if (!(scaleX > 0.0 && scaleY > 0.0)) { return fallback; }
  let geometric = cross(dy / scaleY, dx / scaleX);
  let lengthSquared = dot(geometric, geometric);
  if (!(lengthSquared > 0.0)) { return fallback; }
  return geometric * inverseSqrt(lengthSquared);
}
