/** Shared conservative bounds query. This certifies an interval enclosure,
 * never a primitive intersection. Exact queries and march entry use one body. */
export const SDF_SURFACE_BOUNDS_TYPE_WGSL = `// A caller may prune only when certified=1; possible=1 is not a surface hit.
struct SdfSurfaceBounds { possible: u32, certified: u32, near: f32, far: f32 }

`;

export const SDF_SURFACE_SLAB_WGSL = `fn sdfSurfaceSlab(ray:SdfSurfaceRay,loBits:vec3u,hiBits:vec3u) -> SdfSurfaceBounds {
 let unknown=SdfSurfaceBounds(1u,0u,0,0);
 let range=sdfIntervalRaw(ray.tRange.x,ray.tRange.y);
 if(ray.valid!=1u || range.valid==0u){return unknown;}
 var near=range.lo;var far=range.hi;
 let origin=sdfIntervalVector(ray.originLo,ray.originHi);
 let direction=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let boxBounds=sdfIntervalVector(loBits,hiBits);
 if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(direction) || !sdfIntervalVectorValid(boxBounds)){return unknown;}
 for(var i=0u;i<3u;i++){
  let box=boxBounds.axis[i];let o=origin.axis[i];let d=direction.axis[i];
  if(d.lo==0 && d.hi==0){
   if(o.hi<box.lo || o.lo>box.hi){return SdfSurfaceBounds(0u,1u,near,far);}
   continue;
  }
  if(d.lo<=0 && d.hi>=0){return unknown;}
  let first=sdfIntervalDivide(sdfIntervalSubtract(SdfRealInterval(box.lo,box.lo,1u),o),d);
  let last=sdfIntervalDivide(sdfIntervalSubtract(SdfRealInterval(box.hi,box.hi,1u),o),d);
  if(first.valid==0u || last.valid==0u){return unknown;}
  near=max(near,min(first.lo,last.lo));far=min(far,max(first.hi,last.hi));
  if(near>far){return SdfSurfaceBounds(0u,1u,near,far);}
 }
 return SdfSurfaceBounds(1u,1u,near,far);
}
`;
