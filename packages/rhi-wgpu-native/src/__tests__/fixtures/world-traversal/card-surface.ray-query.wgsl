enable wgpu_ray_query;
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct Hit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
struct Candidates { state: vec4u, ids: vec4u }
@group(0) @binding(0) var tlas: acceleration_structure;
@group(0) @binding(2) var<storage,read> traversalInstances: array<vec4u>;
@group(0) @binding(3) var<storage,read> faceNormals: array<vec4f>;
fn traceWorld(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 var result=Hit(vec4u(0u,0u,0u,0xffffffffu),vec4f(ray.tMax,0,0,0),vec4f(ray.origin+ray.direction*ray.tMax,1),vec4f(0));
 if(ray.mask.x==0u){return result;}
 if(traversalInstances[0].x!=0u){result.state.x=4u;return result;}
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
 result.state=vec4u(1u,0u,1u,row.x);
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
 if(hit.state.x==1u){out.state=vec4u(1u,0u,hit.state.x,1u);out.ids.x=hit.state.w;}
 return out;
}

// Match ray-raster-source/ray-path-tracer exact receiver precision. A field
// voxel clearance can skip a nearby triangle and change the first surface.
fn worldSurfaceOrigin(position: vec3f, normal: vec3f, fieldBias: f32) -> vec3f {
 let bias = max(1e-4, max(max(abs(position.x), abs(position.y)), abs(position.z)) * 1e-5);
 return position + normal * bias;
}

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


struct Frame { schedule: vec4u, cards: vec4u, atlas: vec4u, environment: vec4f, trace: vec4f, gather: vec4u, query: vec4u }
struct Field { originSpacing: vec4f, dimensionsCount: vec4u, bias: vec4f, levels: vec4u, window: array<vec4i,4>, validMin: array<vec4i,4>, validMax: array<vec4i,4> }
struct CardSurface { position: vec3f, mask: u32, normal: vec3f, valid: u32, albedo: vec4f, emission: vec4f }
struct ProbeRay { radianceDistance: vec4f, directionStatus: vec4f }
struct ProbeOrigin { position: vec3f, probe: u32, updates: u32 }
fn linearId(gid: vec3u, groups: vec3u) -> u32 { return gid.x + gid.y * groups.x * 64u; }


fn decodeCardNormal(p: vec2f) -> vec3f {
 var n = vec3f(p,1.0-abs(p.x)-abs(p.y));
 if(n.z<0.0){n=vec3f((vec2f(1)-abs(n.yx))*select(vec2f(-1),vec2f(1),n.xy>=vec2f(0)),n.z);}
 return normalize(n);
}
struct Card { origin: vec4f, u: vec4f, v: vec4f, n: vec4f, ids: vec4u }
struct Lookup { state: vec4u, albedoRoughness: vec4f, normalDepth: vec4f, emissionMetallic: vec4f, f0: vec4f, texels: vec4u, weights: vec4f }
fn lookupCardPoint(position: vec3f, hitNormal: vec3f, instanceId: u32, projectionMargin: f32, queryStatus: u32, cardCount: u32, resolution: u32) -> Lookup {
 var out=Lookup(vec4u(2u,queryStatus,0xffffffffu,instanceId),vec4f(0),vec4f(0),vec4f(0),vec4f(0),vec4u(0xffffffffu),vec4f(0));
 var best=-1.0;
 for(var i=0u;i<cardCount;i++){
  let card=cards[i];if(card.ids.x!=instanceId){continue;}
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
  if(hit.state.x!=1u&&hit.state.x!=2u){mask|=1u<<l;}
 }
 out=CardSurface(position,mask,shading,1u,textureLoad(albedo,vec2i(pixel),0),textureLoad(emission,vec2i(pixel),0));
 surfaces[texel]=out;
}
