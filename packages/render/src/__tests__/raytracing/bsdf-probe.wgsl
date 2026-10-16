#define_import_path forgeax_test::bsdf_probe
#import forgeax_material::ray_abi::{RayMaterialSurface}
#import forgeax_pbr::ray_bsdf::{rayBsdfValue, rayBsdfPdf, sampleRayBsdf}
struct Probe { directionPdf: vec4f, weightValid: vec4f, evaluationPdf: vec4f, integralPdf: vec4f }
@group(0) @binding(0) var<storage,read_write> output: array<Probe>;
fn probe(id:vec3u, n:vec3f, outgoing:vec3f) {
  if(id.x>=arrayLength(&output)){return;}
  let count=arrayLength(&output);
  let u=(f32(id.x)+0.5)/f32(count);
  let v=fract(f32(id.x)*0.61803398875);
  let w=fract(f32(id.x)*0.754877666);
  let surface=RayMaterialSurface(vec4f(0.8,0.4,0.2,1),vec4f(n,0.65),vec4f(0),vec4f(0),vec4u(1u,0u,0u,0u),vec4f(0,0,1,0));
  let sample=sampleRayBsdf(surface,outgoing,vec3f(w,u,v));
  let incoming=vec3f(sqrt(1.0-u*u)*cos(6.28318530718*v),sqrt(1.0-u*u)*sin(6.28318530718*v),u);
  output[id.x]=Probe(vec4f(sample.direction,sample.pdf),vec4f(sample.weight,f32(sample.valid)),
    vec4f(rayBsdfValue(surface,outgoing,sample.direction),rayBsdfPdf(surface,outgoing,sample.direction)),
    vec4f(rayBsdfValue(surface,outgoing,incoming)*max(dot(n,incoming),0.0)*6.28318530718,rayBsdfPdf(surface,outgoing,incoming)*6.28318530718));
}

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) { probe(id,vec3f(0,0,1),vec3f(0.6,0,0.8)); }
@compute @workgroup_size(64) fn tilted(@builtin(global_invocation_id) id:vec3u) { probe(id,vec3f(0.8,0,0.6),vec3f(0.6,0,0.8)); }
@compute @workgroup_size(64) fn grazing(@builtin(global_invocation_id) id:vec3u) { probe(id,vec3f(0.8,0,0.6),normalize(vec3<f32>(-0.5,0,0.8660254))); }
@compute @workgroup_size(64) fn backside(@builtin(global_invocation_id) id:vec3u) { probe(id,vec3f(0.8,0,0.6),normalize(vec3<f32>(0.9,0,-0.4358899))); }

@compute @workgroup_size(64) fn opposed(@builtin(global_invocation_id) id:vec3u) { probe(id,vec3f(0.8,0,-0.6),normalize(vec3f(0.95,0,0.3122499))); }
@compute @workgroup_size(64) fn opposedNull(@builtin(global_invocation_id) id:vec3u) { probe(id,vec3f(0,0,-1),vec3f(0,0,1)); }
