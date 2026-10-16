#define_import_path forgeax_ray::path_tracer
#pragma variant_axis DIRECT_DFG_LUT_AVAILABLE
#import forgeax_material::ray_abi::{RayMaterialInput, RayMaterialSurface}
#import forgeax_pbr::ray_bsdf::{RAY_BSDF_LAMBERT, rayBasis, rayBsdfValue, rayBsdfPdf, sampleRayBsdf, rayPowerHeuristic}
#import forgeax_pbr::ibl_shared::{standardDiffuseWeight}
#import forgeax_pbr::lighting_attenuation::{evalDistanceAttenuation, evalSpotAttenuation}

#import forgeax_ray::traversal::{Triangle, Node, Ray, Hit, TraceResult, triangles, nodes, traceAny, traceOccluder, traceReference, traceReferenceAfter}

struct AttributeVertex { objectPosition: vec4f, color: vec4f, uvA: vec4f, uvB: vec4f, uvC: vec4f, uvD: vec4f, normal: vec4f, tangent: vec4f }
struct Attributes { a: AttributeVertex, b: AttributeVertex, c: AttributeVertex }
struct PathState { origin: vec4f, direction: vec4f, throughput: vec4f, radiance: vec4f, state: vec4u }
struct Accumulation { mean: vec3f, count: u32, m2: vec3f, error: u32, albedo: vec4f, normalDepth: vec4f, identity: vec4u }
struct TraceLight { positionKind: vec4f, radiance: vec4f, directionRange: vec4f, cone: vec4f }
struct TraceSettings { origin: vec4f, forward: vec4f, right: vec4f, up: vec4f, environment: vec4f, dimensions: vec4u }
#ifdef DIRECT_DFG_LUT_AVAILABLE
@group(0) @binding(10) var directDfgLut: texture_2d<f32>;
@group(0) @binding(11) var directDfgSampler: sampler;
// Preserve the filtering contract through the shared BRDF texture parameters.
fn directDfgTextureFilteringWitness() {
  let sample = textureSample(directDfgLut, directDfgSampler, vec2<f32>(0.0));
}
#endif
@group(0) @binding(2) var<storage, read> attributes: array<Attributes>;
@group(0) @binding(3) var<storage, read_write> paths: array<PathState>;
@group(0) @binding(4) var<storage, read_write> inputs: array<RayMaterialInput>;
@group(0) @binding(5) var<storage, read_write> surfaces: array<RayMaterialSurface>;
@group(0) @binding(6) var<storage, read_write> accumulation: array<Accumulation>;
@group(0) @binding(7) var<uniform> lights: array<TraceLight, 32>;
@group(0) @binding(8) var<uniform> settings: TraceSettings;
// Masked coverage runs as bounded candidate rounds. Each round a ray gathers its
// ordered alpha candidates into a shared pool in the tail of inputs/surfaces (from
// `poolBase`), the masked Surface programs run once per pooled candidate through a
// GPU-sized dispatch, and the ray resolves its candidates in (t, triangle) order.
// A ray the full pool deferred continues from its cursor in the next round.
struct CoverageQuery {
  origin: vec4f, direction: vec4f, contribution: vec4f,
  // status (pending/accepted-or-blocked/clear/invalid), cursor triangle, light index,
  // candidates consumed.
  state: vec4u,
  // first pooled candidate, pooled count | terminal << 8, deferred queue (even, odd round).
  gather: vec4u,
}
struct Coverage {
  pool: atomic<u32>, queued: array<atomic<u32>, 2>,
  // Queries left pending with candidate budget to spare: the rounds ran out.
  overflow: atomic<u32>,
  round: u32, capacity: u32, poolBase: u32, padding: u32,
  queries: array<CoverageQuery>,
}
@group(0) @binding(9) var<storage, read_write> coverage: Coverage;
// Indirect workgroup counts: [0..3) pooled candidates, [3..6) deferred rays.
@group(1) @binding(0) var<storage, read_write> dispatchArgs: array<u32>;
const COVERAGE_CANDIDATES = 64u; const COVERAGE_ROUNDS = 3u;
const NONE = 0xffffffffu;
const TERMINAL_NONE = 0u;
const TERMINAL_MISS = 1u;
const TERMINAL_HIT = 2u;

fn random(state: ptr<function,u32>) -> f32 {
  *state = *state * 747796405u + 2891336453u;
  let word = ((*state >> ((*state >> 28u) + 4u)) ^ *state) * 277803737u;
  return f32(((word >> 22u) ^ word) >> 8u) * (1.0 / 16777216.0);
}
fn epsilon(position: vec3f) -> f32 { return max(1e-4, max(max(abs(position.x),abs(position.y)),abs(position.z))*1e-5); }
fn visible(position: vec3f, normal: vec3f, direction: vec3f, distance: f32) -> bool {
  let offset = epsilon(position);
  let ray = Ray(position + normal*offset, 0.0, direction, max(0.0,distance-offset*2.0), vec4u(255u,0u,0u,0u));
  return traceAny(ray).hit.ids.x == 0xffffffffu;
}
// settings.up.w == 1: the first surface responds only as the raster diffuse-GI
// receiver (the composite's weight, albedo and material occlusion), so an
// indirect estimate is directly comparable to the diffuse lane.
fn pathSurface(surface: RayMaterialSurface, input: RayMaterialInput, bounce: u32) -> RayMaterialSurface {
  if (settings.up.w == 0.0 || bounce != 0u || surface.status.x != 1u) { return surface; }
  var receiver = surface;
  let n = surface.normalRoughness.xyz;
  let weight = standardDiffuseWeight(max(dot(n, input.outgoing.xyz), 0.0),
    surface.f0Occlusion.xyz, surface.normalRoughness.w, surface.emissionMetallic.w);
  receiver.albedoOpacity = vec4f(weight * surface.albedoOpacity.rgb * surface.f0Occlusion.w, surface.albedoOpacity.a);
  receiver.status.y = RAY_BSDF_LAMBERT;
  return receiver;
}
fn uvDensity(a: vec2f, b: vec2f, c: vec2f, e: vec3f, f: vec3f) -> f32 {
  let ee = dot(e,e); let ef = dot(e,f); let ff = dot(f,f);
  let det = ee*ff-ef*ef;
  let ab = b-a; let ac = c-a;
  let gu = ((ab.x*ff-ac.x*ef)*e + (ac.x*ee-ab.x*ef)*f)/det;
  let gv = ((ab.y*ff-ac.y*ef)*e + (ac.y*ee-ab.y*ef)*f)/det;
  return sqrt(dot(gu,gu)+dot(gv,gv));
}
fn interpolateVertex(a: AttributeVertex, b: AttributeVertex, c: AttributeVertex, w: vec3f) -> AttributeVertex {
  return AttributeVertex(a.objectPosition*w.x+b.objectPosition*w.y+c.objectPosition*w.z,
    clamp(a.color+(b.color-a.color)*w.y+(c.color-a.color)*w.z,vec4f(0),vec4f(1)), a.uvA*w.x+b.uvA*w.y+c.uvA*w.z,
    a.uvB*w.x+b.uvB*w.y+c.uvB*w.z, a.uvC*w.x+b.uvC*w.y+c.uvC*w.z,
    a.uvD*w.x+b.uvD*w.y+c.uvD*w.z, a.normal*w.x+b.normal*w.y+c.normal*w.z,
    a.tangent*w.x+b.tangent*w.y+c.tangent*w.z);
}
fn materialInput(traced: TraceResult, ray: Ray, coneWidth: f32, coneSpread: f32, bounce: u32) -> RayMaterialInput {
  let hit = traced.hit;
  let triangle = triangles[traced.triangleIndex]; let attr = attributes[traced.triangleIndex];
  let w = vec3f(1.0-hit.metrics.y-hit.metrics.z,hit.metrics.yz);
  let vertex = interpolateVertex(attr.a,attr.b,attr.c,w);
  let e = triangle.b.xyz-triangle.a.xyz; let f = triangle.c.xyz-triangle.a.xyz;
  let normal = normalize(cross(e,f))*attr.a.normal.w; let position = ray.origin+ray.direction*hit.metrics.x;
  let cone = coneWidth + hit.metrics.x*coneSpread;
  let footprint = cone/max(abs(dot(normal,ray.direction)),0.001);
  let densityA = vec4f(uvDensity(attr.a.uvA.xy,attr.b.uvA.xy,attr.c.uvA.xy,e,f),uvDensity(attr.a.uvA.zw,attr.b.uvA.zw,attr.c.uvA.zw,e,f),
    uvDensity(attr.a.uvB.xy,attr.b.uvB.xy,attr.c.uvB.xy,e,f),uvDensity(attr.a.uvB.zw,attr.b.uvB.zw,attr.c.uvB.zw,e,f));
  let densityB = vec4f(uvDensity(attr.a.uvC.xy,attr.b.uvC.xy,attr.c.uvC.xy,e,f),uvDensity(attr.a.uvC.zw,attr.b.uvC.zw,attr.c.uvC.zw,e,f),
    uvDensity(attr.a.uvD.xy,attr.b.uvD.xy,attr.c.uvD.xy,e,f),uvDensity(attr.a.uvD.zw,attr.b.uvD.zw,attr.c.uvD.zw,e,f));
  return RayMaterialInput(vertex.objectPosition,vec4f(position,hit.metrics.x),vec4f(normal,select(0.0,1.0,dot(normal,ray.direction)<0.0)),
    vertex.tangent,vec4f(-ray.direction,cone),vertex.uvA,vertex.uvB,vertex.uvC,vertex.uvD,vertex.color,
    densityA*footprint,densityB*footprint,vertex.normal,vec4u(hit.ids.w,1u,bounce,traced.triangleIndex));
}
@compute @workgroup_size(64) fn generate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  var rng = (id.x+1u)*2654435761u ^ (accumulation[id.x].count+1u)*2246822519u ^ settings.dimensions.w;
  let jitter = vec2f(random(&rng),random(&rng));
  let pixel = vec2f(f32(id.x % settings.dimensions.x), f32(id.x/settings.dimensions.x));
  let ndc = ((pixel+jitter)/vec2f(settings.dimensions.xy))*2.0-vec2f(1.0);
  let direction = normalize(settings.forward.xyz + ndc.x*settings.right.xyz - ndc.y*settings.up.xyz);
  paths[id.x] = PathState(vec4f(settings.origin.xyz,0.0),vec4f(direction,settings.origin.w),vec4f(1,1,1,0),vec4f(0),vec4u(1u,0u,rng,0u));
  accumulation[id.x].identity = vec4u(0xffffffffu);
  accumulation[id.x].albedo = vec4f(0);
  accumulation[id.x].normalDepth = vec4f(0,0,0,-1);
}
@compute @workgroup_size(64) fn trace(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  inputs[id.x].identity = vec4u(NONE,0u,0u,0u);
  surfaces[id.x].status = vec4u(0u);
  var path = paths[id.x];
  if (path.state.x == 0u) { return; }
  let ray = Ray(path.origin.xyz,0.0,path.direction.xyz,settings.environment.w,vec4u(255u,0u,0u,0u));
  let traced=traceReference(ray);
  if (traced.hit.ids.x == NONE) { missPath(id.x); return; }
  inputs[id.x] = materialInput(traced, ray, path.origin.w, path.direction.w, path.state.y);
  if (path.state.y == 0u) { accumulation[id.x].identity = traced.hit.ids; }
}
fn missPath(index: u32) {
  var path = paths[index];
  if (path.state.y == 0u) { accumulation[index].identity=vec4u(NONE); }
  var mis = 1.0;
  if (path.state.y > 0u) { mis = rayPowerHeuristic(path.throughput.w, 1.0/6.28318530718); }
  path.radiance += vec4f(path.throughput.xyz*settings.environment.xyz*mis,0);
  path.state.x = 0u; paths[index] = path;
}
@compute @workgroup_size(64) fn shade(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  var path = paths[id.x];
  if (path.state.x == 0u) { return; }
  let input = inputs[id.x]; let surface = pathSurface(surfaces[id.x], input, path.state.y);
  if (surface.status.x != 1u) { path.state.x=0u; path.radiance.w=1.0; paths[id.x]=path; return; }
  let n = surface.normalRoughness.xyz; let outgoing = input.outgoing.xyz; let position = input.positionWS.xyz;
  let ng = surface.geometricNormal.xyz;
  if (path.state.y == 0u) {
    accumulation[id.x].albedo = surfaces[id.x].albedoOpacity;
    accumulation[id.x].normalDepth = vec4f(n,input.positionWS.w);
  }
  // Emissive surfaces are BSDF-sampled only in this baseline, so no competing
  // emitter NEE term exists and this contribution has weight one.
  var radiance = surface.emissionMetallic.xyz;
  var rng=path.state.z;
  if (settings.forward.w == 0.0) {
  for (var i=0u; i<u32(settings.right.w); i++) {
    let light=lights[i]; let kind=u32(light.positionKind.w);
    if (kind == 0u) { continue; }
    var incoming=normalize(-light.directionRange.xyz); var distance=settings.environment.w; var scale=1.0;
    if (kind >= 2u) {
      let delta=light.positionKind.xyz-position; distance=length(delta);
      incoming=delta/max(distance,1e-8);
      scale=evalDistanceAttenuation(distance*distance,light.directionRange.w,light.radiance.w,1e-4);
      if (kind == 3u) { scale=evalSpotAttenuation(light.positionKind.xyz,light.directionRange.xyz,position,light.cone.x,light.cone.y,light.directionRange.w); }
    }
    let cosine=max(dot(n,incoming),0.0);
    if (cosine > 0.0 && dot(ng,incoming)>0.0 && visible(position,ng,incoming,distance)) { radiance += rayBsdfValue(surface,outgoing,incoming,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  )*light.radiance.xyz*(scale*cosine); }
  }
  let z=random(&rng); let phi=6.28318530718*random(&rng); let r=sqrt(1.0-z*z);
  let environmentDirection=rayBasis(n)*vec3f(r*cos(phi),r*sin(phi),z);
  let environmentPdf=1.0/6.28318530718;
  if (any(settings.environment.xyz > vec3f(0)) && dot(ng,environmentDirection)>0.0 && visible(position,ng,environmentDirection,settings.environment.w)) {
    var weight=rayPowerHeuristic(environmentPdf,rayBsdfPdf(surface,outgoing,environmentDirection));
    if (path.state.y+1u >= settings.dimensions.z) { weight=1.0; }
    radiance += rayBsdfValue(surface,outgoing,environmentDirection,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  )*settings.environment.xyz*(z*weight/environmentPdf);
  }
  }
  path.radiance += vec4f(path.throughput.xyz*radiance,0);
  let sample=sampleRayBsdf(surface,outgoing,vec3f(random(&rng),random(&rng),random(&rng)),
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  path.throughput=vec4f(path.throughput.xyz*sample.weight,sample.pdf);
  path.state.y++;
  path.state.x=sample.valid;
  if (path.state.y >= 3u && path.state.x != 0u) {
    let q=clamp(max(max(path.throughput.x,path.throughput.y),path.throughput.z),0.05,0.95);
    if (random(&rng) >= q) { path.state.x=0u; } else { path.throughput=vec4f(path.throughput.xyz/q,path.throughput.w); }
  }
  if (path.state.y >= settings.dimensions.z) { path.state.x=0u; }
  path.state.z=rng;
  path.origin=vec4f(position+ng*epsilon(position),input.outgoing.w);
  path.direction=vec4f(sample.direction,max(path.direction.w,surface.normalRoughness.w*surface.normalRoughness.w));
  if (!all(abs(path.radiance.xyz) < vec3f(1e30)) || !all(abs(path.throughput.xyz) < vec3f(1e30))) { path.radiance=vec4f(0,0,0,1); path.state.x=0u; }
  paths[id.x]=path;
}
@compute @workgroup_size(64) fn accumulate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  let value=paths[id.x].radiance;
  var a=accumulation[id.x];
  if (value.w != 0.0) { a.error=1u; accumulation[id.x]=a; return; }
  a.count++;
  let delta=value.xyz-a.mean; a.mean+=delta/f32(a.count); a.m2+=delta*(value.xyz-a.mean);
  accumulation[id.x]=a;
}

// Rays the current round gathers: every pixel first, then the rays the full pool deferred.
fn gatherRay(index: u32) -> u32 {
  if (coverage.round == 0u) {
    if (index >= arrayLength(&paths)) { return NONE; }
    return index;
  }
  let list = (coverage.round + 1u) % 2u;
  if (index >= atomicLoad(&coverage.queued[list])) { return NONE; }
  return select(coverage.queries[index].gather.z, coverage.queries[index].gather.w, list == 1u);
}
// Appends one alpha candidate to the ray's ordered chain; false when the pool is full.
fn poolCandidate(input: RayMaterialInput, tail: ptr<function,u32>, head: ptr<function,u32>) -> bool {
  let slot = atomicAdd(&coverage.pool, 1u);
  if (slot >= coverage.capacity) { return false; }
  let entry = coverage.poolBase + slot;
  var linked = input; linked.identity.z = NONE;
  inputs[entry] = linked;
  if (*tail == NONE) { *head = entry; } else { inputs[*tail].identity.z = entry; }
  *tail = entry;
  return true;
}
// Cumulative candidate budget through this round: it doubles per round and only a
// ray whose earlier window was entirely rejected looks deeper, which bounds the pool
// spent on candidates behind the one a Surface program accepts.
fn roundWindow() -> u32 { return COVERAGE_CANDIDATES >> (COVERAGE_ROUNDS - 1u - coverage.round); }
fn deferRay(ray: u32) {
  let list = coverage.round % 2u;
  let k = atomicAdd(&coverage.queued[list], 1u);
  if (list == 0u) { coverage.queries[k].gather.z = ray; } else { coverage.queries[k].gather.w = ray; }
}
@compute @workgroup_size(64) fn beginCoverage(@builtin(global_invocation_id) id: vec3u) {
  if (id.x == 0u) { resetRounds(); }
  if (id.x >= arrayLength(&paths)) { return; }
  coverage.queries[id.x].state=vec4u(select(1u,0u,paths[id.x].state.x!=0u),NONE,0u,0u);
  coverage.queries[id.x].contribution=vec4f(0);
}
fn resetRounds() {
  coverage.round=0u; atomicStore(&coverage.pool,0u);
  atomicStore(&coverage.queued[0],0u); atomicStore(&coverage.queued[1],0u);
}
// Speculatively walks the ordered candidates from the committed cursor until an
// opaque hit, a miss, the candidate budget or a full pool ends the round.
@compute @workgroup_size(64) fn gather(@builtin(global_invocation_id) id: vec3u) {
  let index = gatherRay(id.x);
  if (index == NONE) { return; }
  let q = coverage.queries[index];
  if (q.state.x != 0u) { return; }
  inputs[index].identity = vec4u(NONE,0u,0u,0u);
  surfaces[index].status = vec4u(0u);
  let path = paths[index];
  let ray = Ray(path.origin.xyz,0.0,path.direction.xyz,settings.environment.w,vec4u(255u,0u,0u,0u));
  var afterT = q.contribution.w; var afterTriangle = q.state.y;
  var head = NONE; var tail = NONE; var pooled = 0u; var terminal = TERMINAL_NONE;
  let window = roundWindow();
  while (q.state.w + pooled < window) {
    let traced = traceReferenceAfter(ray,afterT,afterTriangle);
    if (traced.hit.ids.x == NONE) { terminal = TERMINAL_MISS; break; }
    let input = materialInput(traced, ray, path.origin.w, path.direction.w, path.state.y);
    if (triangles[traced.triangleIndex].maskData.z == 0u) { inputs[index] = input; terminal = TERMINAL_HIT; break; }
    if (!poolCandidate(input, &tail, &head)) { break; }
    pooled++; afterT = traced.hit.metrics.x; afterTriangle = traced.triangleIndex;
  }
  coverage.queries[index].gather.x = head;
  coverage.queries[index].gather.y = pooled | (terminal << 8u);
}
// Visibility is order-independent: any opaque blocker ends the query; only
// coverage candidates need their Surface program, nearest first.
@compute @workgroup_size(64) fn gatherShadow(@builtin(global_invocation_id) id: vec3u) {
  let index = gatherRay(id.x);
  if (index == NONE) { return; }
  let q = coverage.queries[index];
  if (q.state.x != 0u) { return; }
  let ray = Ray(q.origin.xyz,0.0,q.direction.xyz,q.direction.w,vec4u(255u,0u,0u,0u));
  var afterT = q.contribution.w; var afterTriangle = q.state.y;
  var head = NONE; var tail = NONE; var pooled = 0u; var terminal = TERMINAL_NONE;
  let window = roundWindow();
  while (q.state.w + pooled < window) {
    let traced = traceOccluder(ray,afterT,afterTriangle);
    if (traced.hit.ids.x == NONE) { terminal = TERMINAL_MISS; break; }
    if (triangles[traced.triangleIndex].maskData.z == 0u) { terminal = TERMINAL_HIT; break; }
    if (!poolCandidate(materialInput(traced,ray,q.origin.w,0.0,paths[index].state.y), &tail, &head)) { break; }
    pooled++; afterT = traced.hit.metrics.x; afterTriangle = traced.triangleIndex;
  }
  coverage.queries[index].gather.x = head;
  coverage.queries[index].gather.y = pooled | (terminal << 8u);
}
// Resolves pooled candidates in (t, triangle) order. Returns the first candidate
// whose Surface program did not reject coverage, or NONE once the chain is rejected.
fn resolveChain(index: u32, primary: bool) -> u32 {
  var q = coverage.queries[index];
  var entry = q.gather.x;
  for (var i = 0u; i < (q.gather.y & 0xffu); i++) {
    if (surfaces[entry].status.x != 3u) { return entry; }
    let input = inputs[entry];
    q.contribution.w = input.positionWS.w; q.state.y = input.identity.w; q.state.w++;
    if (primary && paths[index].state.y == 0u) { accumulation[index].identity = triangles[input.identity.w].ids; }
    entry = input.identity.z;
  }
  coverage.queries[index].contribution.w = q.contribution.w;
  coverage.queries[index].state = q.state;
  return NONE;
}
// The ray is still pending: continue next round, or remain pending once its budget is spent.
fn continueRay(index: u32) {
  if (coverage.queries[index].state.w < COVERAGE_CANDIDATES) { deferRay(index); }
}
@compute @workgroup_size(64) fn resolve(@builtin(global_invocation_id) id: vec3u) {
  let index = gatherRay(id.x);
  if (index == NONE || coverage.queries[index].state.x != 0u) { return; }
  let accepted = resolveChain(index, true);
  if (accepted != NONE) {
    var input = inputs[accepted]; input.identity.z = paths[index].state.y;
    let surface = surfaces[accepted];
    inputs[index] = input; surfaces[index] = surface;
    if (paths[index].state.y == 0u) { accumulation[index].identity = triangles[input.identity.w].ids; }
    coverage.queries[index].state.x = 1u;
    if (surface.status.x != 1u) { paths[index].radiance.w=1.0; paths[index].state.x=0u; }
    return;
  }
  switch (coverage.queries[index].gather.y >> 8u) {
    case TERMINAL_MISS: { missPath(index); coverage.queries[index].state.x = 1u; }
    case TERMINAL_HIT: {
      if (paths[index].state.y == 0u) { accumulation[index].identity = triangles[inputs[index].identity.w].ids; }
      coverage.queries[index].state.x = 1u;
    }
    default: { continueRay(index); }
  }
}
@compute @workgroup_size(64) fn resolveShadow(@builtin(global_invocation_id) id: vec3u) {
  let index = gatherRay(id.x);
  if (index == NONE || coverage.queries[index].state.x != 0u) { return; }
  let accepted = resolveChain(index, false);
  if (accepted != NONE) {
    coverage.queries[index].state.x = select(3u,1u,surfaces[accepted].status.x==1u);
    return;
  }
  switch (coverage.queries[index].gather.y >> 8u) {
    case TERMINAL_MISS: { coverage.queries[index].state.x = 2u; }
    case TERMINAL_HIT: { coverage.queries[index].state.x = 1u; }
    default: { continueRay(index); }
  }
}
// Single-thread indirect producers: the pooled candidates of this round, then the
// deferred rays of the next one.
@compute @workgroup_size(1) fn armMaterials() {
  let pooled = min(atomicLoad(&coverage.pool), coverage.capacity);
  dispatchArgs[0] = (pooled + 63u) / 64u; dispatchArgs[1] = 1u; dispatchArgs[2] = 1u;
}
@compute @workgroup_size(1) fn armRound() {
  let list = coverage.round % 2u;
  dispatchArgs[3] = (atomicLoad(&coverage.queued[list]) + 63u) / 64u; dispatchArgs[4] = 1u; dispatchArgs[5] = 1u;
  atomicStore(&coverage.pool, 0u);
  atomicStore(&coverage.queued[1u - list], 0u);
  coverage.round++;
}
// Exhaustion is an invalid sample, never an unoccluded approximation. A ray that
// still had budget ran out of rounds instead: counted, and equally invalid.
fn sealQuery(index: u32) {
  let q = coverage.queries[index];
  if (q.state.x != 0u && q.state.x != 3u) { return; }
  if (q.state.x == 0u && q.state.w < COVERAGE_CANDIDATES) { atomicAdd(&coverage.overflow, 1u); }
  paths[index].radiance.w=1.0; paths[index].state.x=0u;
}
@compute @workgroup_size(64) fn sealCoverage(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  sealQuery(id.x);
}
// The shading point stays in inputs/surfaces[ray]: shadow candidates live in the pool.
@compute @workgroup_size(64) fn beginShadow(@builtin(global_invocation_id) id: vec3u) {
  if (id.x == 0u) { resetRounds(); }
  if (id.x >= arrayLength(&paths)) { return; }
  var q=coverage.queries[id.x];
  q.state=vec4u(1u,NONE,q.state.z,0u); q.contribution=vec4f(0);
  if (paths[id.x].state.x == 0u) { coverage.queries[id.x]=q; return; }
  let input=inputs[id.x]; let surface=pathSurface(surfaces[id.x],input,paths[id.x].state.y); let position=input.positionWS.xyz;
  let n=surface.normalRoughness.xyz; let ng=surface.geometricNormal.xyz; let outgoing=input.outgoing.xyz;
  var incoming=vec3f(0); var distance=settings.environment.w; var incident=vec3f(0);
  if (q.state.z < u32(settings.right.w)) {
    let light=lights[q.state.z]; let kind=u32(light.positionKind.w);
    incoming=normalize(-light.directionRange.xyz); var scale=1.0;
    if (kind >= 2u) {
      let delta=light.positionKind.xyz-position; distance=length(delta); incoming=delta/max(distance,1e-8);
      scale=evalDistanceAttenuation(distance*distance,light.directionRange.w,light.radiance.w,1e-4);
      if (kind == 3u) { scale=evalSpotAttenuation(light.positionKind.xyz,light.directionRange.xyz,position,light.cone.x,light.cone.y,light.directionRange.w); }
    }
    incident=light.radiance.xyz*scale*max(dot(n,incoming),0.0);
  } else {
    var rng=paths[id.x].state.z;
    let z=random(&rng); let phi=6.28318530718*random(&rng); let r=sqrt(1.0-z*z);
    incoming=rayBasis(n)*vec3f(r*cos(phi),r*sin(phi),z);
    let pdf=1.0/6.28318530718;
    var weight=rayPowerHeuristic(pdf,rayBsdfPdf(surface,outgoing,incoming));
    if (paths[id.x].state.y+1u >= settings.dimensions.z) { weight=1.0; }
    incident=settings.environment.xyz*(z*weight/pdf);
    paths[id.x].state.z=rng;
  }
  let contribution=rayBsdfValue(surface,outgoing,incoming,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  )*incident;
  if (dot(ng,incoming)>0.0 && any(contribution>vec3f(0))) {
    q.state.x=0u;
    let offset=epsilon(position);
    q.origin=vec4f(position+ng*offset,input.outgoing.w);
    q.direction=vec4f(incoming,max(0.0,distance-offset*2.0));
    q.contribution=vec4f(contribution,0);
  }
  coverage.queries[id.x]=q;
}
@compute @workgroup_size(64) fn endShadow(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&paths)) { return; }
  let q=coverage.queries[id.x];
  if (q.state.x == 2u) { paths[id.x].radiance+=vec4f(paths[id.x].throughput.xyz*q.contribution.xyz,0); }
  sealQuery(id.x);
  coverage.queries[id.x].state.z++;
}
