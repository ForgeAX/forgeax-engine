import { SDF_SAMPLE_WGSL } from '../raytracing/sdf-query';

export const ADVANCED_RIGID_COLLISION_WGSL = `
struct RigidPrimitive {
  inverse:mat4x4<f32>, previous:mat4x4<f32>, shape:vec4<f32>, field:vec4<f32>
}
struct RigidProjection { point:vec3<f32>, distance:f32 }
@group(0) @binding(17) var<storage,read> rigidPrimitives:array<RigidPrimitive>;
@group(0) @binding(18) var<storage,read> instances:array<Instance>;
@group(0) @binding(19) var<storage,read> fields:array<u32>;
${SDF_SAMPLE_WGSL}
fn rigidProject(primitive:RigidPrimitive,position:vec3<f32>)->RigidProjection {
  let local=(primitive.inverse*vec4<f32>(position,1.0)).xyz;
  if(primitive.shape.x<1.5){
    let center=vec3<f32>(0.0,select(0.0,clamp(local.y,-primitive.shape.z,primitive.shape.z),primitive.shape.x>0.5),0.0);
    let offset=local-center;let magnitude=length(offset);
    var direction=vec3<f32>(0.0);
    if(magnitude>0.0000000001){direction=offset/magnitude;}
    return RigidProjection(center+direction*primitive.shape.y,magnitude-primitive.shape.y);
  }
  let extent=primitive.shape.yzw;let delta=abs(local)-extent;
  var point=clamp(local,-extent,extent);
  let outside=length(max(delta,vec3<f32>(0.0)));
  // UE local XYZ maps to engine XZY; maximum-axis ties retain UE Z, then Y.
  var axis=select(1u,2u,delta.z>delta.y);
  if(delta.x>delta.y&&delta.x>delta.z){axis=0u;}
  if(outside==0.0){point[axis]=select(-extent[axis],extent[axis],local[axis]>=0.0);}
  return RigidProjection(point,outside+min(delta[axis],0.0));
}
fn rigidCurrentPoint(primitive:RigidPrimitive,local:vec3<f32>)->vec3<f32> {
  return transpose(mat3x3<f32>(primitive.inverse[0].xyz,primitive.inverse[1].xyz,primitive.inverse[2].xyz))*(local-primitive.inverse[3].xyz);
}
fn rigidPointVelocity(primitive:RigidPrimitive,point:vec3<f32>)->vec3<f32> {
  if(p[24].y<=0.0){return vec3<f32>(0.0);}
  return (rigidCurrentPoint(primitive,point)-(primitive.previous*vec4<f32>(point,1.0)).xyz)/p[24].y;
}
fn rigidClosest(position:vec3<f32>)->u32 {
  var closest=0xffffffffu;var distance=3.402823e38;
  for(var element=0u;element<u32(p[23].x);element++){
    let projection=rigidProject(rigidPrimitives[element],position);
    if(projection.distance<distance){closest=element;distance=projection.distance;}
  }
  return closest;
}
fn rigidSample(element:u32,position:vec3<f32>)->vec4<f32> {
  let primitive=rigidPrimitives[element];let projection=rigidProject(primitive,position);
  var distance=projection.distance;
  if(p[24].x>0.5&&primitive.field.x>0.5){
    let instance=instances[u32(primitive.field.x)-1u];
    let local=(instance.inverse*vec4<f32>(position,1.0)).xyz;
    let scale=1.0/max(max(length(vec3<f32>(instance.inverse[0].x,instance.inverse[1].x,instance.inverse[2].x)),length(vec3<f32>(instance.inverse[0].y,instance.inverse[1].y,instance.inverse[2].y))),length(vec3<f32>(instance.inverse[0].z,instance.inverse[1].z,instance.inverse[2].z)));
    distance=sdfValue(instance,local)*scale;
  }
  return vec4<f32>(rigidPointVelocity(primitive,projection.point),distance);
}
fn rigidTriangleArea(a:f32,b:f32,c:f32)->f32 {
  var low=min(a,min(b,c));var high=max(a,max(b,c));let middle=a+b+c-low-high;
  if(low>0.0){return 0.0;}if(high<0.0){return 1.0;}
  if(low==high){return 0.0;}
  if(middle>=0.0){return low*low/((low-middle)*(low-high));}
  return 1.0-high*high/((high-low)*(high-middle));
}
fn rigidCell(position:vec3<f32>,dx:vec2<f32>,depth:f32)->vec4<f32> {
  let closest=rigidClosest(position);
  if(closest==0xffffffffu){return vec4<f32>(0.0);}
  let offset=-p[23].z*dx.x;
  var center=rigidSample(closest,position);center.w+=offset;
  var area=0.0;
  if(p[23].y>0.5){
    let corners=array<vec2<f32>,4>(vec2<f32>(-1.0,-1.0),vec2<f32>(1.0,-1.0),vec2<f32>(1.0,1.0),vec2<f32>(-1.0,1.0));
    var theta:array<f32,4>;var velocity=vec3<f32>(0.0);
    for(var corner=0u;corner<4u;corner++){
      let horizontal=rotate(0.5*dx*corners[corner],p[2].x);
      let sample=rigidSample(closest,position+vec3<f32>(horizontal.x,0.0,horizontal.y));
      theta[corner]=sample.w+offset;velocity+=sample.xyz;
    }
    center=vec4<f32>(0.25*velocity,0.25*(theta[0]+theta[1]+theta[2]+theta[3]));
    for(var triangle=0u;triangle<4u;triangle++){area+=rigidTriangleArea(theta[triangle],theta[(triangle+1u)%4u],center.w);}
    area=0.25*area;
    if(area<=0.00001){area=0.0;}
  }else{
    let falloff=p[23].w;
    // UE's zero-width smoothstep is undefined; R7 chooses a strict-inside boundary.
    if(falloff>0.0){area=clamp(1.0-smoothstep(-falloff,0.0,center.w),0.0,1.0);}
    else{area=select(0.0,1.0,center.w<0.0);}
    if(area<=0.000001){area=0.0;}
  }
  let overlap=select(abs(center.w),0.0,p[24].z>0.5&&depth<0.0000001);
  return vec4<f32>(area,overlap,rotate(center.xz,-p[2].x));
}
`;
