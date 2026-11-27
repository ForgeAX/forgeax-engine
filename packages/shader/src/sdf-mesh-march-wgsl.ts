import { SDF_SURFACE_MARCH_FOUNDATION_WGSL } from './sdf-surface-march-wgsl';
import {
  SDF_SURFACE_POOL_LAYOUT as LAYOUT,
  SDF_SURFACE_INVERSE_WGSL,
} from './sdf-surface-pool-wgsl';

/** Per-row surface-interval outcomes, never Scene visibility or Card readiness. */
export const SDF_MESH_MARCH_STATE = { clear: 0, nearBand: 1, unknown: 2, budget: 3 } as const;

/** Bounded unsigned-distance preparation for a later continuation. Every prefix
 * attempt consumes one existing work unit; actual sample loads are also counted.
 * A near-band request includes unavailable certificates and non-useful bounds.
 * No outcome certifies a hit, facing, radiance, or an outside-volume start.
 * In particular a clear surface interval inside an opaque volume is not sky.
 * The caller retains the original ray/source and revalidates its token before
 * continuation; it never resets the returned remaining budget. This complete
 * binding-free module already includes its foundation: append only adapters. */
export const SDF_MESH_MARCH_ADMISSION_WGSL = `fn sdfMeshMarchSourceReady(actual:vec4u,expected:vec4u) -> bool {
 let capacity=sdfInstanceRowCount();let directory=sdfSurfaceDirectory();
 if(any(actual!=expected) || expected.w==0u || expected.x%${LAYOUT.instanceWords}u!=0u ||
  capacity==0u || capacity>${LAYOUT.maxRows}u || expected.x/${LAYOUT.instanceWords}u!=capacity ||
  expected.y!=sdfFieldWordCount() || expected.z>capacity || directory.valid!=1u){return false;}
 return directory.indexed==0u || (directory.epoch==expected.w && directory.rowLimit==expected.z);
}
fn sdfMeshMarchLayout(row:u32,packet:SdfSurfacePacket) -> bool {
 let dimensions=vec3u(sdfInstanceWord(row,21u),sdfInstanceWord(row,22u),sdfInstanceWord(row,23u));
 if(any(dimensions==vec3u(0u)) || any(dimensions>vec3u(16777216u))){return false;}
 let spacing=sdfIntervalPoint(sdfInstanceWord(row,27u));
 let band=sdfIntervalPoint(sdfInstanceWord(row,31u));
 if(spacing.valid==0u || band.valid==0u || spacing.lo<=0 || band.lo<=0){return false;}
 let bricks=(dimensions+vec3u(3u))/4u;
 if(bricks.x>packet.samples.y/bricks.y){return false;}
 let plane=bricks.x*bricks.y;
 if(plane>packet.samples.y/bricks.z){return false;}
 let table=plane*bricks.z;
 return table<=packet.samples.y && packet.samples.y-table>=32u;
}
// Do not turn the legacy clamped sampler into coverage outside its authored
// lattice. Require the entire affine position interval inside a conservatively
// narrowed lattice domain before the first sample access at this parameter.
fn sdfMeshMarchCoverage(row:u32,ray:SdfSurfaceRay) -> bool {
 let spacing=sdfIntervalPoint(sdfInstanceWord(row,27u));
 let time=sdfIntervalPoint(ray.tRange.x);
 let origin=sdfIntervalVector(ray.originLo,ray.originHi);
 let direction=sdfIntervalVector(ray.directionLo,ray.directionHi);
 for(var axis=0u;axis<3u;axis++){
  let first=sdfIntervalPoint(sdfInstanceWord(row,24u+axis));
  let index=sdfIntervalPoint(bitcast<u32>(f32(sdfInstanceWord(row,21u+axis)-1u)));
  let last=sdfIntervalAdd(first,sdfIntervalMultiply(index,spacing));
  let position=sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],time));
  if(first.valid==0u || last.valid==0u || position.valid==0u ||
   position.lo<first.hi || position.hi>last.lo){return false;}
 }
 return true;
}
`;

export const SDF_MESH_MARCH_WGSL = `${SDF_SURFACE_MARCH_FOUNDATION_WGSL}
${SDF_SURFACE_INVERSE_WGSL}
struct SdfMeshMarchRequest {
 state:u32, row:u32, instance:u32, attempts:u32,
 originalRange:vec2u, sampledAt:f32, firstUnresolved:f32,
 samples:u32, remaining:u32, emptyEndLower:f32, expectedSource:vec4u
}
${SDF_MESH_MARCH_ADMISSION_WGSL}fn sdfMeshMarchRow(world:SdfSurfaceRay,row:u32,mask:u32,actual:vec4u,expected:vec4u,
 remaining:ptr<function,u32>) -> SdfMeshMarchRequest {
 var out=SdfMeshMarchRequest(${SDF_MESH_MARCH_STATE.unknown}u,row,0xffffffffu,0u,
  world.tRange,0,0,0u,*remaining,0,expected);
 if(mask==0u){out.state=${SDF_MESH_MARCH_STATE.clear}u;return out;}
 if(mask>255u || *remaining>1024u || !sdfMeshMarchSourceReady(actual,expected)) {return out;}
 if(row>=expected.z){return out;}
 let rowMask=sdfInstanceMask(row);
 if(rowMask>255u){return out;}
 if((rowMask&mask)==0u){out.state=${SDF_MESH_MARCH_STATE.clear}u;return out;}
 if(!sdfInstanceValid(row) || !sdfSurfaceRowAssociated(row)){return out;}
 out.instance=sdfInstanceWord(row,16u);
 let packet=sdfSurfacePacket(row);
 if(packet.valid!=1u){return out;}
 let local=sdfSurfaceLocalRay(world,sdfSurfaceInverse(row),packet.coefficients.yz);
 if(local.valid!=1u){return out;}
 let first=bitcast<f32>(world.tRange.x);let last=bitcast<f32>(world.tRange.y);
 out.firstUnresolved=first;out.emptyEndLower=first;
 if(packet.prefixEligible!=1u){out.state=${SDF_MESH_MARCH_STATE.nearBand}u;return out;}
 if(!sdfMeshMarchLayout(row,packet)){return out;}
 loop {
  var sampleRay=local;sampleRay.tRange.x=bitcast<u32>(out.firstUnresolved);
  if(!sdfMeshMarchCoverage(row,sampleRay)){out.state=${SDF_MESH_MARCH_STATE.nearBand}u;return out;}
  if(*remaining==0u){out.state=${SDF_MESH_MARCH_STATE.budget}u;return out;}
  *remaining-=1u;out.attempts++;out.remaining=*remaining;out.sampledAt=out.firstUnresolved;
  let proof=sdfSurfaceRootPrefix(row,packet,sampleRay);
  out.samples+=proof.samples;
  if(proof.valid!=1u || !(proof.end>out.firstUnresolved)){
   out.state=${SDF_MESH_MARCH_STATE.nearBand}u;return out;
  }
  out.emptyEndLower=proof.end;
  // The available proof describes an empty prefix. Equality does not certify
  // the closed endpoint: visit it under the same remaining budget instead.
  if(proof.end>last){out.state=${SDF_MESH_MARCH_STATE.clear}u;out.firstUnresolved=last;return out;}
  out.firstUnresolved=proof.end;
 }
 return out;
}
`;
