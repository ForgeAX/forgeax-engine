enable wgpu_ray_query;
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
 if(instance==0u || instance>=traversalInstances[0].z/4u){return false;}
 let row=traversalInstances[instance];
 if(primitive>=(row.z>>2u)){return false;}
 let mode=row.z&3u;
 if(mode<2u){return mode==0u;}
 if(mode!=2u){return false;}
 let word=row.w+(primitive>>5u);
 let first=traversalInstances[0].z;
 let count=traversalInstances[0].w;
 if(row.w<first || word<row.w || word-first>=count || word/4u>=arrayLength(&traversalInstances)){return false;}
 return ((traversalInstances[word/4u][word&3u]>>(primitive&31u))&1u)!=0u;
}
fn traceWorldRayQuery(ray: Ray, maxSteps: u32, opaqueOccluderIsEnough: bool) -> Hit {
 var result=Hit(vec4u(0u,0u,0u,0xffffffffu),vec4f(ray.tMax,0,0,0),vec4f(ray.origin+ray.direction*ray.tMax,1),vec4f(0));
 if(ray.mask.x==0u){return result;}
 if(traversalInstances[0].x!=0u){result.state.x=4u;return result;}
 let allOpaque=traversalInstances[0].y==0u;
 var first=ray.tMin;
 var last=ray.tMax;
 // DXR triangle extents are open. Broaden only the hardware search, retaining
 // the original range for candidate admission. Zero stays native open-zero.
 if(!(first>=0.0) || !(last>first) || !(last<bitcast<f32>(0x7f7fffffu))){result.state.x=4u;return result;}
 if(first>0.0){first=bitcast<f32>(bitcast<u32>(first)-1u);}
 last=bitcast<f32>(bitcast<u32>(last)+1u);
 var query: ray_query;
 var forceOpaque=allOpaque;
 rayQueryInitialize(&query,tlas,RayDesc(select(0u,RAY_FLAG_FORCE_OPAQUE,forceOpaque),ray.mask.x&0xffu,first,last,ray.origin,ray.direction));
 var steps=0u;
 loop {
  if(steps>=maxSteps){result.state.x=4u;return result;}
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
  }
 }
 let c=rayQueryGetCommittedIntersection(&query);
 result.state.z=1u;
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
   if(steps>=maxSteps){result.state.x=4u;return result;}
   steps++;
   if(!rayQueryProceed(&unresolved)){break;}
   let candidate=rayQueryGetCandidateIntersection(&unresolved);
   if(candidate.kind==RAY_QUERY_INTERSECTION_TRIANGLE && candidate.t>=ray.tMin && candidate.t<=prefix && (candidate.geometry_index!=0u || !worldRayQueryOpaque(candidate.instance_custom_data,candidate.primitive_index))){
    result.state.x=4u;
    result.metrics.x=candidate.t;
    return result;
   }
  }
 }
 if(c.kind!=RAY_QUERY_INTERSECTION_TRIANGLE){return result;}
 if(c.geometry_index!=0u || c.instance_custom_data==0u || c.instance_custom_data>=traversalInstances[0].z/4u){result.state.x=4u;return result;}
 let row=traversalInstances[c.instance_custom_data];
 if(c.primitive_index>=(row.z>>2u)){result.state.x=4u;return result;}
 let face=faceNormals[row.y+c.primitive_index];
 let local=face.xyz;
 let n=transpose(mat3x3f(c.world_to_object[0],c.world_to_object[1],c.world_to_object[2]))*local;
 result.state=vec4u(1u,0u,1u,row.x);
 result.metrics=vec4f(c.t,0,0,1);
 result.position=vec4f(ray.origin+ray.direction*c.t,1);
 let normal=n/max(length(n),1e-20);
 // Exact coincident opposite windings cover both sides of the same plane.
 // A closest-hit tie must not turn that surface into an ordinary backface.
 result.normal=vec4f(select(normal,-normal,face.w!=0.0&&dot(ray.direction,normal)>0.0),0);
 return result;
}
fn traceWorld(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 return traceWorldRayQuery(ray,maxSteps,false);
}
fn traceWorldVisibility(ray: Ray, maxSteps: u32) -> Hit {
 return traceWorldRayQuery(ray,maxSteps,true);
}
fn worldHitCandidates(hit: Hit) -> Candidates {
 var out=Candidates(vec4u(0u,0u,hit.state.x,0u),vec4u(0xffffffffu));
 if(hit.state.x==1u){out.state=vec4u(1u,0u,hit.state.x,1u);out.ids.x=hit.state.w;}
 return out;
}

// Match ray-raster-source/ray-path-tracer exact receiver precision. A field
// voxel clearance can skip a nearby triangle and change the first surface.
fn worldSurfaceOrigin(position: vec3f, normal: vec3f, fieldBias: f32) -> vec3f {
 let bias = max(1e-4, max(max(abs(position.x), abs(position.y)), abs(position.z)) * 1e-5);
 return position + normal * bias;
}

@group(0) @binding(5) var<storage,read> cards: array<Card>;
@group(0) @binding(6) var<storage,read> cardLit: array<vec4f>;
@group(0) @binding(7) var<storage,read_write> probeRays: array<ProbeRay>;
@group(0) @binding(8) var<uniform> probeField: Field;
@group(0) @binding(16) var<storage,read> probeOrigins: array<ProbeOrigin>;
@group(0) @binding(9) var<uniform> frame: Frame;
@group(0) @binding(10) var<uniform> settings: vec4u;
@group(0) @binding(11) var albedo: texture_2d<f32>;
@group(0) @binding(12) var normal: texture_2d<f32>;
@group(0) @binding(13) var emission: texture_2d<f32>;
@group(0) @binding(14) var f0: texture_2d<f32>;
@group(0) @binding(15) var cardDepth: texture_depth_2d;


struct Frame { schedule: vec4u, cards: vec4u, atlas: vec4u, environment: vec4f, trace: vec4f, gather: vec4u, query: vec4u, expectedSource:vec4u }
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
// meta.zw: relocation offset in probe spacings from the lattice point, f16 xyz.
fn probeOffset(state: vec4u, spacing: f32) -> vec3f { return vec3f(unpack2x16float(state.z),unpack2x16float(state.w).x)*spacing; }
fn farRadianceProbeField() -> bool { return (probeField.levels.w&2u)!=0u; }
// Screen Probe Gather's radiance cache traces from the lattice. A displaced
// slot saved by an older producer has history from a different origin.
fn restartProbePlacement(entry: u32, state: vec4u) -> bool {
 return (entry&PROBE_FRESH)!=0u || (farRadianceProbeField() && any(probeOffset(state,1.0)!=vec3f(0)));
}

fn worldSceneExpected()->vec4u{return frame.expectedSource;}


fn decodeCardNormal(p: vec2f) -> vec3f {
 var n = vec3f(p,1.0-abs(p.x)-abs(p.y));
 if(n.z<0.0){n=vec3f((vec2f(1)-abs(n.yx))*select(vec2f(-1),vec2f(1),n.xy>=vec2f(0)),n.z);}
 return normalize(n);
}
struct Card { origin: vec4f, u: vec4f, v: vec4f, n: vec4f, ids: vec4u }
struct Lookup { state: vec4u, albedoRoughness: vec4f, normalDepth: vec4f, emissionMetallic: vec4f, f0: vec4f, texels: vec4u, weights: vec4f }

fn firstOwnerCard(instanceId: u32, count: u32) -> u32 {
 var lo=0u;var hi=count;
 while(lo<hi){
  let mid=lo+(hi-lo)/2u;let head=cards[mid].ids.z;
  if(head==0u){hi=mid;continue;}
  if(head>count){return 0u;}
  if(cards[head-1u].ids.x<instanceId){lo=mid+1u;}else{hi=mid;}
 }
 if(lo>=count){return 0u;}
 let head=cards[lo].ids.z;
 if(head==0u||head>count){return 0u;}
 return select(0u,head,cards[head-1u].ids.x==instanceId&&instanceId!=0xffffffffu);
}

fn lookupCardPoint(position: vec3f, hitNormal: vec3f, instanceId: u32, projectionMargin: f32, queryStatus: u32, cardCount: u32, resolution: u32) -> Lookup {
 var out=Lookup(vec4u(2u,queryStatus,0xffffffffu,instanceId),vec4f(0),vec4f(0),vec4f(0),vec4f(0),vec4u(0xffffffffu),vec4f(0));
 var best=-1.0;
 let count=min(cardCount,arrayLength(&cards));
 var cursor=firstOwnerCard(instanceId,count);var previous=0u;
 while(cursor!=0u){
  let i=cursor-1u;if(i>=count||cursor<=previous){break;}previous=cursor;
  let card=cards[i];cursor=card.ids.w;if(card.ids.x!=instanceId){break;}
  if(card.ids.y!=1u){out.state.x=3u;continue;}
  let alignment=dot(hitNormal,card.n.xyz);if(alignment<0.5){continue;}
  let rel=position-card.origin.xyz;let uv=vec2f(dot(rel,card.u.xyz)/card.u.w,dot(rel,card.v.xyz)/card.v.w);
  // The caller owns the world-space projection margin and its approximation.
  // Preserve depth/orientation tests when admitting a point outside the silhouette.
  // Interior points have exact zero edge distance. Keep that decision separate
  // from GPU distance arithmetic, especially for zero-allowance visibility hits.
  if(any(uv<vec2f(0))||any(uv>vec2f(1))){
   let edge=clamp(uv,vec2f(0),vec2f(1));
   if(length((uv-edge)*vec2f(card.u.w,card.v.w))>projectionMargin){continue;}
  }
  let depth=-dot(rel,card.n.xyz)/card.n.w;
  let pixelRadius=0.5*length(vec2f(card.u.w,card.v.w))/f32(resolution);
  let tolerance=projectionMargin+pixelRadius+card.n.w/1024.0;
  let xy=clamp(uv*f32(resolution)-vec2f(0.5),vec2f(0),vec2f(f32(resolution-1u)));
  let base=vec2u(floor(xy));let fraction=fract(xy);
  let tile=vec2u(i%(textureDimensions(f0).x/resolution),i/(textureDimensions(f0).x/resolution))*resolution;
  var texels=vec4u(0xffffffffu);var weights=vec4f(0);
  var a=vec4f(0);var e=vec4f(0);var specular=vec3f(0);var n=vec3f(0);var z=0.0;var error=0.0;var materialFlags=0u;var materialWeight=-1.0;
  for(var tap=0u;tap<4u;tap++){
   let offset=vec2u(tap&1u,tap>>1u);
   let axisWeight=select(vec2f(1)-fraction,fraction,offset>vec2u(0));let weight=axisWeight.x*axisWeight.y;
   if(weight<=0.0){continue;}
   let pixel=vec2i(tile+min(base+offset,vec2u(resolution-1u)));
   let material=textureLoad(f0,pixel,0);if((u32(material.w)&3u)!=1u){continue;}
   let frame=textureLoad(normal,pixel,0);if(dot(decodeCardNormal(frame.zw),hitNormal)<0.5){continue;}
   let sampleDepth=textureLoad(cardDepth,pixel,0);let delta=abs(depth-sampleDepth)*card.n.w;
   if(delta>tolerance){continue;}
   // Discrete material metadata follows the strongest accepted sample.
   if(weight>materialWeight){materialFlags=u32(material.w);materialWeight=weight;}
   texels[tap]=u32(pixel.y)*textureDimensions(f0).x+u32(pixel.x);weights[tap]=weight;
   a+=textureLoad(albedo,pixel,0)*weight;e+=textureLoad(emission,pixel,0)*weight;specular+=material.xyz*weight;
   n+=decodeCardNormal(frame.xy)*weight;z+=sampleDepth*weight;error+=delta*weight;
  }
  let support=dot(weights,vec4f(1));if(support<=0.0||length(n)<1e-10){continue;}
  let score=alignment-error/support/max(tolerance,1e-8)*0.1;
  if(score>best){best=score;out=Lookup(vec4u(1u,queryStatus,i,instanceId),a/support,vec4f(normalize(n),z/support),e/support,vec4f(specular/support,f32(materialFlags)),texels,weights/support);}
 }
 return out;
}

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
  if(lookup.state.x!=1u){continue;}
  var radiance=vec3f(0);var nearest=0u;
  for(var t=0u;t<4u;t++){
   if(lookup.texels[t]==0xffffffffu){continue;}
   if(lookup.weights[t]>lookup.weights[nearest]){nearest=t;}
  }
  if(!WORLD_HIT_NORMAL_EXACT && (hit.state.y&0x80000000u)==0u){
   let texel=lookup.texels[nearest];let width=textureDimensions(normal).x;
   let pixel=vec2i(i32(texel%width),i32(texel/width));
   let geometric=decodeCardNormal(textureLoad(normal,pixel,0).zw);
   if(dot(ray.direction,geometric)>0.0){return vec4f(0,0,0,2.0);}
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


fn probeEscape(p: vec3f) -> vec3f { return vec3f(0); }
fn probeSurface(p: vec3f) -> vec4f { return vec4f(0); }
fn probeVoxel() -> f32 { return 0.0; }
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
fn farProbeDirection(ray: u32, rays: u32) -> vec3f {
 // Keep the far domain's angular strata attached to its octahedral cache.
 // Equal-area UV rows admit every configured ray, including non-square counts.
 let rows=max(1u,u32(sqrt(f32(rays))));let count=rays/rows;let extra=rays%rows;
 var first=0u;var columns=count;
 for(var row=0u;row<rows;row++){
  columns=count+u32(row<extra);if(ray<first+columns){break;}first+=columns;
 }
 // Radiance cache traces texel centers so an unchanged source repeats its sample.
 let uv=vec2f((f32(ray-first)+0.5)/f32(columns),
  (f32(first)+0.5*f32(columns))/f32(rays));
 let p=uv*2.0-vec2f(1.0);
 let z=1.0-abs(p.x)-abs(p.y);
 let folded=(vec2f(1.0)-abs(p.yx))*select(vec2f(-1.0),vec2f(1.0),p>=vec2f(0.0));
 return normalize(vec3f(select(p,folded,z<0.0),z));
}
fn traceProbeDirection(probe: u32, updates: u32, ray: u32, rays: u32, far: bool) -> vec3f {
 if(far){return farProbeDirection(ray,rays);}
 return probeDirection(probe,updates,ray,rays);
}
@compute @workgroup_size(64) fn traceProbes(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let rays=frame.schedule.z;let i=linearId(gid,groups);
 if(i>=frame.schedule.y*rays){return;}
 let placed=probeOrigins[i/rays];let probe=placed.probe;
 // Stable probe identity decorrelates neighbours without tying samples to view cadence.
 let far=farRadianceProbeField();
 // A far trace interval denotes the Screen Probe cache. Its companion
 // near cache repeats its directional samples when lighting is unchanged.
 let traceUpdate=select(placed.updates,0u,bitcast<f32>(probeField.window[0].w)>0.0);
 let direction=traceProbeDirection(probe,traceUpdate,i%rays,rays,far);
 let origin=placed.position;
 let clampDistance=frame.trace.z*probeScale(probe);
 let tMin=select(0.0,bitcast<f32>(probeField.window[0].w)*probeScale(probe),far);
 if(far&&tMin>=frame.trace.x){
  probeRays[i]=ProbeRay(vec4f(0,0,0,clampDistance),vec4f(direction,3.0));
  return;
 }
 var tracedRay=Ray(origin,tMin,direction,frame.trace.x,vec4u(1u,0u,0u,0u));
 var hit=traceWorld(tracedRay,frame.query.x,bitcast<f32>(frame.query.y));
 // A start closer than one SDF voxel steps through sub-voxel walls (the trace's
 // self-hit expansion shrinks with the start distance): a ray into the nearby
 // surface that runs past it is retraced from one voxel off that surface.
 var liftAlong=0.0;
 if(!far){
  let surface=probeSurface(origin);let cosine=dot(surface.xyz,direction);
  let voxel=probeVoxel();let expected=(voxel-surface.w)/max(-cosine,1e-4)+voxel;
  if(cosine<0.0&&surface.w>0.0&&(hit.state.x!=1u||hit.metrics.x>expected)){
   liftAlong=surface.w*cosine;
   tracedRay.origin=origin+surface.xyz*surface.w;
   hit=traceWorld(tracedRay,frame.query.x,bitcast<f32>(frame.query.y));
  }
 }
 var out=ProbeRay(vec4f(0,0,0,clampDistance),vec4f(direction,3.0));
 let status=hit.state.x;
 if(status==0u){
  out.radianceDistance=vec4f(frame.environment.xyz,clampDistance);out.directionStatus.w=0.0;
 } else if(status==2u){
  out.radianceDistance=vec4f(probeEscape(origin),0.0);out.directionStatus.w=2.0;
 } else if(status==1u&&worldHitBackface(hit,tracedRay)){
  out.radianceDistance=vec4f(0,0,0,clamp(hit.metrics.x+liftAlong,0.0,clampDistance));out.directionStatus.w=2.0;
 } else if(status==1u){
   let card=worldCardRadiance(hit,frame.trace.w,!far,tracedRay);
   out.radianceDistance=vec4f(max(card.xyz,vec3f(0)),clamp(hit.metrics.x+liftAlong,0.0,clampDistance));
   out.directionStatus.w=select(4.0,1.0,card.w==1.0);
   if(card.w==2.0){out.directionStatus.w=2.0;}
 }
 probeRays[i]=out;
}
