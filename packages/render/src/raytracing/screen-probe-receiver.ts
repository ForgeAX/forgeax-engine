import {
  CANONICAL_RECEIVER_RECONSTRUCTION_WGSL,
  SCREEN_PROBE_CURRENT_SUPPORT_MASK,
  SDF_INSTANCE_WORD_GUARDS_WGSL,
  SDF_SURFACE_POOL_WGSL,
} from '@forgeax/engine-shader';
import { FIELD_RECEIVER_GPU } from './field-receiver-texture';
import { SCREEN_PROBE_WORLD_RECORDS_WGSL } from './screen-probe-records';
import { SDF_INSTANCE_RAW_WGSL } from './sdf-instance-wgsl';

/** The canonical construction defines the secondary ray's exact mathematical
 * start. A strict nonparallel determinant then proves its receiver plane has
 * exactly one contact, at t=0. This is not a depth-point error certificate and
 * cannot be used for an arbitrary origin or a point-light direction. */
export const SCREEN_PROBE_CONTACT_WGSL = `
fn screenProbeContact(probe:ScreenProbe,direction:vec3f)->SdfSurfaceContact{
 let none=SdfSurfaceContact(0xffffffffu,0xffffffffu,0u);
 let local=(probe.receiverControl.x==2u||probe.receiverControl.x==3u)&&
  (probeFrame.control.z&~7u)==${SCREEN_PROBE_CURRENT_SUPPORT_MASK}u;
 if((probe.receiverControl.x!=1u&&!local)||probe.receiverControl.y!=probeFrame.probes.w||probe.receiverControl.z==0u||probe.receiverControl.w!=probeFrame.query.z||
  probe.pixel==0xffffffffu||any(probe.receiverExpected!=probeFrame.expectedSource)||any(grid.source!=probeFrame.expectedSource)||
  probeFrame.expectedSource.w==0u||probe.receiverRow>=probeFrame.expectedSource.z||!sdfInstanceValid(probe.receiverRow)||!sdfSurfaceRowAssociated(probe.receiverRow)){return none;}
 let packet=sdfSurfacePacket(probe.receiverRow);
 if(packet.valid!=1u||probe.receiverPrimitive>=packet.triangles.y||(!local&&!sdfSurfacePrimitiveOpaque(packet,probe.receiverPrimitive))||sdfSurfaceExpectedDirectory(probeFrame.expectedSource.z,probeFrame.expectedSource).valid!=1u){return none;}
 let world=SdfSurfaceRay(probe.canonicalLo,probe.canonicalHi,bitcast<vec3u>(direction),bitcast<vec3u>(direction),bitcast<vec2u>(vec2f(0,probeFrame.environment.w)),1u);
 if(!sdfSurfaceRayUsable(world)){return none;}
 let ray=sdfSurfaceLocalRay(world,sdfSurfaceInverse(probe.receiverRow),packet.coefficients.yz);
 if(ray.valid!=1u){return none;}
 let tri=packet.triangles.x+probe.receiverPrimitive*3u;let indices=vec3u(sdfFieldWord(tri),sdfFieldWord(tri+1u),sdfFieldWord(tri+2u));
 if(any(indices>=vec3u(packet.positions.y))){return none;}
 let aBits=sdfSurfaceVertex(packet,indices.x);let bBits=sdfSurfaceVertex(packet,indices.y);let cBits=sdfSurfaceVertex(packet,indices.z);
 let a=sdfIntervalVector(aBits,aBits);
 let e1=sdfIntervalVectorSubtract(sdfIntervalVector(bBits,bBits),a);let e2=sdfIntervalVectorSubtract(sdfIntervalVector(cBits,cBits),a);
 let d=sdfIntervalVector(ray.directionLo,ray.directionHi);let det=sdfIntervalDot(e1,sdfIntervalCross(d,e2));
 if(det.valid!=1u||(det.lo<=0&&det.hi>=0)){return none;}
 // A local raster token never permits transport into the observed side.
 // Only this exact receiver primitive's unique geometric t=0 is excluded.
 if(local&&select(0u,1u,det.lo>0)==probe.receiverControl.x-2u){return none;}
 return SdfSurfaceContact(probe.receiverRow,probe.receiverPrimitive,1u);
}
`;

/** Same accepted per-frame raster-to-canonical authority for both endpoints. */
export const SCREEN_PROBE_RECEIVER_SOURCE_WGSL = `
struct ReceiverView { viewProjection:mat4x4f }
@group(0) @binding(17) var visibleSurface:texture_2d<u32>;
@group(0) @binding(18) var receiverSource:texture_2d<u32>;
@group(0) @binding(19) var<uniform> receiverView:ReceiverView;
fn receiverWord(i:u32)->u32{
 let shape=textureDimensions(receiverSource);let t=i>>2u;
 if(shape.x==0u||t/shape.x>=shape.y){return 0u;}
 return textureLoad(receiverSource,vec2i(i32(t%shape.x),i32(t/shape.x)),0)[i&3u];
}
fn receiverSourceReady(directoryReady:bool)->bool{
 let shape=textureDimensions(receiverSource);let expected=probeFrame.expectedSource;
 if(any(expected!=grid.source)||expected.w==0u||expected.x!=arrayLength(&instances)*36u||expected.y!=arrayLength(&fields)||expected.z!=grid.dimensionsCount.w){return false;}
 if(receiverWord(0u)!=${FIELD_RECEIVER_GPU.magic}u||receiverWord(1u)!=${FIELD_RECEIVER_GPU.version}u||receiverWord(3u)!=probeFrame.probes.w||receiverWord(8u)!=shape.x||receiverWord(10u)!=probeFrame.query.z){return false;}
 if(!directoryReady&&sdfSurfaceExpectedDirectory(expected.z,expected).valid!=1u){return false;}
 for(var i=0u;i<4u;i++){if(receiverWord(4u+i)!=expected[i]){return false;}}
 let count=receiverWord(2u);if(count>(0xffffffffu-${FIELD_RECEIVER_GPU.headerWords}u)/${FIELD_RECEIVER_GPU.rowWords}u){return false;}
 return receiverWord(9u)==${FIELD_RECEIVER_GPU.headerWords}u+count*${FIELD_RECEIVER_GPU.rowWords}u&&receiverWord(9u)/4u<=shape.x*shape.y;
}
fn screenReceiverPrimitive(pixel:vec2u,directoryReady:bool)->vec4u{
 let none=vec4u(0xffffffffu,0xffffffffu,0u,0u);if(!receiverSourceReady(directoryReady)){return none;}
 if(any(pixel>=probeFrame.extent.xy)||any(textureDimensions(visibleSurface)!=probeFrame.extent.xy)){return none;}
 let identity=textureLoad(visibleSurface,vec2i(pixel),0);
 if(identity.x==0u||identity.x>receiverWord(2u)||(identity.w&1u)==0u){return none;}
 let at=${FIELD_RECEIVER_GPU.headerWords}u+(identity.x-1u)*${FIELD_RECEIVER_GPU.rowWords}u;
 let mapped=receiverWord(at);let first=receiverWord(at+1u);let count=receiverWord(at+2u);
 let proof=receiverWord(at+3u);let local=proof==${FIELD_RECEIVER_GPU.rasterAlphaLocal}u&&
  (probeFrame.control.z&~7u)==${SCREEN_PROBE_CURRENT_SUPPORT_MASK}u;
 if(mapped==0u||mapped>probeFrame.expectedSource.z||(proof!=${FIELD_RECEIVER_GPU.opaquePrimitive}u&&!local)||identity.y>=count||first>0xffffffffu-identity.y){return none;}
 let row=mapped-1u;let primitive=first+identity.y;
 if(!sdfInstanceValid(row)||!sdfSurfaceRowAssociated(row)||(sdfInstanceMask(row)&1u)==0u){return none;}
 let packet=sdfSurfacePacket(row);if(packet.valid!=1u||primitive>=packet.triangles.y||(!local&&!sdfSurfacePrimitiveOpaque(packet,primitive))){return none;}
 return vec4u(row,primitive,at,identity.x);
}
`;

/** One canonical reconstruction per actual placed probe, before its 64 rays.
 * It reads the actual raster identity and the same accepted forward/geometry
 * source. Depth is never an input to this construction. */
export function screenProbeReceiverWgsl(): string {
  return `${CANONICAL_RECEIVER_RECONSTRUCTION_WGSL}
${SDF_INSTANCE_RAW_WGSL}${SDF_INSTANCE_WORD_GUARDS_WGSL}${SDF_SURFACE_POOL_WGSL}
${SCREEN_PROBE_WORLD_RECORDS_WGSL}
struct Grid { originSpacing:vec4f, dimensionsCount:vec4u, ranges:vec4f, source:vec4u }
@group(0) @binding(1) var<uniform> grid:Grid;
@group(0) @binding(2) var<storage,read> instances:array<RawInstance>;
@group(0) @binding(3) var<storage,read> fields:array<u32>;
@group(0) @binding(6) var<storage,read_write> probes:array<ScreenProbe>;
@group(0) @binding(9) var<uniform> probeFrame:ScreenProbeFrame;
fn sdfFieldWordCount()->u32{return arrayLength(&fields);}
fn sdfFieldWord(i:u32)->u32{if(i>=arrayLength(&fields)){return 0u;}return fields[i];}
${SCREEN_PROBE_RECEIVER_SOURCE_WGSL}
fn screenReceiverMatrixDet(matrix:array<vec4u,4>,last:u32)->SdfRealInterval{
 let a=sdfIntervalVector(vec3u(matrix[0][0],matrix[1][0],matrix[2][0]),vec3u(matrix[0][0],matrix[1][0],matrix[2][0]));
 let b=sdfIntervalVector(vec3u(matrix[0][1],matrix[1][1],matrix[2][1]),vec3u(matrix[0][1],matrix[1][1],matrix[2][1]));
 let c=sdfIntervalVector(vec3u(matrix[0][last],matrix[1][last],matrix[2][last]),vec3u(matrix[0][last],matrix[1][last],matrix[2][last]));
 return sdfIntervalDot(a,sdfIntervalCross(b,c));
}
// Native CCW perspective raster convention, qualified conservatively from the
// actual matrices. Orthographic, mirrored-projection and uncertain domains keep
// local receivers unavailable; the opaque/reference construction is unchanged.
fn screenReceiverLocalSide(input:CanonicalReceiverInput,pixel:vec2u)->u32{
 let forward=screenReceiverMatrixDet(input.forward,2u);
 let projection=screenReceiverMatrixDet(input.viewProjection,3u);
 if(forward.valid!=1u||(forward.lo<=0&&forward.hi>=0)||projection.valid!=1u||projection.hi>=0){return 0u;}
 let front=(textureLoad(visibleSurface,vec2i(pixel),0).w>>1u)&1u;
 return 2u+(front^select(0u,1u,forward.hi<0));
}
fn reconstructScreenReceiver(probe:ScreenProbe)->ScreenProbe{
 var out=probe;out.canonicalLo=vec3u(0);out.canonicalHi=vec3u(0);out.receiverRow=0xffffffffu;out.receiverPrimitive=0xffffffffu;
 out.receiverExpected=vec4u(0);out.receiverControl=vec4u(0);
 if(probe.pixel==0xffffffffu){return out;}
 let pixel=vec2u(probe.pixel&65535u,probe.pixel>>16u);
 let location=screenReceiverPrimitive(pixel,false);if(location.w==0u){return out;}
 let row=location.x;let primitive=location.y;let at=location.z;
 let packet=sdfSurfacePacket(row);
 var input:CanonicalReceiverInput;let tri=packet.triangles.x+primitive*3u;
 for(var v=0u;v<3u;v++){
  let index=sdfFieldWord(tri+v);if(index>=packet.positions.y){return out;}
  let p=packet.positions.x+index*3u;input.vertices[v]=vec3u(sdfFieldWord(p),sdfFieldWord(p+1u),sdfFieldWord(p+2u));
 }
 for(var c=0u;c<4u;c++){
  let m=at+4u+c*4u;input.forward[c]=vec4u(receiverWord(m),receiverWord(m+1u),receiverWord(m+2u),receiverWord(m+3u));
  input.viewProjection[c]=bitcast<vec4u>(receiverView.viewProjection[c]);
 }
 input.pixel=pixel;input.extent=probeFrame.extent.xy;input.sampleOffset=vec2u(0x3f000000u);
 let point=canonicalReceiverReconstruct(input);
 if(point.state!=1u||point.rasterQualified!=0u){return out;}
 var proof=1u;
 if(receiverWord(at+3u)==${FIELD_RECEIVER_GPU.rasterAlphaLocal}u){
  proof=screenReceiverLocalSide(input,pixel);if(proof==0u){return out;}
 }
 for(var axis=0u;axis<3u;axis++){out.canonicalLo[axis]=bitcast<u32>(point.point.axis[axis].lo);out.canonicalHi[axis]=bitcast<u32>(point.point.axis[axis].hi);}
 out.receiverRow=row;out.receiverPrimitive=primitive;out.receiverExpected=probeFrame.expectedSource;
 // This is canonical construction lineage, never a raster/contact-ready flag.
 out.receiverControl=vec4u(proof,probeFrame.probes.w,location.w,probeFrame.query.z);return out;
}
@compute @workgroup_size(64) fn prepareScreenReceivers(@builtin(global_invocation_id)id:vec3u,@builtin(num_workgroups)groups:vec3u){
 let i=id.x+id.y*groups.x*64u;if(i>=probeFrame.probes.x+probeFrame.probes.y||i>=arrayLength(&probes)){return;}
 probes[i]=reconstructScreenReceiver(probes[i]);
}
`;
}
