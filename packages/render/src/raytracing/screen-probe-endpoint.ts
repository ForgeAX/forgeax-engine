import { SCREEN_PROBE_CANDIDATE_WGSL } from '@forgeax/engine-shader';
import { SCREEN_PROBE_RECEIVER_SOURCE_WGSL } from './screen-probe-receiver';

/** Private Ray32 transport. RGB is only a tagged candidate until World runs.
 * Bit11 records an actual extra Screen triangle test, including misses. */
export const SCREEN_PROBE_ENDPOINT_WGSL = `${SCREEN_PROBE_CANDIDATE_WGSL}${SCREEN_PROBE_RECEIVER_SOURCE_WGSL}
struct ScreenEndpoint { trace:SdfSurfaceTrace, tested:u32 }
fn screenProbeEndpoint(probe:ScreenProbe,ray:ProbeRay,contact:SdfSurfaceContact)->ScreenEndpoint{
 var out=ScreenEndpoint(sdfSurfaceTraceEmpty(probeFrame.environment.w),0u);
 if((ray.info&RAY_SCREEN_CANDIDATE)==0u||!screenCandidateValid(ray.radiance)){return out;}
 if(contact.valid!=1u||contact.row!=probe.receiverRow||contact.primitive!=probe.receiverPrimitive){return out;}
 let candidate=screenCandidateUnpack(ray.radiance);
 if(candidate.y!=probeFrame.probes.w||candidate.z!=probeFrame.query.z){return out;}
 let pixel=vec2u(candidate.x&65535u,candidate.x>>16u);
 // The caller just established this directory through the same read-only source.
 // Frame/header/pose association is still checked against this current mapping.
 let location=screenReceiverPrimitive(pixel,true);if(location.w==0u){return out;}
 let row=location.x;let primitive=location.y;
 // The origin's own construction is excluded only by its existing contact proof.
 if(row==probe.receiverRow&&primitive==probe.receiverPrimitive){return out;}
 let packet=sdfSurfacePacket(row);
 // Raster-local receiver identity never certifies a remote MASK endpoint.
 if(!sdfSurfacePrimitiveOpaque(packet,primitive)){return out;}
 let world=SdfSurfaceRay(probe.canonicalLo,probe.canonicalHi,bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(0,probeFrame.environment.w)),1u);
 if(!sdfSurfaceRayUsable(world)){return out;}
 let local=sdfSurfaceLocalRay(world,sdfSurfaceInverse(row),packet.coefficients.yz);
 if(local.valid!=1u){return out;}
 let at=packet.triangles.x+primitive*3u;
 let indices=vec3u(sdfFieldWord(at),sdfFieldWord(at+1u),sdfFieldWord(at+2u));
 if(any(indices>=vec3u(packet.positions.y))){return out;}
 let a=sdfSurfaceVertex(packet,indices.x);let b=sdfSurfaceVertex(packet,indices.y);let c=sdfSurfaceVertex(packet,indices.z);
 for(var axis=0u;axis<3u;axis++){
  if(!sdfSurfaceBitsUsable(a[axis])||!sdfSurfaceBitsUsable(b[axis])||!sdfSurfaceBitsUsable(c[axis])){return out;}
 }
 // At most one extra canonical test. It never precharges World remaining.
 out.tested=1u;let hit=sdfSurfaceTriangle(local,a,b,c);
 if(hit.state!=1u){return out;}
 out.trace.state=1u;out.trace.row=row;out.trace.primitive=primitive;out.trace.frontFace=hit.frontFace;
 out.trace.lower=hit.tLower;out.trace.upper=hit.tUpper;
 out.trace.reserved=(sdfFieldWord(packet.sidedness.x+(primitive>>5u))>>(primitive&31u))&1u;
 return out;
}
`;

export const SCREEN_PROBE_ENDPOINT_ROSTER = [
  [17, 'uint', 'visibleSurface'],
  [18, 'uint', 'receiverSource'],
  [19, 'uniform', 'receiverView'],
] as const;
