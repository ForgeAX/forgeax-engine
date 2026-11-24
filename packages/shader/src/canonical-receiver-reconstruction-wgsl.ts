import {
  SDF_INTERVAL_OPERATIONS_WGSL,
  SDF_INTERVAL_RAY_TYPES_WGSL,
} from './sdf-surface-interval-wgsl';

/** Canonical geometry enclosure and raster/contact qualification are distinct. */
export const CANONICAL_RECEIVER_STATE = { unavailable: 0, canonicalEnclosure: 1 } as const;
export const CANONICAL_RECEIVER_REASON = {
  none: 0,
  input: 1,
  arithmetic: 2,
  determinant: 3,
  interior: 4,
  clip: 5,
} as const;

/** Binding-free reconstruction only. It neither owns textures nor launches a
 * World query. Raster coverage, geometry/pose identity and shader displacement
 * admission belong to the same-frame caller. No raster/contact proof is issued. */
export const CANONICAL_RECEIVER_RECONSTRUCTION_BODY_WGSL = `
struct CanonicalReceiverInput {
 vertices:array<vec3u,3>, forward:array<vec4u,4>, viewProjection:array<vec4u,4>,
 pixel:vec2u, extent:vec2u, sampleOffset:vec2u
}
struct CanonicalReceiverResult {
 state:u32, reason:u32, rasterQualified:u32,
 point:SdfIntervalVector, barycentric:array<SdfRealInterval,2>
}
fn canonicalReceiverUnavailable(reason:u32)->CanonicalReceiverResult {
 var out:CanonicalReceiverResult;out.reason=reason;return out;
}
struct CanonicalReceiverHomogeneous { axis:array<SdfRealInterval,4> }
fn canonicalReceiverRawMatrixValid(matrix:array<vec4u,4>,affine:bool)->bool {
 for(var column=0u;column<4u;column++){
  for(var axis=0u;axis<4u;axis++){
   if(!sdfSurfaceBitsUsable(matrix[column][axis])){return false;}
  }
 }
 if(affine){
  for(var column=0u;column<3u;column++){
   if((matrix[column][3]&0x7fffffffu)!=0u){return false;}
  }
  if(matrix[3][3]!=0x3f800000u){return false;}
 }
 return true;
}
fn canonicalReceiverInputValid(input:CanonicalReceiverInput)->bool {
 for(var vertex=0u;vertex<3u;vertex++){
  for(var axis=0u;axis<3u;axis++){
   if(!sdfSurfaceBitsUsable(input.vertices[vertex][axis])){return false;}
  }
 }
 for(var axis=0u;axis<2u;axis++){
  if(input.extent[axis]==0u || input.extent[axis]>16777216u || input.pixel[axis]>=input.extent[axis]){return false;}
  if(!sdfSurfaceBitsUsable(input.sampleOffset[axis])){return false;}
  let sample=sdfIntervalPoint(input.sampleOffset[axis]);
  if(sample.lo<0 || sample.hi>=1){return false;}
 }
 return canonicalReceiverRawMatrixValid(input.forward,true) && canonicalReceiverRawMatrixValid(input.viewProjection,false);
}
// This explicit interval composition encloses the canonical matrix equation.
// It does not assert a hardware vertex/raster arithmetic implementation order.
fn canonicalReceiverTransform(matrix:array<vec4u,4>,point:CanonicalReceiverHomogeneous)->CanonicalReceiverHomogeneous {
 var out:CanonicalReceiverHomogeneous;
 for(var axis=0u;axis<4u;axis++){
  var value=sdfIntervalZero();
  for(var column=0u;column<4u;column++){
   value=sdfIntervalAdd(value,sdfIntervalMultiply(sdfIntervalPoint(matrix[column][axis]),point.axis[column]));
  }
  out.axis[axis]=value;
 }
 return out;
}
fn canonicalReceiverPlane(clip:CanonicalReceiverHomogeneous,coordinate:SdfRealInterval,axis:u32)->SdfRealInterval {
 return sdfIntervalSubtract(clip.axis[axis],sdfIntervalMultiply(coordinate,clip.axis[3]));
}
fn canonicalReceiverReconstruct(input:CanonicalReceiverInput)->CanonicalReceiverResult {
 if(!canonicalReceiverInputValid(input)){return canonicalReceiverUnavailable(1u);}
 let one=sdfIntervalPoint(0x3f800000u);let two=sdfIntervalPoint(0x40000000u);
 var world:array<CanonicalReceiverHomogeneous,3>;var clip:array<CanonicalReceiverHomogeneous,3>;
 for(var i=0u;i<3u;i++){
  var vertex:CanonicalReceiverHomogeneous;
  for(var axis=0u;axis<3u;axis++){vertex.axis[axis]=sdfIntervalPoint(input.vertices[i][axis]);}
  vertex.axis[3]=one;
  world[i]=canonicalReceiverTransform(input.forward,vertex);
  clip[i]=canonicalReceiverTransform(input.viewProjection,world[i]);
 }
 var coordinate:array<SdfRealInterval,2>;
 for(var axis=0u;axis<2u;axis++){
  let pixel=sdfIntervalAdd(sdfIntervalPoint(bitcast<u32>(f32(input.pixel[axis]))),sdfIntervalPoint(input.sampleOffset[axis]));
  let unit=sdfIntervalDivide(pixel,sdfIntervalPoint(bitcast<u32>(f32(input.extent[axis]))));
  let doubled=sdfIntervalMultiply(two,unit);
  if(axis==0u){coordinate[axis]=sdfIntervalSubtract(doubled,one);}
  else{coordinate[axis]=sdfIntervalSubtract(one,doubled);}
 }
 let a0=canonicalReceiverPlane(clip[0],coordinate[0],0u);let a1=canonicalReceiverPlane(clip[0],coordinate[1],1u);
 let b0=canonicalReceiverPlane(clip[1],coordinate[0],0u);let b1=canonicalReceiverPlane(clip[1],coordinate[1],1u);
 let c0=canonicalReceiverPlane(clip[2],coordinate[0],0u);let c1=canonicalReceiverPlane(clip[2],coordinate[1],1u);
 let ex=sdfIntervalSubtract(b0,a0);let ey=sdfIntervalSubtract(b1,a1);
 let fx=sdfIntervalSubtract(c0,a0);let fy=sdfIntervalSubtract(c1,a1);
 let det=sdfIntervalSubtract(sdfIntervalMultiply(ex,fy),sdfIntervalMultiply(fx,ey));
 if(det.valid==0u){return canonicalReceiverUnavailable(2u);}
 if(det.lo<=0 && det.hi>=0){return canonicalReceiverUnavailable(3u);}
 let uNumerator=sdfIntervalSubtract(sdfIntervalMultiply(a1,fx),sdfIntervalMultiply(a0,fy));
 let vNumerator=sdfIntervalSubtract(sdfIntervalMultiply(a0,ey),sdfIntervalMultiply(a1,ex));
 let u=sdfIntervalDivide(uNumerator,det);let v=sdfIntervalDivide(vNumerator,det);let sum=sdfIntervalAdd(u,v);
 if(u.valid==0u || v.valid==0u || sum.valid==0u){return canonicalReceiverUnavailable(2u);}
 // Only strict interior is admitted. Shared edges remain unavailable rather
 // than borrowing a raster tie or silently broadening a self-contact scope.
 if(u.lo<=0 || v.lo<=0 || sum.hi>=1){return canonicalReceiverUnavailable(4u);}
 let weights=array<SdfRealInterval,3>(sdfIntervalSubtract(one,sum),u,v);
 var point:CanonicalReceiverHomogeneous;var projected:CanonicalReceiverHomogeneous;
 for(var axis=0u;axis<4u;axis++){
  var position=sdfIntervalZero();var value=sdfIntervalZero();
  var anchored=world[0].axis[axis];
  for(var i=0u;i<3u;i++){
   position=sdfIntervalAdd(position,sdfIntervalMultiply(world[i].axis[axis],weights[i]));
   value=sdfIntervalAdd(value,sdfIntervalMultiply(clip[i].axis[axis],weights[i]));
   if(i>0u){anchored=sdfIntervalAdd(anchored,sdfIntervalMultiply(sdfIntervalSubtract(world[i].axis[axis],world[0].axis[axis]),weights[i]));}
  }
  // Preserve the original availability domain when edge subtraction overflows
  // or loses precision. Select a whole checked enclosure, never clamp it.
  if(position.valid!=0u && anchored.valid!=0u && anchored.lo>=position.lo && anchored.hi<=position.hi){position=anchored;}
  point.axis[axis]=position;projected.axis[axis]=value;
 }
 if(projected.axis[3].valid==0u || projected.axis[3].lo<=0){return canonicalReceiverUnavailable(5u);}
 let depth=sdfIntervalDivide(projected.axis[2],projected.axis[3]);
 if(depth.valid==0u || depth.lo<0 || depth.hi>1){return canonicalReceiverUnavailable(5u);}
 var out:CanonicalReceiverResult;
 for(var axis=0u;axis<3u;axis++){
  if(point.axis[axis].valid==0u){return canonicalReceiverUnavailable(2u);}
  out.point.axis[axis]=point.axis[axis];
 }
 out.barycentric[0]=u;out.barycentric[1]=v;
 out.state=1u;out.reason=0u;out.rasterQualified=0u;
 return out;
}
`;

/** Standalone control composition. Existing exact World consumers append only
 * the body above to their already-owned interval module. */
export const CANONICAL_RECEIVER_RECONSTRUCTION_WGSL =
  SDF_INTERVAL_RAY_TYPES_WGSL +
  SDF_INTERVAL_OPERATIONS_WGSL +
  CANONICAL_RECEIVER_RECONSTRUCTION_BODY_WGSL;
