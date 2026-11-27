import { SDF_SURFACE_LOCAL_RAY_WGSL } from './sdf-surface-intersection-wgsl';
import { SDF_SURFACE_INVERSE_WGSL, SDF_SURFACE_POOL_WGSL } from './sdf-surface-pool-wgsl';
import {
  SDF_SURFACE_RAY_USABLE_WGSL,
  SDF_SURFACE_ROOT_REQUEST_WGSL,
  SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL,
} from './sdf-surface-root-request-wgsl';
import { SDF_SURFACE_SAMPLE_WGSL } from './sdf-surface-sample-wgsl';

/** Same canonical field packet and raw instance words as World and visibility.
 * state is clear=0, proven hit=1, unavailable=2, exhausted=3. All work shares
 * the caller's remaining node/triangle budget. The first paid root evaluation
 * also contains at most one bounded unsigned sample lookup, counted separately;
 * this extra work is not a free sample or a multi-step marcher. */
const SDF_SURFACE_TRACE_COMMON_WGSL = `${SDF_SURFACE_LOCAL_RAY_WGSL}
${SDF_SURFACE_POOL_WGSL}
struct SdfSurfaceTrace {
 state:u32, row:u32, primitive:u32, frontFace:u32,
 lower:f32, upper:f32, uncertain:f32, reserved:u32, prefixSamples:u32, hasUncertainty:u32
}
fn sdfSurfaceTraceEmpty(last:f32) -> SdfSurfaceTrace {
 return SdfSurfaceTrace(0u,0xffffffffu,0xffffffffu,0u,last,last,last,0u,0u,0u);
}
${SDF_SURFACE_RAY_USABLE_WGSL}fn sdfSurfaceCharge(remaining:ptr<function,u32>) -> bool {
 if(*remaining==0u){return false;}*remaining-=1u;return true;
}
${SDF_SURFACE_SAMPLE_WGSL}fn sdfSurfaceVertex(packet:SdfSurfacePacket,index:u32) -> vec3u {
 let first=packet.positions.x+index*3u;
 return vec3u(sdfFieldWord(first),sdfFieldWord(first+1u),sdfFieldWord(first+2u));
}
${SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL}${SDF_SURFACE_INVERSE_WGSL}
fn sdfSurfaceLeafTrianglePrepared(packet:SdfSurfacePacket,slot:u32,ray:SdfSurfaceRay,segment:ptr<function,SdfIntervalVector>) -> SdfSurfaceTrace {
 var out=sdfSurfaceTraceEmpty(bitcast<f32>(ray.tRange.y));
 if(slot>=packet.order.y){out.state=2u;out.lower=bitcast<f32>(ray.tRange.x);return out;}
 let primitive=sdfFieldWord(packet.order.x+slot);
 if(primitive>=packet.triangles.y){out.state=2u;out.lower=bitcast<f32>(ray.tRange.x);return out;}
 let first=packet.triangles.x+primitive*3u;
 let indices=vec3u(sdfFieldWord(first),sdfFieldWord(first+1u),sdfFieldWord(first+2u));
 if(any(indices>=vec3u(packet.positions.y))){out.state=2u;out.lower=bitcast<f32>(ray.tRange.x);return out;}
 let a=sdfSurfaceVertex(packet,indices.x);let b=sdfSurfaceVertex(packet,indices.y);let c=sdfSurfaceVertex(packet,indices.z);
 for(var axis=0u;axis<3u;axis++){
  if(!sdfSurfaceBitsUsable(a[axis]) || !sdfSurfaceBitsUsable(b[axis]) || !sdfSurfaceBitsUsable(c[axis])){out.state=2u;out.lower=bitcast<f32>(ray.tRange.x);return out;}
 }
 let lo=bitcast<vec3u>(min(bitcast<vec3f>(a),min(bitcast<vec3f>(b),bitcast<vec3f>(c))));
 let hi=bitcast<vec3u>(max(bitcast<vec3f>(a),max(bitcast<vec3f>(b),bitcast<vec3f>(c))));
 if(sdfSurfaceSegmentBoundsClear(segment,lo,hi)){return out;}
 let hit=sdfSurfaceTriangle(ray,a,b,c);
 out.state=hit.state;out.primitive=primitive;out.frontFace=hit.frontFace;
 // Unknown alpha can remove geometry, but cannot create a certified opaque hit.
 // Keep the actual intersection lower bound so only prior/equal unknown blocks.
 if(hit.state==1u && !sdfSurfacePrimitiveOpaque(packet,primitive)){out.state=2u;}
 out.reserved=(sdfFieldWord(packet.sidedness.x+(primitive>>5u))>>(primitive&31u))&1u;
 out.lower=hit.tLower;out.upper=hit.tUpper;return out;
}
fn sdfSurfaceLeafTriangle(packet:SdfSurfacePacket,slot:u32,ray:SdfSurfaceRay) -> SdfSurfaceTrace {
 var segment=sdfSurfaceSegmentEnclosure(ray);
 return sdfSurfaceLeafTrianglePrepared(packet,slot,ray,&segment);
}
fn sdfSurfacePrimitiveAxisPlane(packet:SdfSurfacePacket,primitive:u32,axis:u32) -> vec2u {
 if(packet.valid!=1u || primitive>=packet.triangles.y || axis>=3u){return vec2u(0u);}
 let first=packet.triangles.x+primitive*3u;
 let indices=vec3u(sdfFieldWord(first),sdfFieldWord(first+1u),sdfFieldWord(first+2u));
 if(any(indices>=vec3u(packet.positions.y))){return vec2u(0u);}
 let a=sdfFieldWord(packet.positions.x+indices.x*3u+axis);
 let b=sdfFieldWord(packet.positions.x+indices.y*3u+axis);
 let c=sdfFieldWord(packet.positions.x+indices.z*3u+axis);
 if(!sdfSurfaceBitsUsable(a) || a!=b || a!=c){return vec2u(0u);}
 return vec2u(1u,a);
}
// Both hits must come from this packet and the same original local ray.
// Certified intersections with one identical authored axis plane have the same
// exact parameter for each ray, even when their numeric intervals are not points.
// Numeric interval equality alone is never this certificate.
fn sdfSurfaceAcceptAxisTie(best:ptr<function,SdfSurfaceTrace>,hit:SdfSurfaceTrace,packet:SdfSurfacePacket) -> bool {
 if((*best).state!=1u || hit.state!=1u || hit.primitive==(*best).primitive ||
  hit.upper<(*best).lower || hit.lower>(*best).upper){return false;}
 // Preserve the existing exact-point/signed-zero path byte for byte.
 if((*best).lower==(*best).upper && hit.lower==hit.upper){return false;}
 if(!sdfSurfacePrimitiveOpaque(packet,(*best).primitive) || !sdfSurfacePrimitiveOpaque(packet,hit.primitive)){return false;}
 for(var axis=0u;axis<3u;axis++){
  let a=sdfSurfacePrimitiveAxisPlane(packet,(*best).primitive,axis);
  let b=sdfSurfacePrimitiveAxisPlane(packet,hit.primitive,axis);
  if(a.x==1u && b.x==1u && a.y==b.y){
   let lower=max((*best).lower,hit.lower);let upper=min((*best).upper,hit.upper);
   if(hit.primitive<(*best).primitive){
    let uncertain=(*best).uncertain;let hasUncertainty=(*best).hasUncertainty;
    *best=hit;(*best).uncertain=uncertain;(*best).hasUncertainty=hasUncertainty;
   }
   // Equal exact t is in both intervals. Never widen a bound already used to prune.
   (*best).lower=lower;(*best).upper=upper;
   return true;
  }
 }
 return false;
}
fn sdfSurfaceAccept(best:ptr<function,SdfSurfaceTrace>,hit:SdfSurfaceTrace) {
 if(hit.state==2u){(*best).uncertain=min((*best).uncertain,hit.lower);(*best).hasUncertainty=1u;return;}
 if(hit.state!=1u){return;}
 if((*best).state==0u || hit.upper<(*best).lower){
  let uncertain=(*best).uncertain;let hasUncertainty=(*best).hasUncertainty;
  *best=hit;(*best).uncertain=uncertain;(*best).hasUncertainty=hasUncertainty;return;
 }
 if(hit.lower>(*best).upper){return;}
 if(hit.primitive!=(*best).primitive){
  // This reducer visits one packet. Two certified point intersections at
  // exactly the same parameter are genuine ties, not interval overlap.
  // Choose the smaller primitive without discarding a prior unknown.
  if(hit.lower==hit.upper){
   if((*best).lower==(*best).upper){
    if(hit.lower==(*best).lower){
     if(hit.primitive<(*best).primitive){
      let uncertain=(*best).uncertain;let hasUncertainty=(*best).hasUncertainty;
      *best=hit;(*best).uncertain=uncertain;(*best).hasUncertainty=hasUncertainty;
     }
     return;
    }
   }
  }
  // A different primitive is never inferred from approximate overlap.
  (*best).uncertain=min((*best).uncertain,min(hit.lower,(*best).lower));(*best).hasUncertainty=1u;
 }
 (*best).lower=min((*best).lower,hit.lower);(*best).upper=min((*best).upper,hit.upper);
}
`;

const deferredSiblingCapacity = 6;

/** Screen's nominal ordering hint. The stack belongs to one shader invocation,
 * and each row starts with depth zero. Only charged visits certify geometry. */
const SDF_SURFACE_NEAR_ORDER_WGSL = `var<private> sdfSurfaceDeferredSiblings:array<vec4u,${deferredSiblingCapacity}>;
fn sdfSurfaceNearRight(ray:SdfSurfaceRay,packet:SdfSurfacePacket,left:u32,right:u32)->bool{
 let lat=packet.nodes.x+8u*left;let rat=packet.nodes.x+8u*right;
 var estimate=vec2f(bitcast<f32>(ray.tRange.x));
 for(var axis=0u;axis<3u;axis++){
  let a=sdfFieldWord(lat+axis);let b=sdfFieldWord(lat+4u+axis);
  let c=sdfFieldWord(rat+axis);let e=sdfFieldWord(rat+4u+axis);
  if(!sdfSurfaceBitsUsable(a) || !sdfSurfaceBitsUsable(b) || !sdfSurfaceBitsUsable(c) || !sdfSurfaceBitsUsable(e)){return false;}
  let lo=bitcast<vec2f>(vec2u(a,c));let hi=bitcast<vec2f>(vec2u(b,e));
  if(any(lo>hi)){return false;}
  let o0=bitcast<f32>(ray.originLo[axis]);let o1=bitcast<f32>(ray.originHi[axis]);
  let d0=bitcast<f32>(ray.directionLo[axis]);let d1=bitcast<f32>(ray.directionHi[axis]);
  if(d0<=0.0 && d1>=0.0){
   if(d0!=0.0 || d1!=0.0 || any(vec2f(o1)<lo) || any(vec2f(o0)>hi)){return false;}
   continue;
  }
  let origin=0.5*o0+0.5*o1;let direction=0.5*d0+0.5*d1;
  let nearPlane=select(hi,lo,d0>0.0);
  let entry=(nearPlane-vec2f(origin))*(1.0/direction);
  if(!sdfSurfaceBitsUsable(bitcast<u32>(entry.x)) || !sdfSurfaceBitsUsable(bitcast<u32>(entry.y))){return false;}
  estimate=max(estimate,entry);
 }
 return estimate.y<estimate.x;
}
`;

/** One packet/BVH loop authority; only the requested result policy differs. */
function surfaceTraceRow(
  boundsOnly: boolean,
  prepared = false,
  receiver = false,
  hinted = false,
): string {
  const reject = (state: 2 | 3, nearest: string) => (boundsOnly ? `return ${state}u;` : nearest);
  return `fn ${boundsOnly ? 'sdfSurfaceBoundsRow' : 'sdfSurfaceTraceRow'}(row:u32,world:SdfSurfaceRay,remaining:ptr<function,u32>${prepared ? ',request:SdfSurfaceRootRequest,expected:vec4u,mask:u32,consumed:ptr<function,u32>,context:vec2u' : ''}${receiver ? ',contact:SdfSurfaceContact' : ''}${hinted ? ',seed:SdfSurfaceTrace' : ''}) -> ${boundsOnly ? 'u32' : 'SdfSurfaceTrace'} {
 if(!sdfSurfaceRayUsable(world)){${reject(2, 'return SdfSurfaceTrace(2u,row,0xffffffffu,0u,0,0,0,0u,0u,1u);')}}
 let last=bitcast<f32>(world.tRange.y);let first=bitcast<f32>(world.tRange.x);
 ${boundsOnly ? '' : 'var best=sdfSurfaceTraceEmpty(last);best.row=row;'}
 let packet=sdfSurfacePacket(row);
 if(packet.valid==0u){${reject(2, 'best.state=2u;best.lower=first;return best;')}}
 let ray=sdfSurfaceLocalRay(world,sdfSurfaceInverse(row),packet.coefficients.yz);
 if(ray.valid==0u){${reject(2, 'best.state=2u;best.lower=first;return best;')}}
 var segment=sdfSurfaceSegmentEnclosure(ray);
 var node=0u;${boundsOnly ? '' : 'var prefix=SdfSurfacePrefix(0,0u,0u);'}${
   hinted
     ? `
 var pendingDepth=0u;`
     : ''
 }
 loop {${
   hinted
     ? `
  // Each frame stores left root, right root, parent escape, and left phase.
  while(pendingDepth>0u){
   let index=pendingDepth-1u;let frame=sdfSurfaceDeferredSiblings[index];
   let boundary=select(frame.z,frame.y,frame.w==1u);
   if(node<boundary){break;}
   if(node>boundary){best.state=2u;best.lower=first;return best;}
   if(frame.w==0u){sdfSurfaceDeferredSiblings[index].w=1u;node=frame.x;break;}
   pendingDepth--;node=frame.z;
  }`
     : ''
 }
  if(node>=packet.nodes.y){break;}
${
  prepared
    ? `  var paid=false;
  if(node==0u){
   let payment=sdfSurfaceRedeemRoot(row,world,request,expected,mask,remaining,consumed,context);
   if(payment==2u){best.state=2u;best.lower=first;return best;}
   paid=payment==1u;
  }
  if(!paid && !sdfSurfaceCharge(remaining)){best.state=3u;best.lower=first;return best;}`
    : `  if(!sdfSurfaceCharge(remaining)){${reject(3, 'best.state=3u;best.lower=first;return best;')}}`
}
  let at=packet.nodes.x+node*8u;
  let escape=sdfFieldWord(at+3u);let leaf=sdfFieldWord(at+7u);
${
  hinted
    ? `  if(pendingDepth>0u){
   let frame=sdfSurfaceDeferredSiblings[pendingDepth-1u];
   let boundary=select(frame.z,frame.y,frame.w==1u);
   if(escape>boundary){best.state=2u;best.lower=first;return best;}
  }
`
    : ''
}  if(escape<=node || escape>packet.nodes.y){${reject(2, 'best.state=2u;best.lower=first;return best;')}}
  let lo=vec3u(sdfFieldWord(at),sdfFieldWord(at+1u),sdfFieldWord(at+2u));
  let hi=vec3u(sdfFieldWord(at+4u),sdfFieldWord(at+5u),sdfFieldWord(at+6u));
${boundsOnly ? '  if(!sdfIntervalVectorValid(sdfIntervalVector(lo,hi))){return 2u;}\n' : ''}  if(sdfSurfaceSegmentBoundsClear(&segment,lo,hi)){node=escape;continue;}
  let bounds=sdfSurfaceSlab(ray,lo,hi);
${hinted ? '  if(seed.state==1u && bounds.certified==1u && bounds.near>seed.upper){node=escape;continue;}\n' : ''}\
${
  boundsOnly
    ? ''
    : `  // A later node cannot resolve geometry before the earliest unknown.
  // Keep the closed boundary and unqualified slabs on the original path.
  var traversalLimit=best.upper;
  if(best.hasUncertainty==1u){traversalLimit=min(traversalLimit,best.uncertain);}
`
}  if(bounds.certified==1u && (bounds.possible==0u || bounds.near>${boundsOnly ? 'last' : 'traversalLimit'})){node=escape;continue;}
${
  boundsOnly
    ? ''
    : `  if(node==0u){${
        prepared
          ? `
   if(paid && request.control.z==3u){prefix=SdfSurfacePrefix(bitcast<f32>(request.payload[2].z),request.payload[3].y,request.payload[2].w);}
   else{prefix=sdfSurfaceRootPrefix(row,packet,ray);}
   best.prefixSamples=prefix.samples;
  `
          : 'prefix=sdfSurfaceRootPrefix(row,packet,ray);best.prefixSamples=prefix.samples;'
      }}
  // Strict far comparison preserves closed endpoints, primitive/facing identity
  // and every original slab/triangle input. Failure simply keeps the old path.
  if(prefix.valid==1u && bounds.certified==1u && bounds.far<prefix.end){node=escape;continue;}
`
}  let count=leaf&3u;let start=leaf>>2u;
  if(count==0u){
   if(start>=packet.order.y || node+1u>=escape){${reject(2, 'best.state=2u;best.lower=first;return best;')}}${
     hinted
       ? `
   // Risky forks pay only a ranking lookahead. Both child visits retain their
   // original charges and exact geometry tests. A full stack keeps preorder.
   if(seed.state==0u && pendingDepth<${deferredSiblingCapacity}u && *remaining>=2u && escape-node-1u>*remaining){
    let left=node+1u;let right=sdfFieldWord(packet.nodes.x+8u*left+3u);
    if(right>left && right<escape && sdfFieldWord(packet.nodes.x+8u*right+3u)==escape && sdfSurfaceNearRight(ray,packet,left,right)){
     sdfSurfaceDeferredSiblings[pendingDepth]=vec4u(left,right,escape,0u);
     pendingDepth++;node=right;continue;
    }
   }`
       : ''
   }
   node++;continue;
  }
  if(count>2u || start>packet.order.y || count>packet.order.y-start || escape!=node+1u){${reject(2, 'best.state=2u;best.lower=first;return best;')}}
${
  boundsOnly
    ? '  return 1u;'
    : `  for(var slot=0u;slot<count;slot++){
   if(!sdfSurfaceCharge(remaining)){${reject(3, 'best.state=3u;best.lower=first;return best;')}}
${
  receiver
    ? `   // Only the canonical construction's unique plane contact is excluded.
   // The original primitive address is not a BVH ordinal; every other face,
   // including faces of the same instance, retains its original charged query.
   if(contact.valid==1u && contact.row==row && sdfFieldWord(packet.order.x+start+slot)==contact.primitive){continue;}
`
    : ''
}${
  hinted
    ? `   var hit:SdfSurfaceTrace;
   // The extra Screen test never pays this World visit. The charge above is
   // retained even when the already certified primitive math can be reused.
   if(seed.state==1u && seed.row==row && sdfFieldWord(packet.order.x+start+slot)==seed.primitive){hit=seed;}
   else{hit=sdfSurfaceLeafTrianglePrepared(packet,start+slot,ray,&segment);}`
    : '   let hit=sdfSurfaceLeafTrianglePrepared(packet,start+slot,ray,&segment);'
}
   if(!sdfSurfaceAcceptAxisTie(&best,hit,packet)){sdfSurfaceAccept(&best,hit);}best.row=row;best.prefixSamples=prefix.samples;
  }
  node=escape;`
}
 }
${
  boundsOnly
    ? ' return 0u;'
    : ` // Presence is independent of the bound: an unknown at the closed endpoint
 // must not collide with the empty trace's initial numeric bound.
 if(best.hasUncertainty==1u && best.uncertain<=best.upper){best.state=2u;best.lower=min(best.lower,best.uncertain);}
 return best;`
}
}
`;
}

function surfaceTraceModule(mode: 'nearest' | 'bounds' | 'both'): string {
  if (mode === 'bounds') return SDF_SURFACE_TRACE_COMMON_WGSL + surfaceTraceRow(true);
  const nearest = SDF_SURFACE_TRACE_COMMON_WGSL + surfaceTraceRow(false);
  return mode === 'both' ? nearest + surfaceTraceRow(true) : nearest;
}

/** Full nearest-hit module over the original charged ray and result policy. */
export const SDF_SURFACE_TRACE_WGSL = surfaceTraceModule('nearest');
/** Clear-only enclosure query: 0 every Mesh leaf box excluded, 1 a possible
 * leaf enclosure, 2 unavailable, 3 exhausted. State 1 is never a primitive hit.
 * It calls neither triangle intersection nor the unsigned root-prefix sampler. */
export const SDF_SURFACE_BOUNDS_WGSL = surfaceTraceModule('bounds');
/** Both policies over one word-fetch transport, with common code defined once.
 * A mixed storage/texture transport requires separate protocol design. */
export const SDF_SURFACE_TRACE_WITH_BOUNDS_WGSL = surfaceTraceModule('both');

/** Private Screen continuation variant. Default exact modules remain unchanged.
 * Only one node-zero bank can be redeemed; row, raw ray, source and instance
 * are checked again before the original triangle loop consumes its remainder. */
export const SDF_SURFACE_TRACE_ROOT_WGSL =
  SDF_SURFACE_TRACE_COMMON_WGSL + SDF_SURFACE_ROOT_REQUEST_WGSL + surfaceTraceRow(false, true);

/** Receiver-only exact traversal. Construction lineage and the nonparallel
 * unique-contact proof are owned by the Screen World caller, not a raw ID skip. */
export const SDF_SURFACE_TRACE_RECEIVER_WGSL =
  SDF_SURFACE_TRACE_COMMON_WGSL +
  `struct SdfSurfaceContact { row:u32, primitive:u32, valid:u32 }\n` +
  surfaceTraceRow(false, false, true);

/** Screen-only certified endpoint hint. It never initializes a proven hit;
 * the ordinary charged traversal must reach its primitive and prove the prefix. */
export const SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL =
  SDF_SURFACE_TRACE_COMMON_WGSL +
  `struct SdfSurfaceContact { row:u32, primitive:u32, valid:u32 }\n` +
  SDF_SURFACE_NEAR_ORDER_WGSL +
  surfaceTraceRow(false, false, true, true);
