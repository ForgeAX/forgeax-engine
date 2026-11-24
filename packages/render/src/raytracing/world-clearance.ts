/** A positive result certifies only an empty ray prefix, never a surface hit.
 * The composing world module supplies Instance/ObjectBounds, their buffers and
 * the Mesh SDF decoder. Absolute visibility samples are capped unsigned nearest
 * distances before encoding; their heuristic sign is irrelevant to this bound. */
export const WORLD_LOCAL_BOUNDS_INTERVAL_WGSL = `
fn worldLocalBoundsInterval(origin: vec3f, direction: vec3f, lo: vec3f, hi: vec3f,
    first: f32, last: f32) -> vec2f {
 var near=first;var far=last;
 for(var axis=0u;axis<3u;axis++){
  if(direction[axis]==0.0){if(origin[axis]<lo[axis]||origin[axis]>hi[axis]){return vec2f(1,-1);}}
  else {let a=(lo[axis]-origin[axis])/direction[axis];let b=(hi[axis]-origin[axis])/direction[axis];near=max(near,min(a,b));far=min(far,max(a,b));}
 }
 return vec2f(near,far);
}
`;
export const WORLD_SDF_CLEARANCE_WGSL = `${WORLD_LOCAL_BOUNDS_INTERVAL_WGSL}
fn worldMeshDistanceLowerBound(m: Instance, position: vec3f, arithmetic: f32) -> f32 {
 if(m.field.x==0xffffffffu||!(m.origin.w>0.0)){return 0.0;}
 // An inside indication remains an occluder; the unsigned certificate is not
 // permission to walk through an interior after an approximate entry.
 if(sdfValue(m,position)<0.0){return 0.0;}
 let cell=vec3i(floor((position-m.origin.xyz)/m.origin.w));
 let last=vec3i(m.field.yzw)-vec3i(1);
 // SNORM rounding can increase a magnitude. The geometric field retains its
 // producer-owned error bound instead. Coordinate/inverse errors are separate.
 let storageError=select(m.error.x,m.extent.w/32767.0,m.error.w>0.5);
 var lower=0.0;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let c=vec3u(clamp(cell+vec3i(x,y,z),vec3i(0),last));
  let point=m.origin.xyz+vec3f(c)*m.origin.w;
  // The unsigned distance to any fixed geometry is 1-Lipschitz. Every sample
  // supplies a lower bound, and the maximum of those bounds remains a bound.
  lower=max(lower,abs(sdfTexel(m,c))-storageError-length(position-point)-arithmetic);
 }}}
 return lower;
}
struct WorldRayClearance { advance: f32, originalEmpty: bool, remainingEmpty: bool }
// Original and remaining closed intervals retain separate bounds proofs.
fn worldRayClearance(ray: Ray, t: f32) -> WorldRayClearance {
 if(!worldBoundsValid(grid.dimensionsCount.w)){return WorldRayClearance(0,false,false);}
 var advance=ray.tMax-t;var fullEmpty=true;var remainingEmpty=true;
 for(var i=0u;i<grid.dimensionsCount.w;i++){
  if(sdfInstanceMask(i)==0u){continue;}
  if(!sdfInstanceValid(i)){return WorldRayClearance(0,false,false);}
  let m=sdfInstanceAt(i);
  let b=worldBoundsAt(i);let origin=(m.inverse*vec4f(ray.origin,1)).xyz;
  let direction=(m.inverse*vec4f(ray.direction,0)).xyz;let position=origin+direction*t;
  if(!all(abs(position)<=vec3f(3.402823466e+38))||!all(abs(direction)<=vec3f(3.402823466e+38))){return WorldRayClearance(0,false,false);}
  let inverseNorm=sqrt(dot(m.inverse[0].xyz,m.inverse[0].xyz)+dot(m.inverse[1].xyz,m.inverse[1].xyz)+dot(m.inverse[2].xyz,m.inverse[2].xyz));
  // Scene packing validates the inverse product at 1e-4. Keep a deliberately
  // wider envelope for that product, f32 coordinates and lattice arithmetic.
  // Large/ill-conditioned coordinates lose the certificate, not the occluder.
  let arithmetic=4e-4*max(1.0,max(length(position),length(ray.origin)*inverseNorm+length(m.inverse[3].xyz)))+m.origin.w*1e-3;
  if(!(arithmetic>0.0)||arithmetic>3.402823466e+38){return WorldRayClearance(0,false,false);}
  let lo=b.lo.xyz-vec3f(arithmetic);let hi=b.hi.xyz+vec3f(arithmetic);
  let interval=worldLocalBoundsInterval(origin,direction,lo,hi,ray.tMin,ray.tMax);
  if(interval.x>interval.y){continue;}
  fullEmpty=false;
  if(interval.y<t){continue;}
  remainingEmpty=false;
  if(interval.x>t){advance=min(advance,interval.x-t);continue;}
  let scale=max(abs(direction.x),max(abs(direction.y),abs(direction.z)));
  let speed=scale*length(direction/scale);
  if(!(speed>0.0)||speed>3.402823466e+38){return WorldRayClearance(0,false,false);}
  let lower=worldMeshDistanceLowerBound(m,position,arithmetic);
  if(!(lower>0.0)){return WorldRayClearance(0,false,false);}
  advance=min(advance,lower/speed);
 }
 return WorldRayClearance(advance,fullEmpty,remainingEmpty);
}
`;
