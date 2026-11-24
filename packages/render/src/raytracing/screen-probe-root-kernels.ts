import type { Binding } from './irradiance-field';
import { SCREEN_PROBE_ENDPOINT_WGSL } from './screen-probe-endpoint';
import { SCREEN_PROBE_CONTACT_WGSL } from './screen-probe-receiver';
import {
  SCREEN_PROBE_RECEIVER_REQUEST_WGSL,
  SCREEN_PROBE_WORLD_RECORDS_WGSL,
} from './screen-probe-records';
import { worldTraversalWgsl } from './world-traversal';

export { SCREEN_PROBE_WORLD_RECORDS_WGSL } from './screen-probe-records';

/** Private split dispatch; ordinary combined and split both use canonical World. */
export type ScreenProbeRootStage = 'prepareRoot' | 'refineRoot' | 'resolveRoot';

const rayResourcesWgsl = (
  write = false,
) => `${SCREEN_PROBE_WORLD_RECORDS_WGSL}${SCREEN_PROBE_RECEIVER_REQUEST_WGSL}
@group(0) @binding(7) var<storage,${write ? 'read_write' : 'read'}> rays:array<ProbeRay>;
@group(0) @binding(8) var<storage,read> probesIn:array<ScreenProbe>;
@group(0) @binding(9) var<uniform> probeFrame:ScreenProbeFrame;
@group(0) @binding(16) var<storage,read_write> rootRequests:array<ScreenProbeRootRequest>;
fn worldSceneExpected()->vec4u{return probeFrame.expectedSource;}
`;

export const SCREEN_PROBE_ROOT_RAY_ROSTER = [
  [7, 'read', 'rays'],
  [8, 'read', 'probesIn'],
  [9, 'uniform', 'probeFrame'],
  [16, 'storage', 'rootRequests'],
] as const satisfies readonly (readonly [number, Binding, string])[];

/** Seal the actual canonical construction without borrowing the old point-ray
 * bank. The continuation uses the equivalent original-budget exact traversal. */
export function screenProbeRootPrepareWgsl(): string {
  return `${rayResourcesWgsl()}
@compute @workgroup_size(64) fn prepareRoot(@builtin(global_invocation_id) id:vec3u,@builtin(num_workgroups) groups:vec3u){
 let i=id.x+id.y*groups.x*64u;
 if(i>=(probeFrame.probes.x+probeFrame.probes.y)*64u || i>=arrayLength(&rootRequests)){return;}
 var request:ScreenProbeRootRequest;rootRequests[i]=request;
 let ray=rays[i];if(((ray.info>>12u)&7u)!=1u){return;}
 let probe=probesIn[i/64u];
 if(probe.receiverControl.x!=1u||probe.receiverControl.y!=probeFrame.probes.w||any(probe.receiverExpected!=probeFrame.expectedSource)){return;}
 request.expected=probeFrame.expectedSource;request.control=vec4u(1u,i,probeFrame.probes.w,probeFrame.query.x);
 request.originLo=probe.canonicalLo;request.originHi=probe.canonicalHi;request.receiverRow=probe.receiverRow;request.receiverPrimitive=probe.receiverPrimitive;
 request.payload[0]=vec4u(probe.canonicalLo,1u);request.payload[1]=vec4u(bitcast<vec3u>(ray.direction),probeFrame.query.x);
 request.payload[2]=vec4u(bitcast<vec2u>(vec2f(0,probeFrame.environment.w)),0u,0u);
 rootRequests[i]=request;
}
`;
}

/** Only the immutable same-frame enclosure is refined. The selected receiver
 * proof is checked again; a missing/parallel proof remains unavailable. */
export function screenProbeRootRefineWgsl(): string {
  return `${worldTraversalWgsl('global-sdf', false, true, true)}
${rayResourcesWgsl(true)}
${SCREEN_PROBE_CONTACT_WGSL}
${SCREEN_PROBE_ENDPOINT_WGSL}
@compute @workgroup_size(64) fn refineRoot(@builtin(global_invocation_id) id:vec3u,@builtin(num_workgroups) groups:vec3u){
 let i=id.x+id.y*groups.x*64u;
 if(i>=(probeFrame.probes.x+probeFrame.probes.y)*64u || i>=arrayLength(&rootRequests)){return;}
 var ray=rays[i];if(((ray.info>>12u)&7u)!=1u){return;}
 let request=rootRequests[i];let context=vec2u(i,probeFrame.probes.w);let probe=probesIn[i/64u];
 let world=SdfSurfaceRay(request.originLo,request.originHi,request.payload[1].xyz,request.payload[1].xyz,request.payload[2].xy,1u);
 var hit=Hit(vec4u(4u,0u,0u,0u),vec4f(0),vec4f(0),vec4f(0));
 // Raw admission and independent lineage precede every conversion. Consume the
 // original ray exactly once; do not recompute its FP bias in another PSO.
 let contact=screenProbeContact(probe,ray.direction);
 if(contact.valid==1u && sdfSurfaceRayUsable(world) && all(request.expected==probeFrame.expectedSource) && all(request.control==vec4u(1u,context,probeFrame.query.x)) &&
  request.receiverRow==probe.receiverRow&&request.receiverPrimitive==probe.receiverPrimitive&&all(request.originLo==probe.canonicalLo)&&all(request.originHi==probe.canonicalHi)&&
  all(request.payload[0]==vec4u(probe.canonicalLo,1u))&&request.payload[1].w==probeFrame.query.x&&all(request.payload[2].zw==vec2u(0))&&all(request.payload[3]==vec4u(0))&&
  all(world.directionLo==bitcast<vec3u>(ray.direction)) && all(world.tRange==bitcast<vec2u>(vec2f(0,probeFrame.environment.w)))){
  let endpoint=screenProbeEndpoint(probe,ray,contact);
  ray.info=(ray.info&~RAY_SCREEN_ENDPOINT_TESTED)|select(0u,RAY_SCREEN_ENDPOINT_TESTED,endpoint.tested==1u);
  hit=traceWorld(Ray(bitcast<vec3f>(world.originLo),0,ray.direction,probeFrame.environment.w,vec4u(1u,0u,0u,0u)),
   probeFrame.query.x,bitcast<f32>(probeFrame.query.y),world.originHi,bitcast<vec3u>(ray.direction),contact,endpoint.trace);
 }
 rays[i]=ray;
 var out:ScreenProbeRootRequest;out.expected=probeFrame.expectedSource;out.control=vec4u(3u,context,0u);
 out.originLo=request.originLo;out.originHi=request.originHi;out.receiverRow=request.receiverRow;out.receiverPrimitive=request.receiverPrimitive;
 out.payload[0]=hit.state;out.payload[1]=bitcast<vec4u>(hit.metrics);
 out.payload[2]=bitcast<vec4u>(hit.position);out.payload[3]=bitcast<vec4u>(hit.normal);
 rootRequests[i]=out;
}
`;
}
