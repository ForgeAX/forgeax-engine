import { SDF_SAMPLE_WGSL } from '../raytracing/sdf-query';
import { advancedStockhamButterflyWgsl } from './advanced-fft-shader';

export const DISPERSIVE_MAX_COLUMN_INTERVALS = 128;

export const DISPERSIVE_QUERY_SHADER = `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var outputTile:texture_storage_2d<r32float,write>;
@group(0) @binding(2) var<storage,read> p:array<vec4<f32>>;
@compute @workgroup_size(8,8) fn sampleQuery(@builtin(global_invocation_id) id:vec3<u32>){
  if(any(id.xy>=vec2<u32>(p[1].xy))){return;}
  let n=i32(p[0].z);let cell=(vec2<i32>(id.xy)+vec2<i32>(p[0].xy)+vec2<i32>(n*2))%n;
  textureStore(outputTile,vec2<i32>(id.xy)+vec2<i32>(0,i32(p[0].w)),vec4<f32>(textureLoad(source,cell,0).x));
}
@compute @workgroup_size(8,8) fn clearQuery(@builtin(global_invocation_id) id:vec3<u32>){
  if(any(id.xy>=vec2<u32>(p[1].xy))){return;}
  textureStore(outputTile,vec2<i32>(id.xy)+vec2<i32>(0,i32(p[0].w)),vec4<f32>(0.0));
}`;

/** One geometry source, two wave variables and a same-field foam history. */
let rgba16floatDispersiveOceanSource: string | undefined;
let rgba32floatDispersiveOceanSource: string | undefined;

export function dispersiveOceanShader(format: 'rgba16float' | 'rgba32float'): string {
  if (format === 'rgba16float') {
    if (rgba16floatDispersiveOceanSource === undefined)
      rgba16floatDispersiveOceanSource = buildDispersiveOceanShader(format);
    return rgba16floatDispersiveOceanSource;
  }
  if (format === 'rgba32float') {
    if (rgba32floatDispersiveOceanSource === undefined)
      rgba32floatDispersiveOceanSource = buildDispersiveOceanShader(format);
    return rgba32floatDispersiveOceanSource;
  }
  return buildDispersiveOceanShader(format);
}

function buildDispersiveOceanShader(format: 'rgba16float' | 'rgba32float'): string {
  return `
const TAU=6.283185307179586;
struct RigidPrimitive { inverse:mat4x4<f32>, previous:mat4x4<f32>, shape:vec4<f32>, field:vec4<f32> }
@group(0) @binding(0) var inputGrid:texture_2d<f32>;
@group(0) @binding(1) var outputGrid:texture_storage_2d<rgba32float,write>;
@group(0) @binding(2) var<storage,read> p:array<vec4<f32>>;
@group(0) @binding(3) var sourceGrid:texture_2d<f32>;
@group(0) @binding(4) var outputNormal:texture_storage_2d<${format},write>;
@group(0) @binding(5) var priorSpatial:texture_2d<f32>;
@group(0) @binding(6) var priorSource:texture_2d<f32>;
@group(0) @binding(7) var outputSource:texture_storage_2d<rgba32float,write>;
@group(0) @binding(8) var outputState:texture_storage_2d<rgba32float,write>;
@group(0) @binding(9) var outputHeight:texture_storage_2d<rgba32float,write>;
@group(0) @binding(10) var outputFoam:texture_storage_2d<rgba32float,write>;
@group(0) @binding(11) var<storage,read> slabs:array<f32>;
@group(0) @binding(12) var outputOccupancy:texture_storage_2d<rgba32float,write>;
@group(0) @binding(14) var outputMapping:texture_storage_2d<rgba32float,write>;
@group(0) @binding(17) var<storage,read> primitives:array<RigidPrimitive>;
@group(0) @binding(18) var<storage,read> instances:array<Instance>;
@group(0) @binding(19) var<storage,read> fields:array<u32>;
@group(0) @binding(20) var<storage,read> waveImpulses:array<vec4<f32>>;
${SDF_SAMPLE_WGSL}
var<private> intervals:array<vec2<f32>,${DISPERSIVE_MAX_COLUMN_INTERVALS}>;
var<private> intervalCount:u32;
var<private> columnTotal:f32;
fn insertInterval(value:vec2<f32>){
  if(value.x>=value.y){return;}
  var at=intervalCount;
  loop{if(at==0u){break;}if(intervals[at-1u].x<=value.x){break;}intervals[at]=intervals[at-1u];at--;}
  intervals[at]=value;intervalCount++;
}
fn slabRay(o:vec3<f32>,d:vec3<f32>,lo:vec3<f32>,hi:vec3<f32>)->vec2<f32>{
  var near=-p[1].x;var far=0.0;
  for(var axis=0u;axis<3u;axis++){
    if(abs(d[axis])<0.00000001){if(o[axis]<lo[axis]||o[axis]>hi[axis]){return vec2<f32>(1.0,-1.0);}}
    else{let a=(lo[axis]-o[axis])/d[axis];let b=(hi[axis]-o[axis])/d[axis];near=max(near,min(a,b));far=min(far,max(a,b));}
  }
  return vec2<f32>(near,far);
}
fn sphereRay(o:vec3<f32>,d:vec3<f32>,center:vec3<f32>,radius:f32)->vec2<f32>{
  let v=o-center;let a=dot(d,d);let b=dot(v,d);let c=dot(v,v)-radius*radius;let disc=b*b-a*c;
  if(disc<0.0){return vec2<f32>(1.0,-1.0);}
  let root=sqrt(max(0.0,disc));return vec2<f32>(max(-p[1].x,(-b-root)/a),min(0.0,(-b+root)/a));
}
fn primitiveRay(primitive:RigidPrimitive,xz:vec2<f32>)->vec2<f32>{
  let o=(primitive.inverse*vec4<f32>(xz.x,0.0,xz.y,1.0)).xyz;
  let d=(primitive.inverse*vec4<f32>(0.0,1.0,0.0,0.0)).xyz;
  if(primitive.shape.x<0.5){return sphereRay(o,d,vec3<f32>(0.0),primitive.shape.y);}
  if(primitive.shape.x>1.5){return slabRay(o,d,-primitive.shape.yzw,primitive.shape.yzw);}
  let r=primitive.shape.y;let half=primitive.shape.z;
  var value=vec2<f32>(1.0,-1.0);let a=dot(d.xz,d.xz);let b=dot(o.xz,d.xz);let c=dot(o.xz,o.xz)-r*r;
  if(a>0.00000001){let disc=b*b-a*c;if(disc>=0.0){let root=sqrt(disc);value=vec2<f32>((-b-root)/a,(-b+root)/a);}}
  else if(c<=0.0){value=vec2<f32>(-p[1].x,0.0);}
  if(abs(d.y)>0.00000001){let low=(-half-o.y)/d.y;let high=(half-o.y)/d.y;value=vec2<f32>(max(value.x,min(low,high)),min(value.y,max(low,high)));}
  else if(abs(o.y)>half){value=vec2<f32>(1.0,-1.0);}
  for(var end=0u;end<2u;end++){
    let cap=sphereRay(o,d,vec3<f32>(0.0,select(-half,half,end==1u),0.0),r);
    if(cap.x<cap.y){if(value.x>=value.y){value=cap;}else{value=vec2<f32>(min(value.x,cap.x),max(value.y,cap.y));}}
  }
  return vec2<f32>(max(-p[1].x,value.x),min(0.0,value.y));
}
fn fieldIntervals(instance:Instance,xz:vec2<f32>){
  let o=(instance.inverse*vec4<f32>(xz.x,0.0,xz.y,1.0)).xyz;
  let d=(instance.inverse*vec4<f32>(0.0,1.0,0.0,0.0)).xyz;
  let span=slabRay(o,d,instance.origin.xyz,instance.extent.xyz);
  if(span.x>=span.y){return;}
  let count=u32(ceil((span.y-span.x)/p[6].y));
  let dy=(span.y-span.x)/f32(count);var before=sdfValue(instance,o+d*span.x);
  var start=span.x;var inside=before<=0.0;
  for(var step=1u;step<=count;step++){
    let y=span.x+f32(step)*dy;let value=sdfValue(instance,o+d*y);let nextInside=value<=0.0;
    if(nextInside!=inside){let crossing=y-dy+dy*clamp(before/(before-value),0.0,1.0);
      if(nextInside){start=crossing;}else{insertInterval(vec2<f32>(start,crossing));}
    }
    inside=nextInside;before=value;
  }
  if(inside){insertInterval(vec2<f32>(start,span.y));}
}
fn columnAt(xz:vec2<f32>,group:f32)->vec4<f32>{
  intervalCount=0u;
  for(var element=0u;element<u32(p[6].x);element++){
    let primitive=primitives[element];
    if(group>=0.0&&primitive.field.w!=group){continue;}
    if(primitive.field.x>0.5){
      var duplicate=false;for(var prior=0u;prior<element;prior++){if(primitives[prior].field.x==primitive.field.x&&primitives[prior].field.w==primitive.field.w){duplicate=true;break;}}
      if(!duplicate){fieldIntervals(instances[u32(primitive.field.x)-1u],xz);}
    }else{insertInterval(primitiveRay(primitive,xz));}
  }
  var thickness=vec4<f32>(0.0);var total=0.0;var at=0u;
  loop{
    if(at>=intervalCount){break;}
    var merged=intervals[at];at++;
    loop{if(at>=intervalCount){break;}if(intervals[at].x>merged.y){break;}merged.y=max(merged.y,intervals[at].y);at++;}
    total+=merged.y-merged.x;
    for(var lane=0u;lane<4u;lane++){
      let lower=slabs[u32(p[5].x)+lane];let upper=slabs[u32(p[5].x)+lane+1u];
      thickness[lane]+=max(0.0,min(merged.y,upper)-max(merged.x,lower));
    }
  }
  columnTotal=total;return thickness;
}
@compute @workgroup_size(8,8) fn columns(@builtin(global_invocation_id) id:vec3<u32>){
  let n=u32(p[0].x);if(any(id.xy>=vec2<u32>(n))){return;}
  let xz=((vec2<f32>(id.xy)+0.5)/f32(n)-0.5)*p[0].y;
  let thickness=columnAt(xz,0.0);var total=columnTotal;
  if(p[5].x<0.5&&p[6].w>0.0){let allThickness=columnAt(xz,-1.0);total=columnTotal;}
  textureStore(outputGrid,vec2<i32>(id.xy),thickness);
  if(p[5].x<0.5){textureStore(outputOccupancy,vec2<i32>(id.xy),vec4<f32>(total,0.0,0.0,1.0));}
}
// Only the current submerged union's facing boundary exports displaced water.
// Retreating geometry and passive heave are not new entry sources. Each body's
// velocity is in m/s and each slab thickness is in m, so flux is in m^2/s.
@compute @workgroup_size(8,8) fn transportcolumns(@builtin(global_invocation_id) id:vec3<u32>){
  let n=u32(p[0].x);if(any(id.xy>=vec2<u32>(n))){return;}
  let index=vec2<i32>(id.xy);let velocity=p[3].xy;
  var fx=vec4<f32>(0.0);var fz=vec4<f32>(0.0);
  if(dot(velocity,velocity)>0.0){
    let dx=p[0].y/f32(n);let xz=((vec2<f32>(id.xy)+0.5)/f32(n)-0.5)*p[0].y;
    let thickness=columnAt(xz,p[6].w);
    let left=columnAt(xz-vec2<f32>(dx,0.0),p[6].w);let leftTotal=columnTotal;
    let right=columnAt(xz+vec2<f32>(dx,0.0),p[6].w);let rightTotal=columnTotal;
    let below=columnAt(xz-vec2<f32>(0.0,dx),p[6].w);let belowTotal=columnTotal;
    let above=columnAt(xz+vec2<f32>(0.0,dx),p[6].w);let aboveTotal=columnTotal;
    let gradient=vec2<f32>(rightTotal-leftTotal,aboveTotal-belowTotal)/(2.0*dx);
    let magnitude=length(gradient);
    if(magnitude>0.00000001){
      let outward=-gradient/magnitude;let speed=max(0.0,dot(velocity,outward));
      fx=thickness*(speed*outward.x);fz=thickness*(speed*outward.y);
    }
  }
  textureStore(outputGrid,index,fx);textureStore(outputOccupancy,index,fz);
}
// Periodic central differences telescope to zero DC; there is no net water
// injection and no global compensation pulse. The exterior crest propagates
// through the same depth-resolved modes as entry waves.
@compute @workgroup_size(8,8) fn transportdivergence(@builtin(global_invocation_id) id:vec3<u32>){
  let n=i32(p[0].x);let index=vec2<i32>(id.xy);if(any(index>=vec2<i32>(n))){return;}
  let left=(index+vec2<i32>(n-1,n))%n;let right=(index+vec2<i32>(1,0))%n;
  let below=(index+vec2<i32>(n,n-1))%n;let above=(index+vec2<i32>(0,1))%n;
  let rate=-(textureLoad(inputGrid,right,0)-textureLoad(inputGrid,left,0)+textureLoad(sourceGrid,above,0)-textureLoad(sourceGrid,below,0))/(2.0*p[0].y/p[0].x);
  textureStore(outputGrid,index,rate);
}
${advancedStockhamButterflyWgsl(true)}
fn waveNumber(index:vec2<i32>)->f32{
  let n=i32(p[0].x);let signed=select(index,index-vec2<i32>(n),index>vec2<i32>(n/2));
  return length(vec2<f32>(signed))*TAU/p[0].y;
}
// k*depth is nonnegative. Preserve small inputs and avoid overflowing positive exponentials.
fn finiteDepthFactor(x:f32)->f32{
  if(x<0.25){let x2=x*x;return x*(1.0+x2*(-1.0/3.0+x2*(2.0/15.0+x2*(-17.0/315.0+x2*(62.0/2835.0)))));}
  let decay=exp(-2.0*x);return (1.0-decay)/(1.0+decay);
}
// Preserve cos(x)-1 and sin(x)/x through the GPU builtins' absolute approximation error.
fn phaseIntegrals(x:f32)->vec2<f32>{
  if(x==0.0){return vec2<f32>(0.0,1.0);}
  let reduced=x-round(x/TAU)*TAU;let x2=reduced*reduced;
  let cosMinusOne=x2*(-0.5+x2*(1.0/24.0+x2*(-1.0/720.0+x2*(1.0/40320.0+x2*(-1.0/3628800.0+
    x2*(1.0/479001600.0+x2*(-1.0/87178291200.0+x2*(1.0/20922789888000.0-x2/6402373705728000.0))))))));
  let sinc=1.0+x2*(-1.0/6.0+x2*(1.0/120.0+x2*(-1.0/5040.0+x2*(1.0/362880.0+x2*(-1.0/39916800.0+
    x2*(1.0/6227020800.0+x2*(-1.0/1307674368000.0+x2*(1.0/355687428096000.0-x2/121645100408832000.0))))))));
  return vec2<f32>(cosMinusOne,(reduced/x)*sinc);
}
fn layerWeight(k:f32,lo:f32,hi:f32)->f32{
  if(k<0.0000001){return 1.0;}
  let h=p[1].x;
  return (exp(k*hi)-exp(k*lo)+exp(-k*(lo+2.0*h))-exp(-k*(hi+2.0*h)))/(k*(hi-lo)*(1.0+exp(-2.0*k*h)));
}
@compute @workgroup_size(8,8) fn clear(@builtin(global_invocation_id) id:vec3<u32>){
  if(any(id.xy>=vec2<u32>(u32(p[0].x)))){return;}textureStore(outputGrid,vec2<i32>(id.xy),vec4<f32>(0.0));
}
@compute @workgroup_size(8,8) fn project(@builtin(global_invocation_id) id:vec3<u32>){
  let n=i32(p[0].x);let index=vec2<i32>(id.xy);if(any(index>=vec2<i32>(n))){return;}
  let mirrored=(vec2<i32>(n)-index)%n;let value=textureLoad(inputGrid,index,0);let opposite=textureLoad(inputGrid,mirrored,0);
  let spectra=array<vec2<f32>,4>(0.5*(value.xy+opposite.xy*vec2<f32>(1.0,-1.0)),
    0.5*vec2<f32>(value.y+opposite.y,opposite.x-value.x),
    0.5*(value.zw+opposite.zw*vec2<f32>(1.0,-1.0)),
    0.5*vec2<f32>(value.w+opposite.w,opposite.z-value.z));
  let k=waveNumber(index);var projected=textureLoad(sourceGrid,index,0);var contribution=vec2<f32>(0.0);
  for(var lane=0u;lane<4u;lane++){contribution+=spectra[lane]*layerWeight(k,slabs[u32(p[5].x)+lane],slabs[u32(p[5].x)+lane+1u]);}
  if(p[5].y<0.5){projected=vec4<f32>(projected.xy+contribution,projected.zw);}
  else{projected=vec4<f32>(projected.xy,projected.zw+contribution);}
  textureStore(outputGrid,index,projected);
}
@compute @workgroup_size(8,8) fn prepare(@builtin(global_invocation_id) id:vec3<u32>){
  if(any(id.xy>=vec2<u32>(u32(p[0].x)))){return;}let index=vec2<i32>(id.xy);
  var state=vec4<f32>(0.0);if(p[4].y<0.5){state=textureLoad(priorSpatial,index,0);}
  textureStore(outputGrid,index,vec4<f32>(state.x,0.0,state.y,0.0));
}
@compute @workgroup_size(8,8) fn advance(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);if(any(id.xy>=vec2<u32>(u32(p[0].x)))){return;}
  let state=textureLoad(inputGrid,index,0);let source=textureLoad(sourceGrid,index,0);let current=source.xy;
  var old=current;if(p[4].z<0.5){old=textureLoad(priorSource,index,0).xy;}
  let dt=p[0].z;let k=waveNumber(index);var eta=state.xy;var v=state.zw;
  if(dt>0.0){
    let delta=(current-old)*p[2].x+source.zw*dt*p[7].w;
    if(k<0.0000001){eta+=v*dt+delta;}
    else{let omega2=p[1].y*k*finiteDepthFactor(k*p[1].x);let phase=sqrt(omega2)*dt;
      let integrals=phaseIntegrals(phase);let c=1.0+integrals.x;
      eta=state.xy*c+(state.zw*dt+delta)*integrals.y;
      v=state.zw*c-state.xy*(omega2*dt*integrals.y)+delta*(integrals.x/dt);
      // Attenuate free modes, not their source history or zero-frequency water volume.
      let envelope=exp(-p[7].z*dt);eta*=envelope;v*=envelope;
    }
  }
  // The Laplacian of a Gaussian supplies localized momentum with exactly zero DC.
  // Its analytic transform avoids a resolution-dependent sampled volume correction.
  if(k>0.0000001){
    let omega=sqrt(p[1].y*k*finiteDepthFactor(k*p[1].x));
    let cell=p[0].y/p[0].x;
    let signedIndex=vec2<f32>(select(index,index-vec2<i32>(i32(p[0].x)),index>vec2<i32>(i32(p[0].x/2.0))));
    let waveVector=signedIndex*TAU/p[0].y;
    for(var impulseIndex=0u;impulseIndex<u32(p[4].w);impulseIndex++){
      let impulse=waveImpulses[impulseIndex*2u];let age=waveImpulses[impulseIndex*2u+1u].x;
      let radius2=impulse.z*impulse.z;
      let amplitude=-impulse.w*0.5*TAU*radius2*radius2*k*k*exp(-0.5*radius2*k*k)/(cell*cell);
      let angle=-dot(waveVector,impulse.xy+vec2<f32>(0.5*p[0].y-0.5*cell));
      let spectral=amplitude*vec2<f32>(cos(angle),sin(angle))*exp(-p[7].z*age);
      eta+=spectral*sin(omega*age)/omega;
      v+=spectral*cos(omega*age);
    }
  }
  textureStore(outputGrid,index,vec4<f32>(eta,v));textureStore(outputSource,index,source);
}
fn heightAt(index:vec2<i32>)->f32{
  let n=i32(p[0].x);return textureLoad(inputGrid,(index+vec2<i32>(n))%n,0).x/(p[0].x*p[0].x);
}
fn boundaryDamping(index:vec2<i32>)->f32{
  if(p[1].z<=0.0){return 1.0;}
  let n=p[0].x;let at=vec2<f32>(index);let dx=p[0].y/n;
  let edge=min(min(at.x+0.5,at.y+0.5),min(n-at.x-0.5,n-at.y-0.5))*dx;
  let mask=1.0-smoothstep(0.0,p[1].z,edge);return exp(-p[1].w*p[0].z*mask*mask);
}
fn surfaceAt(index:vec2<i32>)->f32{
  let n=i32(p[0].x);let wrapped=(index+vec2<i32>(n))%n;
  return heightAt(wrapped)*boundaryDamping(wrapped);
}
@compute @workgroup_size(8,8) fn publishquery(@builtin(global_invocation_id) id:vec3<u32>){
  if(any(id.xy>=vec2<u32>(u32(p[0].x)))){return;}
  let index=vec2<i32>(id.xy);let inverse=textureLoad(inputGrid,index,0)/(p[0].x*p[0].x);
  let damping=boundaryDamping(index);
  textureStore(outputState,index,vec4<f32>(inverse.x*damping,inverse.z*damping,0.0,0.0));
}
@compute @workgroup_size(8,8) fn publish(@builtin(global_invocation_id) id:vec3<u32>){
  let n=i32(p[0].x);let index=vec2<i32>(id.xy);if(any(index>=vec2<i32>(n))){return;}
  let normalization=p[0].x*p[0].x;let inverse=textureLoad(inputGrid,index,0)/normalization;
  let dx=p[0].y/p[0].x;
  let slope=vec2<f32>(surfaceAt(index+vec2<i32>(1,0))-surfaceAt(index-vec2<i32>(1,0)),surfaceAt(index+vec2<i32>(0,1))-surfaceAt(index-vec2<i32>(0,1)))/(2.0*dx);
  let damping=boundaryDamping(index);
  let eta=inverse.x*damping;let velocity=inverse.z*damping;
  var previousFoam=0.0;if(p[4].y<0.5){previousFoam=textureLoad(priorSpatial,index,0).z;}
  let foam=clamp(previousFoam*exp(-p[2].w*p[0].z)+max(0.0,length(slope)-p[2].y)*p[2].z*p[0].z,0.0,1.0)*damping;
  let normal=normalize(vec3<f32>(-slope,1.0));
  textureStore(outputNormal,index,vec4<f32>(normal,eta));
  textureStore(outputState,index,vec4<f32>(eta,velocity,foam,(eta-inverse.x)*dx*dx));
  textureStore(outputHeight,index,vec4<f32>(p[0].w+eta,0.0,0.0,0.0));
  textureStore(outputFoam,index,vec4<f32>(foam,0.0,0.0,1.0));
}
@compute @workgroup_size(8,8) fn mapping(@builtin(global_invocation_id) id:vec3<u32>){
  if(all(id.xy<vec2<u32>(2u))){textureStore(outputMapping,vec2<i32>(id.xy),select(vec4<f32>(0.0,1.0,1.0,p[0].w),vec4<f32>(p[7].xy,p[0].y,p[0].y),id.x==0u));}
}
`;
}
