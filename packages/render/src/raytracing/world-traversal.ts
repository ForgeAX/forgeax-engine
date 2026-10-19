import { RAY_QUERY_WGSL_ENABLE } from '@forgeax/engine-rhi';
import { CARD_POINT_LOOKUP_WGSL, CardLookupStatus } from './card-lookup';
import { GLOBAL_CARD_CANDIDATES_WGSL } from './global-card-lookup';
import {
  GLOBAL_SDF_SAMPLE_WGSL,
  GLOBAL_SDF_TRACE_WGSL,
  GlobalSdfQueryStatus,
} from './global-sdf-query';
import { SDF_SAMPLE_WGSL } from './sdf-query';

/**
 * How world-trace kernels find the first surface along a ray. Both kinds
 * define the same WGSL seam, so a kernel composes one of them and never
 * branches on the backend:
 *
 * - `traceWorld(ray, maxSteps, minStepFactor) -> Hit` with the Global SDF
 *   `Hit` layout and `GlobalSdfQueryStatus` codes;
 * - `worldSurfaceOrigin(position, normal, fieldBias) -> vec3f`, a surface
 *   origin using field clearance or the shared exact-receiver precision policy;
 * - `worldHitCandidates(hit) -> Candidates`, the instances whose Cards may
 *   shade the hit.
 *
 * `'global-sdf'` marches the Global SDF and associates instances by distance
 * (approximate; thin walls can leak). `'ray-query'` traces the TLAS with
 * hardware Ray Query: a hit is an exact triangle whose instance is the only
 * candidate. An incomplete TLAS reports `missingField`; a complete TLAS
 * reports `miss` or `hit` (a ray starting inside geometry hits a backface).
 * Hit shading stays Card radiance for both.
 * `'ray-query'` requires `caps.rayQuery.supported` and a TLAS from
 * `createWorldAcceleration`; renderers compose `'global-sdf'` until they own one.
 */
export type WorldTraversal = 'global-sdf' | 'ray-query';

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

const GLOBAL_SDF_TRAVERSAL_WGSL = `
${SDF_SAMPLE_WGSL}
${GLOBAL_SDF_SAMPLE_WGSL}
@group(0) @binding(0) var<storage,read> voxels: array<Voxel>;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var<storage,read> instances: array<Instance>;
@group(0) @binding(3) var<storage,read> fields: array<u32>;
@group(0) @binding(4) var<storage,read> bounds: array<ObjectBounds>;
${GLOBAL_SDF_TRACE_WGSL}
${GLOBAL_CARD_CANDIDATES_WGSL}
fn traceWorld(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit { return traceGlobal(ray, maxSteps, minStepFactor); }
fn worldHitCandidates(hit: Hit) -> Candidates { return findCandidates(SdfHit(hit.state,hit.metrics,hit.position,hit.normal)); }
`;

/** Row 0 of `traversalInstances`: x = pending instances. Row `customIndex`
 * (starting at 1): x = scene instance id, y = first
 * `faceNormals` row of its geometry. `faceNormals` holds one object-space
 * unit normal per triangle in BLAS primitive order; w marks exact coincident
 * opposite windings (portable: Metal has no vertex-position fetch). */
const RAY_QUERY_TRAVERSAL_WGSL = `${RAY_QUERY_WGSL_ENABLE}
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct Hit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
struct Candidates { state: vec4u, ids: vec4u }
@group(0) @binding(0) var tlas: acceleration_structure;
@group(0) @binding(2) var<storage,read> traversalInstances: array<vec4u>;
@group(0) @binding(3) var<storage,read> faceNormals: array<vec4f>;
fn traceWorld(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 var result=Hit(vec4u(${GlobalSdfQueryStatus.miss}u,0u,0u,0xffffffffu),vec4f(ray.tMax,0,0,0),vec4f(ray.origin+ray.direction*ray.tMax,1),vec4f(0));
 if(ray.mask.x==0u){return result;}
 if(traversalInstances[0].x!=0u){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}
 var query: ray_query;
 rayQueryInitialize(&query,tlas,RayDesc(0u,ray.mask.x&0xffu,ray.tMin,ray.tMax,ray.origin,ray.direction));
 while(rayQueryProceed(&query)){}
 let c=rayQueryGetCommittedIntersection(&query);
 result.state.z=1u;
 if(c.kind!=RAY_QUERY_INTERSECTION_TRIANGLE){return result;}
 let row=traversalInstances[c.instance_custom_data];
 let face=faceNormals[row.y+c.primitive_index];
 let local=face.xyz;
 let n=transpose(mat3x3f(c.world_to_object[0],c.world_to_object[1],c.world_to_object[2]))*local;
 result.state=vec4u(${GlobalSdfQueryStatus.hit}u,0u,1u,row.x);
 result.metrics=vec4f(c.t,0,0,1);
 result.position=vec4f(ray.origin+ray.direction*c.t,1);
 let normal=n/max(length(n),1e-20);
 // Exact coincident opposite windings cover both sides of the same plane.
 // A closest-hit tie must not turn that surface into an ordinary backface.
 result.normal=vec4f(select(normal,-normal,face.w!=0.0&&dot(ray.direction,normal)>0.0),0);
 return result;
}
fn worldHitCandidates(hit: Hit) -> Candidates {
 var out=Candidates(vec4u(0u,0u,hit.state.x,0u),vec4u(0xffffffffu));
 if(hit.state.x==${GlobalSdfQueryStatus.hit}u){out.state=vec4u(1u,0u,hit.state.x,1u);out.ids.x=hit.state.w;}
 return out;
}
`;

/** The traversal half of a world-trace module. It declares `Ray`, `Hit`,
 * `Candidates` and slots 0..4, and must lead the module (the Ray Query kind
 * starts with an `enable` directive). */
export function worldTraversalWgsl(traversal: WorldTraversal): string {
  switch (traversal) {
    case 'global-sdf':
      return `${GLOBAL_SDF_TRAVERSAL_WGSL}
fn worldSurfaceOrigin(position: vec3f, normal: vec3f, fieldBias: f32) -> vec3f {
 return position + normal * fieldBias;
}
`;
    case 'ray-query':
      return `${RAY_QUERY_TRAVERSAL_WGSL}
// Match ray-raster-source/ray-path-tracer exact receiver precision. A field
// voxel clearance can skip a nearby triangle and change the first surface.
fn worldSurfaceOrigin(position: vec3f, normal: vec3f, fieldBias: f32) -> vec3f {
 let bias = max(1e-4, max(max(abs(position.x), abs(position.y)), abs(position.z)) * 1e-5);
 return position + normal * bias;
}
`;
  }
}

/** Card radiance at a world hit: the first candidate with a mapped Card
 * returns its lit texels and w = 1; otherwise zero. `pointSample` reads only
 * the nearest supported texel instead of the bilinear blend: a Card captures
 * one instance, so a bilinear footprint can straddle a thin occluder (a wall
 * meeting a floor) and blend a lit texel into a shadowed hit. Callers that
 * integrate many rays over time (Irradiance Field and Screen Probes) point-sample; a
 * directly viewed lookup keeps the filter. While Card residency has
 * non-resident instances (`settings.z != 0`), a hit whose candidates own no
 * captured Card row returns w = -1 (unlit): consumers keep their history
 * instead of reading black. The kernel declares `cards`, `cardLit`, `settings`
 * (x = Card count, y = resolution, z = residency pending) and the Card atlas
 * textures. */
export const WORLD_CARD_RADIANCE_WGSL = `
${CARD_POINT_LOOKUP_WGSL}
fn worldCardRadiance(hit: Hit, projectionMargin: f32, pointSample: bool) -> vec4f {
 let candidates=worldHitCandidates(hit);
 if(candidates.state.y!=0u){return vec4f(0);}
 for(var k=0u;k<candidates.state.x;k++){
  let lookup=lookupCardPoint(hit.position.xyz,hit.normal.xyz,candidates.ids[k],projectionMargin,hit.state.x,settings.x,settings.y);
  if(lookup.state.x!=${CardLookupStatus.mapped}u){continue;}
  var radiance=vec3f(0);var nearest=0u;
  for(var t=0u;t<4u;t++){
   if(lookup.texels[t]==0xffffffffu){continue;}
   radiance+=cardLit[lookup.texels[t]].xyz*lookup.weights[t];
   if(lookup.weights[t]>lookup.weights[nearest]){nearest=t;}
  }
  if(pointSample){radiance=cardLit[lookup.texels[nearest]].xyz;}
  return vec4f(radiance,1.0);
 }
 if(settings.z!=0u){
  for(var c=0u;c<settings.x;c++){
   let card=cards[c];if(card.ids.y!=1u){continue;}
   for(var k=0u;k<candidates.state.x;k++){if(candidates.ids[k]==card.ids.x){return vec4f(0);}}
  }
  return vec4f(0,0,0,-1);
 }
 return vec4f(0);
}
`;
