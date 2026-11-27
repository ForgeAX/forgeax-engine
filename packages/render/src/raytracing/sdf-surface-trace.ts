import {
  SDF_SURFACE_CANDIDATES_WGSL,
  SDF_SURFACE_POOL_LAYOUT,
  SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL,
  SDF_SURFACE_TRACE_RECEIVER_WGSL,
  SDF_SURFACE_TRACE_ROOT_WGSL,
  SDF_SURFACE_TRACE_WGSL,
  sdfSurfaceCandidatesWgsl,
} from '@forgeax/engine-shader';

/** Binding adapter only: all packet geometry remains in the canonical fields
 * slot. The caller validates the complete active roster before any culling. */
export const SDF_SCENE_SURFACE_TRACE_WGSL = sdfSceneSurfaceTraceWgsl();

function sceneSurfaceTraceModule(prepared: boolean, receiver: boolean, hinted: boolean): string {
  if (hinted) return SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL;
  if (receiver) return SDF_SURFACE_TRACE_RECEIVER_WGSL;
  return prepared ? SDF_SURFACE_TRACE_ROOT_WGSL : SDF_SURFACE_TRACE_WGSL;
}

/** Exact row adapter; prepared mode is private to the Screen dispatch chain. */
export function sdfSceneSurfaceTraceWgsl(
  prepared = false,
  receiver = false,
  hinted = false,
  meteredCandidates = false,
): string {
  return `${sceneSurfaceTraceModule(prepared, receiver, hinted)}
${meteredCandidates ? sdfSurfaceCandidatesWgsl(true) : SDF_SURFACE_CANDIDATES_WGSL}
fn sdfFieldWordCount() -> u32 { return arrayLength(&fields); }
fn sdfFieldWord(index:u32) -> u32 {
 if(index>=sdfFieldWordCount()){return 0u;}return fields[index];
}
fn sdfSceneObservedRayUsable(ray:Ray) -> bool {
 return sdfSurfaceRayUsable(SdfSurfaceRay(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin),
  bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u));
}
fn sdfSceneSurfaceReady(count:u32,mask:u32) -> bool {
 let words=sdfFieldWordCount();let capacity=sdfInstanceRowCount();
 if(words<${SDF_SURFACE_POOL_LAYOUT.sceneWords}u || words>${SDF_SURFACE_POOL_LAYOUT.maxBytes / 4}u || capacity==0u || capacity>${SDF_SURFACE_POOL_LAYOUT.maxRows}u){return false;}
 let scene=sdfSurfacePoolVector(0u);
 if(scene.x!=${SDF_SURFACE_POOL_LAYOUT.magic}u || (scene.y!=${SDF_SURFACE_POOL_LAYOUT.version}u && scene.y!=${SDF_SURFACE_POOL_LAYOUT.indexedVersion}u) || scene.z!=capacity ||
    scene.w<${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+capacity*${SDF_SURFACE_POOL_LAYOUT.rowWords + SDF_SURFACE_POOL_LAYOUT.coverageRecordWords}u || scene.w>words){return false;}
 if(count>sdfInstanceRowCount()){return false;}
 for(var row=0u;row<count;row++){
  if((sdfInstanceMask(row)&mask)==0u){continue;}
  if(!sdfInstanceValid(row) || sdfInstanceWord(row,35u)!=0x40000000u ||
     sdfInstanceWord(row,20u)!=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+row*${SDF_SURFACE_POOL_LAYOUT.rowWords}u || sdfSurfacePacket(row).valid==0u){return false;}
 }
 return true;
}
fn sdfSceneSurfaceTraceRows(ray:Ray,count:u32,remaining:ptr<function,u32>,candidates:ptr<function,SdfSurfaceCandidates>${prepared ? ',request:SdfSurfaceRootRequest,expected:vec4u,consumed:ptr<function,u32>,context:vec2u' : ''}${receiver ? ',world:SdfSurfaceRay,contact:SdfSurfaceContact' : ''}${hinted ? ',seed:SdfSurfaceTrace' : ''}) -> SdfSurfaceTrace {
 var best=sdfSurfaceTraceEmpty(ray.tMax);
 if((*candidates).state==2u || count>sdfInstanceRowCount() || count>${SDF_SURFACE_POOL_LAYOUT.maxRows}u){best.state=2u;best.lower=ray.tMin;return best;}
 ${
   receiver
     ? ''
     : `let world=SdfSurfaceRay(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin),
  bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u);`
 }
 for(var row=0u;row<count;row++){
  if(!sdfSurfaceCandidateContains(candidates,row)){continue;}
  // A culled legal missing row needs no packet. A retained row must still
  // name its own canonical packet in the sampled-surface mode.
  if(!sdfSurfaceRowAssociated(row)){
   best.uncertain=min(best.uncertain,ray.tMin);best.hasUncertainty=1u;continue;
  }
  var hit=sdfSurfaceTraceRow(row,world,remaining${prepared ? ',request,expected,ray.mask.x,consumed,context' : ''}${receiver ? ',contact' : ''}${hinted ? ',seed' : ''});
  if(hit.state==3u){
   best.state=3u;best.lower=ray.tMin;return best;
  }
  if(hit.state==2u){best.uncertain=min(best.uncertain,hit.lower);best.hasUncertainty=1u;continue;}
  if(hit.state==0u){continue;}
  if(best.state==0u || hit.upper<best.lower){
   let uncertain=best.uncertain;let hasUncertainty=best.hasUncertainty;
   best=hit;best.uncertain=uncertain;best.hasUncertainty=hasUncertainty;
  }else if(hit.lower<=best.upper){
   best.uncertain=min(best.uncertain,min(best.lower,hit.lower));best.hasUncertainty=1u;
  }
 }
${hinted ? ' if(seed.state==1u && (best.state==0u || best.lower>seed.upper)){best.state=2u;best.lower=ray.tMin;return best;}\n' : ''}\
 if(best.hasUncertainty==1u && best.uncertain<=best.upper){
  best.state=2u;best.lower=min(best.lower,best.uncertain);return best;
 }
 return best;
}
// Full-roster exact reference/fallback entry. World admission and epoch checks
// live at traceWorld; this low-level entry does not qualify a Scene source.
fn sdfSceneSurfaceTrace(ray:Ray,count:u32,remaining:ptr<function,u32>) -> SdfSurfaceTrace {
 var candidates:SdfSurfaceCandidates;candidates.state=1u;
 if(count>sdfInstanceRowCount() || count>${SDF_SURFACE_POOL_LAYOUT.maxRows}u){candidates.state=2u;}
 else{
  for(var row=0u;row<count;row++){
   if((sdfInstanceMask(row)&ray.mask.x)!=0u){candidates.rows[row>>5u]|=1u<<(row&31u);}
  }
 }
 ${prepared ? 'var consumed=0u;let request=sdfSurfaceRootRequestEmpty(SdfSurfaceRay(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u),ray.mask.x,*remaining,grid.source,vec2u(0u));' : ''}return sdfSceneSurfaceTraceRows(ray,count,remaining,&candidates${prepared ? ',request,grid.source,&consumed,vec2u(0u)' : ''}${receiver ? ',SdfSurfaceRay(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u),SdfSurfaceContact(0xffffffffu,0xffffffffu,0u)' : ''}${hinted ? ',sdfSurfaceTraceEmpty(ray.tMax)' : ''});
}
struct SdfScenePoint { position:vec3f, error:f32, valid:u32 }
fn sdfSceneRepresentative(value:SdfRealInterval) -> SdfRealInterval {
 if(value.valid==0u){return sdfIntervalInvalid();}
 let lo=bitcast<u32>(value.lo);let hi=bitcast<u32>(value.hi);
 let checked=sdfIntervalRaw(lo,hi);
 if(checked.valid==0u || (lo&0x7fffffffu)>0x7e800000u || (hi&0x7fffffffu)>0x7e800000u){return sdfIntervalInvalid();}
 // Both endpoints are finite and bounded before ordinary FP. Each half has
 // magnitude<=2^125; adding the halves cannot overflow. Underflow/FTZ of a
 // small representative is covered by the caller's interval radius.
 return sdfIntervalPoint(bitcast<u32>(checked.lo*0.5+checked.hi*0.5));
}
fn sdfSceneSurfacePoint(ray:Ray,best:SdfSurfaceTrace${receiver ? ',world:SdfSurfaceRay' : ''}) -> SdfScenePoint {
 let origin=${receiver ? 'sdfIntervalVector(world.originLo,world.originHi)' : 'sdfIntervalVector(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin))'};
 let direction=${receiver ? 'sdfIntervalVector(world.directionLo,world.directionHi)' : 'sdfIntervalVector(bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction))'};
 let time=sdfIntervalRaw(bitcast<u32>(best.lower),bitcast<u32>(best.upper));
 var point=SdfScenePoint(vec3f(0),0,0u);var radius=sdfIntervalZero();
 for(var axis=0u;axis<3u;axis++){
  let value=sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],time));
  if(value.valid==0u){return point;}
  let representative=sdfSceneRepresentative(value);
  if(representative.valid==0u){return point;}
  let delta=sdfIntervalSubtract(value,representative);
  if(delta.valid==0u){return point;}
  point.position[axis]=representative.lo;
  radius=sdfIntervalAdd(radius,sdfIntervalPoint(bitcast<u32>(max(abs(delta.lo),abs(delta.hi)))));
 }
 if(radius.valid==0u){return point;}point.error=radius.hi;point.valid=1u;return point;
}
fn sdfSceneSurfaceNormal(best:SdfSurfaceTrace) -> vec4f {
 let packet=sdfSurfacePacket(best.row);let first=packet.triangles.x+best.primitive*3u;
 let a=sdfSurfaceVertex(packet,sdfFieldWord(first));
 let b=sdfSurfaceVertex(packet,sdfFieldWord(first+1u));
 let c=sdfSurfaceVertex(packet,sdfFieldWord(first+2u));
 let origin=sdfIntervalVector(a,a);
 let normal=sdfIntervalCross(sdfIntervalVectorSubtract(sdfIntervalVector(b,b),origin),sdfIntervalVectorSubtract(sdfIntervalVector(c,c),origin));
 let inverse=sdfSurfaceInverse(best.row);var center=vec3f(0);
 for(var axis=0u;axis<3u;axis++){
  var value=sdfIntervalZero();
  for(var local=0u;local<3u;local++){
   value=sdfIntervalAdd(value,sdfIntervalMultiply(normal.axis[local],sdfIntervalPoint(inverse[axis][local])));
  }
  let representative=sdfSceneRepresentative(value);
  if(representative.valid==0u){return vec4f(0);}
  center[axis]=representative.lo;
 }
 let scale=max(abs(center.x),max(abs(center.y),abs(center.z)));
 let scaleBits=bitcast<u32>(scale);
 if(scaleBits<0x00800000u || scaleBits>0x7e800000u){return vec4f(0);}
 let unit=center/scale;return vec4f(unit/length(unit),1);
}
fn sdfSceneSurfaceHit(ray:Ray,best:SdfSurfaceTrace${receiver ? ',world:SdfSurfaceRay' : ''}) -> SdfHit {
 var hit=SdfHit(vec4u(0u,0xffffffffu,0xffffffffu,0xffffffffu),vec4f(best.lower,0,0,0),vec4f(0),vec4f(0));
 if(best.state==2u){hit.state.x=4u;return hit;}
 if(best.state==3u){hit.state.x=3u;return hit;}
 if(best.state==0u){return hit;}
 let m=sdfInstanceAt(best.row);let t=best.lower;
 let point=sdfSceneSurfacePoint(ray,best${receiver ? ',world' : ''});let normal=sdfSceneSurfaceNormal(best);
 if(point.valid==0u || normal.w==0.0){hit.state.x=4u;return hit;}
 // Identity and facing come from the certified primitive, never from a
 // second point-candidate search. The representative normal is derived from
 // that primitive and the stored inverse, not a blended field gradient.
 return SdfHit(vec4u(1u,m.ids.xyz),
  vec4f(t,point.error,0,0),vec4f(point.position,1),vec4f(select(normal.xyz,-normal.xyz,best.reserved==1u && best.frontFace==0u),0));
}
`;
}
