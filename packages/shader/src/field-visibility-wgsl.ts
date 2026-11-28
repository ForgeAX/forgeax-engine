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

var<private> fieldCanonicalReadyCache:u32;
fn fieldCanonicalRowValid(row:u32)->bool {
 if(sdfInstanceMask(row)==0u){return true;}
 if(!sdfInstanceValid(row) || sdfInstanceWord(row,35u)!=0x40000000u ||
    sdfInstanceWord(row,20u)!=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+row*${SDF_SURFACE_POOL_LAYOUT.rowWords}u ||
    sdfSurfacePacket(row).valid==0u){return false;}
 return true;
}
fn fieldCanonicalValidateStride(lane:u32,stride:u32)->bool {
 let view=sdfSceneView();
 if(view.valid==0u){return false;}
 let directory=sdfSurfaceExpectedDirectory(sdfSceneRowLimit(),sdfSceneExpected());
 if(directory.valid==0u){return false;}
 for(var row=lane;row<sdfSceneRowLimit();row+=stride){
  if(!fieldCanonicalRowValid(row)){return false;}
 }
 return true;
}
fn fieldCanonicalSetReady(ready:bool) {
 fieldCanonicalReadyCache=select(2u,1u,ready);
}
fn fieldCanonicalSourceReady(remaining:ptr<function,u32>)->bool {
 if(fieldCanonicalReadyCache!=0u){return fieldCanonicalReadyCache==1u;}
 // The view compares the observed texture header to source-owner expectations
 // before exposing word fetches; the same directory policy also owns World.
 let view=sdfSceneView();
 if(view.valid==0u){fieldCanonicalReadyCache=2u;return false;}
 let directory=sdfSurfaceExpectedDirectory(sdfSceneRowLimit(),sdfSceneExpected());
 if(directory.valid==0u){fieldCanonicalReadyCache=2u;return false;}
 // Preserve the complete selected raw-word/packet domain before ANY box cull.
 // This pass pays each row once; the subsequent walk pays only its node work.
 for(var row=0u;row<sdfSceneRowLimit();row++){
  if(!sdfSurfaceCharge(remaining)){return false;}
  if(!fieldCanonicalRowValid(row)){fieldCanonicalReadyCache=2u;return false;}
 }
 fieldCanonicalReadyCache=1u;
 return true;
}

// Called once for the whole segment, only after the coarse march enters its
// near-surface ambiguity band. Only complete exclusion from Mesh leaf boxes
// proves clear. Possible boxes retain the coarse rejection, never a hit claim.
// Unqualified or exhausted work remains unknown.
fn fieldCanonicalVisibility(origin:vec3f,endpoint:vec3f,budget:u32)->f32 {
 var readyRemaining=max(budget,sdfSceneRowLimit()+1u);
 if(!fieldCanonicalSourceReady(&readyRemaining)){return -1.0;}
 var remaining=budget;
 let a=bitcast<vec3u>(origin);let b=bitcast<vec3u>(endpoint);
 let point=sdfIntervalVector(a,a);
 let delta=sdfIntervalVectorSubtract(sdfIntervalVector(b,b),point);
 if(!sdfIntervalVectorValid(point) || !sdfIntervalVectorValid(delta)){return -1.0;}
 let lower=bitcast<vec3u>(vec3f(delta.axis[0].lo,delta.axis[1].lo,delta.axis[2].lo));
 let upper=bitcast<vec3u>(vec3f(delta.axis[0].hi,delta.axis[1].hi,delta.axis[2].hi));
 let ray=SdfSurfaceRay(a,a,lower,upper,vec2u(0u,0x3f800000u),1u);
 let directory=sdfSurfaceExpectedDirectory(sdfSceneRowLimit(),sdfSceneExpected());
 let indexed=directory.indexed!=0u && directory.nodes>0u;
 let capacity=sdfInstanceRowCount();
 let first=directory.first+capacity*${SDF_SURFACE_POOL_LAYOUT.candidateRowWords}u;
 let segLo=min(origin,endpoint);let segHi=max(origin,endpoint);
 let rowLimit=sdfSceneRowLimit();
 var cursor=0u;var visits=0u;
 loop {
  var row=0xffffffffu;
  if(indexed){
   if(cursor>=directory.nodes){break;}
   if(visits>=2u*capacity){return -1.0;}
   visits++;
   let at=first+cursor*${SDF_SURFACE_POOL_LAYOUT.candidateNodeWords}u;
   let na=sdfSurfacePoolVector(at);let nb=sdfSurfacePoolVector(at+4u);
   let flags=na.w;let escape=nb.w;let leaf=(flags&0x80000000u)!=0u;
   if(escape<=cursor || escape>directory.nodes || (cursor==0u && escape!=directory.nodes) ||
      (flags&0x3ffffc00u)!=0u){return -1.0;}
   if((flags&0x40000000u)!=0u){
    if(!sdfInstanceFloatUsable(na.x) || !sdfInstanceFloatUsable(na.y) || !sdfInstanceFloatUsable(na.z) ||
       !sdfInstanceFloatUsable(nb.x) || !sdfInstanceFloatUsable(nb.y) || !sdfInstanceFloatUsable(nb.z)){return -1.0;}
    let boxLo=bitcast<vec3f>(na.xyz);let boxHi=bitcast<vec3f>(nb.xyz);
    if(any(boxLo>boxHi)){return -1.0;}
    if(any(boxHi<segLo) || any(boxLo>segHi)){cursor=escape;continue;}
   }
   if(leaf){
    row=flags&1023u;
    if(escape!=cursor+1u || row>=rowLimit){return -1.0;}
    cursor=escape;
   }else{cursor++;continue;}
  }else{
   if(cursor>=rowLimit){break;}
   row=cursor;cursor++;
  }
  if(sdfInstanceMask(row)==0u){continue;}
  let state=sdfSurfaceBoundsRow(row,ray,&remaining);
  if(state==1u){return 0.0;}
  if(state!=0u){return -1.0;}
 }
 return 1.0;
}
`;
