import { SDF_INSTANCE_WORD_GUARDS_WGSL } from './sdf-instance-word-guards-wgsl';
import { SDF_SCENE_TEXTURE_READ_WGSL } from './sdf-scene-texture-wgsl';
import { SDF_SURFACE_POOL_LAYOUT } from './sdf-surface-pool-wgsl';
import { SDF_SURFACE_BOUNDS_WGSL } from './sdf-surface-trace-wgsl';

/** Build-time live Field sampler closure. No additional geometry registry or
 * runtime source composition; baked sampling does not import this module. */
export const FIELD_VISIBILITY_BOUNDS_WGSL = `
#define_import_path forgeax_ray::field_visibility
struct FieldVisibilityGrid {
 originSpacing:vec4f, dimensionsCount:vec4u, ranges:vec4f,
 // Independent accepted source facts, never read back from the texture header.
 expected:vec4u
}
@group(1) @binding(4) var<uniform> fieldVisibilityGrid:FieldVisibilityGrid;
@group(1) @binding(5) var fieldVisibility:texture_3d<f32>;
@group(1) @binding(6) var sdfSceneTexture:texture_2d<u32>;
fn sdfSceneExpected()->vec4u {return fieldVisibilityGrid.expected;}
${SDF_SCENE_TEXTURE_READ_WGSL}
${SDF_INSTANCE_WORD_GUARDS_WGSL}
${SDF_SURFACE_BOUNDS_WGSL}

fn fieldCanonicalSourceReady(remaining:ptr<function,u32>)->bool {
 // The view compares the observed texture header to source-owner expectations
 // before exposing word fetches; the same directory policy also owns World.
 let view=sdfSceneView();
 if(view.valid==0u){return false;}
 let directory=sdfSurfaceExpectedDirectory(sdfSceneRowLimit(),sdfSceneExpected());
 if(directory.valid==0u){return false;}
 // Preserve the complete selected raw-word/packet domain before ANY box cull.
 // This pass pays each row once; the subsequent walk pays only its node work.
 for(var row=0u;row<sdfSceneRowLimit();row++){
  if(!sdfSurfaceCharge(remaining)){return false;}
  if(sdfInstanceMask(row)==0u){continue;}
  if(!sdfInstanceValid(row) || sdfInstanceWord(row,35u)!=0x40000000u ||
     sdfInstanceWord(row,20u)!=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+row*${SDF_SURFACE_POOL_LAYOUT.rowWords}u ||
     sdfSurfacePacket(row).valid==0u){return false;}
 }
 return true;
}

// Called once for the whole segment, only after the coarse march enters its
// near-surface ambiguity band. Only complete exclusion from Mesh leaf boxes
// proves clear. Possible boxes retain the coarse rejection, never a hit claim.
// Unqualified or exhausted work remains unknown.
fn fieldCanonicalVisibility(origin:vec3f,endpoint:vec3f,budget:u32)->f32 {
 var remaining=budget;
 if(!fieldCanonicalSourceReady(&remaining)){return -1.0;}
 let a=bitcast<vec3u>(origin);let b=bitcast<vec3u>(endpoint);
 let point=sdfIntervalVector(a,a);
 let delta=sdfIntervalVectorSubtract(sdfIntervalVector(b,b),point);
 if(!sdfIntervalVectorValid(point) || !sdfIntervalVectorValid(delta)){return -1.0;}
 let lower=bitcast<vec3u>(vec3f(delta.axis[0].lo,delta.axis[1].lo,delta.axis[2].lo));
 let upper=bitcast<vec3u>(vec3f(delta.axis[0].hi,delta.axis[1].hi,delta.axis[2].hi));
 let ray=SdfSurfaceRay(a,a,lower,upper,vec2u(0u,0x3f800000u),1u);
 for(var row=0u;row<sdfSceneRowLimit();row++){
  if(sdfInstanceMask(row)==0u){continue;}
  let state=sdfSurfaceBoundsRow(row,ray,&remaining);
  if(state==1u){return 0.0;}
  if(state!=0u){return -1.0;}
 }
 return 1.0;
}
`;
