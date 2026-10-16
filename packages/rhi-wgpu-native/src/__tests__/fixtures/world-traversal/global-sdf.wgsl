

struct Instance { inverse: mat4x4f, ids: vec4u, field: vec4u, origin: vec4f, extent: vec4f, error: vec4f }
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct SdfHit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
fn sdfTexel(m: Instance, c: vec3u) -> f32 {
  if(m.error.w>0.5){
    let edge=4u;
    let dims=(m.field.yzw+vec3u(edge-1u))/edge;
    let b=c/edge;
    let entry=fields[m.field.x+(b.z*dims.y+b.y)*dims.x+b.x];
    let p=c%edge;let local=(p.z*edge+p.y)*edge+p.x;
    return unpack2x16snorm(fields[m.field.x+entry+(local>>1u)])[local&1u]*m.extent.w;
  }
  return bitcast<f32>(fields[m.field.x+(c.z*m.field.z+c.y)*m.field.y+c.x]);
}
fn sdfValue(m: Instance, p: vec3f) -> f32 {
  let q=clamp((p-m.origin.xyz)/m.origin.w,vec3f(0),vec3f(m.field.yzw-vec3u(1u)));
  let cell=vec3u(min(floor(q),vec3f(m.field.yzw-vec3u(2u))));
  let f=q-vec3f(cell); var value=0.0;
  for(var z=0u;z<2u;z++){ for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
    let c=cell+vec3u(x,y,z); let w=select(vec3f(1)-f,f,vec3u(x,y,z)>vec3u(0));
    value+=sdfTexel(m,c)*w.x*w.y*w.z;
  }}}
  return value;
}


struct Grid { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
struct Voxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
struct Sample { distance: f32, coverage: f32, status: u32 }
fn sampleGlobal(p: vec3f) -> Sample {
 let dims=grid.dimensionsCount.xyz;
 let q=clamp((p-grid.originSpacing.xyz)/grid.originSpacing.w,vec3f(0),vec3f(dims-vec3u(1u)));
 let cell=vec3u(min(floor(q),vec3f(dims-vec3u(2u))));let f=q-vec3f(cell);
 var result=Sample(0,0,1u);
 for(var z=0u;z<2u;z++){for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
  let offset=vec3u(x,y,z);let w=select(vec3f(1)-f,f,offset>vec3u(0));let weight=w.x*w.y*w.z;
  if(weight>0.0){
   let c=cell+offset;let v=voxels[(c.z*dims.y+c.y)*dims.x+c.x];
   if(v.status!=1u){return Sample(0,0,v.status);}
   result.distance+=v.distance*weight;result.coverage+=v.coverage*weight;
  }
 }}}
 return result;
}

@group(0) @binding(0) var<storage,read> voxels: array<Voxel>;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var<storage,read> instances: array<Instance>;
@group(0) @binding(3) var<storage,read> fields: array<u32>;
@group(0) @binding(4) var<storage,read> bounds: array<ObjectBounds>;

// state: status, unavailable voxel status, steps, reserved.
// metrics: ray t, surface expansion, first sampled distance, geometry coverage.
struct Hit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
fn traceGlobal(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 var result=Hit(vec4u(0u,0,0,0),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));
 if(ray.mask.x==0u){return result;}
 let h=grid.originSpacing.w*0.5;
 // Keep one stored sample border for hit-normal differences.
 let lo=grid.originSpacing.xyz+vec3f(grid.originSpacing.w);
 let hi=grid.originSpacing.xyz+vec3f(grid.dimensionsCount.xyz-vec3u(2u))*grid.originSpacing.w;
 let start=ray.origin+ray.direction*ray.tMin;
 if(any(start<lo)||any(start>hi)){
  result.state.x=5u;result.metrics.x=ray.tMin;result.position=vec4f(start,1);return result;
 }
 var far=ray.tMax;
 for(var a=0u;a<3u;a++){
  if(ray.direction[a]>0.0){far=min(far,(hi[a]-ray.origin[a])/ray.direction[a]);}
  else if(ray.direction[a]<0.0){far=min(far,(lo[a]-ray.origin[a])/ray.direction[a]);}
 }
 let scale=max(abs(ray.direction.x),max(abs(ray.direction.y),abs(ray.direction.z)));
 let speed=scale*length(ray.direction/scale);
 var t=ray.tMin;var maxDistance=0.0;var expansion=0.0;
 for(var step=0u;step<maxSteps;step++){
  result.state.z=step+1u;let p=ray.origin+ray.direction*t;let sample=sampleGlobal(p);
  result.metrics.x=t;result.position=vec4f(p,1);
  if(sample.status!=1u){result.state.x=4u;result.state.y=sample.status;return result;}
  if(step==0u){result.metrics.z=sample.distance;}
  result.metrics.w=sample.coverage;
  if(step==0u && sample.distance<0.0){result.state.x=2u;return result;}
  maxDistance=max(maxDistance,sample.distance);
  expansion=h*clamp(maxDistance/(2.0*h),0.0,1.0);result.metrics.y=expansion;
  if(sample.distance<expansion){
   t=clamp(t+(sample.distance-expansion)/speed,ray.tMin,far);
   let hitPosition=ray.origin+ray.direction*t;
   var gradient=vec3f(0);
   for(var a=0u;a<3u;a++){
    var offset=vec3f(0);offset[a]=h;
    let positive=sampleGlobal(hitPosition+offset);let negative=sampleGlobal(hitPosition-offset);
    if(positive.status!=1u || negative.status!=1u){
     result.state.x=4u;result.state.y=select(negative.status,positive.status,positive.status!=1u);return result;
    }
    gradient[a]=positive.distance-negative.distance;
   }
   result.state.x=1u;result.metrics.x=t;result.position=vec4f(hitPosition,1);
   result.normal=vec4f(gradient/max(length(gradient),1e-20),0);return result;
  }
  let next=t+max(sample.distance,h*minStepFactor)/speed;
  if(next<=t){result.state.x=3u;return result;}
  if(next>far){
   // Only a fully covered requested interval can report an approximate miss.
   result.state.x=select(5u,0u,far==ray.tMax);
   result.metrics.x=far;result.position=vec4f(ray.origin+ray.direction*far,1);return result;
  }
  t=next;
 }
 result.state.x=3u;return result;
}


struct ObjectBounds { lo: vec4f, hi: vec4f, scale: vec4f }
struct Candidates { state: vec4u, ids: vec4u }
fn findCandidates(hit: SdfHit) -> Candidates {
 var out=Candidates(vec4u(0,0,hit.state.x,0),vec4u(0xffffffffu));
 if(hit.state.x!=1u){return out;}
 if(dot(hit.normal.xyz,hit.normal.xyz)<0.5){out.state.y=4u;return out;}
 let halfSpacing=grid.originSpacing.w*0.5;
 let world=hit.position.xyz+hit.normal.xyz*halfSpacing;
 // Association support only: this radius is not a bound on geometric error.
 let radius=3.0*halfSpacing;
 var distances=vec4f(3.402823466e+38);
 for(var i=0u;i<grid.dimensionsCount.w;i++){
  let m=instances[i];if(m.ids.w==0u){continue;}
  let b=bounds[i];let p=(m.inverse*vec4f(world,1)).xyz;
  let toBox=max(b.lo.xyz-p,p-b.hi.xyz)*b.scale.xyz;
  let boxDistance=length(max(toBox,vec3f(0)))+min(0.0,max(toBox.x,max(toBox.y,toBox.z)));
  if(boxDistance>=radius){continue;}
  if(m.field.x==0xffffffffu){out.state.y|=1u;continue;}
  let distance=max(sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz))*b.scale.w+max(boxDistance,0.0),boxDistance);
  if(abs(distance)>=radius){continue;}
  out.state.w++;
  // Signed-distance ordering with stable instance-ID ties, independent of roster order.
  var slot=4u;
  for(var k=0u;k<4u;k++){
   if(distance<distances[k]||(distance==distances[k]&&m.ids.x<out.ids[k])){slot=k;break;}
  }
  if(slot<4u){
   for(var k=3u;k>slot;k--){distances[k]=distances[k-1u];out.ids[k]=out.ids[k-1u];}
   distances[slot]=distance;out.ids[slot]=m.ids.x;
  }
 }
 out.state.x=min(out.state.w,4u);
 if(out.state.w>4u){out.state.y|=2u;}
 return out;
}

fn traceWorld(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit { return traceGlobal(ray, maxSteps, minStepFactor); }
fn worldHitCandidates(hit: Hit) -> Candidates { return findCandidates(SdfHit(hit.state,hit.metrics,hit.position,hit.normal)); }

fn worldSurfaceOrigin(position: vec3f, normal: vec3f, fieldBias: f32) -> vec3f {
 return position + normal * fieldBias;
}

@group(0) @binding(5) var<storage,read> cards: array<Card>;
@group(0) @binding(6) var<storage,read> cardLit: array<vec4f>;
@group(0) @binding(7) var<storage,read> rays: array<Ray>;
struct Traced { hit: Hit, radiance: vec4f }
@group(0) @binding(8) var<storage,read_write> traced: array<Traced>;
@group(0) @binding(9) var<uniform> parity: vec4f;
@group(0) @binding(10) var<uniform> settings: vec4u;
@group(0) @binding(11) var albedo: texture_2d<f32>;
@group(0) @binding(12) var normal: texture_2d<f32>;
@group(0) @binding(13) var emission: texture_2d<f32>;
@group(0) @binding(14) var f0: texture_2d<f32>;
@group(0) @binding(15) var cardDepth: texture_depth_2d;


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

fn worldCardRadiance(hit: Hit, projectionMargin: f32, pointSample: bool) -> vec4f {
 let candidates=worldHitCandidates(hit);
 if(candidates.state.y!=0u){return vec4f(0);}
 for(var k=0u;k<candidates.state.x;k++){
  let lookup=lookupCardPoint(hit.position.xyz,hit.normal.xyz,candidates.ids[k],projectionMargin,hit.state.x,settings.x,settings.y);
  if(lookup.state.x!=1u){continue;}
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

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x>=arrayLength(&rays)){return;}
 let hit=traceWorld(rays[gid.x],settings.w,parity.y);
 traced[gid.x]=Traced(hit,worldCardRadiance(hit,parity.x,false));
}
