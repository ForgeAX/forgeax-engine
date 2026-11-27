/** Prototype visibility policy, not a canonical primitive-intersection contract.
 * The adapter supplies the admitted pooled Mesh fields, existing trilinear
 * sampler, interval transforms, optional LOCAL-window coverage refinement and
 * Card owner. Receiver displacement is a rendering error policy, not an exact
 * empty prefix. No mandatory receiver triangle query precedes the march.
 * Candidate reservation, row preparation, eight-tap samples and refinements
 * share the original query bank; no refund, full-range fallback or reset.
 *
 * Hit64 metadata bits 30/29 mean known instance / approximate DF respectively.
 * Bit31 and the canonical primitive bits stay clear. The reported uncertainty
 * includes sampling/quantization, transform enclosure and receiver displacement.
 * An approximate inside sign alone never certifies opaque geometry.
 */
export const SDF_MESH_DF_APPROX_WGSL = `
struct SdfMeshDfPolicy { receiverBiasVoxels:f32, expansionVoxels:f32, maxErrorVoxels:f32 }
// Identity for biasing a rendering query. It never authorizes an exact leaf skip.
struct SdfMeshDfReceiver { row:u32, primitive:u32, valid:u32 }
struct SdfMeshDfSample { distance:f32, magnitude:f32, gradient:vec3f, valid:u32 }
struct SdfMeshDfPoint { position:vec3f, radius:f32, valid:u32 }
// Per traceWorld invocation: visited candidate tests, actual sample taps,
// exact local work and selected-row preparation. No new resource/binding.
var<private> sdfMeshDfCost:vec4u;
fn sdfMeshDfReserve(remaining:ptr<function,u32>,cost:u32) -> bool {
 if(cost>(*remaining)){return false;}(*remaining)-=cost;return true;
}
fn sdfMeshDfUnknown(t:f32) -> Hit {
 return Hit(vec4u(4u,0x20000000u,0u,0xffffffffu),vec4f(t,0,0,0),vec4f(0),vec4f(0));
}
fn sdfMeshDfFinite(v:f32) -> bool {return (bitcast<u32>(v)&0x7fffffffu)<0x7f800000u;}
fn sdfMeshDfUnit(v:vec3f) -> vec3f {
 let scale=max(abs(v.x),max(abs(v.y),abs(v.z)));
 if(!sdfMeshDfFinite(scale) || scale<bitcast<f32>(0x00800000u)){return vec3f(0);}
 let unit=v/scale;return unit/length(unit);
}
// The inverse's adjugate/determinant gives a conservative local-to-world L1
// operator bound. Interval authority covers reflections and nonuniform scale;
// singular/unsupported transforms remain unavailable rather than using one axis.
fn sdfMeshDfScale(row:u32) -> f32 {
 let inverse=sdfSurfaceInverse(row);
 var rows:array<SdfIntervalVector,3>;
 for(var axis=0u;axis<3u;axis++){
  let r=vec3u(inverse[0][axis],inverse[1][axis],inverse[2][axis]);
  rows[axis]=sdfIntervalVector(r,r);
 }
 var cofactors:array<SdfIntervalVector,3>;
 cofactors[0]=sdfIntervalCross(rows[1],rows[2]);
 cofactors[1]=sdfIntervalCross(rows[2],rows[0]);
 cofactors[2]=sdfIntervalCross(rows[0],rows[1]);
 let det=sdfIntervalDot(rows[0],cofactors[0]);var scale=sdfIntervalZero();
 for(var column=0u;column<3u;column++){for(var axis=0u;axis<3u;axis++){
  let value=sdfIntervalDivide(cofactors[column].axis[axis],det);
  if(value.valid==0u){return 0;}
  let magnitude=sdfSurfaceIntervalMagnitude(value);
  scale=sdfIntervalAdd(scale,sdfIntervalMultiply(magnitude,magnitude));
 }}
 if(scale.valid==0u){return 0;}let root=sqrt(scale.hi);
 if(!sdfMeshDfFinite(root) || root<=0){return 0;}
 return bitcast<f32>(bitcast<u32>(root)+1u);
}
fn sdfMeshDfPoint(ray:SdfSurfaceRay,t:f32) -> SdfMeshDfPoint {
 var query=ray;query.tRange=vec2u(bitcast<u32>(t));
 let box=sdfSurfaceSegmentEnclosure(query);var out=SdfMeshDfPoint(vec3f(0),0,0u);
 var radius=sdfIntervalZero();
 for(var axis=0u;axis<3u;axis++){
  let span=box.axis[axis];if(span.valid==0u){return out;}
  out.position[axis]=span.lo;
  radius=sdfIntervalAdd(radius,sdfIntervalSubtract(span,sdfIntervalPoint(bitcast<u32>(span.lo))));
 }
 if(radius.valid==0u){return out;}out.radius=radius.hi;out.valid=1u;return out;
}
// Same trilinear cell convention as sdfValue, with checked pooled reads and an
// analytic gradient from those SAME eight samples (no six unaccounted queries).
fn sdfMeshDfSample(row:u32,packet:SdfSurfacePacket,p:vec3f) -> SdfMeshDfSample {
 var out=SdfMeshDfSample(0,0,vec3f(0),0u);let m=sdfInstanceAt(row);
 let dimensions=m.field.yzw;
 if(any(dimensions<vec3u(2u))){return out;}
 let q=(p-m.origin.xyz)/m.origin.w;
 if(any(q<vec3f(0)) || any(q>vec3f(dimensions-vec3u(1u)))){return out;}
 for(var axis=0u;axis<3u;axis++){if(!sdfMeshDfFinite(q[axis])){return out;}}
 let cell=vec3u(min(floor(q),vec3f(dimensions-vec3u(2u))));let fraction=q-vec3f(cell);
 for(var tap=0u;tap<8u;tap++){
  let offset=vec3u(tap&1u,(tap>>1u)&1u,tap>>2u);
  let code=sdfSurfaceSampleCode(packet,dimensions,cell+offset);
  if(code.x!=1u){return out;}
  let value=(f32(code.y)-select(0.0,65536.0,code.y>32767u))*m.extent.w/32767.0;
  let weights=select(vec3f(1)-fraction,fraction,offset>vec3u(0u));
  let weight=weights.x*weights.y*weights.z;
  out.distance+=value*weight;out.magnitude+=abs(value)*weight;
  let sign=select(vec3f(-1),vec3f(1),offset>vec3u(0u));
  out.gradient+=value*sign*vec3f(weights.y*weights.z,weights.x*weights.z,weights.x*weights.y)/m.origin.w;
 }
 if(!sdfMeshDfFinite(out.distance) || !sdfMeshDfFinite(out.magnitude)){return out;}
 out.valid=1u;return out;
}
fn sdfMeshDfError(row:u32,packet:SdfSurfacePacket,radius:f32) -> f32 {
 let spacing=sdfIntervalPoint(sdfInstanceWord(row,27u));
 let band=sdfIntervalPoint(sdfInstanceWord(row,31u));
 let unit=sdfIntervalDivide(band,sdfIntervalPoint(bitcast<u32>(32767.0)));
 // Outward binary32 sqrt(3), for the full trilinear cell's diagonal.
 let cell=sdfIntervalMultiply(spacing,sdfIntervalPoint(0x3fddb3d8u));
 let error=sdfIntervalAdd(sdfIntervalAdd(cell,unit),sdfIntervalPoint(packet.coefficients.x));
 let total=sdfIntervalAdd(error,sdfIntervalPoint(bitcast<u32>(radius)));
 if(total.valid==0u){return -1;}return total.hi;
}
fn sdfMeshDfRefine(row:u32,world:SdfSurfaceRay,first:f32,last:f32,
 remaining:ptr<function,u32>,contact:SdfSurfaceContact) -> SdfSurfaceTrace {
 var query=world;query.tRange=bitcast<vec2u>(vec2f(first,last));
 // Receiver-only exact entry has NO prepared-root nonce. This is a new paid
 // local window, not a replay of an original-query prepaid root certificate.
 let before=*remaining;
 let result=sdfSurfaceTraceRow(row,query,remaining,contact);
 sdfMeshDfCost.z+=before-*remaining;return result;
}
fn sdfMeshDfFromExact(ray:Ray,hit:SdfSurfaceTrace,world:SdfSurfaceRay,error:f32) -> Hit {
 let surface=sdfSceneSurfaceHit(ray,hit,world);
 if(surface.state.x!=1u){return sdfMeshDfUnknown(hit.lower);}
 // Local refinement qualifies placement coverage, not an original-ray exact
// tag after bias. Keep approximate metadata even when its primitive is known.
 return Hit(vec4u(1u,0x60000000u,0u,surface.state.y),
  vec4f(hit.lower,max(error,surface.metrics.y),0,1),surface.position,surface.normal);
}
fn sdfMeshDfRow(row:u32,ray:Ray,world:SdfSurfaceRay,remaining:ptr<function,u32>,
 contact:SdfSurfaceContact,offset:vec3f,bias:f32,receiverVoxel:f32,policy:SdfMeshDfPolicy) -> Hit {
 var out=sdfMeshDfUnknown(ray.tMin);
 let packet=sdfSurfacePacket(row);let m=sdfInstanceAt(row);
 if(packet.valid!=1u || packet.prefixEligible!=1u || !sdfSurfaceRowAssociated(row) || m.error.w!=2.0 || any(m.field.yzw<vec3u(2u))){return out;}
 let scale=sdfMeshDfScale(row);let speed=length(ray.direction);
 if(!(scale>0) || !(speed>0) || !sdfMeshDfFinite(scale) || !sdfMeshDfFinite(speed)){return out;}
 // The skipped receiver band is declared approximation, NOT certified empty.
 // Only uncertain near-hit coverage below requests paid local refinement.
 let shift=dot(offset,ray.direction)/dot(ray.direction,ray.direction);
 let last=ray.tMax-shift;
 if(!sdfMeshDfFinite(last) || last<ray.tMin){return out;}
 var shifted=world;
 for(var axis=0u;axis<3u;axis++){
  let value=sdfIntervalAdd(sdfIntervalRaw(world.originLo[axis],world.originHi[axis]),sdfIntervalPoint(bitcast<u32>(offset[axis])));
  if(value.valid==0u){return out;}
  shifted.originLo[axis]=bitcast<u32>(value.lo);shifted.originHi[axis]=bitcast<u32>(value.hi);
 }
 shifted.tRange=bitcast<vec2u>(vec2f(ray.tMin,last));
 let local=sdfSurfaceLocalRay(shifted,sdfSurfaceInverse(row),packet.coefficients.yz);
 if(local.valid!=1u){return out;}
 let lo=m.origin.xyz;let hi=lo+vec3f(m.field.yzw-vec3u(1u))*m.origin.w;
 // Complete authored geometry must fit the sampled volume. A truncated field
 // cannot certify a miss outside its lattice or extrapolate a boundary sample.
 let root=packet.nodes.x;
 let meshLo=bitcast<vec3f>(vec3u(sdfFieldWord(root),sdfFieldWord(root+1u),sdfFieldWord(root+2u)));
 let meshHi=bitcast<vec3f>(vec3u(sdfFieldWord(root+4u),sdfFieldWord(root+5u),sdfFieldWord(root+6u)));
 if(any(meshLo<lo) || any(meshHi>hi)){return out;}
 let bounds=sdfSurfaceSlab(local,bitcast<vec3u>(lo),bitcast<vec3u>(hi));
 if(bounds.certified!=1u){return out;}
 var t=max(ray.tMin,bounds.near);let far=min(last,bounds.far);
 let displacement=length(offset);
 if(!sdfMeshDfFinite(displacement)){return out;}
 out=Hit(vec4u(0u,0x20000000u,0u,0xffffffffu),vec4f(ray.tMax,displacement,0,0),vec4f(0),vec4f(0));
 if(bounds.possible==0u || t>far){return out;}
 let localSpeed=length(bitcast<vec3f>(local.directionLo));
 if(!(localSpeed>0) || !sdfMeshDfFinite(localSpeed)){return sdfMeshDfUnknown(ray.tMin);}
 var first=true;
 loop {
  if(!sdfMeshDfReserve(remaining,8u)){out.state.x=3u;return out;}
  sdfMeshDfCost.y+=8u;
  let point=sdfMeshDfPoint(local,t);
  if(point.valid!=1u){return sdfMeshDfUnknown(t+shift);}
  let sample=sdfMeshDfSample(row,packet,point.position);
  if(sample.valid!=1u){return sdfMeshDfUnknown(t+shift);}
  let error=sdfMeshDfError(row,packet,point.radius);
  let worldError=(2.0*error+policy.expansionVoxels*m.origin.w)*scale+displacement;
  let allowed=max(receiverVoxel,m.origin.w*scale)*policy.maxErrorVoxels;
  if(error<0 || !sdfMeshDfFinite(worldError) || worldError>allowed){return sdfMeshDfUnknown(t+shift);}
  out.metrics.y=max(out.metrics.y,worldError);
  if(first){out.metrics.z=sample.distance;first=false;}
  // The sign vote is approximate, not a proof of being inside an opaque solid.
  if(sample.distance<0 && sample.magnitude>error){return sdfMeshDfUnknown(t+shift);}
  let expansion=policy.expansionVoxels*m.origin.w*clamp((t-ray.tMin)*localSpeed/(2.0*m.origin.w),0.0,1.0);
  if(sample.magnitude<=error+expansion){
   let width=(error+expansion)/localSpeed;
   if(packet.coverage.x!=0u){
    // Partial/MASK is decided only at a nearby canonical primitive. The
    // biased query gets NO original contact exemption and NO Screen hit seed.
    let near=sdfMeshDfRefine(row,shifted,max(ray.tMin,t-width),min(far,t+width),remaining,SdfSurfaceContact(0xffffffffu,0xffffffffu,0u));
    if(near.state==3u){out.state.x=3u;return out;}
    if(near.state==2u){return sdfMeshDfUnknown(t+shift);}
    if(near.state==1u){
     let observed=Ray(bitcast<vec3f>(shifted.originLo),ray.tMin,ray.direction,last,ray.mask);
     var hit=sdfMeshDfFromExact(observed,near,shifted,worldError);hit.metrics.x+=shift;return hit;
    }
    let next=min(far,t+width);
    if(!(next>t)){return sdfMeshDfUnknown(t+shift);}
    if(next==far){return out;}
    t=next;
   }else{
    let inverse=sdfInstanceAt(row).inverse;
    let gradient=sdfMeshDfUnit(transpose(mat3x3f(inverse[0].xyz,inverse[1].xyz,inverse[2].xyz))*sample.gradient);
    if(all(gradient==vec3f(0))){return sdfMeshDfUnknown(t+shift);}
    return Hit(vec4u(1u,0x60000000u,0u,m.ids.x),vec4f(t+shift,worldError,out.metrics.z,1),
     vec4f(bitcast<vec3f>(shifted.originLo)+ray.direction*t,1),vec4f(gradient,0));
   }
  }else{
   let next=t+(sample.magnitude-error)/localSpeed;
   if(!(next>t) || !sdfMeshDfFinite(next)){return sdfMeshDfUnknown(t+shift);}
   t=next;
  }
  if(t>far){return out;}
 }
 return out;
}
fn sdfMeshDfWorld(ray:Ray,world:SdfSurfaceRay,remaining:ptr<function,u32>,receiver:SdfMeshDfReceiver,policy:SdfMeshDfPolicy) -> Hit {
 var out=Hit(vec4u(0u,0x20000000u,0u,0xffffffffu),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));
 if(any(grid.source!=worldSceneExpected())){return sdfMeshDfUnknown(ray.tMin);}
 var normal=vec3f(0);var voxel=grid.originSpacing.w;
 if(receiver.valid==1u){
  if(!sdfMeshDfReserve(remaining,1u)){out.state.x=3u;return out;}
  sdfMeshDfCost.w++;
  let packet=sdfSurfacePacket(receiver.row);
  if(packet.valid!=1u || receiver.primitive>=packet.triangles.y || !sdfSurfaceRowAssociated(receiver.row) ||
   !sdfSurfacePrimitiveOpaque(packet,receiver.primitive)){return sdfMeshDfUnknown(ray.tMin);}
  let surface=SdfSurfaceTrace(1u,receiver.row,receiver.primitive,1u,0,0,0,0u,0u,0u);
  let geometric=sdfSceneSurfaceNormal(surface);
  if(geometric.w!=1.0){return sdfMeshDfUnknown(ray.tMin);}
  normal=geometric.xyz;
  voxel=sdfInstanceAt(receiver.row).origin.w*sdfMeshDfScale(receiver.row);
 }
 let bias=voxel*policy.receiverBiasVoxels;
 let direction=sdfMeshDfUnit(ray.direction);
 if(!sdfMeshDfFinite(bias) || !(bias>=0) || all(direction==vec3f(0))){return sdfMeshDfUnknown(ray.tMin);}
 let offset=(normal+direction)*bias;
 // Include BOTH the original and displaced ray in object candidate culling.
 // This enclosure is candidate coverage, not an exact hit/empty certificate.
 var candidateRay=world;
 for(var axis=0u;axis<3u;axis++){
  let source=sdfIntervalRaw(world.originLo[axis],world.originHi[axis]);
  let moved=sdfIntervalAdd(source,sdfIntervalPoint(bitcast<u32>(offset[axis])));
  if(moved.valid==0u){return sdfMeshDfUnknown(ray.tMin);}
  candidateRay.originLo[axis]=bitcast<u32>(min(source.lo,moved.lo));
  candidateRay.originHi[axis]=bitcast<u32>(max(source.hi,moved.hi));
 }
 let capacity=sdfInstanceRowCount();
 let directory=sdfSurfaceExpectedDirectory(grid.dimensionsCount.w,worldSceneExpected());
 if(directory.valid!=1u || capacity==0u){return sdfMeshDfUnknown(ray.tMin);}
 // The same directory/row checks run before culling. Charge each actual test
 // before executing it, not every directory node skipped by an enclosing slab.
 // No reserved work is refunded, and capacity alone is never live work.
 var candidateWork=0u;
 var candidates=sdfSurfaceSceneCandidates(candidateRay,grid.dimensionsCount.w,ray.mask.x,grid.source,worldSceneExpected(),remaining,&candidateWork);
 sdfMeshDfCost.x+=candidateWork;
 if(candidates.state==3u){out.state.x=3u;return out;}
 if(candidates.state==2u){return sdfMeshDfUnknown(ray.tMin);}
 for(var row=0u;row<grid.dimensionsCount.w;row++){
  if(!sdfSurfaceCandidateContains(&candidates,row)){continue;}
  if(!sdfMeshDfReserve(remaining,1u)){out.state.x=3u;return out;}
  sdfMeshDfCost.w++;
  let hit=sdfMeshDfRow(row,ray,world,remaining,SdfSurfaceContact(0xffffffffu,0xffffffffu,0u),offset,bias,voxel,policy);
  if(hit.state.x==3u || hit.state.x==4u){return hit;}
  if(hit.state.x==1u && (out.state.x==0u || hit.metrics.x<out.metrics.x)){out=hit;}
  else{out.metrics.y=max(out.metrics.y,hit.metrics.y);}
 }
 return out;
}
`;
