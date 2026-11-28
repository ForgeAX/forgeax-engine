import { RAY_QUERY_WGSL_ENABLE } from '@forgeax/engine-rhi';
import {
  SDF_MESH_DF_APPROX_WGSL,
  SDF_SURFACE_POOL_LAYOUT,
  SDF_SURFACE_ROOT_REQUEST_WGSL,
} from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { isMeshDfApproxPolicy, type MeshDfApproxPolicy } from '../pipeline/standard-profile';
import { CARD_POINT_LOOKUP_WGSL, CardLookupStatus } from './card-lookup';
import { GLOBAL_CARD_CANDIDATES_WGSL } from './global-card-lookup';
import {
  GLOBAL_SDF_SAMPLE_WGSL,
  GLOBAL_SDF_SHARED_BANK_TRACE_WGSL,
  GLOBAL_SDF_TRACE_WGSL,
  GlobalSdfQueryStatus,
} from './global-sdf-query';
import { rayReferenceFailure } from './scene';
import { SDF_TRACE_WGSL } from './sdf-query';
import { SDF_SCENE_SURFACE_TRACE_WGSL, sdfSceneSurfaceTraceWgsl } from './sdf-surface-trace';
import {
  WORLD_ACCELERATION_MOTION_ROW_WORDS,
  WORLD_ACCELERATION_TABLE_LAYOUT,
} from './world-acceleration-coverage';
import { WORLD_LOCAL_BOUNDS_INTERVAL_WGSL } from './world-clearance';
import { worldSurfaceOriginWgsl } from './world-surface-origin';

/**
 * How world-trace kernels find the first surface along a ray. Both kinds
 * define the same WGSL seam, so a kernel composes one of them and never
 * branches on the backend:
 *
 * - `traceWorld(ray, maxSteps, minStepFactor) -> Hit` with the Global SDF
 *   `Hit` layout and `GlobalSdfQueryStatus` codes;
 * - `worldSurfaceOrigin(position, normal, fieldBias) -> vec3f`, a surface
 *   origin using software field clearance or hardware receiver precision;
 * - `worldHitCandidates(hit) -> Candidates`, the instances whose Cards may
 *   shade the hit.
 *
 * `'global-sdf'` refines the uncertified original interval through canonical
 * Mesh triangle packets under one work budget. An uncertified Global hint is
 * not executed until a later producer can certify a useful empty prefix.
 * Missing source/coverage or unresolved primitive identity stays unavailable.
 * `'ray-query'` traces the TLAS with
 * hardware Ray Query: a hit is an exact triangle whose instance is the only
 * candidate. An incomplete TLAS reports `missingField`; a complete TLAS
 * reports `miss` or `hit` (a ray starting inside geometry hits a backface).
 * Placement alpha uncertainty is checked at real triangle candidates: an unknown
 * before or tied with the closest opaque hit is unavailable, not an opaque hit.
 * Two queries share maxSteps; exhaustion stays unavailable. This does not evaluate
 * MASK texture alpha or certify the native open-zero endpoint as canonical contact.
 * Hit shading stays Card radiance for both.
 * `'ray-query'` requires `caps.rayQuery.supported` and a TLAS from
 * `createWorldAcceleration`; renderers compose `'global-sdf'` until they own one.
 */
export type WorldTraversal = 'global-sdf' | 'ray-query';

/** Private frame qualification: hardware does not borrow a software epoch. */
export type WorldSource =
  | {
      readonly traversal: 'global-sdf';
      readonly expected: readonly [number, number, number, number];
    }
  | { readonly traversal: 'ray-query' };

/** Non-tracing frame programs still declare that the World seam is unused. */
export type WorldFrameSource = WorldSource | { readonly traversal: 'unused' };

export function packWorldFrameSource(source: WorldFrameSource) {
  return source.traversal === 'unused' ? ok([0, 0, 0, 0] as const) : packWorldSource(source);
}

export function packWorldSource(source: WorldSource) {
  if (source.traversal === 'ray-query') return ok([0, 0, 0, 0] as const);
  const value = source.expected,
    capacity = value[0] / SDF_SURFACE_POOL_LAYOUT.instanceWords;
  if (
    value.length !== 4 ||
    !value.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff) ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > SDF_SURFACE_POOL_LAYOUT.maxRows ||
    value[1] < SDF_SURFACE_POOL_LAYOUT.sceneWords ||
    value[1] > SDF_SURFACE_POOL_LAYOUT.maxBytes / 4 ||
    value[2] > capacity ||
    value[3] === 0
  )
    return rayReferenceFailure(
      'software World frames require the accepted source tuple, not zero defaults',
    );
  return ok(value);
}

/** Group-0 resources a traversal binds in slots 0..4; kernels own slots 5 and up. */
export type WorldTraversalInput =
  | 'voxels'
  | 'grid'
  | 'instances'
  | 'fields'
  | 'bounds'
  | 'tlas'
  | 'traversalInstances'
  | 'faceNormals';

type WorldTraversalBinding = 'read' | 'uniform' | 'tlas';

export const WORLD_TRAVERSAL_ROSTER: Record<
  WorldTraversal,
  readonly (readonly [number, WorldTraversalBinding, WorldTraversalInput])[]
> = {
  'global-sdf': [
    [0, 'read', 'voxels'],
    [1, 'uniform', 'grid'],
    [2, 'read', 'instances'],
    [3, 'read', 'fields'],
    [4, 'read', 'bounds'],
  ],
  'ray-query': [
    [0, 'tlas', 'tlas'],
    [2, 'read', 'traversalInstances'],
    [3, 'read', 'faceNormals'],
  ],
};

const GLOBAL_SDF_TRAVERSAL_WGSL = globalSdfTraversalWgsl();

/** Explicit prototype policy in field voxels, never hidden epsilon or an exact
 * empty-prefix claim. The existing default and hardware branches ignore it.
 * Hit64 y: bit31 canonical primitive exact; bit30 known instance; bit29 dfApprox.
 * Exact-only bits 0/1/2..22 retain facing/two-sided/primitive under bit31 only.
 * Approximate metrics are original-ray parameter/world uncertainty/first signed
 * sample/coverage. The displaced position stays explicitly approximate. state.z
 * includes reserved candidate work, row preparation, sample taps and refinement;
 * sdfMeshDfCost exposes those separate costs in a diagnostic kernel.
 */
export type { MeshDfApproxPolicy } from '../pipeline/standard-profile';

function meshDfApproxTraceBody(
  prepared: boolean,
  receiver: boolean,
  policy: MeshDfApproxPolicy,
): string {
  if (!isMeshDfApproxPolicy(policy))
    throw new RangeError(
      'Mesh DF needs a finite voxel policy and an optional positive f32 split distance',
    );
  const nearDistance =
    policy.nearDistance === undefined ? undefined : Math.fround(policy.nearDistance);
  if (prepared && nearDistance !== undefined)
    throw new Error('A near/far trace cannot redeem a full-interval Mesh DF root request');
  return ` sdfMeshDfCost=vec4u(0u);
 if(ray.mask.x==0u){return Hit(vec4u(0u),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));}
 let world=SdfSurfaceRay(bitcast<vec3u>(ray.origin),${receiver ? 'originHi' : 'bitcast<vec3u>(ray.origin)'},bitcast<vec3u>(ray.direction),${receiver ? 'directionHi' : 'bitcast<vec3u>(ray.direction)'},bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u);
 if(!sdfSurfaceRayUsable(world) || ray.tMin<0.0 || !worldBoundsValid(grid.dimensionsCount.w)){return sdfMeshDfUnknown(ray.tMin);}
 var remaining=maxSteps;
 ${
   prepared
     ? `var consumed=0u;
 if(!sdfSurfaceRootRequestMatches(request,world,ray.mask.x,worldSceneExpected(),maxSteps,context)){return sdfMeshDfUnknown(ray.tMin);}
 if(request.control.x==2u && sdfSurfaceRedeemRoot(request.control.y,world,request,worldSceneExpected(),ray.mask.x,&remaining,&consumed,context)!=1u){return sdfMeshDfUnknown(ray.tMin);}`
     : ''
 }
 ${
   nearDistance === undefined
     ? 'let nearRay=ray;let nearWorld=world;'
     : `let speed=length(ray.direction);
 if(!(speed>0.0) || !sdfMeshDfFinite(speed)){return sdfMeshDfUnknown(ray.tMin);}
 var nearRay=ray;
 nearRay.tMax=min(ray.tMax,ray.tMin+${nearDistance}/speed);
 var nearWorld=world;nearWorld.tRange.y=bitcast<u32>(nearRay.tMax);`
 }
 var result=sdfMeshDfWorld(nearRay,nearWorld,&remaining,${receiver ? 'receiver' : 'SdfMeshDfReceiver(0xffffffffu,0xffffffffu,0u)'},SdfMeshDfPolicy(${policy.receiverBiasVoxels},${policy.expansionVoxels},${policy.maxErrorVoxels}));
 ${
   nearDistance === undefined
     ? ''
     : `if(result.state.x==${GlobalSdfQueryStatus.miss}u && nearRay.tMax<ray.tMax){
  // Overlap the two approximate visibility intervals by one Global voxel.
  // An unfinished near trace never authorizes skipping to the far field.
  var farRay=ray;
  farRay.tMin=max(ray.tMin,nearRay.tMax-grid.originSpacing.w/speed);
  var farHit=traceGlobal(farRay,remaining,minStepFactor);
  remaining-=farHit.state.z;
  // A negative continuation start does not classify the original receiver.
  if(farHit.state.x==${GlobalSdfQueryStatus.negativeStart}u){farHit.state.x=${GlobalSdfQueryStatus.missingField}u;}
  if(farHit.state.x==${GlobalSdfQueryStatus.hit}u){
   farHit.state.y=0x20000000u;
   farHit.metrics.y=max(farHit.metrics.y,grid.originSpacing.w);
  }
  result=farHit;
 }`
 }
 result.state.z=maxSteps-remaining;return result;
`;
}

function worldReceiverParameters(receiver: boolean, approximate: boolean): string {
  if (!receiver) return '';
  return approximate
    ? ',originHi:vec3u,directionHi:vec3u,receiver:SdfMeshDfReceiver'
    : ',originHi:vec3u,directionHi:vec3u,contact:SdfSurfaceContact';
}

function globalSdfVisibilityHelperWgsl(
  prepared: boolean,
  receiver: boolean,
  hinted: boolean,
): string {
  if (prepared || receiver || hinted) return '';
  return `
fn traceWorldVisibility(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 return traceWorld(ray,maxSteps,minStepFactor);
}`;
}

function globalSdfTraversalWgsl(
  prepared = false,
  receiver = false,
  hinted = false,
  approximate?: MeshDfApproxPolicy,
): string {
  return `
const WORLD_HIT_NORMAL_EXACT: bool = false;
${SDF_TRACE_WGSL}
${approximate ? sdfSceneSurfaceTraceWgsl(false, true, false, true) : receiver ? sdfSceneSurfaceTraceWgsl(false, true, hinted) : prepared ? sdfSceneSurfaceTraceWgsl(true) : SDF_SCENE_SURFACE_TRACE_WGSL}
${approximate && prepared ? SDF_SURFACE_ROOT_REQUEST_WGSL : ''}\
${GLOBAL_SDF_SAMPLE_WGSL}
@group(0) @binding(0) var<storage,read> voxels: array<Voxel>;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var<storage,read> instances: array<RawInstance>;
@group(0) @binding(3) var<storage,read> fields: array<u32>;
@group(0) @binding(4) var<storage,read> bounds: array<vec4u>;
${GLOBAL_CARD_CANDIDATES_WGSL}
${WORLD_LOCAL_BOUNDS_INTERVAL_WGSL}
${approximate?.nearDistance === undefined ? GLOBAL_SDF_TRACE_WGSL : GLOBAL_SDF_SHARED_BANK_TRACE_WGSL}
${approximate ? SDF_MESH_DF_APPROX_WGSL : ''}\
fn traceWorld(ray: Ray, maxSteps: u32, minStepFactor: f32${prepared ? ',request:SdfSurfaceRootRequest,context:vec2u' : ''}${worldReceiverParameters(receiver, approximate !== undefined)}${hinted ? ',seed:SdfSurfaceTrace' : ''}) -> Hit {
${
  approximate
    ? meshDfApproxTraceBody(prepared, receiver, approximate)
    : ` if(ray.mask.x==0u){return Hit(vec4u(0u),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));}
 ${
   receiver
     ? `let world=SdfSurfaceRay(bitcast<vec3u>(ray.origin),originHi,bitcast<vec3u>(ray.direction),directionHi,bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u);
 if(!sdfSurfaceRayUsable(world))`
     : 'if(!sdfSceneObservedRayUsable(ray))'
 }{return Hit(vec4u(${GlobalSdfQueryStatus.missingField}u,0u,0u,0u),vec4f(0),vec4f(0),vec4f(0));}
 // Source owner epochs are independent of the metadata being queried. The
 // lookup retains complete selected raw admission before any interval cull.
 if(!worldBoundsValid(grid.dimensionsCount.w)){
  return Hit(vec4u(${GlobalSdfQueryStatus.missingField}u,0u,0u,0u),vec4f(ray.tMin,0,0,0),vec4f(0),vec4f(0));
 }
 ${
   receiver
     ? ''
     : `let world=SdfSurfaceRay(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin),
  bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u);`
 }
 var candidates=sdfSurfaceSceneCandidates(world,grid.dimensionsCount.w,ray.mask.x,grid.source,worldSceneExpected());
 if(candidates.state==2u){return Hit(vec4u(${GlobalSdfQueryStatus.missingField}u,0u,0u,0u),vec4f(ray.tMin,0,0,0),vec4f(0),vec4f(0));}
 // A coarse signed union currently supplies no certified empty prefix or
 // useful qualified advance. Do not execute its redundant ordinary-f32 hint.
 // Nodes and triangles consume the original shared remaining-work budget.
 var remaining=maxSteps;
 ${
   prepared
     ? `var consumed=0u;
 if(!sdfSurfaceRootRequestMatches(request,world,ray.mask.x,worldSceneExpected(),maxSteps,context)){
  return Hit(vec4u(4u,0u,0u,0u),vec4f(ray.tMin,0,0,0),vec4f(0),vec4f(0));
 }
 `
     : ''
 }let detail=sdfSceneSurfaceTraceRows(ray,grid.dimensionsCount.w,&remaining,&candidates${prepared ? ',request,worldSceneExpected(),&consumed,context' : ''}${receiver ? ',world,contact' : ''}${hinted ? ',seed' : ''});${
   prepared
     ? `
 if(request.control.x==2u && consumed!=1u){return Hit(vec4u(4u,0u,0u,0u),vec4f(ray.tMin,0,0,0),vec4f(0),vec4f(0));}`
     : ''
 }
 let surface=sdfSceneSurfaceHit(ray,detail${receiver ? ',world' : ''});
 var status=surface.state.x;
 let steps=maxSteps-remaining;
 var state=vec4u(status,0u,steps,0xffffffffu);
 if(detail.state==1u && surface.state.x==1u){
  // Private World metadata: bit31 marks a certified triangle, bit0 facing,
  // bit1 two-sided, bits2..22 primitive. Identity stays explicit for Card lookup.
  state.y=0x80000000u|(detail.primitive<<2u)|(detail.reserved<<1u)|detail.frontFace;
  state.w=surface.state.y;
 }
 return Hit(state,surface.metrics,surface.position,surface.normal);
`
}\
}${globalSdfVisibilityHelperWgsl(prepared, receiver, hinted)}
fn worldHitCandidates(hit: Hit) -> Candidates {
${approximate ? ' if(hit.state.x==1u && (hit.state.y&0x60000000u)==0x60000000u){return Candidates(vec4u(1u,0u,hit.state.x,1u),vec4u(hit.state.w,0xffffffffu,0xffffffffu,0xffffffffu));}\n' : ''}\
 if(hit.state.x==${GlobalSdfQueryStatus.hit}u && (hit.state.y&0x80000000u)!=0u){return Candidates(vec4u(1u,0u,hit.state.x,1u),vec4u(hit.state.w,0xffffffffu,0xffffffffu,0xffffffffu));}
 return findCandidates(SdfHit(hit.state,hit.metrics,hit.position,hit.normal));
}
// A conservative Global SDF hit can lie outside the actual source silhouette.
// It may occlude, but cannot lend radiance from an instance the ray never enters.
fn worldRayIntersectsBounds(i: u32, ray: Ray) -> bool {
  if(!sdfInstanceValid(i)){return false;}
  let m=sdfInstanceAt(i);
  let b=worldBoundsAt(i);let origin=(m.inverse*vec4f(ray.origin,1)).xyz;
  let direction=(m.inverse*vec4f(ray.direction,0)).xyz;
  let interval=worldLocalBoundsInterval(origin,direction,b.lo.xyz,b.hi.xyz,ray.tMin,ray.tMax);
  return interval.x<=interval.y;
}
fn worldCandidateOnRay(id: u32, ray: Ray) -> bool {
 if(!worldBoundsValid(grid.dimensionsCount.w)){return false;}
 let row=worldBoundsRowForId(id,grid.dimensionsCount.w,grid.originSpacing.w*1.5);
 if(row==0xffffffffu){return false;}
 return worldRayIntersectsBounds(row,ray);
}
`;
}

/** Row 0: pending count, unknown placement count, bitmap word base/capacity.
 * Row `customIndex`: scene instance id, first face normal, packed count/mode,
 * bitmap word offset. `faceNormals` holds one object-space
 * unit normal per triangle in BLAS primitive order; w marks exact coincident
 * opposite windings (portable: Metal has no vertex-position fetch). */
const rayQueryTraversalWgsl = (hitMotion: boolean) => `${RAY_QUERY_WGSL_ENABLE}
const WORLD_HIT_NORMAL_EXACT: bool = true;
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct Hit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
struct Candidates { state: vec4u, ids: vec4u }
fn worldCandidateOnRay(id: u32, ray: Ray) -> bool { return true; }
@group(0) @binding(0) var tlas: acceleration_structure;
@group(0) @binding(2) var<storage,read> traversalInstances: array<vec4u>;
@group(0) @binding(3) var<storage,read> faceNormals: array<vec4f>;
// Geometry stays whole-Mesh and non-opaque. Qualification is placement-owned.
fn worldRayQueryOpaque(instance:u32, primitive:u32) -> bool {
 if(instance==0u || instance>=traversalInstances[0].z/${WORLD_ACCELERATION_TABLE_LAYOUT.rowWords}u){return false;}
 let row=traversalInstances[instance];
 if(primitive>=(row.z>>${WORLD_ACCELERATION_TABLE_LAYOUT.modeBits}u)){return false;}
 let mode=row.z&${(1 << WORLD_ACCELERATION_TABLE_LAYOUT.modeBits) - 1}u;
 if(mode<2u){return mode==0u;}
 if(mode!=2u){return false;}
 let word=row.w+(primitive>>5u);
 let first=traversalInstances[0].z;
 let count=traversalInstances[0].w;
 if(row.w<first || word<row.w || word-first>=count || word/4u>=arrayLength(&traversalInstances)){return false;}
 return ((traversalInstances[word/4u][word&3u]>>(primitive&31u))&1u)!=0u;
}
${hitMotion ? WORLD_RAY_QUERY_HIT_MOTION_WGSL : ''}fn traceWorldRayQuery(ray: Ray, maxSteps: u32, opaqueOccluderIsEnough: bool${hitMotion ? ', motion: ptr<function, WorldRayQueryHitMotion>' : ''}) -> Hit {
 var result=Hit(vec4u(${GlobalSdfQueryStatus.miss}u,0u,0u,0xffffffffu),vec4f(ray.tMax,0,0,0),vec4f(ray.origin+ray.direction*ray.tMax,1),vec4f(0));
 if(ray.mask.x==0u){return result;}
 if(traversalInstances[0].x!=0u){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}
 let allOpaque=traversalInstances[0].y==0u;
 var first=ray.tMin;
 var last=ray.tMax;
 // DXR triangle extents are open. Broaden only the hardware search, retaining
 // the original range for candidate admission. Zero stays native open-zero.
 if(!(first>=0.0) || !(last>first) || !(last<bitcast<f32>(0x7f7fffffu))){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}
 if(first>0.0){first=bitcast<f32>(bitcast<u32>(first)-1u);}
 last=bitcast<f32>(bitcast<u32>(last)+1u);
 var query: ray_query;
 var forceOpaque=allOpaque;
 let opaqueFlags=select(RAY_FLAG_FORCE_OPAQUE,RAY_FLAG_FORCE_OPAQUE|RAY_FLAG_TERMINATE_ON_FIRST_HIT,opaqueOccluderIsEnough);
 rayQueryInitialize(&query,tlas,RayDesc(select(0u,opaqueFlags,forceOpaque),ray.mask.x&0xffu,first,last,ray.origin,ray.direction));
 var steps=0u;
 loop {
  if(steps>=maxSteps){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}
  steps++;
  if(!rayQueryProceed(&query)){
   let committed=rayQueryGetCommittedIntersection(&query);
   if(forceOpaque && committed.kind==RAY_QUERY_INTERSECTION_TRIANGLE && (committed.t<ray.tMin || committed.t>ray.tMax)){
    // An outer auto-commit may hide an in-range surface. Every World BLAS is
    // non-opaque, so removing FORCE_OPAQUE restores filtered candidate callbacks.
    // Reuse the same query and shared Proceed budget; never accept the outer hit.
    forceOpaque=false;
    rayQueryInitialize(&query,tlas,RayDesc(0u,ray.mask.x&0xffu,first,last,ray.origin,ray.direction));
    continue;
   }
   break;
  }
  let candidate=rayQueryGetCandidateIntersection(&query);
  if(candidate.kind==RAY_QUERY_INTERSECTION_TRIANGLE && candidate.t>=ray.tMin && candidate.t<=ray.tMax && candidate.geometry_index==0u && worldRayQueryOpaque(candidate.instance_custom_data,candidate.primitive_index)){
   rayQueryConfirmIntersection(&query);
   if(opaqueOccluderIsEnough){rayQueryTerminate(&query);}
  }
 }
 let c=rayQueryGetCommittedIntersection(&query);
 result.state.z=steps;
 // A shadow needs existence, not the closest hit. A qualified opaque hit
 // already proves zero visibility, even if a nearer MASK candidate is unknown.
 if(!allOpaque && !(opaqueOccluderIsEnough && c.kind==RAY_QUERY_INTERSECTION_TRIANGLE)){
  // A second non-committing closed-prefix query prevents an opaque closest-hit
  // tie from hiding an unknown candidate. Both queries share the original budget.
  var prefix=ray.tMax;
  if(c.kind==RAY_QUERY_INTERSECTION_TRIANGLE){prefix=min(prefix,c.t);}
  var unresolved: ray_query;
  rayQueryInitialize(&unresolved,tlas,RayDesc(0u,ray.mask.x&0xffu,first,bitcast<f32>(bitcast<u32>(prefix)+1u),ray.origin,ray.direction));
  loop {
   if(steps>=maxSteps){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}
   steps++;
   if(!rayQueryProceed(&unresolved)){break;}
   let candidate=rayQueryGetCandidateIntersection(&unresolved);
   if(candidate.kind==RAY_QUERY_INTERSECTION_TRIANGLE && candidate.t>=ray.tMin && candidate.t<=prefix && (candidate.geometry_index!=0u || !worldRayQueryOpaque(candidate.instance_custom_data,candidate.primitive_index))){
    result.state.x=${GlobalSdfQueryStatus.missingField}u;
    result.metrics.x=candidate.t;
    return result;
   }
  }
 }
 if(c.kind!=RAY_QUERY_INTERSECTION_TRIANGLE){return result;}
 if(c.geometry_index!=0u || c.instance_custom_data==0u || c.instance_custom_data>=traversalInstances[0].z/${WORLD_ACCELERATION_TABLE_LAYOUT.rowWords}u){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}
 let row=traversalInstances[c.instance_custom_data];
 if(c.primitive_index>=(row.z>>${WORLD_ACCELERATION_TABLE_LAYOUT.modeBits}u)){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}
 let face=faceNormals[row.y+c.primitive_index];
 let local=face.xyz;
 let n=transpose(mat3x3f(c.world_to_object[0],c.world_to_object[1],c.world_to_object[2]))*local;
 result.state=vec4u(${GlobalSdfQueryStatus.hit}u,0u,steps,row.x);
 result.metrics=vec4f(c.t,0,0,1);
 result.position=vec4f(ray.origin+ray.direction*c.t,1);${
   hitMotion
     ? `
 let localHit = vec4f(c.world_to_object * result.position, 1.0);
 (*motion).displacement = worldRayQueryHitMotion(c.instance_custom_data, localHit, result.position.xyz);
 (*motion).instanceRow = c.instance_custom_data;`
     : ''
 }
 let normal=n/max(length(n),1e-20);
 // Exact coincident opposite windings cover both sides of the same plane.
 // A closest-hit tie must not turn that surface into an ordinary backface.
 result.normal=vec4f(select(normal,-normal,face.w!=0.0&&dot(ray.direction,normal)>0.0),0);
 return result;
}
${
  hitMotion
    ? `fn traceWorldWithHitMotion(ray: Ray, maxSteps: u32) -> WorldRayQueryHitMotion {
 var result: WorldRayQueryHitMotion;
 let hit = traceWorldRayQuery(ray, maxSteps, false, &result);
 result.hit = hit;
 return result;
}
`
    : `fn traceWorld(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 return traceWorldRayQuery(ray,maxSteps,false);
}
fn traceWorldVisibility(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 return traceWorldRayQuery(ray,maxSteps,true);
}
`
}fn worldHitCandidates(hit: Hit) -> Candidates {
 var out=Candidates(vec4u(0u,0u,hit.state.x,0u),vec4u(0xffffffffu));
 if(hit.state.x==${GlobalSdfQueryStatus.hit}u){out.state=vec4u(1u,0u,hit.state.x,1u);out.ids.x=hit.state.w;}
 return out;
}
`;

/** Displacement is qualified at a committed triangle with a submitted previous placement. */
const WORLD_RAY_QUERY_HIT_MOTION_WGSL = `
struct WorldRayQueryHitMotion {
 hit: Hit,
 displacement: vec4f,
 instanceRow: u32,
}
fn worldRayQueryHitMotion(row: u32, objectHit: vec4f, worldHit: vec3f) -> vec4f {
 let header = traversalInstances[0];
 let first = header.z / 4u + (header.w + 3u) / 4u;
 let base = first + (row - 1u) * ${WORLD_ACCELERATION_MOTION_ROW_WORDS / 4}u;
 if (base + 3u >= arrayLength(&traversalInstances)) { return vec4f(0); }
 let state = traversalInstances[base + 3u].x;
 if (state < 2u) { return vec4f(0, 0, 0, f32(state)); }
 let previousHit = vec3f(
   dot(bitcast<vec4f>(traversalInstances[base]), objectHit),
   dot(bitcast<vec4f>(traversalInstances[base + 1u]), objectHit),
   dot(bitcast<vec4f>(traversalInstances[base + 2u]), objectHit));
 return vec4f(worldHit - previousHit, 1);
}
`;

/** The traversal half of a world-trace module. It declares `Ray`, `Hit`,
 * `Candidates` and slots 0..4, and must lead the module (the Ray Query kind
 * starts with an `enable` directive). */
export function worldTraversalWgsl(
  traversal: WorldTraversal,
  preparedRoot = false,
  receiver = false,
  hinted = false,
  approximate?: MeshDfApproxPolicy,
): string {
  switch (traversal) {
    case 'global-sdf':
      if (approximate)
        return `${globalSdfTraversalWgsl(preparedRoot, receiver, hinted, approximate)}${worldSurfaceOriginWgsl(traversal)}`;
      return `${receiver ? globalSdfTraversalWgsl(false, true, hinted) : preparedRoot ? globalSdfTraversalWgsl(true) : GLOBAL_SDF_TRAVERSAL_WGSL}${worldSurfaceOriginWgsl(traversal)}`;
    case 'ray-query':
      return `${rayQueryTraversalWgsl(false)}${worldSurfaceOriginWgsl(traversal)}`;
  }
}

/** Closest hardware triangle and its submitted world displacement for Screen Probe motion. */
export function worldRayQueryMotionTraversalWgsl(): string {
  return `${rayQueryTraversalWgsl(true)}${worldSurfaceOriginWgsl('ray-query')}`;
}

/** Internal sample tags; backfaces are known zero but retain their own identity. */
export const WorldCardSampleStatus = { unlit: -1, unmapped: 0, mapped: 1, backface: 2 } as const;

/** Card radiance at a world hit: the first candidate with a mapped Card
 * returns its lit texels and w = 1, or known black with w = 2 when its actual
 * geometric normal proves a software-traced backface. Unmapped remains w = 0.
 * `pointSample` reads only
 * the nearest supported texel instead of the bilinear blend: a Card captures
 * one instance, so a bilinear footprint can straddle a thin occluder (a wall
 * meeting a floor) and blend a lit texel into a shadowed hit. Software
 * transport and the standalone Irradiance Field retain the point policy.
 * Hardware Screen Probe World and its far cache filter the same qualified
 * taps. While Card residency has
 * non-resident instances (`settings.z != 0`), a hit whose candidates own no
 * captured Card row returns w = -1 (unlit): consumers keep their history
 * instead of reading black. The kernel declares `cards`, `cardLit`, `settings`
 * (x = Card count, y = resolution, z = residency pending) and the Card atlas
 * textures. */
export const WORLD_CARD_RADIANCE_WGSL = `
${CARD_POINT_LOOKUP_WGSL}
// A Global SDF gradient blends nearby faces. Only an exact triangle normal
// can decide facing before the supported Card geometric sample is available.
fn worldHitBackface(hit: Hit, ray: Ray) -> bool {
 if((hit.state.y&0x80000000u)!=0u){return (hit.state.y&3u)==0u;}
 return WORLD_HIT_NORMAL_EXACT && dot(ray.direction,hit.normal.xyz)>0.0;
}
fn worldCardRadiance(hit: Hit, projectionMargin: f32, pointSample: bool, ray: Ray) -> vec4f {
 let candidates=worldHitCandidates(hit);
 if(candidates.state.y!=0u){return vec4f(0);}
 var admitted=0u;
 for(var k=0u;k<candidates.state.x;k++){
  if((hit.state.y&0xc0000000u)==0u && !worldCandidateOnRay(candidates.ids[k],ray)){continue;}
  admitted|=1u<<k;
  // Approximate DF geometry keeps its uncertainty at the Card projection seam;
  // it never borrows the exact-triangle facing or primitive qualification.
  let margin=select(projectionMargin,max(projectionMargin,hit.metrics.y),(hit.state.y&0x20000000u)!=0u);
  let lookup=lookupCardPoint(hit.position.xyz,hit.normal.xyz,candidates.ids[k],margin,hit.state.x,settings.x,settings.y);
  if(lookup.state.x!=${CardLookupStatus.mapped}u){continue;}
  var radiance=vec3f(0);var nearest=0u;
  for(var t=0u;t<4u;t++){
   if(lookup.texels[t]==0xffffffffu){continue;}
   if(lookup.weights[t]>lookup.weights[nearest]){nearest=t;}
  }
  if(!WORLD_HIT_NORMAL_EXACT && (hit.state.y&0x80000000u)==0u){
   let texel=lookup.texels[nearest];let width=textureDimensions(normal).x;
   let pixel=vec2i(i32(texel%width),i32(texel/width));
   let geometric=decodeCardNormal(textureLoad(normal,pixel,0).zw);
   if(dot(ray.direction,geometric)>0.0){return vec4f(0,0,0,${WorldCardSampleStatus.backface}.0);}
  }
  if(pointSample){
   let value=cardLit[lookup.texels[nearest]];
   if(!(value.w>0.0)){return vec4f(0,0,0,-1);}
   radiance=value.xyz;
  }else{
   for(var t=0u;t<4u;t++){
    if(lookup.texels[t]==0xffffffffu||!(lookup.weights[t]>0.0)){continue;}
    let value=cardLit[lookup.texels[t]];
    if(!(value.w>0.0)){return vec4f(0,0,0,-1);}
    radiance+=value.xyz*lookup.weights[t];
   }
  }
  return vec4f(radiance,1.0);
 }
 if(admitted==0u){return vec4f(0);}
 if(settings.z!=0u){
  let count=min(settings.x,arrayLength(&cards));
  for(var k=0u;k<candidates.state.x;k++){
   if((admitted&(1u<<k))==0u){continue;}
   var cursor=firstOwnerCard(candidates.ids[k],count);var previous=0u;
   while(cursor!=0u){
    let c=cursor-1u;if(c>=count||cursor<=previous){break;}previous=cursor;
    let card=cards[c];cursor=card.ids.w;if(card.ids.x!=candidates.ids[k]){break;}
    if(card.ids.y==1u){return vec4f(0);}
   }
  }
  return vec4f(0,0,0,-1);
 }
 return vec4f(0);
}
`;
