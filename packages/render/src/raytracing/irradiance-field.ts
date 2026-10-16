import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  Buffer,
  RhiComputePassEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
  TextureView,
  Tlas,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { CARD_POINT_LOOKUP_WGSL, CardLookupStatus } from './card-lookup';
import { GlobalSdfQueryStatus } from './global-sdf-query';
import {
  IRRADIANCE_FIELD_MIP_TEXELS,
  IRRADIANCE_FIELD_OCT,
  IRRADIANCE_FIELD_PROBE_STRIDE,
  IRRADIANCE_FIELD_TEXELS,
  type IrradianceFieldPlan,
} from './irradiance-field-plan';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import {
  WORLD_CARD_RADIANCE_WGSL,
  WORLD_TRAVERSAL_ROSTER,
  type WorldTraversal,
  type WorldTraversalInput,
  worldTraversalWgsl,
} from './world-traversal';

/** Probe ray record: radiance + clamped hit distance, direction + status. */
export const IRRADIANCE_FIELD_RAY_BYTES = 32;
/** Placed position, probe index and metadata-derived update count; WGSL stride. */
export const IRRADIANCE_FIELD_ORIGIN_BYTES = 32;
/** Card surface record: position + light mask, shading normal + validity, albedo, emission. */
export const IRRADIANCE_FIELD_SURFACE_BYTES = 64;
export const IRRADIANCE_FIELD_FRAME_BYTES = 112;
export const IRRADIANCE_FIELD_UNIFORM_BYTES = 256;
/** `IrradianceField.levels.z`: pending native instances, copied from the TLAS roster. */
export const IRRADIANCE_FIELD_PENDING_OFFSET = 56;
export const IRRADIANCE_FIELD_LIGHTS_BYTES = 32 * 64;
/** `unlit` is a hit on an instance whose Cards are not resident: it shapes depth
 * moments but leaves radiance history untouched. */
export const IrradianceFieldRayStatus = {
  miss: 0,
  hit: 1,
  backface: 2,
  skip: 3,
  unlit: 4,
} as const;
/** Probe classification (`meta.y`); only `active` probes contribute to a receiver.
 * `inside`: more than a quarter of the traced rays hit backfaces after relocation.
 * `relocated`: the offset moved this update, so the history restarts next update. */
export const IrradianceFieldProbeState = {
  untraced: 0,
  active: 1,
  inside: 2,
  relocated: 3,
} as const;
/** Relocation bounds in probe cells: an inside probe steps `clearance` past the
 * surface it escapes through, offsets stay within `limit` per axis of the lattice point, and a
 * move longer than `restart` discards the history traced at the old position. */
export const IRRADIANCE_FIELD_RELOCATION = { clearance: 0.25, limit: 0.45, restart: 0.1 } as const;

/** Per-frame schedule. The probe list (see `probe-clipmap.ts`) names this
 * frame's `probeBudget` probes; it advances only after a physical submit. */
export interface IrradianceFieldFrame {
  readonly probeBudget: number;
  readonly raysPerProbe: number;
  readonly frameIndex: number;
  readonly tileOffset: number;
  readonly tileBudget: number;
  readonly tileCount: number;
  readonly lightCount: number;
  readonly atlasWidth: number;
  readonly cardResolution: number;
  readonly radiosity: boolean;
  readonly environment: readonly [number, number, number];
  readonly hysteresis: number;
  readonly maxDistance: number;
  readonly surfaceBias: number;
  readonly depthClamp: number;
  readonly cardMargin: number;
  readonly gather: readonly [number, number, number, number];
  /** Global SDF query settings: u32 max steps and f32 min step factor bytes. */
  readonly query: Uint8Array;
  /** Lite reflections trace limit and fade (query.zw); zero when reflections are off. */
  readonly reflections: readonly [number, number];
}

export function packIrradianceFieldFrame(frame: IrradianceFieldFrame): Uint8Array {
  const bytes = new Uint8Array(IRRADIANCE_FIELD_FRAME_BYTES);
  const u = new Uint32Array(bytes.buffer);
  const f = new Float32Array(bytes.buffer);
  u.set([0, frame.probeBudget, frame.raysPerProbe, frame.frameIndex >>> 0], 0);
  u.set([frame.tileOffset, frame.tileBudget, frame.tileCount, frame.lightCount], 4);
  u.set([frame.atlasWidth, frame.cardResolution, frame.tileCount, frame.radiosity ? 1 : 0], 8);
  f.set([...frame.environment, frame.hysteresis], 12);
  f.set([frame.maxDistance, frame.surfaceBias, frame.depthClamp, frame.cardMargin], 16);
  u.set(frame.gather, 20);
  bytes.set(frame.query.subarray(0, 8), 96);
  f.set(frame.reflections, 26);
  return bytes;
}

/** Cross-level blend band, in cells of the finer clipmap level. */
export const IRRADIANCE_FIELD_BLEND_CELLS = 2;

/** One clipmap level's uniform row: window min cell and traced box `[min, max)`. */
export interface IrradianceFieldLevelWindow {
  readonly window: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** The `forgeax_ray::irradiance_field_sample` uniform: lattice, biases and the
 * per-level clipmap windows (rewritten whenever a window scrolls or a slab lands). */
export function packIrradianceFieldUniform(
  plan: Pick<IrradianceFieldPlan, 'origin' | 'spacing' | 'dimensions' | 'probeCount' | 'levels'>,
  levels: readonly IrradianceFieldLevelWindow[],
): Uint8Array {
  const bytes = new Uint8Array(IRRADIANCE_FIELD_UNIFORM_BYTES);
  const u = new Uint32Array(bytes.buffer);
  const i = new Int32Array(bytes.buffer);
  const f = new Float32Array(bytes.buffer);
  const [dx, dy, dz] = plan.dimensions;
  f.set([...plan.origin, plan.spacing], 0);
  u.set([dx, dy, dz, plan.probeCount], 4);
  const band = plan.levels > 1 ? IRRADIANCE_FIELD_BLEND_CELLS : 0;
  f.set([0.25 * plan.spacing, 0.1 * plan.spacing, irradianceFieldDepthClamp(plan), band], 8);
  u.set([plan.levels, dx * dy * dz, 0, 0], 12);
  levels.forEach((level, l) => {
    i.set(level.window, 16 + 4 * l);
    i.set(level.min, 32 + 4 * l);
    i.set(level.max, 48 + 4 * l);
  });
  return bytes;
}

/** Enclose every biased-cell corner plus its per-axis relocation. Otherwise
 * clamped open-space moments falsely occlude a valid relocated probe. */
export function irradianceFieldDepthClamp(plan: Pick<IrradianceFieldPlan, 'spacing'>): number {
  return Math.ceil(Math.sqrt(3) * (1 + IRRADIANCE_FIELD_RELOCATION.limit)) * plan.spacing;
}

const SHARED_WGSL = `
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct Frame { schedule: vec4u, cards: vec4u, atlas: vec4u, environment: vec4f, trace: vec4f, gather: vec4u, query: vec4u }
struct Field { originSpacing: vec4f, dimensionsCount: vec4u, bias: vec4f, levels: vec4u, window: array<vec4i,4>, validMin: array<vec4i,4>, validMax: array<vec4i,4> }
struct CardSurface { position: vec3f, mask: u32, normal: vec3f, valid: u32, albedo: vec4f, emission: vec4f }
struct ProbeRay { radianceDistance: vec4f, directionStatus: vec4f }
struct ProbeOrigin { position: vec3f, probe: u32, updates: u32 }
fn linearId(gid: vec3u, groups: vec3u) -> u32 { return gid.x + gid.y * groups.x * 64u; }
fn probeScale(probe: u32) -> f32 { return f32(1u<<(probe/probeField.levels.y)); }
// Toroidal decode: storage slot p of level l holds the window cell congruent to p.
fn probePosition(probe: u32) -> vec3f {
 let level=probe/probeField.levels.y;let local=probe%probeField.levels.y;
 let d=probeField.dimensionsCount.xyz;let di=vec3i(d);
 let p=vec3i(vec3u(local%d.x,(local/d.x)%d.y,local/(d.x*d.y)));
 let w=probeField.window[level].xyz;
 let c=w+(((p-w)%di)+di)%di;
 return probeField.originSpacing.xyz+vec3f(c)*(probeField.originSpacing.w*probeScale(probe));
}
const PROBE_FRESH=0x80000000u;const PROBE_FAST=0x40000000u;const PROBE_INDEX=0x3fffffffu;
// meta.zw: relocation offset from the lattice point, f16 xyz.
fn probeOffset(state: vec4u) -> vec3f { return vec3f(unpack2x16float(state.z),unpack2x16float(state.w).x); }
`;

const WORLD_TRACE_SHARED_WGSL = SHARED_WGSL.replace(
  'struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }',
  '',
);

/** Card texel -> world surface and analytic light visibility through the world
 * traversal: shadow rays find any surface before the light (Ray Query reports a
 * backface start as a hit, the Global SDF as `negativeStart`). */
const irradianceFieldCardSurfaceWgsl = (
  traversal: WorldTraversal,
) => `${worldTraversalWgsl(traversal)}
struct Light { positionKind: vec4f, radiance: vec4f, directionRange: vec4f, cone: vec4f }
@group(0) @binding(5) var<storage,read> cards: array<Card>;
@group(0) @binding(6) var<uniform> lights: array<Light,32>;
@group(0) @binding(7) var<uniform> frame: Frame;
@group(0) @binding(8) var<uniform> settings: vec4u;
@group(0) @binding(9) var<storage,read_write> surfaces: array<CardSurface>;
@group(0) @binding(10) var albedo: texture_2d<f32>;
@group(0) @binding(11) var normal: texture_2d<f32>;
@group(0) @binding(12) var emission: texture_2d<f32>;
@group(0) @binding(13) var f0: texture_2d<f32>;
@group(0) @binding(14) var cardDepth: texture_depth_2d;
${WORLD_TRACE_SHARED_WGSL.replace(/fn probeScale[\s\S]*$/, '')}
${CARD_POINT_LOOKUP_WGSL}
@compute @workgroup_size(64) fn cardSurface(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let res=frame.atlas.y;let i=linearId(gid,groups);
 if(i>=frame.cards.y*res*res){return;}
 let tile=(frame.cards.x+i/(res*res))%frame.cards.z;let localTexel=i%(res*res);
 let tilesPerRow=frame.atlas.x/res;
 let pixel=vec2u((tile%tilesPerRow)*res+localTexel%res,(tile/tilesPerRow)*res+localTexel/res);
 let texel=pixel.y*frame.atlas.x+pixel.x;
 var out=CardSurface(vec3f(0),0u,vec3f(0),0u,vec4f(0),vec4f(0));
 let card=cards[tile];let material=textureLoad(f0,vec2i(pixel),0);
 if(tile>=settings.x||card.ids.y==0u||(u32(material.w)&3u)!=1u){surfaces[texel]=out;return;}
 let uv=(vec2f(f32(localTexel%res),f32(localTexel/res))+vec2f(0.5))/f32(res);
 let depth=textureLoad(cardDepth,vec2i(pixel),0);
 let position=card.origin.xyz+card.u.xyz*(uv.x*card.u.w)+card.v.xyz*(uv.y*card.v.w)-card.n.xyz*(depth*card.n.w);
 let frameNormal=textureLoad(normal,vec2i(pixel),0);
 let shading=decodeCardNormal(frameNormal.xy);let geometric=decodeCardNormal(frameNormal.zw);
 let origin=worldSurfaceOrigin(position,geometric,frame.trace.y);let bias=length(origin-position);var mask=0u;
 for(var l=0u;l<frame.cards.w;l++){
  let light=lights[l];let kind=u32(light.positionKind.w);if(kind==0u){continue;}
  var incoming=normalize(-light.directionRange.xyz);var tMax=frame.trace.x;
  if(kind>=2u){let delta=light.positionKind.xyz-position;let d=length(delta);incoming=delta/max(d,1e-8);tMax=d-bias;}
  if(dot(geometric,incoming)<=0.0||dot(shading,incoming)<=0.0){continue;}
  if(tMax<=0.0){mask|=1u<<l;continue;}
  let hit=traceWorld(Ray(origin,0.0,incoming,tMax,vec4u(1u,0u,0u,0u)),frame.query.x,bitcast<f32>(frame.query.y));
  if(hit.state.x!=${GlobalSdfQueryStatus.hit}u&&hit.state.x!=${GlobalSdfQueryStatus.negativeStart}u){mask|=1u<<l;}
 }
 out=CardSurface(position,mask,shading,1u,textureLoad(albedo,vec2i(pixel),0),textureLoad(emission,vec2i(pixel),0));
 surfaces[texel]=out;
}
`;

/** World traversal (slots 0..4) + Card lookup bindings shared by every
 * world-trace kernel; bindings 7 and 8 are the kernel's own ray records. */
const worldTraceWgsl = (
  traversal: WorldTraversal,
  records: string,
  shared: string,
) => `${worldTraversalWgsl(traversal)}
@group(0) @binding(5) var<storage,read> cards: array<Card>;
@group(0) @binding(6) var<storage,read> cardLit: array<vec4f>;
${records}
@group(0) @binding(9) var<uniform> frame: Frame;
@group(0) @binding(10) var<uniform> settings: vec4u;
@group(0) @binding(11) var albedo: texture_2d<f32>;
@group(0) @binding(12) var normal: texture_2d<f32>;
@group(0) @binding(13) var emission: texture_2d<f32>;
@group(0) @binding(14) var f0: texture_2d<f32>;
@group(0) @binding(15) var cardDepth: texture_depth_2d;
${shared}
${WORLD_CARD_RADIANCE_WGSL}
`;

/** Displacement that carries an origin inside geometry to its surface. Only the
 * Global SDF knows it (distance x gradient); a Ray Query backface start is an
 * ordinary backface hit with a real distance and direction instead.
 * `probeSurface` is the near-surface frame (normal, lift to one SDF voxel) of an
 * open-space origin closer than one voxel; Ray Query has no such blind band. */
const PROBE_ESCAPE_WGSL: Record<WorldTraversal, string> = {
  'global-sdf': `fn probeEscape(p: vec3f) -> vec3f {
 let h=grid.originSpacing.w*0.5;let center=sampleGlobal(p);
 var gradient=vec3f(0);
 for(var a=0u;a<3u;a++){
  var offset=vec3f(0);offset[a]=h;
  let positive=sampleGlobal(p+offset);let negative=sampleGlobal(p-offset);
  if(center.status!=1u||positive.status!=1u||negative.status!=1u){return vec3f(0);}
  gradient[a]=positive.distance-negative.distance;
 }
 let g=length(gradient);
 return select(vec3f(0),gradient/g*max(-center.distance,0.0),g>1e-12);
}
fn probeVoxel() -> f32 { return grid.originSpacing.w; }
fn probeSurface(p: vec3f) -> vec4f {
 let s=grid.originSpacing.w;let h=0.5*s;let center=sampleGlobal(p);
 if(center.status!=1u||center.distance<0.0||center.distance>=s){return vec4f(0);}
 var gradient=vec3f(0);
 for(var a=0u;a<3u;a++){
  var offset=vec3f(0);offset[a]=h;
  let positive=sampleGlobal(p+offset);let negative=sampleGlobal(p-offset);
  if(positive.status!=1u||negative.status!=1u){return vec4f(0);}
  gradient[a]=positive.distance-negative.distance;
 }
 let g=length(gradient);
 return select(vec4f(0),vec4f(gradient/g,s-center.distance),g>1e-12);
}`,
  'ray-query':
    'fn probeEscape(p: vec3f) -> vec3f { return vec3f(0); }\nfn probeSurface(p: vec3f) -> vec4f { return vec4f(0); }\nfn probeVoxel() -> f32 { return 0.0; }',
};

/** `placeProbes` expands the CPU probe list into trace origins (relocated
 * position bits + list entry), so the trace stage stays within the default
 * eight storage buffers per stage. A fresh slot's stored offset belongs to the
 * clipmap cell it held before, so it traces from the lattice point. */
const IRRADIANCE_FIELD_PLACE_WGSL = `
@group(0) @binding(0) var<storage,read> probeList: array<u32>;
@group(0) @binding(1) var<storage,read> probeMeta: array<vec4u>;
@group(0) @binding(2) var<uniform> probeField: Field;
@group(0) @binding(3) var<uniform> frame: Frame;
@group(0) @binding(4) var<storage,read_write> probeOrigins: array<ProbeOrigin>;
${SHARED_WGSL}
@compute @workgroup_size(64) fn placeProbes(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let i=linearId(gid,groups);
 if(i>=frame.schedule.y){return;}
 let entry=probeList[i];let probe=entry&PROBE_INDEX;
 let origin=probePosition(probe)+select(probeOffset(probeMeta[probe]),vec3f(0),(entry&PROBE_FRESH)!=0u);
 let updates=select(probeMeta[probe].x,0u,(entry&PROBE_FRESH)!=0u);
 probeOrigins[i]=ProbeOrigin(origin,probe,updates);
}
`;

/** Probe ray emission from the relocated probe position, world trace and Card
 * radiance lookup. A backface record keeps zero radiance in the splat; its xyz
 * carries the Global SDF escape displacement of a negative start instead. */
const irradianceFieldTraceWgsl = (traversal: WorldTraversal) => `${worldTraceWgsl(
  traversal,
  `@group(0) @binding(7) var<storage,read_write> probeRays: array<ProbeRay>;
@group(0) @binding(8) var<uniform> probeField: Field;
@group(0) @binding(16) var<storage,read> probeOrigins: array<ProbeOrigin>;`,
  WORLD_TRACE_SHARED_WGSL,
)}
${PROBE_ESCAPE_WGSL[traversal]}
fn hash(x: u32) -> u32 { var v=x*747796405u+2891336453u; v=((v>>((v>>28u)+4u))^v)*277803737u; return (v>>22u)^v; }
fn radicalInverse(index: u32, base: u32) -> f32 {
 var digits=index;var value=0.0;var place=1.0/f32(base);
 loop {if(digits==0u){break;}value+=f32(digits%base)*place;digits/=base;place/=f32(base);}
 return min(value,0.99999994);
}
fn rotation(probe: u32) -> mat3x3f {
 let sample=vec3f(f32(hash(probe)>>8u),f32(hash(probe^0x9e3779b9u)>>8u),f32(hash(probe^0x85ebca6bu)>>8u))/16777216.0;
 let a=sample.x*6.28318530718;let b=sample.y*6.28318530718;let c=sample.z;
 let r=mat3x3f(vec3f(cos(a),sin(a),0),vec3f(-sin(a),cos(a),0),vec3f(0,0,1));
 let v=vec3f(cos(b)*sqrt(c),sin(b)*sqrt(c),sqrt(1.0-c));
 let h=mat3x3f(vec3f(1,0,0)-2.0*v*v.x,vec3f(0,1,0)-2.0*v*v.y,vec3f(0,0,1)-2.0*v*v.z);
 return (h*r)*-1.0;
}
fn probeDirection(probe: u32, updates: u32, ray: u32, rays: u32) -> vec3f {
 // Longitude/height rectangles have equal solid angle. Variable band counts
 // retain exactly rays equal-area strata for every accepted integer budget.
 let bands=max(1u,u32(sqrt(f32(rays)*0.5)));let count=rays/bands;let extra=rays%bands;
 var first=0u;var columns=count;
 for(var band=0u;band<bands;band++){
  columns=count+u32(band<extra);if(ray<first+columns){break;}first+=columns;
 }
 let seed=hash(probe^hash(ray));
 let phase=vec2f(f32(seed>>8u),f32(hash(seed^0x9e3779b9u)>>8u))/16777216.0;
 let jitter=fract(vec2f(radicalInverse(updates,2u),radicalInverse(updates,3u))+phase);
 let z=1.0-2.0*(f32(first)+jitter.x*f32(columns))/f32(rays);
 let phi=6.28318530718*(f32(ray-first)+jitter.y)/f32(columns);
 let radius=sqrt(max(0.0,1.0-z*z));
 return normalize(rotation(probe)*vec3f(radius*cos(phi),radius*sin(phi),z));
}
@compute @workgroup_size(64) fn traceProbes(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let rays=frame.schedule.z;let i=linearId(gid,groups);
 if(i>=frame.schedule.y*rays){return;}
 let placed=probeOrigins[i/rays];let probe=placed.probe;
 // Stable probe identity decorrelates neighbours without tying samples to view cadence.
 let direction=probeDirection(probe,placed.updates,i%rays,rays);
 let origin=placed.position;
 let clampDistance=frame.trace.z*probeScale(probe);
 var hit=traceWorld(Ray(origin,0.0,direction,frame.trace.x,vec4u(1u,0u,0u,0u)),frame.query.x,bitcast<f32>(frame.query.y));
 // A start closer than one SDF voxel steps through sub-voxel walls (the trace's
 // self-hit expansion shrinks with the start distance): a ray into the nearby
 // surface that runs past it is retraced from one voxel off that surface.
 let surface=probeSurface(origin);let cosine=dot(surface.xyz,direction);var liftAlong=0.0;
 let voxel=probeVoxel();let expected=(voxel-surface.w)/max(-cosine,1e-4)+voxel;
 if(cosine<0.0&&surface.w>0.0&&(hit.state.x!=${GlobalSdfQueryStatus.hit}u||hit.metrics.x>expected)){
  liftAlong=surface.w*cosine;
  hit=traceWorld(Ray(origin+surface.xyz*surface.w,0.0,direction,frame.trace.x,vec4u(1u,0u,0u,0u)),frame.query.x,bitcast<f32>(frame.query.y));
 }
 var out=ProbeRay(vec4f(0,0,0,clampDistance),vec4f(direction,${IrradianceFieldRayStatus.skip}.0));
 let status=hit.state.x;
 if(status==${GlobalSdfQueryStatus.miss}u||status==${GlobalSdfQueryStatus.outsideRegion}u){
  out.radianceDistance=vec4f(frame.environment.xyz,clampDistance);out.directionStatus.w=${IrradianceFieldRayStatus.miss}.0;
 } else if(status==${GlobalSdfQueryStatus.negativeStart}u){
  out.radianceDistance=vec4f(probeEscape(origin),0.0);out.directionStatus.w=${IrradianceFieldRayStatus.backface}.0;
 } else if(status==${GlobalSdfQueryStatus.hit}u&&dot(direction,hit.normal.xyz)>0.0){
  out.radianceDistance=vec4f(0,0,0,clamp(hit.metrics.x+liftAlong,0.0,clampDistance));out.directionStatus.w=${IrradianceFieldRayStatus.backface}.0;
 } else if(status==${GlobalSdfQueryStatus.hit}u){
   let card=worldCardRadiance(hit,frame.trace.w,true);
   out.radianceDistance=vec4f(max(card.xyz,vec3f(0)),clamp(hit.metrics.x+liftAlong,0.0,clampDistance));
   out.directionStatus.w=select(${IrradianceFieldRayStatus.hit}.0,${IrradianceFieldRayStatus.unlit}.0,card.w<0.0);
 }
 probeRays[i]=out;
}
`;

/** Per pixel reflection ray: biased origin + trace weight, direction + interval,
 * radiance-cache fallback for a miss + traced hit distance. Written by
 * `generateFieldReflections`; `traceReflections` fills the hit distance. */
export const IRRADIANCE_FIELD_REFLECTION_RAY_BYTES = 48;
/** Denoiser history per pixel: radiance + frames, normal + roughness, position + valid. */
export const IRRADIANCE_FIELD_REFLECTION_HISTORY_BYTES = 48;

/** Lite reflections for the field lanes: rays with a positive trace weight march
 * the world traversal and read lit Card radiance. Misses and region exits read the
 * environment exactly as probe rays do; backfaces, negative starts, exhausted
 * step budgets and unmapped hits keep the radiance-cache fallback. The hit
 * distance returns in `fallback.w` for the denoiser's reflection reprojection:
 * positive for a surface hit, -1 for an infinitely distant miss, 0 otherwise. */
const irradianceFieldReflectionWgsl = (traversal: WorldTraversal) => `${worldTraceWgsl(
  traversal,
  `struct ReflectionRay { originWeight: vec4f, directionDistance: vec4f, fallback: vec4f }
@group(0) @binding(7) var<storage,read_write> reflectionRays: array<ReflectionRay>;
@group(0) @binding(8) var<storage,read_write> reflectionSignal: array<vec4f>;`,
  WORLD_TRACE_SHARED_WGSL.replace(/fn probeScale[\s\S]*$/, ''),
)}
@compute @workgroup_size(64) fn traceReflections(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let i=linearId(gid,groups);
 if(i>=arrayLength(&reflectionSignal)||i>=arrayLength(&reflectionRays)){return;}
 let ray=reflectionRays[i];let weight=ray.originWeight.w;
 if(!(weight>0.0)){return;}
 var radiance=ray.fallback.xyz;
 let direction=ray.directionDistance.xyz;
 let hit=traceWorld(Ray(ray.originWeight.xyz,0.0,direction,ray.directionDistance.w,vec4u(1u,0u,0u,0u)),frame.query.x,bitcast<f32>(frame.query.y));
 let status=hit.state.x;
 var distance=0.0;
 if(status==${GlobalSdfQueryStatus.miss}u||status==${GlobalSdfQueryStatus.outsideRegion}u){
  radiance=frame.environment.xyz;distance=-1.0;
 } else if(status==${GlobalSdfQueryStatus.hit}u){
  distance=max(hit.metrics.x,1e-4);
  if(dot(direction,hit.normal.xyz)<=0.0){
   let card=worldCardRadiance(hit,frame.trace.w,false);
   if(card.w==1.0){radiance=card.xyz;}
  }
 }
 reflectionRays[i].fallback.w=distance;
 let signal=reflectionSignal[i];
 reflectionSignal[i]=vec4f(signal.xyz+radiance*weight,signal.w);
}
`;

/** Coverage record of one diagnostic ray, 96 bytes:
 * state (Global SDF status, candidate flags, candidates seen, Card lookup status),
 * detail (Card index, instance id, march steps, Cards owned by the candidates),
 * metrics (t, expansion, first sampled distance, coverage),
 * normal (SDF normal, dot(direction, normal)), Card albedo/roughness, and
 * lit Card radiance (w = 1 when mapped). */
export const IRRADIANCE_FIELD_COVERAGE_BYTES = 96;

/** Diagnostic world-trace over caller rays: the exact Global SDF march, Card
 * candidate search and lookup the probe and reflection kernels consume, with
 * every intermediate outcome kept instead of folded into radiance. Bindings
 * 0-6 and 9-15 are the trace kernels'; 7 holds 48-byte rays, 8 the records. */
export const IRRADIANCE_FIELD_COVERAGE_WGSL = `
${worldTraceWgsl(
  'global-sdf',
  `struct Coverage { state: vec4u, detail: vec4u, metrics: vec4f, normal: vec4f, albedoRoughness: vec4f, radiance: vec4f }
@group(0) @binding(7) var<storage,read> coverageRays: array<Ray>;
@group(0) @binding(8) var<storage,read_write> coverage: array<Coverage>;`,
  WORLD_TRACE_SHARED_WGSL.replace(/fn probeScale[\s\S]*$/, ''),
)}
struct WorldCard { candidates: Candidates, lookup: Lookup, radiance: vec4f }
// worldCardRadiance with the candidates and the most specific failed lookup kept,
// so diagnostics classify exactly what the lighting kernels skip.
fn worldCard(hit: Hit, projectionMargin: f32) -> WorldCard {
 var out=WorldCard(worldHitCandidates(hit),Lookup(vec4u(${CardLookupStatus.notSurface}u,hit.state.x,0xffffffffu,0xffffffffu),vec4f(0),vec4f(0),vec4f(0),vec4f(0),vec4u(0xffffffffu),vec4f(0)),vec4f(0));
 if(out.candidates.state.y!=0u){return out;}
 for(var k=0u;k<out.candidates.state.x;k++){
  let lookup=lookupCardPoint(hit.position.xyz,hit.normal.xyz,out.candidates.ids[k],projectionMargin,hit.state.x,settings.x,settings.y);
  if(lookup.state.x!=${CardLookupStatus.mapped}u){
   if(k==0u||lookup.state.x==${CardLookupStatus.stale}u){out.lookup=lookup;}
   continue;
  }
  out.lookup=lookup;out.radiance=worldCardRadiance(hit,projectionMargin,false);
  return out;
 }
 return out;
}
@compute @workgroup_size(64) fn classifyRays(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let i=linearId(gid,groups);
 if(i>=arrayLength(&coverage)||i>=arrayLength(&coverageRays)){return;}
 let ray=coverageRays[i];
 let hit=traceWorld(ray,frame.query.x,bitcast<f32>(frame.query.y));
 let status=hit.state.x;
 var out=Coverage(vec4u(status,0u,0u,${CardLookupStatus.notSurface}u),vec4u(0xffffffffu,0xffffffffu,hit.state.z,0u),hit.metrics,vec4f(hit.normal.xyz,dot(ray.direction,hit.normal.xyz)),vec4f(0),vec4f(0));
 if(status==${GlobalSdfQueryStatus.hit}u){
  let card=worldCard(hit,frame.trace.w);
  out.state.y=card.candidates.state.y;out.state.z=card.candidates.state.w;out.state.w=card.lookup.state.x;
  out.detail.x=card.lookup.state.z;
  out.detail.y=select(card.candidates.ids.x,card.lookup.state.w,card.lookup.state.w!=0xffffffffu);
  var owned=0u;
  for(var c=0u;c<settings.x;c++){
   let id=cards[c].ids.x;
   for(var k=0u;k<card.candidates.state.x;k++){if(card.candidates.ids[k]==id){owned++;break;}}
  }
  out.detail.w=owned;out.albedoRoughness=card.lookup.albedoRoughness;out.radiance=card.radiance;
 }
 coverage[i]=out;
}
`;

/** Unit direction and relative solid angle (1 / |v|^3 on the octahedron) of each 8x8 texel. */
const OCT_LOBES = Array.from({ length: IRRADIANCE_FIELD_TEXELS }, (_, texel) => {
  const x = (((texel % IRRADIANCE_FIELD_OCT) + 0.5) / IRRADIANCE_FIELD_OCT) * 2 - 1;
  const y = ((Math.floor(texel / IRRADIANCE_FIELD_OCT) + 0.5) / IRRADIANCE_FIELD_OCT) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const fold = (a: number, b: number) => (z < 0 ? (1 - Math.abs(b)) * (a >= 0 ? 1 : -1) : a);
  const v = [fold(x, y), fold(y, x), z] as const;
  const length = Math.hypot(...v);
  return `vec4f(${v.map((c) => (c / length).toFixed(7)).join(',')},${(1 / length ** 3).toFixed(7)})`;
}).join(',');
/** Threads per probe in `updateProbes` and `deriveProbes`. */
const PROBE_THREADS = 8;
/** Octahedral texels each `updateProbes` / `deriveProbes` thread owns. */
const THREAD_TEXELS = IRRADIANCE_FIELD_TEXELS / PROBE_THREADS;
const threadTexels = (line: (k: number) => string) =>
  Array.from({ length: THREAD_TEXELS }, (_, k) => line(k)).join('\n');

/** One 8-thread workgroup integrates one probe: rays splat into the 8x8
 * radiance level (the hysteresis authority) and the depth moments with the
 * same cos^16 kernel. Each thread owns 8 texels, so one ray load feeds 8
 * texels. Skipped and backface rays carry zero radiance, so the ray loop is
 * branch-free. `deriveProbes` re-derives the other two levels. */
export const IRRADIANCE_FIELD_UPDATE_WGSL = `
@group(0) @binding(0) var<storage,read> probeRays: array<ProbeRay>;
@group(0) @binding(1) var<storage,read_write> irradiance: array<vec4f>;
@group(0) @binding(2) var<storage,read_write> moments: array<vec2f>;
@group(0) @binding(3) var<storage,read_write> probeMeta: array<vec4u>;
@group(0) @binding(4) var<uniform> probeField: Field;
@group(0) @binding(5) var<uniform> frame: Frame;
@group(0) @binding(6) var<storage,read> probeList: array<u32>;
${SHARED_WGSL}
fn octSurface(texel: u32) -> vec3f {
 let p=(vec2f(f32(texel%${IRRADIANCE_FIELD_OCT}u),f32(texel/${IRRADIANCE_FIELD_OCT}u))+vec2f(0.5))/${IRRADIANCE_FIELD_OCT}.0*2.0-vec2f(1.0);
 var n=vec3f(p,1.0-abs(p.x)-abs(p.y));
 if(n.z<0.0){n=vec3f((vec2f(1)-abs(n.yx))*select(vec2f(-1),vec2f(1),n.xy>=vec2f(0)),n.z);}
 return n;
}
fn storeTexel(probe: u32, texel: u32, radiance: vec3f, depth: vec2f, weight: f32, depthWeight: f32, isFirst: bool, h: f32) {
 let level0=probe*${IRRADIANCE_FIELD_PROBE_STRIDE}u+${IRRADIANCE_FIELD_TEXELS}u+texel;
 let index=probe*${IRRADIANCE_FIELD_TEXELS}u+texel;
 // A recycled block must not leak its previous radiance into the derivation.
 if(weight>0.0){
  let stored=select(irradiance[level0],vec4f(0),isFirst);
  let fresh=radiance/weight;
  irradiance[level0]=vec4f(select(mix(fresh,stored.xyz,h),fresh,stored.w==0.0),1.0);
 } else if(isFirst){irradiance[level0]=vec4f(0);}
 if(depthWeight>0.0){
  let freshDepth=depth/depthWeight;
  moments[index]=select(mix(freshDepth,moments[index],h),freshDepth,isFirst);
 } else if(isFirst){moments[index]=vec2f(0);}
}
var<workgroup> previous: vec4u;
@compute @workgroup_size(${PROBE_THREADS}) fn updateProbes(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lane: u32, @builtin(num_workgroups) groups: vec3u) {
 let slot=wid.x+wid.y*groups.x;
 if(slot>=frame.schedule.y){return;}
 let entry=probeList[slot];let probe=entry&PROBE_INDEX;
 // A fresh entry is a newly exposed clipmap cell: its slot's history belongs to
 // another world cell, so it restarts exactly like a never-updated probe.
 let restart=(entry&PROBE_FRESH)!=0u;
 if(lane==0u){previous=probeMeta[probe];}
 let old=workgroupUniformLoad(&previous);
 let rays=frame.schedule.z;let depthClamp=probeField.bias.z*probeScale(probe);
 var backfaces=0u;var traced=0u;
  // Relocation evidence: the closest backface beyond the origin and the Global
  // SDF escape of a negative start.
  var back=depthClamp;var backDirection=vec3f(0);var escape=vec3f(0);
${threadTexels((k) => ` let direction${k}=normalize(octSurface(lane+${k * PROBE_THREADS}u));var radiance${k}=vec3f(0);var depth${k}=vec2f(0);var weight${k}=0.0;var depthWeight${k}=0.0;`)}
 for(var r=0u;r<rays;r++){
  let ray=probeRays[slot*rays+r];let status=u32(ray.directionStatus.w);
  traced+=u32(status!=${IrradianceFieldRayStatus.skip}u);
  let isBack=status==${IrradianceFieldRayStatus.backface}u;
  backfaces+=u32(isBack);
  // Unlit hits (non-resident Cards) shape depth only; radiance keeps its history.
  let lit=select(0.0,1.0,status<${IrradianceFieldRayStatus.backface}u);
  let live=status<${IrradianceFieldRayStatus.backface}u||status==${IrradianceFieldRayStatus.unlit}u;
  let d=min(ray.radianceDistance.w,depthClamp);let moment=vec2f(d,d*d);
  if(isBack&&d>0.0&&d<back){back=d;backDirection=ray.directionStatus.xyz;}
  if(isBack&&d==0.0&&any(ray.radianceDistance.xyz!=vec3f(0))){escape=ray.radianceDistance.xyz;}
${threadTexels((k) => `  {let c=select(0.0,max(dot(direction${k},ray.directionStatus.xyz),0.0),live);let c2=c*c;let c4=c2*c2;let c8=c4*c4;let w=c8*c8;radiance${k}+=ray.radianceDistance.xyz*(w*lit);depth${k}+=moment*w;weight${k}+=w*lit;depthWeight${k}+=w;}`)}
 }
 let isFirst=old.x==0u||restart;
 let h=select(frame.environment.w,min(frame.environment.w,0.5),(entry&PROBE_FAST)!=0u);
${threadTexels((k) => ` storeTexel(probe,lane+${k * PROBE_THREADS}u,radiance${k},depth${k},weight${k},depthWeight${k},isFirst,h);`)}
 if(lane==0u){
  let spacing=probeField.originSpacing.w*probeScale(probe);
  let clearance=${IRRADIANCE_FIELD_RELOCATION.clearance}*spacing;let limit=${IRRADIANCE_FIELD_RELOCATION.limit}*spacing;
  let offset=select(probeOffset(old),vec3f(0),restart);
  let inside=traced>0u&&backfaces*4u>traced;
  // Inside geometry: step out through the closest backface (or the SDF escape)
  // plus the clearance. Open-space probes stay on the lattice: thin walls next to
  // them are resolved by the trace (probeSurface), not by moving the probe.
  var moved=offset;
  if(inside&&any(escape!=vec3f(0))){moved=offset+escape+normalize(escape)*clearance;}
  else if(inside&&back<depthClamp){moved=offset+backDirection*(back+clearance);}
  moved=clamp(moved,vec3f(-limit),vec3f(limit));
  let relocated=length(moved-offset)>${IRRADIANCE_FIELD_RELOCATION.restart}*spacing;
  var state=${IrradianceFieldProbeState.untraced}u;
  if(relocated){state=${IrradianceFieldProbeState.relocated}u;}
  else if(inside){state=${IrradianceFieldProbeState.inside}u;}
  else if(traced>0u){state=${IrradianceFieldProbeState.active}u;}
  // A relocated probe restarts its history at the next update (updates = 0).
  let updates=select(select(old.x,0u,restart)+select(0u,1u,traced>0u),0u,relocated);
  probeMeta[probe]=vec4u(updates,state,pack2x16float(moved.xy),pack2x16float(vec2f(moved.z,0.0)));
 }
}
`;

/** Re-derives the irradiance level and the 4x4 radiance prefilter from the
 * filtered radiance level every update (SSOT), in the same pass as
 * `updateProbes`. Irradiance is the discrete cosine convolution of the 64
 * radiance texels weighted by solid angle, normalized by the summed weight
 * (E / pi). Each of the 8 threads owns one octahedral row, so one radiance
 * load feeds 8 texels; the prefilter averages 2x2 radiance texels. Radiance
 * validity only drops on a restart, so an empty support clears the derived
 * texel instead of keeping the previous clipmap cell's value. */
export const IRRADIANCE_FIELD_DERIVE_WGSL = `
@group(0) @binding(1) var<storage,read_write> irradiance: array<vec4f>;
@group(0) @binding(4) var<uniform> probeField: Field;
@group(0) @binding(5) var<uniform> frame: Frame;
@group(0) @binding(6) var<storage,read> probeList: array<u32>;
${SHARED_WGSL}
const OCT_LOBE=array<vec4f,${IRRADIANCE_FIELD_TEXELS}>(${OCT_LOBES});
@compute @workgroup_size(${PROBE_THREADS}) fn deriveProbes(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lane: u32, @builtin(num_workgroups) groups: vec3u) {
 let slot=wid.x+wid.y*groups.x;
 if(slot>=frame.schedule.y){return;}
 let probe=probeList[slot]&PROBE_INDEX;
 let block=probe*${IRRADIANCE_FIELD_PROBE_STRIDE}u;
 let level0=block+${IRRADIANCE_FIELD_TEXELS}u;
${threadTexels((k) => ` let direction${k}=OCT_LOBE[lane*${THREAD_TEXELS}u+${k}u].xyz;var e${k}=vec3f(0);var ew${k}=0.0;`)}
 for(var j=0u;j<${IRRADIANCE_FIELD_TEXELS}u;j++){
  let lobe=OCT_LOBE[j];let stored=irradiance[level0+j];
  let solidAngle=select(0.0,lobe.w,stored.w>0.0);
${threadTexels((k) => `  {let c=max(dot(direction${k},lobe.xyz),0.0)*solidAngle;e${k}+=stored.xyz*c;ew${k}+=c;}`)}
 }
${threadTexels((k) => ` if(ew${k}>0.0){irradiance[block+lane*${THREAD_TEXELS}u+${k}u]=vec4f(e${k}/ew${k},1.0);} else {irradiance[block+lane*${THREAD_TEXELS}u+${k}u]=vec4f(0);}`)}
 for(var i=0u;i<${IRRADIANCE_FIELD_MIP_TEXELS / PROBE_THREADS}u;i++){
  let texel=lane*${IRRADIANCE_FIELD_MIP_TEXELS / PROBE_THREADS}u+i;
  let m=vec2u(texel%${IRRADIANCE_FIELD_OCT / 2}u,texel/${IRRADIANCE_FIELD_OCT / 2}u)*2u;
  var mip=vec3f(0);var weight=0.0;
  for(var c=0u;c<4u;c++){
   let source=(m.y+(c>>1u))*${IRRADIANCE_FIELD_OCT}u+m.x+(c&1u);
   let stored=irradiance[level0+source];
   let w=select(0.0,OCT_LOBE[source].w,stored.w>0.0);mip+=stored.xyz*w;weight+=w;
  }
  if(weight>0.0){irradiance[block+${IRRADIANCE_FIELD_TEXELS * 2}u+texel]=vec4f(mip/weight,1.0);}
  else {irradiance[block+${IRRADIANCE_FIELD_TEXELS * 2}u+texel]=vec4f(0);}
 }
}
`;

export type Binding = 'uniform' | 'storage' | 'read' | 'float' | 'depth' | 'uint' | 'tlas';

function layoutEntry(binding: number, kind: Binding) {
  if (kind === 'tlas') return { binding, visibility: 4, accelerationStructure: {} };
  return kind === 'float' || kind === 'depth' || kind === 'uint'
    ? {
        binding,
        visibility: 4,
        texture: {
          sampleType:
            kind === 'depth'
              ? ('depth' as const)
              : kind === 'uint'
                ? ('uint' as const)
                : ('unfilterable-float' as const),
        },
      }
    : {
        binding,
        visibility: 4,
        buffer: {
          type:
            kind === 'uniform'
              ? ('uniform' as const)
              : kind === 'storage'
                ? ('storage' as const)
                : ('read-only-storage' as const),
        },
      };
}

export function createComputeLayout(
  device: RhiDevice,
  bindings: readonly (readonly [number, Binding])[],
): Result<BindGroupLayout, RhiError> {
  return device.createBindGroupLayout({
    entries: bindings.map(([binding, kind]) => layoutEntry(binding, kind)),
  });
}

/** Binding names of the TS-owned kernels; textures use the Card atlas plane names. */
export type IrradianceFieldKernelInput =
  | WorldTraversalInput
  | 'cards'
  | 'cardSettings'
  | 'lights'
  | 'frame'
  | 'field'
  | 'surfaces'
  | 'cardLit'
  | 'probeRays'
  | 'irradiance'
  | 'moments'
  | 'meta'
  | 'probeList'
  | 'probeOrigins'
  | 'reflectionRays'
  | 'reflectionSignal'
  | 'albedoRoughness'
  | 'normals'
  | 'emissionMetallic'
  | 'f0Validity'
  | 'depth';

export type IrradianceFieldKernelStage =
  | 'cardSurface'
  | 'placeProbes'
  | 'traceProbes'
  | 'updateProbes'
  | 'deriveProbes'
  | 'traceReflections';

type Roster = readonly (readonly [number, Binding, IrradianceFieldKernelInput])[];
const CARD_ATLAS_ROSTER: Roster = [
  [10, 'uniform', 'cardSettings'],
  [11, 'float', 'albedoRoughness'],
  [12, 'float', 'normals'],
  [13, 'float', 'emissionMetallic'],
  [14, 'float', 'f0Validity'],
  [15, 'depth', 'depth'],
];
/** World-trace stages: traversal slots 0..4, then Cards, records, frame, atlas. */
const worldTraceRoster = (traversal: WorldTraversal, records: Roster): Roster => [
  ...WORLD_TRAVERSAL_ROSTER[traversal],
  [5, 'read', 'cards'],
  [6, 'read', 'cardLit'],
  ...records,
  [9, 'uniform', 'frame'],
  ...CARD_ATLAS_ROSTER,
];

const stages = (traversal: WorldTraversal): Record<IrradianceFieldKernelStage, Roster> => ({
  traceProbes: [
    ...worldTraceRoster(traversal, [
      [7, 'storage', 'probeRays'],
      [8, 'uniform', 'field'],
    ]),
    [16, 'read', 'probeOrigins'],
  ],
  placeProbes: [
    [0, 'read', 'probeList'],
    [1, 'read', 'meta'],
    [2, 'uniform', 'field'],
    [3, 'uniform', 'frame'],
    [4, 'storage', 'probeOrigins'],
  ],
  traceReflections: worldTraceRoster(traversal, [
    [7, 'storage', 'reflectionRays'],
    [8, 'storage', 'reflectionSignal'],
  ]),
  cardSurface: [
    ...WORLD_TRAVERSAL_ROSTER[traversal],
    [5, 'read', 'cards'],
    [6, 'uniform', 'lights'],
    [7, 'uniform', 'frame'],
    [8, 'uniform', 'cardSettings'],
    [9, 'storage', 'surfaces'],
    [10, 'float', 'albedoRoughness'],
    [11, 'float', 'normals'],
    [12, 'float', 'emissionMetallic'],
    [13, 'float', 'f0Validity'],
    [14, 'depth', 'depth'],
  ],
  updateProbes: [
    [0, 'read', 'probeRays'],
    [1, 'storage', 'irradiance'],
    [2, 'storage', 'moments'],
    [3, 'storage', 'meta'],
    [4, 'uniform', 'field'],
    [5, 'uniform', 'frame'],
    [6, 'read', 'probeList'],
  ],
  deriveProbes: [
    [1, 'storage', 'irradiance'],
    [4, 'uniform', 'field'],
    [5, 'uniform', 'frame'],
    [6, 'read', 'probeList'],
  ],
});

/** Kernel sources of one world traversal: Card light visibility, probe rays and
 * Lite reflections all trace through the same `traceWorld` seam. */
export function irradianceFieldKernelWgsl(
  traversal: WorldTraversal,
): Record<IrradianceFieldKernelStage, string> {
  return {
    cardSurface: irradianceFieldCardSurfaceWgsl(traversal),
    placeProbes: IRRADIANCE_FIELD_PLACE_WGSL,
    traceProbes: irradianceFieldTraceWgsl(traversal),
    updateProbes: IRRADIANCE_FIELD_UPDATE_WGSL,
    deriveProbes: IRRADIANCE_FIELD_DERIVE_WGSL,
    traceReflections: irradianceFieldReflectionWgsl(traversal),
  };
}

/** Group-0 bind-group entry for one roster slot; buffers bind whole unless `size` narrows them. */
export function kernelResource(
  binding: number,
  kind: Binding,
  value: TextureView | Tlas | { readonly buffer: Buffer; readonly size?: number },
): BindGroupEntry {
  switch (kind) {
    case 'tlas':
      return { binding, resource: { kind: 'accelerationStructure', value: value as Tlas } };
    case 'float':
    case 'depth':
    case 'uint':
      return { binding, resource: { kind: 'textureView', value: value as TextureView } };
    case 'uniform':
    case 'storage':
    case 'read':
      return {
        binding,
        resource: {
          kind: 'buffer',
          value: value as { readonly buffer: Buffer; readonly size?: number },
        },
      };
  }
}

/** Splits a linear thread count into a dispatch within the per-dimension limit. */
export function linearDispatch(device: RhiDevice, threads: number): readonly [number, number] {
  const groups = Math.ceil(threads / 64);
  const max = device.limits.maxComputeWorkgroupsPerDimension;
  const x = Math.min(groups, max);
  return [x, Math.ceil(groups / x)];
}

export function createIrradianceFieldKernel(
  device: RhiDevice,
  stage: IrradianceFieldKernelStage,
  module: ShaderModule,
  traversal: WorldTraversal,
) {
  const roster = stages(traversal)[stage];
  const layout = createComputeLayout(
    device,
    roster.map(([binding, kind]) => [binding, kind] as const),
  );
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label: `irradiance-field.${stage}`,
    layout: pipelineLayout.value,
    compute: { module, entryPoint: stage },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    /** The stage's roster, declared by the caller as graph accesses. */
    bindings: roster,
    /** `work` is tile texels or probe rays; the update and derive stages dispatch one group per probe. */
    record(
      pass: RhiComputePassEncoder,
      resolve: (
        name: IrradianceFieldKernelInput,
      ) => TextureView | Tlas | { readonly buffer: Buffer; readonly size?: number },
      work: number,
    ): Result<void, RayReferenceError | RhiError> {
      if (!Number.isSafeInteger(work) || work < 1)
        return rayReferenceFailure(`irradiance field ${stage} requires positive work`);
      const group = device.createBindGroup({
        layout: layout.value,
        entries: roster.map(([binding, kind, name]) =>
          kernelResource(binding, kind, resolve(name)),
        ),
      });
      if (!group.ok) return group;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      if (stage === 'updateProbes' || stage === 'deriveProbes') {
        const max = device.limits.maxComputeWorkgroupsPerDimension;
        const x = Math.min(work, max);
        pass.dispatchWorkgroups(x, Math.ceil(work / x));
      } else {
        const [x, y] = linearDispatch(device, work);
        pass.dispatchWorkgroups(x, y);
      }
      return ok(undefined);
    },
  });
}

/** Entry points of the published `forgeax_ray::irradiance_field` module. */
export type IrradianceFieldViewStage =
  | 'lightCards'
  | 'radiateCards'
  | 'gatherField'
  | 'upsampleField'
  | 'generateFieldReflections'
  | 'accumulateFieldReflections'
  | 'filterFieldReflections';
const VIEW_STAGES: Record<IrradianceFieldViewStage, readonly (readonly [number, Binding])[]> = {
  lightCards: [
    [0, 'uniform'],
    [1, 'uniform'],
    [2, 'read'],
    [3, 'storage'],
  ],
  radiateCards: [
    [0, 'uniform'],
    [2, 'read'],
    [4, 'read'],
    [5, 'storage'],
  ],
  gatherField: [
    [0, 'uniform'],
    [6, 'depth'],
    [7, 'uint'],
    [8, 'uniform'],
    [9, 'storage'],
  ],
  upsampleField: [
    [0, 'uniform'],
    [6, 'depth'],
    [7, 'uint'],
    [8, 'uniform'],
    [10, 'read'],
    [11, 'storage'],
  ],
  generateFieldReflections: [
    [0, 'uniform'],
    [6, 'depth'],
    [7, 'uint'],
    [8, 'uniform'],
    [12, 'storage'],
    [13, 'storage'],
  ],
  accumulateFieldReflections: [
    [0, 'uniform'],
    [6, 'depth'],
    [7, 'uint'],
    [8, 'uniform'],
    [14, 'read'],
    [15, 'read'],
    [16, 'storage'],
    [17, 'float'],
    [20, 'read'],
  ],
  filterFieldReflections: [
    [0, 'uniform'],
    [8, 'uniform'],
    [18, 'read'],
    [19, 'storage'],
  ],
};
/** Stages that sample the probe field through the shared group(1). */
const FIELD_SAMPLING_STAGES: ReadonlySet<IrradianceFieldViewStage> = new Set([
  'radiateCards',
  'gatherField',
  'upsampleField',
  'generateFieldReflections',
]);
/** `forgeax_ray::irradiance_field_sample` group(1): field uniform, irradiance, moments, meta. */
export const IRRADIANCE_FIELD_SAMPLE_BINDINGS = [
  [0, 'uniform'],
  [1, 'read'],
  [2, 'read'],
  [3, 'read'],
] as const;

/** Buffers bind whole unless `size` narrows them; texture slots take a view. */
export type IrradianceFieldViewResource =
  | { readonly buffer: Buffer; readonly size?: number }
  | TextureView;

/** One compute pipeline per published entry; the sample group is shared and
 * built once per field generation by the owner. */
export function createIrradianceFieldSampleLayout(device: RhiDevice, mode: 'live' | 'baked') {
  return device.createBindGroupLayout({
    entries: [
      ...IRRADIANCE_FIELD_SAMPLE_BINDINGS.map(([binding, kind]) => layoutEntry(binding, kind)),
      ...(mode === 'live'
        ? [
            { binding: 4, visibility: 4, buffer: { type: 'uniform' as const } },
            {
              binding: 5,
              visibility: 4,
              texture: { sampleType: 'unfilterable-float' as const, viewDimension: '3d' as const },
            },
          ]
        : []),
    ],
  });
}

export function createIrradianceFieldViewKernels(
  device: RhiDevice,
  module: ShaderModule,
  mode: 'live' | 'baked',
) {
  const sampleLayout = createIrradianceFieldSampleLayout(device, mode);
  if (!sampleLayout.ok) return sampleLayout;
  const kernels = {} as Record<
    IrradianceFieldViewStage,
    {
      record(
        pass: RhiComputePassEncoder,
        resources: readonly IrradianceFieldViewResource[],
        sample: BindGroup | undefined,
        threads: number,
      ): Result<void, RhiError>;
    }
  >;
  for (const stage of Object.keys(VIEW_STAGES) as IrradianceFieldViewStage[]) {
    const roster = VIEW_STAGES[stage];
    const layout = createComputeLayout(device, roster);
    if (!layout.ok) return layout;
    const usesField = FIELD_SAMPLING_STAGES.has(stage);
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: usesField ? [layout.value, sampleLayout.value] : [layout.value],
    });
    if (!pipelineLayout.ok) return pipelineLayout;
    const pipeline = device.createComputePipeline({
      label: `irradiance-field.${stage}`,
      layout: pipelineLayout.value,
      compute: {
        module,
        entryPoint:
          mode === 'baked' && (stage === 'gatherField' || stage === 'upsampleField')
            ? stage.replace('Field', 'BakedField')
            : stage,
      },
    });
    if (!pipeline.ok) return pipeline;
    kernels[stage] = {
      record(pass, resources, sample, threads) {
        const group = device.createBindGroup({
          layout: layout.value,
          entries: roster.map(([binding, kind], i) => {
            const value = resources[i];
            if (value === undefined)
              throw new Error(`irradiance field ${stage} missing ${binding}`);
            return kind === 'float' || kind === 'depth' || kind === 'uint'
              ? { binding, resource: { kind: 'textureView' as const, value: value as TextureView } }
              : {
                  binding,
                  resource: {
                    kind: 'buffer' as const,
                    value: value as { readonly buffer: Buffer; readonly size?: number },
                  },
                };
          }),
        });
        if (!group.ok) return group;
        pass.setPipeline(pipeline.value);
        pass.setBindGroup(0, group.value);
        if (usesField) {
          if (sample === undefined) throw new Error(`irradiance field ${stage} needs the field`);
          pass.setBindGroup(1, sample);
        }
        const [x, y] = linearDispatch(device, threads);
        pass.dispatchWorkgroups(x, y);
        return ok(undefined);
      },
    };
  }
  return ok({ sampleLayout: sampleLayout.value, kernels });
}
