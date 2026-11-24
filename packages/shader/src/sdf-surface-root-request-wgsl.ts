import { SDF_MESH_MARCH_ADMISSION_WGSL } from './sdf-mesh-march-wgsl';
import { SDF_SURFACE_MARCH_FOUNDATION_WGSL } from './sdf-surface-march-wgsl';
import { SDF_SURFACE_INVERSE_WGSL } from './sdf-surface-pool-wgsl';
import { SDF_SURFACE_BOUNDS_TYPE_WGSL, SDF_SURFACE_SLAB_WGSL } from './sdf-surface-slab-wgsl';

/** Six vec4u words per Screen ray. The final phase reuses payload for Hit64.
 * Phase zero is unprepared, not an empty scene. No floating-point sentinel is
 * used. Only the owning immutable dispatch chain may write these requests. */
export const SDF_SURFACE_ROOT_REQUEST_BYTES = 96;
export const SDF_SURFACE_RAY_USABLE_WGSL = `fn sdfSurfaceRayUsable(ray:SdfSurfaceRay) -> bool {
 return ray.valid==1u && sdfIntervalRaw(ray.tRange.x,ray.tRange.y).valid==1u &&
  sdfIntervalVectorValid(sdfIntervalVector(ray.originLo,ray.originHi)) &&
  sdfIntervalVectorValid(sdfIntervalVector(ray.directionLo,ray.directionHi));
}
`;
export const SDF_SURFACE_ROOT_REQUEST_WGSL = `struct SdfSurfaceRootRequest {
 expected:vec4u, control:vec4u, payload:array<vec4u,4>
}
fn sdfSurfaceRootRequestEmpty(world:SdfSurfaceRay,mask:u32,budget:u32,expected:vec4u,context:vec2u) -> SdfSurfaceRootRequest {
 var out:SdfSurfaceRootRequest;out.expected=expected;out.control=vec4u(1u,0xffffffffu,0u,budget);
 out.payload[0]=vec4u(world.originLo,mask);out.payload[1]=vec4u(world.directionLo,budget);
 out.payload[2]=vec4u(world.tRange,0u,0u);out.payload[3]=vec4u(0xffffffffu,0u,context);
 return out;
}
fn sdfSurfaceRootRequestMatches(request:SdfSurfaceRootRequest,world:SdfSurfaceRay,mask:u32,
 expected:vec4u,budget:u32,context:vec2u) -> bool {
 if(any(request.expected!=expected) || expected.w==0u || world.valid!=1u ||
  any(world.originLo!=world.originHi) || any(world.directionLo!=world.directionHi) ||
  any(request.payload[0]!=vec4u(world.originLo,mask)) ||
  any(request.payload[1]!=vec4u(world.directionLo,budget)) ||
  any(request.payload[2].xy!=world.tRange) || any(request.payload[3].zw!=context)){return false;}
 if(request.control.x==1u){return request.control.y==0xffffffffu && request.control.z==0u &&
  request.control.w==budget && all(request.payload[2].zw==vec2u(0)) &&
  request.payload[3].x==0xffffffffu && request.payload[3].y==0u;}
 if(request.control.x!=2u || budget==0u || request.control.y>=expected.z ||
  (request.control.z!=1u && request.control.z!=3u) || request.control.w!=budget-1u ||
  request.payload[2].w>1u || request.payload[3].y>1u){return false;}
 if(request.control.z==1u){return all(request.payload[2].zw==vec2u(0)) && request.payload[3].y==0u;}
 if(request.payload[2].w==0u){return request.payload[2].z==0u;}
 let end=sdfIntervalPoint(request.payload[2].z);let first=sdfIntervalPoint(world.tRange.x);
 return end.valid==1u && first.valid==1u && end.lo>first.lo;
}
fn sdfSurfaceRedeemRoot(row:u32,world:SdfSurfaceRay,request:SdfSurfaceRootRequest,expected:vec4u,mask:u32,
 remaining:ptr<function,u32>,consumed:ptr<function,u32>,context:vec2u) -> u32 {
 if(request.control.x!=2u || request.control.y!=row){return 0u;}
 if(*consumed!=0u || !sdfSurfaceRootRequestMatches(request,world,mask,expected,*remaining,context) ||
  request.payload[3].x!=sdfInstanceWord(row,16u)){return 2u;}
 *remaining=request.control.w;*consumed=1u;return 1u;
}
`;

/** Bounds-only segment rejection shared by paid-root preparation and exact row
 * traversal. It cannot certify a hit or replace an uncertain slab with a nearT.
 * A row retains its three positions; fresh bounds are validated at every test.
 * Invalid ray inputs disable every axis, but position overflow disables only
 * that axis. Function pointers keep the retained vector local to its owner. */
export const SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL = `fn sdfSurfaceSegmentEnclosure(ray:SdfSurfaceRay) -> SdfIntervalVector {
 var segment:SdfIntervalVector;
 let origin=sdfIntervalVector(ray.originLo,ray.originHi);
 let direction=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let time=sdfIntervalRaw(ray.tRange.x,ray.tRange.y);
 if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(direction) || time.valid==0u){return segment;}
 for(var axis=0u;axis<3u;axis++){
  segment.axis[axis]=sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],time));
 }
 return segment;
}
fn sdfSurfaceSegmentBoundsClear(segment:ptr<function,SdfIntervalVector>,lo:vec3u,hi:vec3u) -> bool {
 let bounds=sdfIntervalVector(lo,hi);
 if(!sdfIntervalVectorValid(bounds)){return false;}
 for(var axis=0u;axis<3u;axis++){
  let position=(*segment).axis[axis];
  if(position.valid!=0u && (position.hi<bounds.axis[axis].lo || position.lo>bounds.axis[axis].hi)){return true;}
 }
 return false;
}
fn sdfSurfaceSegmentBoxClear(ray:SdfSurfaceRay,lo:vec3u,hi:vec3u) -> bool {
 var segment=sdfSurfaceSegmentEnclosure(ray);
 return sdfSurfaceSegmentBoundsClear(&segment,lo,hi);
}
`;

// This fragment appends to the march foundation, never to the exact module.
// Both consume the same slab and sampling bodies, without triangle reachability.
export const SDF_SURFACE_ROOT_PREPARE_WGSL = `${SDF_SURFACE_BOUNDS_TYPE_WGSL}${SDF_SURFACE_SLAB_WGSL}
${SDF_SURFACE_RAY_USABLE_WGSL}
${SDF_SURFACE_INVERSE_WGSL}
${SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL}${SDF_SURFACE_ROOT_REQUEST_WGSL}${SDF_MESH_MARCH_ADMISSION_WGSL}
// Every SNORM magnitude is <=band. If one axis separates the original position
// from the ENTIRE lattice by >=band, the old clamped root lower cannot be useful,
// even before subtracting its code-unit/E errors. Failure proves nothing.
fn sdfSurfaceRootOldSampleUnusable(row:u32,ray:SdfSurfaceRay) -> bool {
 let spacing=sdfIntervalPoint(sdfInstanceWord(row,27u));let band=sdfIntervalPoint(sdfInstanceWord(row,31u));
 if(spacing.valid==0u || band.valid==0u || spacing.lo<=0 || band.lo<=0){return false;}
 let origin=sdfIntervalVector(ray.originLo,ray.originHi);let direction=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let time=sdfIntervalPoint(ray.tRange.x);
 for(var axis=0u;axis<3u;axis++){
  let first=sdfIntervalPoint(sdfInstanceWord(row,24u+axis));
  let index=sdfIntervalPoint(bitcast<u32>(f32(sdfInstanceWord(row,21u+axis)-1u)));
  let last=sdfIntervalAdd(first,sdfIntervalMultiply(index,spacing));
  let position=sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],time));
  if(first.valid==0u || last.valid==0u || position.valid==0u){return false;}
  var separation=sdfIntervalZero();
  if(position.hi<first.lo){separation=sdfIntervalSubtract(first,position);}
  else if(position.lo>last.hi){separation=sdfIntervalSubtract(position,last);}
  if(separation.valid==1u && separation.lo>=band.hi){return true;}
 }
 return false;
}
fn sdfSurfacePrepareRoot(world:SdfSurfaceRay,row:u32,mask:u32,actual:vec4u,expected:vec4u,budget:u32,context:vec2u) -> SdfSurfaceRootRequest {
 var out=sdfSurfaceRootRequestEmpty(world,mask,budget,expected,context);
 if(budget==0u || budget>1024u || mask==0u || mask>255u ||
  any(world.originLo!=world.originHi) || any(world.directionLo!=world.directionHi) ||
  !sdfMeshMarchSourceReady(actual,expected) || row>=expected.z ||
  !sdfInstanceValid(row) || (sdfInstanceMask(row)&mask)==0u || !sdfSurfaceRowAssociated(row)){return out;}
 let packet=sdfSurfacePacket(row);if(packet.valid!=1u || packet.nodes.y==0u){return out;}
 let local=sdfSurfaceLocalRay(world,sdfSurfaceInverse(row),packet.coefficients.yz);
 if(local.valid!=1u){return out;}
 let at=packet.nodes.x;let escape=sdfFieldWord(at+3u);
 if(escape==0u || escape>packet.nodes.y){return out;}
 out.control=vec4u(2u,row,1u,budget-1u);out.payload[3].x=sdfInstanceWord(row,16u);
 let lo=vec3u(sdfFieldWord(at),sdfFieldWord(at+1u),sdfFieldWord(at+2u));
 let hi=vec3u(sdfFieldWord(at+4u),sdfFieldWord(at+5u),sdfFieldWord(at+6u));
 if(sdfSurfaceSegmentBoxClear(local,lo,hi)){return out;}
 let bounds=sdfSurfaceSlab(local,lo,hi);let last=bitcast<f32>(world.tRange.y);
 if(bounds.certified==1u && (bounds.possible==0u || bounds.near>last)){return out;}
 var sampleRay=local;
 // A certified LOWER entry may replace a provably useless old sample. Never
 // shorten the refinement ray, substitute far/upper, or clamp an uncovered point.
 if(packet.prefixEligible==1u && sdfMeshMarchLayout(row,packet) &&
  bounds.certified==1u && bounds.possible==1u && sdfSurfaceRootOldSampleUnusable(row,local)){
  sampleRay.tRange.x=bitcast<u32>(bounds.near);
  if(!sdfMeshMarchCoverage(row,sampleRay)){sampleRay=local;}
 }
 let prefix=sdfSurfaceRootPrefix(row,packet,sampleRay);
 out.control.z=3u;out.payload[2].z=bitcast<u32>(prefix.end);out.payload[2].w=prefix.valid;
 out.payload[3].y=prefix.samples;
 return out;
}
`;

/** Complete triangle-free preparation module; append only transport/dispatch. */
export const SDF_SURFACE_ROOT_PREPARATION_WGSL =
  SDF_SURFACE_MARCH_FOUNDATION_WGSL + SDF_SURFACE_ROOT_PREPARE_WGSL;
