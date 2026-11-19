import {
  WATER_ADVANCED_DEBUG_WRITER_ORDER,
  type WaterAdvancedDebugWriter,
  type WaterAdvancedStageProfile,
} from '@forgeax/engine-types';
import { ADVANCED_GRID_VERTEX_WGSL } from './advanced-grid-mesh';
import { ADVANCED_RIGID_COLLISION_WGSL } from './advanced-rigid-collision-shader';

const DEBUG_WRITER_VALUES: Record<WaterAdvancedDebugWriter['kind'], string> = {
  'height-collider-speed': 'vec4<f32>(value.x-p[12].z,collision.y,length(value.zw)*p[22].x,0.0)',
  normal: 'vec4<f32>(surfaceNormal(index),0.0)',
  'cell-speed': 'vec4<f32>(length(value.zw),0.0,0.0,0.0)',
  'depth-collider': 'vec4<f32>(value.y,collision.y,0.0,0.0)',
  'water-info-speed': 'vec4<f32>(length(waterInfoVelocity(at)),0.0,0.0,0.0)',
  'bottom-contour': 'vec4<f32>(0.0,0.0,0.0,collision.x-p[12].z)',
};
const debugWrites = (profile: WaterAdvancedStageProfile, output: string) =>
  WATER_ADVANCED_DEBUG_WRITER_ORDER[profile]
    .map((kind, index) => `if(p[21][${index}]>0.5){${output}=${DEBUG_WRITER_VALUES[kind]};}`)
    .join('\n');

/** Grid channels stay in lattice u/v; only input/output transforms touch world XZ. */
export function advancedShallowShader(
  format: 'rgba16float' | 'rgba32float',
  waterInfo: boolean,
  rigid = false,
  history: 'seed' | 'retained' = 'retained',
): string {
  return `
@group(0) @binding(0) var previousGrid: texture_2d<f32>;
@group(0) @binding(1) var previousField: texture_2d<f32>;
@group(0) @binding(2) var previousFoam: texture_2d<f32>;
@group(0) @binding(3) var nextGrid: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var nextField: texture_storage_2d<rgba32float, write>;
@group(0) @binding(5) var nextFoam: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var<storage, read> p: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> impulses: array<vec4<f32>>;
${ADVANCED_GRID_VERTEX_WGSL}
@group(0) @binding(8) var<storage, read_write> vertices: array<GridVertex>;
@group(0) @binding(9) var<storage, read_write> triangles: array<u32>;
@group(0) @binding(15) var previousNormal: texture_2d<f32>;
${waterInfo ? '@group(0) @binding(10) var waterInfo: texture_2d_array<f32>;' : ''}
${rigid ? ADVANCED_RIGID_COLLISION_WGSL : ''}
const LEFT = vec2<i32>(-1, 0);
const RIGHT = vec2<i32>(1, 0);
const DOWN = vec2<i32>(0, -1);
const UP = vec2<i32>(0, 1);
fn size() -> vec2<i32> { return vec2<i32>(p[0].yz); }
fn grid(index: vec2<i32>) -> vec4<f32> { return textureLoad(previousGrid, clamp(index, vec2<i32>(0), size()-1), 0); }
fn field(index: vec2<i32>) -> vec4<f32> { return textureLoad(previousField, clamp(index, vec2<i32>(0), size()-1), 0); }
fn foam(index: vec2<i32>) -> vec4<f32> { return textureLoad(previousFoam, clamp(index, vec2<i32>(0), size()-1), 0); }
fn normalAt(index: vec2<i32>) -> vec4<f32> { return textureLoad(previousNormal, clamp(index, vec2<i32>(0), size()-1), 0); }
fn rotate(v: vec2<f32>, angle: f32) -> vec2<f32> { return vec2<f32>(cos(angle)*v.x-sin(angle)*v.y, sin(angle)*v.x+cos(angle)*v.y); }
fn world(index: vec2<i32>) -> vec2<f32> { return p[1].xy + rotate(((vec2<f32>(index)+0.5)/vec2<f32>(size())-0.5)*p[1].zw,p[2].x); }
fn bilinear(index: vec2<f32>) -> vec4<f32> {
  let low=vec2<i32>(floor(index)); let t=fract(index);
  return mix(mix(grid(low),grid(low+RIGHT),t.x),mix(grid(low+UP),grid(low+UP+RIGHT),t.x),t.y);
}
fn sampleFoam(index:vec2<f32>)->f32 {
  let low=vec2<i32>(floor(index));let t=fract(index);
  return mix(mix(foam(low).x,foam(low+RIGHT).x,t.x),mix(foam(low+UP).x,foam(low+UP+RIGHT).x,t.x),t.y);
}
fn blurWeight(offset:vec2<i32>,radius:i32)->f32 { return length(vec2<f32>(1.0)-abs(vec2<f32>(offset))/f32(radius+1)); }
fn blurredVelocity(index:vec2<i32>,radius:i32)->vec2<f32> {
  var sum=vec2<f32>(0.0);var total=0.0;
  for(var x=-radius;x<=radius;x++){for(var y=-radius;y<=radius;y++){
    let offset=vec2<i32>(x,y);let weight=blurWeight(offset,radius);sum+=grid(index+offset).zw*weight;total+=weight;
  }}
  return select(sum,sum/max(total,0.00001),total>0.00001);
}
fn blurredNormal(index:vec2<i32>,radius:i32)->vec3<f32> {
  var sum=vec3<f32>(0.0);var total=0.0;
  for(var x=-radius;x<=radius;x++){for(var y=-radius;y<=radius;y++){
    let offset=vec2<i32>(x,y);let weight=blurWeight(offset,radius);sum+=normalAt(index+offset).xyz*weight;total+=weight;
  }}
  if(total>0.00001){sum/=total;}
  let magnitude=length(sum);return select(sum,sum/max(magnitude,0.00001),magnitude>0.00001);
}
fn emissionCriterion(criterion:vec4<f32>,value:f32)->f32 {
  if(criterion.z==0.0){return 0.0;}
  return smoothstep(criterion.x,criterion.y,value)*criterion.z;
}
struct FoamEmissionResult { criteria:vec4<f32>, amount:f32 }
fn foamEmission(index:vec2<i32>,dt:f32)->FoamEmissionResult {
  let unit=(vec2<f32>(index)+0.5)/vec2<f32>(size());let border=2.0/vec2<f32>(size());let value=grid(index);
  if(any(unit<=border)||any(unit>=vec2<f32>(1.0)-border)||value.y<=0.0000001){return FoamEmissionResult(vec4<f32>(0.0),0.0);}
  let dx=p[1].z/f32(size().x);
  let vx1=grid(index+UP).z;let vx0=grid(index+DOWN).z;
  let vy1=grid(index+RIGHT).w;let vy0=grid(index+LEFT).w;
  let velocity=0.5*vec2<f32>(vx1+vx0,vy1+vy0);let speed=length(velocity);
  let vorticity=abs(((vx1-vx0)-(vy1-vy0))/(2.0*dx));
  let normal=normalAt(index).xyz;
  let curvature=abs(0.5*((1.0-dot(normal,normalAt(index+RIGHT).xyz))+(1.0-dot(normal,normalAt(index+UP).xyz))));
  let depthDifference=bilinear(vec2<f32>(index)+velocity*dt/dx).y-value.y;
  let criteria=vec4<f32>(emissionCriterion(p[18],speed),emissionCriterion(p[17],curvature),emissionCriterion(p[16],vorticity),emissionCriterion(p[19],depthDifference));
  let amount=max(max(criteria.x,criteria.y),max(criteria.z,criteria.w));
  let restriction=smoothstep(p[20].x,p[20].y,value.y)*smoothstep(p[20].z,p[20].w,speed);
  return FoamEmissionResult(criteria,clamp(amount*p[15].y*restriction,0.0,p[15].z));
}
fn cubic(a: vec4<f32>, b: vec4<f32>, c: vec4<f32>, d: vec4<f32>, t:f32) -> vec4<f32> {
  return b+0.5*t*(c-a+t*(2.0*a-5.0*b+4.0*c-d+t*(3.0*(b-c)+d-a)));
}
fn sampleGrid(index: vec2<f32>) -> vec4<f32> {
  if(p[7].x<0.5){return bilinear(index);}
  let low=vec2<i32>(floor(index)); let t=fract(index);
  var rows:array<vec4<f32>,4>;
  for(var y=0;y<4;y++){let q=low+vec2<i32>(0,y-1);rows[y]=cubic(grid(q+LEFT),grid(q),grid(q+RIGHT),grid(q+2*RIGHT),t.x);}
  return cubic(rows[0],rows[1],rows[2],rows[3],t.y);
}
fn minmod(a:f32,b:f32) -> f32 { return select(0.0, sign(a)*min(abs(a),abs(b)), a*b>0.0); }
fn surfaceNormal(index:vec2<i32>)->vec3<f32> {
  let value=grid(index);let dx=p[1].zw/vec2<f32>(size());
  let crossed=cross(vec3<f32>(dx.x,0.0,grid(index+RIGHT).x-value.x),vec3<f32>(0.0,dx.y,grid(index+UP).x-value.x));
  let magnitude=length(crossed);
  return select(vec3<f32>(0.0,0.0,1.0),crossed/max(magnitude,0.000000001),value.y>0.0000001&&magnitude>0.000000001);
}
fn faceDepth(index:vec2<i32>,axis:vec2<i32>,velocity:f32) -> f32 {
  let before=index-axis; let c=grid(index).y;let b=grid(before).y;
  var result=select(0.5*(c+b),select(c,b,velocity>0.0),p[11].x>0.5);
  if(p[7].z>0.5){
    if(velocity>0.0){result=b+0.5*minmod(b-grid(before-axis).y,c-b);}
    else{result=c-0.5*minmod(c-b,grid(index+axis).y-c);}
  }
  return max(0.0,result);
}
fn terrain(at:vec2<f32>) -> vec3<f32> {
${
  waterInfo
    ? `
  let uv=(at-p[4].xy)/p[4].zw+0.5;
  if(all(uv>=vec2<f32>(0.0))&&all(uv<=vec2<f32>(1.0))){
    let dimensions=vec2<i32>(textureDimensions(waterInfo));
    let value=textureLoad(waterInfo,clamp(vec2<i32>(uv*vec2<f32>(dimensions)),vec2<i32>(0),dimensions-1),i32(p[5].w),0);
    let bottom=mix(p[5].z,p[5].y,clamp(value.w,0.0,1.0));
    let height=mix(p[5].x,p[5].y,clamp(value.z,0.0,1.0));
    return vec3<f32>(bottom,height,select(0.0,1.0,value.z>0.0));
  }
`
    : ''
}
  return vec3<f32>(p[2].y-p[2].z,p[2].y,${waterInfo ? '0.0' : '1.0'});
}
fn waterInfoVelocity(at:vec2<f32>)->vec2<f32> {
${
  waterInfo
    ? `
  let uv=(at-p[4].xy)/p[4].zw+0.5;
  if(all(uv>=vec2<f32>(0.0))&&all(uv<=vec2<f32>(1.0))){
    let dimensions=vec2<i32>(textureDimensions(waterInfo));
    let sample=textureLoad(waterInfo,clamp(vec2<i32>(uv*vec2<f32>(dimensions)),vec2<i32>(0),dimensions-1),i32(p[5].w),0);
    return (sample.xy-vec2<f32>(0.5))*2.0*p[22].w;
  }`
    : ''
}
  return vec2<f32>(0.0);
}
@compute @workgroup_size(8,8) fn initialize(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);if(any(index>=size())){return;}
  textureStore(nextGrid,index,vec4<f32>(0.0));
  textureStore(nextField,index,vec4<f32>(0.0));
  textureStore(nextFoam,index,vec4<f32>(0.0));
  textureStore(normalOutput,index,vec4<f32>(0.0,0.0,1.0,0.0));
}
@compute @workgroup_size(8,8) fn stage(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);let stageId=u32(p[0].x);
  if(stageId==0u&&all(index<=size())){
    let uv=vec2<f32>(index)/vec2<f32>(size());let position=(uv-0.5)*p[1].zw;
    let vertexIndex=id.y*u32(size().x+1)+id.x;
    vertices[vertexIndex]=GridVertex(vec4<f32>(position.x,0.0,position.y,1.0),vec4<f32>(0.0,1.0,0.0,0.0),vec4<f32>(1.0,0.0,0.0,-1.0),vec4<f32>(uv,0.0,0.0),vec4<f32>(1.0));
  }
  if(any(index>=size())){return;}
  let dx=p[1].zw/vec2<f32>(size());let dt=p[0].w;let dtOverDx=dt/dx;
  let at=world(index);let bed=terrain(at);
  var value=vec4<f32>(max(bed.x,bed.y),max(0.0,bed.y-bed.x),0.0,0.0);
  var collision=vec4<f32>(bed.x,0.0,0.0,0.0);var bubbles=vec4<f32>(0.0,value.y,0.0,value.x);
  var normal=vec4<f32>(0.0,0.0,1.0,0.0);
  if(stageId>3u){value=grid(index);collision=field(index);bubbles=foam(index);normal=normalAt(index);}
  if(stageId==1u){
    let a=id.y*u32(size().x+1)+id.x;let b=a+1u;let c=a+u32(size().x+1);let d=c+1u;
    let offset=(id.y*u32(size().x)+id.x)*6u;
    triangles[offset]=a;triangles[offset+1u]=d;triangles[offset+2u]=b;
    triangles[offset+3u]=a;triangles[offset+4u]=c;triangles[offset+5u]=d;
  }
  if(stageId==4u){
    let oldUv=rotate(at-p[3].xy,-p[3].z)/p[1].zw+0.5;
    if(all(oldUv>=vec2<f32>(0.0))&&all(oldUv<=vec2<f32>(1.0))){
      value=sampleGrid(oldUv*vec2<f32>(size())-0.5);
      bubbles.x=sampleFoam(oldUv*vec2<f32>(size())-0.5);
      value=vec4<f32>(value.xy,rotate(value.zw,p[3].z-p[2].x));
      // The WaterBody profile leaves bottom-contour suppression disabled during window remapping.
      value.y=max(0.0,value.x-bed.x);
    }else{value=vec4<f32>(bed.y,max(0.0,bed.y-bed.x),0.0,0.0);bubbles.x=0.0;}
    collision=vec4<f32>(bed.x,0.0,0.0,0.0);
    bubbles.z=0.0;
    if(index.x==0||index.y==0||index.x==size().x-1||index.y==size().y-1){collision.y=1.0;}
    ${
      rigid
        ? `
    let relativeXZ=rotate(((vec2<f32>(index)+0.5)/vec2<f32>(size())-0.5)*p[1].zw,p[2].x);
    let rigid=rigidCell(vec3<f32>(relativeXZ.x,value.x-p[12].z,relativeXZ.y),dx,value.y);
    let rigidVelocity=rigid.zw*p[13].z;
    if(rigid.x>0.0&&length(rigidVelocity)>p[13].w){
      collision=vec4<f32>(collision.x,rigid.x,rigidVelocity);bubbles.z=max(bubbles.z,rigid.y);
    }`
        : ''
    }
    for(var i=0u;i<u32(p[6].x);i++){
      let a=impulses[i*2u];let b=impulses[i*2u+1u];
      let distance=length(vec3<f32>(at-a.xy,value.x-a.w));let radius=a.z;
      let weight=1.0-smoothstep(radius*p[8].w,radius+0.5*min(dx.x,dx.y),distance);
      if(weight>0.00001&&value.y>0.000000001&&length(b.xyz*p[13].z)>p[13].w){
        let sphereHeight=value.x+abs(a.w-value.x);var overlap=0.0;
        for(var corner=0u;corner<4u;corner++){
          let cornerOffsets=array<vec2<f32>,4>(vec2<f32>(-1.0,-1.0),vec2<f32>(1.0,-1.0),vec2<f32>(1.0,1.0),vec2<f32>(-1.0,1.0));
          let cornerPosition=at+rotate(0.5*dx*cornerOffsets[corner],p[2].x);let r2=radius*radius-dot(a.xy-cornerPosition,a.xy-cornerPosition);
          if(r2>0.000000001){overlap+=max(0.0,sqrt(r2)-(sphereHeight-value.x));}
        }
        overlap*=0.25;
        let collisionVelocity=rotate(b.xy*p[13].z,-p[2].x);
        if(overlap>bubbles.z&&length(collisionVelocity)>p[13].w){collision=vec4<f32>(bed.x,weight,collisionVelocity);bubbles.z=overlap;}
      }
    }
    bubbles.y=value.y;
  }
  if(stageId==5u){
    let offset=u32(p[6].x)*2u;
    let inputVelocity=value.zw;
    for(var i=0u;i<u32(p[6].y);i++){
      let a=impulses[offset+i*4u];let b=impulses[offset+i*4u+1u];let c=impulses[offset+i*4u+2u];let d=impulses[offset+i*4u+3u];
      let local=rotate(at-a.xy,-a.z);
      if(a.w>0.5){
        if(all(abs(local)<=b.xy*0.5)&&abs(value.x-d.x)<=b.w*0.5){
          let targetVelocity=rotate(c.xy,-p[2].x);
          value.x=b.z;value.y=value.x-bed.x;
          if(c.z>0.5){value=vec4<f32>(value.xy,value.zw+targetVelocity);}else if(length(targetVelocity)>length(inputVelocity)){value=vec4<f32>(value.xy,targetVelocity);}
        }
      }else if(value.y>0.0000001&&abs(local.y)<=b.x){
        let lateral=smoothstep(0.0,b.x,abs(local.y));
        let targetHeight=select(bed.x,bed.y,bed.z>0.5&&bed.y-bed.x>0.0000001);
        let goalHeight=mix(targetHeight,value.x,lateral);
        value.x+=c.w*(goalHeight-value.x)*dt;value.y=value.x-bed.x;
        let goalVelocity=mix(vec2<f32>(0.0),value.zw,lateral);
        value=vec4<f32>(value.xy,value.zw+0.1*c.w*(goalVelocity-value.zw)*dt);
      }
    }
  }
  if(stageId==6u&&collision.y<0.99999){
    let radius=i32(p[8].x);var volume=0.0;
    for(var y=-radius;y<=radius;y++){for(var x=-radius;x<=radius;x++){
      volume+=foam(index+vec2<i32>(x,y)).z;
    }}
    value.y=clamp(value.y+volume/pow(f32(2*radius+1),2.0)*p[8].y*dt*30.0,0.0,p[11].y);value.x=bed.x+value.y;
  }
  if(stageId==7u&&(value.y<=p[2].w||collision.y>0.99999)){
    var nearest=65500.0;let radius=2;
    for(var y=-radius;y<=radius;y++){for(var x=-radius;x<=radius;x++){
      let offset=vec2<i32>(x,y);let neighbor=grid(index+offset);let distance=length(vec2<f32>(offset));
      if(distance<nearest&&neighbor.y>p[2].w&&neighbor.x>value.x&&length(neighbor.zw)>0.0000001){value=vec4<f32>(value.xy,neighbor.zw);nearest=distance;}
    }}
  }
  if(stageId==8u&&collision.y<0.99999){
    let v=value.zw;
    let vx=vec2<f32>(v.x,0.25*(grid(index+LEFT).w+grid(index+LEFT+UP).w+v.y+grid(index+UP).w));
    let vy=vec2<f32>(0.25*(grid(index+DOWN).z+grid(index+DOWN+RIGHT).z+v.x+grid(index+RIGHT).z),v.y);
    value.z=sampleGrid(vec2<f32>(index)-dtOverDx*p[7].y*vx).z;
    value.w=sampleGrid(vec2<f32>(index)-dtOverDx*p[7].y*vy).w;
    let centered=0.5*(v+vec2<f32>(grid(index+RIGHT).z,grid(index+UP).w));
    value.y=max(0.0,sampleGrid(vec2<f32>(index)-dtOverDx*p[7].y*centered).y);value.x=bed.x+value.y;
  }
  if(stageId==9u){
    var nearest=65500.0;let radius=2;
    if(collision.y>0.99999){for(var y=-radius;y<=radius;y++){for(var x=-radius;x<=radius;x++){
      let offset=vec2<i32>(x,y);let neighbor=grid(index+offset);let distance=length(vec2<f32>(offset));
      if(distance<nearest&&field(index+offset).y<0.99999&&neighbor.y>p[2].w){value.x=neighbor.x;nearest=distance;}
    }}value.y=value.x-bed.x;}
    bubbles.y=max(0.0,value.x-bed.x);
  }
  if(stageId==10u){
    let left=grid(index+LEFT);let down=grid(index+DOWN);
    value=vec4<f32>(value.xy,value.zw-p[6].z*dtOverDx*(vec2<f32>(value.x)-vec2<f32>(left.x,down.x)));
    value.z=mix(value.z,field(index+LEFT).z,field(index+LEFT).y);
    value.w=mix(value.w,field(index+DOWN).w,field(index+DOWN).y);
    if((value.y<=p[2].w&&left.y<=p[2].w)||max(value.x,left.x)<max(bed.x,field(index+LEFT).x)){value.z=0.0;}
    if((value.y<=p[2].w&&down.y<=p[2].w)||max(value.x,down.x)<max(bed.x,field(index+DOWN).x)){value.w=0.0;}
    value=vec4<f32>(value.xy,mix(value.zw,collision.zw,collision.y));
    var depth=vec2<f32>(0.5*(left.y+value.y),0.5*(down.y+value.y));
    if(p[11].x>0.5){depth=vec2<f32>(select(value.y,left.y,value.z>0.0),select(value.y,down.y,value.w>0.0));}
    let velocity=value.zw;
    let drag=velocity*p[6].w*length(velocity)/pow(max(depth,vec2<f32>(p[2].w)),vec2<f32>(4.0/3.0));
    let dragLength=length(drag);let speed=length(velocity);
    value=vec4<f32>(value.xy,value.zw-drag*min(dt,speed/max(dragLength,0.000001)));
    value=vec4<f32>(value.xy,value.zw*max(0.0,1.0-p[9].x*dt));
    value=vec4<f32>(value.xy,value.zw*min(1.0,p[9].y/max(length(value.zw),0.000001)));
    if(index.x==0||index.x==size().x-1){value.z=0.0;}if(index.y==0||index.y==size().y-1){value.w=0.0;}
  }
  if(stageId==11u){
    if(p[3].w<0.5){
      value.x=p[12].z+(value.x-p[12].z)*smoothstep(0.0,p[10].z,p[10].w);
      value.y=value.x-collision.x;
    }
    let right=grid(index+RIGHT);let up=grid(index+UP);
    var faces=vec4<f32>(faceDepth(index,RIGHT,value.z),faceDepth(index+RIGHT,RIGHT,right.z),faceDepth(index,UP,value.w),faceDepth(index+UP,UP,up.w));
    if(p[7].w>0.5&&dt>0.0){
      let depths=vec4<f32>(grid(index+LEFT).y,right.y,grid(index+DOWN).y,up.y);
      let total=dot(select(vec4<f32>(0.0),vec4<f32>(1.0),depths>vec4<f32>(0.00000001)),vec4<f32>(1.0));
      let average=dot(depths,vec4<f32>(1.0))/max(1.0,total);
      let integrationDepth=p[8].z*min(dx.x,dx.y)/(p[6].z*dt);
      faces=max(vec4<f32>(0.0),faces-vec4<f32>(max(0.0,average-integrationDepth)));
    }
    value.y=max(0.0,value.y-dtOverDx.x*(faces.y*right.z-faces.x*value.z)-dtOverDx.y*(faces.w*up.w-faces.z*value.w));
    if(p[9].z>0.0){value.y-=dt*p[9].w*(1.0-smoothstep(0.0,p[9].z,value.y));}
    let inside=max(0.0,p[2].y-bed.x-bubbles.z);
    value.y=clamp(mix(value.y,select(inside,value.y,p[11].z>0.5),collision.y),0.0,p[11].y);
    if(p[11].w>0.5){let radius=2.0*length((vec2<f32>(index)+0.5)/vec2<f32>(size())-0.5);value.y=clamp(mix(value.y,p[2].y-bed.x,smoothstep(0.5,1.0,radius)),0.0,p[11].y);}
    value.x=bed.x+value.y;bubbles.y=value.y;
  }
  if(stageId==12u){
    bubbles.w=value.x;
    if(p[3].w>0.5){
      let border=any(index<vec2<i32>(2))||any(index>size()-3);
      let extrapolate=!border&&(collision.y>0.99999||value.y<0.0000001);
      var height=select(value.x,0.0,extrapolate);var depth=select(value.y,0.0,extrapolate);
      var heightWeight=select(1.0,0.0,extrapolate);var depthWeight=heightWeight;
      for(var x=-2;x<=2;x++){for(var y=-2;y<=2;y++){
        if(x!=0&&y!=0){
          let neighbor=clamp(index+vec2<i32>(x,y),vec2<i32>(0),size()-1);let sample=grid(neighbor);
          if(field(neighbor).y<0.99999&&sample.y>0.0000001){
            let distance=length(vec2<f32>(neighbor-index));
            let weight=select((1.0-smoothstep(0.0,2.0,distance))*(1.0-smoothstep(0.0,0.5,abs(sample.x-value.x))),distance,extrapolate);
            height+=sample.x*weight;heightWeight+=weight;
            if(abs(x)<=1&&abs(y)<=1){depth+=sample.y*weight;depthWeight+=weight;}
          }
        }
      }}
      bubbles.w=select(value.x,height/max(heightWeight,0.00000001),heightWeight>0.00000001);
      bubbles.y=select(value.y,depth/max(depthWeight,0.00000001),depthWeight>0.00000001);
      if(border){bubbles.y=0.0;}
    }
  }
  if(stageId==13u){let computed=surfaceNormal(index);normal=vec4<f32>(computed,select(clamp(bubbles.x,p[22].y,p[22].z),0.0,p[3].w>0.5));if(p[3].w>0.5){value.x=collision.x+value.y;}}
  if(stageId==14u&&p[3].w<0.5){
    ${debugWrites('water-body-shallow/2', 'normal')}
  }
  if(stageId==15u){normal=vec4<f32>(surfaceNormal(index),value.x-p[12].z);}
  if(stageId==16u&&dt>0.0){
    let old=sampleFoam(vec2<f32>(index)-value.zw*dtOverDx*p[14].x);
    let emitted=old+foamEmission(index,dt).amount;
    bubbles.x=clamp(emitted/(1.0+p[13].x*p[14].y)-p[14].z*p[13].x,p[14].w,p[15].x);
  }
  if(stageId==17u){normal=vec4<f32>(blurredNormal(index,i32(p[10].y)),normal.w);}
  textureStore(nextGrid,index,value);textureStore(nextField,index,collision);textureStore(nextFoam,index,bubbles);
  textureStore(normalOutput,index,normal);
}
@group(0) @binding(11) var normalOutput:texture_storage_2d<${format},write>;
@group(0) @binding(12) var gridOutput:texture_storage_2d<rgba16float,write>;
@group(0) @binding(13) var foamOutput:texture_storage_2d<${format},write>;
@group(0) @binding(14) var mappingOutput:texture_storage_2d<rgba32float,write>;
${history === 'retained' ? '@group(0) @binding(16) var previousMapping:texture_2d<f32>;' : ''}
@compute @workgroup_size(8,8) fn postSim(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);if(any(index>=size())){return;}
  let value=grid(index);
  textureStore(gridOutput,index,select(vec4<f32>(value.x-p[12].z,value.x-field(index).x,0.0,0.0),vec4<f32>(foam(index).w-p[12].z,foam(index).y,blurredVelocity(index,i32(p[10].x))),p[3].w>0.5));
}
@compute @workgroup_size(8,8) fn debugOutput(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);if(any(index>=size())){return;}
  let value=grid(index);let collision=field(index);let at=world(index);var output=vec4<f32>(0.0);
  ${debugWrites('river-shallow/2', 'output')}
  textureStore(gridOutput,index,output);
}
@compute @workgroup_size(8,8) fn foamDebugOutput(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);if(any(index>=size())){return;}
  textureStore(gridOutput,index,vec4<f32>(foamEmission(index,p[13].x).criteria.xyz,grid(index).x-p[12].z));
}
@compute @workgroup_size(8,8) fn publish(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);if(any(index>=size())){return;}
  let value=grid(index);
  textureStore(normalOutput,index,normalAt(index));
  if(p[12].w>0.5){textureStore(gridOutput,index,vec4<f32>(value.x-p[12].z,foam(index).y,value.zw));}
  textureStore(foamOutput,index,vec4<f32>(foam(index).x,0.0,0.0,0.0));
  if(index.y<2&&index.x<2){
    var mapping=select(p[1],vec4<f32>(p[2].x,max(p[3].w,p[13].y),0.0,p[12].z),index.x==1);
    ${history === 'retained' ? 'if(index.y==1){mapping=textureLoad(previousMapping,vec2<i32>(index.x,0),0);}' : ''}
    textureStore(mappingOutput,index,mapping);
  }
}
@compute @workgroup_size(8,8) fn bake(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);if(any(id.xy>=textureDimensions(previousGrid))){return;}
  let value=textureLoad(previousGrid,index,0);
  textureStore(gridOutput,index,value);
}
`;
}
