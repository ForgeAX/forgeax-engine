

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

struct ObjectBounds { lo: vec4f, hi: vec4f, scale: vec4f }
struct Settings { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
struct GlobalVoxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
@group(0) @binding(0) var<storage,read> instances: array<Instance>;
@group(0) @binding(1) var<storage,read> fields: array<u32>;
@group(0) @binding(2) var<storage,read> bounds: array<ObjectBounds>;
@group(0) @binding(3) var<uniform> settings: Settings;
@group(0) @binding(4) var<storage,read_write> voxels: array<GlobalVoxel>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims=settings.dimensionsCount.xyz;
  let count=dims.x*dims.y*dims.z;
  // ranges.zw: optional edit box as exact f32 integers, x|y<<8|z<<16 (lo, extent).
  let boxExtent=u32(settings.ranges.w);var cell:vec3u;
  if(boxExtent==0u){
    if(gid.x>=count){return;}
    cell=vec3u(gid.x%dims.x,(gid.x/dims.x)%dims.y,gid.x/(dims.x*dims.y));
  }else{
    let boxLo=u32(settings.ranges.z);
    let e=vec3u(boxExtent&255u,(boxExtent>>8u)&255u,boxExtent>>16u);
    if(gid.x>=e.x*e.y*e.z){return;}
    cell=vec3u(boxLo&255u,(boxLo>>8u)&255u,boxLo>>16u)+vec3u(gid.x%e.x,(gid.x/e.x)%e.y,gid.x/(e.x*e.y));
    if(any(cell>=dims)){return;}
  }
  let index=cell.x+cell.y*dims.x+cell.z*dims.x*dims.y;
  let world=settings.originSpacing.xyz+vec3f(cell)*settings.originSpacing.w;
  var distance=settings.ranges.x;var nearest=0xffffffffu;var missing=false;
  var oneSided=false;var twoSided=false;
  for(var i=0u;i<settings.dimensionsCount.w;i++){
    let m=instances[i];if(m.ids.w==0u){continue;}
    let b=bounds[i];let p=(m.inverse*vec4f(world,1)).xyz;
    let toBox=max(b.lo.xyz-p,p-b.hi.xyz)*b.scale.xyz;
    let boxDistance=length(max(toBox,vec3f(0)))+min(0.0,max(toBox.x,max(toBox.y,toBox.z)));
    if(boxDistance>=settings.ranges.x){continue;}
    if(m.field.x==0xffffffffu){missing=true;continue;}
    let local=sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz));
    let candidate=max(local*b.scale.w+max(boxDistance,0.0),boxDistance);
    if(candidate<distance||(candidate==distance&&candidate<settings.ranges.x&&m.ids.x<nearest)){
      distance=candidate;nearest=m.ids.x;
    }
    if(abs(candidate)<settings.ranges.y){
      if(b.lo.w>0.5){twoSided=true;}else{oneSided=true;}
    }
  }
  let coverage=select(1.0,0.0,twoSided&&!oneSided);
  voxels[index]=GlobalVoxel(clamp(distance,-settings.ranges.x,settings.ranges.x),coverage,select(1u,2u,missing),nearest);
}
