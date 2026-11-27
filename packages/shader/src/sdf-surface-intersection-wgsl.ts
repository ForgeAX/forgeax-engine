import {
  SDF_INTERVAL_OPERATIONS_WGSL,
  SDF_INTERVAL_RAY_TYPES_WGSL,
  SDF_SURFACE_AFFINE_LOCAL_RAY_WGSL,
} from './sdf-surface-interval-wgsl';
import { SDF_SURFACE_BOUNDS_TYPE_WGSL, SDF_SURFACE_SLAB_WGSL } from './sdf-surface-slab-wgsl';

/** Complete conservative primitive query module. The march foundation consumes
 * the same arithmetic directly, without this triangle/slab query fragment. */
export const SDF_SURFACE_INTERSECTION_WGSL: string =
  SDF_INTERVAL_RAY_TYPES_WGSL +
  `// state: clear=0, hit=1, uncertain=2. Only hit certifies a primitive intersection.
struct SdfSurfaceIntersection { state: u32, tLower: f32, tUpper: f32, frontFace: u32 }
` +
  SDF_SURFACE_BOUNDS_TYPE_WGSL +
  SDF_INTERVAL_OPERATIONS_WGSL +
  `fn sdfSurfaceTriangleTighten(a:SdfRealInterval,b:SdfRealInterval) -> SdfRealInterval {
 if(a.valid==0u || b.valid==0u){return sdfIntervalInvalid();}
 let lo=max(a.lo,b.lo);let hi=min(a.hi,b.hi);
 if(lo>hi){return sdfIntervalInvalid();}
 return SdfRealInterval(lo,hi,1u);
}
fn sdfSurfaceTriangle(ray:SdfSurfaceRay,aBits:vec3u,bBits:vec3u,cBits:vec3u) -> SdfSurfaceIntersection {
 let unknown=SdfSurfaceIntersection(2u,0,0,0u);
 let range=sdfIntervalRaw(ray.tRange.x,ray.tRange.y);
 if(ray.valid!=1u || range.valid==0u){return unknown;}
 let o=sdfIntervalVector(ray.originLo,ray.originHi);
 let d=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let a=sdfIntervalVector(aBits,aBits);
 let e1=sdfIntervalVectorSubtract(sdfIntervalVector(bBits,bBits),a);
 let e2=sdfIntervalVectorSubtract(sdfIntervalVector(cBits,cBits),a);
 let p=sdfIntervalCross(d,e2);var det=sdfIntervalDot(e1,p);
 if(det.valid==0u || (det.lo<=0 && det.hi>=0)){return unknown;}
 let s=sdfIntervalVectorSubtract(o,a);let q=sdfIntervalCross(s,e1);
 var u=sdfIntervalDot(s,p);var v=sdfIntervalDot(d,q);var t=sdfIntervalDot(e2,q);
 let frontFace=select(0u,1u,det.lo>0);
 if(det.hi<0){det=sdfIntervalNegate(det);u=sdfIntervalNegate(u);v=sdfIntervalNegate(v);t=sdfIntervalNegate(t);}
 let sum=sdfIntervalAdd(u,v);
 if(u.valid==0u || v.valid==0u || t.valid==0u || sum.valid==0u){return unknown;}
 if(u.hi<0 || v.hi<0 || sum.lo>det.hi){return SdfSurfaceIntersection(0u,0,0,frontFace);}
 let time=sdfIntervalDivide(t,det);
 if(time.valid==0u){return unknown;}
 if(time.hi<range.lo || time.lo>range.hi){return SdfSurfaceIntersection(0u,0,0,frontFace);}
 let lo=max(time.lo,range.lo);let hi=min(time.hi,range.hi);
 if(u.lo>=0 && v.lo>=0 && sum.hi<=det.lo && time.lo>=range.lo && time.hi<=range.hi){
  return SdfSurfaceIntersection(1u,lo,hi,frontFace);
 }
 // Only refine the unresolved path. The cyclic W numerator retains the shared
 // origin dependence lost by adding independently bounded U and V.
 let b=sdfIntervalVector(bBits,bBits);let c=sdfIntervalVector(cBits,cBits);
 var affineV=sdfIntervalDot(s,sdfIntervalCross(e1,d));
 var affineT=sdfIntervalDot(s,sdfIntervalCross(e1,e2));
 var affineW=sdfIntervalDot(sdfIntervalVectorSubtract(b,o),sdfIntervalCross(d,sdfIntervalVectorSubtract(c,b)));
 if(frontFace==0u){affineV=sdfIntervalNegate(affineV);affineT=sdfIntervalNegate(affineT);affineW=sdfIntervalNegate(affineW);}
 let refinedV=sdfSurfaceTriangleTighten(v,affineV);
 let refinedT=sdfSurfaceTriangleTighten(t,affineT);
 let refinedW=sdfSurfaceTriangleTighten(sdfIntervalSubtract(det,sum),affineW);
 let refinedTime=sdfIntervalDivide(refinedT,det);
 if(refinedV.valid==1u && refinedW.valid==1u && refinedTime.valid==1u){
  if(refinedV.hi<0 || refinedW.hi<0 || refinedTime.hi<range.lo || refinedTime.lo>range.hi){
   return SdfSurfaceIntersection(0u,0,0,frontFace);
  }
  if(u.lo>=0 && refinedV.lo>=0 && refinedW.lo>=0 &&
     refinedTime.lo>=range.lo && refinedTime.hi<=range.hi){
   return SdfSurfaceIntersection(1u,refinedTime.lo,refinedTime.hi,frontFace);
  }
 }
 return SdfSurfaceIntersection(2u,lo,hi,frontFace);
}
` +
  SDF_SURFACE_SLAB_WGSL;

/** Complete raw-affine exact module; consumers must not append the primitive again. */
export const SDF_SURFACE_LOCAL_RAY_WGSL: string =
  SDF_SURFACE_INTERSECTION_WGSL + SDF_SURFACE_AFFINE_LOCAL_RAY_WGSL;
