#define_import_path forgeax_pbr::ray_bsdf
#import forgeax_pbr::brdf::{standardOpaqueBrdf, d_ggx}
#import forgeax_material::ray_abi::{RayMaterialSurface}

struct RayBsdfSample { direction: vec3f, pdf: f32, weight: vec3f, valid: u32 }
fn rayBasis(n: vec3f) -> mat3x3f {
  let helper = select(vec3f(0,0,1), vec3f(0,1,0), abs(n.z) > 0.9);
  let tangent = normalize(cross(helper, n));
  return mat3x3f(tangent, cross(n, tangent), n);
}
// status.y == RAY_BSDF_LAMBERT marks a surface whose albedo already carries its
// full response: a pure Lambert lobe with no specular term.
const RAY_BSDF_LAMBERT: u32 = 1u;
fn rayBsdfValue(surface: RayMaterialSurface, outgoing: vec3f, incoming: vec3f,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
  ) -> vec3f {
  let n = surface.normalRoughness.xyz;
  let nv = dot(n, outgoing); let nl = dot(n, incoming);
  if (nv <= 0.0 || nl <= 0.0 || dot(surface.geometricNormal.xyz,outgoing)<=0.0 || dot(surface.geometricNormal.xyz,incoming)<=0.0) { return vec3f(0); }
  if (surface.status.y == RAY_BSDF_LAMBERT) { return surface.albedoOpacity.rgb / 3.14159265359; }
  let h = normalize(outgoing + incoming);
  return standardOpaqueBrdf(surface.albedoOpacity.rgb, surface.emissionMetallic.w,
    surface.normalRoughness.w * surface.normalRoughness.w, surface.f0Occlusion.xyz,
    max(nv, 1e-5), nl, max(dot(n,h),0.0), max(dot(outgoing,h),0.0),
    surface.status.z != 0u,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
}
// Full cosine/GGX-NDF mixture density, per steradian. Below-surface NDF
// samples are explicit null events, never renormalized into a different PDF.
fn rayBsdfPdf(surface: RayMaterialSurface, outgoing: vec3f, incoming: vec3f) -> f32 {
  let n = surface.normalRoughness.xyz;
  let nl = dot(n,incoming);
  if (dot(n,outgoing) <= 0.0 || nl <= 0.0 || dot(surface.geometricNormal.xyz,outgoing)<=0.0 || dot(surface.geometricNormal.xyz,incoming)<=0.0) { return 0.0; }
  if (surface.status.y == RAY_BSDF_LAMBERT) { return nl / 3.14159265359; }
  let h = normalize(outgoing+incoming);
  let nh = max(dot(n,h),0.0); let vh = abs(dot(outgoing,h));
  let alpha = surface.normalRoughness.w * surface.normalRoughness.w;
  return 0.5 * (nl / 3.14159265359 + d_ggx(nh,alpha) * nh / max(4.0*vh,1e-20));
}
fn sampleRayBsdf(surface: RayMaterialSurface, outgoing: vec3f, random: vec3f,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
  ) -> RayBsdfSample {
  let n = surface.normalRoughness.xyz; let basis = rayBasis(n);
  let phi = 6.28318530718 * random.z;
  var incoming = vec3f(0);
  if (random.x < 0.5 || surface.status.y == RAY_BSDF_LAMBERT) {
    let r = sqrt(random.y);
    incoming = basis * vec3f(r*cos(phi),r*sin(phi),sqrt(1.0-random.y));
  } else {
    let alpha = surface.normalRoughness.w * surface.normalRoughness.w;
    let z = sqrt((1.0-random.y)/(1.0+(alpha*alpha-1.0)*random.y));
    let r = sqrt(max(1.0-z*z,0.0));
    let h = basis * vec3f(r*cos(phi),r*sin(phi),z);
    incoming = reflect(-outgoing,h);
  }
  let pdf = rayBsdfPdf(surface,outgoing,incoming);
  if (pdf <= 0.0) { return RayBsdfSample(incoming,0.0,vec3f(0),0u); }
  let weight = rayBsdfValue(surface,outgoing,incoming,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  ) * max(dot(n,incoming),0.0) / pdf;
  return RayBsdfSample(incoming,pdf,weight,1u);
}
fn rayPowerHeuristic(a: f32, b: f32) -> f32 { return a*a / max(a*a+b*b,1e-30); }
