/** Private reconstruction policy: bit3 is current support; its next bit marks
 * the actual hardware World source, never an inferred zero software token. */
export const SCREEN_PROBE_CURRENT_SUPPORT_MASK = 8;
const CONFIDENCE_BASE = 2;
const CONFIDENCE_MAX = 3;

/** Shared finite signal tag. This is reconstruction confidence, not ray validity,
 * WorldCard status, a measured sample count, or permission to reuse history. */
export const SCREEN_PROBE_RECONSTRUCTION_WGSL = `
#define_import_path forgeax_ray::screen_reconstruction
const SP_CURRENT_SUPPORT_MASK:u32=${SCREEN_PROBE_CURRENT_SUPPORT_MASK}u;
const SP_CONFIDENCE_BASE:f32=${CONFIDENCE_BASE}.0;
const SP_CONFIDENCE_MAX:f32=${CONFIDENCE_MAX}.0;
fn spCurrentSupport(flags:u32)->bool{return (flags&SP_CURRENT_SUPPORT_MASK)!=0u;}
// Hardware placement is qualified by the current-frame graph, not a software
// canonical contact certificate. History controls are independent of the selected reconstruction method.
fn spReconstructionSource(expected:vec4u,control:vec4u,frame:u32,revision:u32,source:vec4u,flags:u32)->bool{
 let method=flags&~7u;
 if(method==(SP_CURRENT_SUPPORT_MASK|(SP_CURRENT_SUPPORT_MASK<<1u))){
  return all(source==vec4u(0u))&&all(expected==vec4u(0u))&&all(control==vec4u(0u));
 }
 let receiver=control.x==1u||control.x==2u||control.x==3u;
 return method==SP_CURRENT_SUPPORT_MASK&&source.w!=0u&&all(expected==source)&&receiver&&control.y==frame&&control.z!=0u&&control.w==revision;
}
fn spReconstructionConfidence(value:vec4f)->f32{
 if(!(value.w>SP_CONFIDENCE_BASE&&value.w<=SP_CONFIDENCE_MAX)||
  !all(value.xyz>=vec3f(0.0))||!all(value.xyz<vec3f(1e30))){return 0.0;}
 return value.w-SP_CONFIDENCE_BASE;
}
// Confidence weights an estimator, never ray provenance. Count limits latency.
fn spReconstructionTemporalAlpha(currentConfidence:f32,historyConfidence:f32,count:u32)->f32{
 let frames=f32(max(count,1u));
 return max(1.0/frames,currentConfidence/(currentConfidence+(frames-1.0)*historyConfidence));
}
fn spReconstructionSignal(rgb:vec3f,coverage:f32)->vec4f{
 if(!(coverage>0.0&&coverage<=1.0)){return vec4f(0.0);}
 let value=vec4f(rgb,SP_CONFIDENCE_BASE+coverage);
 if(!(spReconstructionConfidence(value)>0.0)){return vec4f(0.0);}
 return value;
}
`;
