


struct RawInstance { words:array<vec4u,9> }
struct Instance { inverse:mat4x4f, ids:vec4u, field:vec4u, origin:vec4f, extent:vec4f, error:vec4f }
fn sdfInstanceRowCount() -> u32 { return arrayLength(&instances); }
fn sdfInstanceWord(row:u32,word:u32) -> u32 {
 if(row>=sdfInstanceRowCount() || word>=36u){return 0u;}
 return instances[row].words[word>>2u][word&3u];
}

fn sdfInstanceMask(row:u32) -> u32 { return sdfInstanceWord(row,19u); }
fn sdfInstanceFloatUsable(word:u32) -> bool {
 let magnitude=word&0x7fffffffu;
 return magnitude==0u || (magnitude>=0x00800000u && magnitude<=0x7f7fffffu);
}
fn sdfInstanceValid(row:u32) -> bool {
 if(row>=sdfInstanceRowCount() || sdfInstanceRowCount()>1024u){return false;}
 if(sdfInstanceMask(row)>255u){return false;}
 for(var word=0u;word<36u;word++){
  if(word>=16u && word<24u){continue;}
  if(!sdfInstanceFloatUsable(sdfInstanceWord(row,word))){return false;}
 }
 if((sdfInstanceWord(row,3u)&0x7fffffffu)!=0u ||
    (sdfInstanceWord(row,7u)&0x7fffffffu)!=0u ||
    (sdfInstanceWord(row,11u)&0x7fffffffu)!=0u || sdfInstanceWord(row,15u)!=0x3f800000u){return false;}
 let mode=sdfInstanceWord(row,35u);
 return mode==0u || mode==0x3f800000u || mode==0x40000000u;
}

fn sdfInstanceAt(row:u32) -> Instance {
 let raw=instances[row].words;
 return Instance(mat4x4f(bitcast<vec4f>(raw[0]),bitcast<vec4f>(raw[1]),bitcast<vec4f>(raw[2]),bitcast<vec4f>(raw[3])),
  raw[4],raw[5],bitcast<vec4f>(raw[6]),bitcast<vec4f>(raw[7]),bitcast<vec4f>(raw[8]));
}

struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct SdfHit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
fn sdfTexel(m: Instance, c: vec3u) -> f32 {
  if(m.error.w==1.0 || m.error.w==2.0){
    let first=select(m.field.x,fields[m.field.x+4u],m.error.w==2.0);
    let edge=4u;
    let dims=(m.field.yzw+vec3u(edge-1u))/edge;
    let b=c/edge;
    let entry=fields[first+(b.z*dims.y+b.y)*dims.x+b.x];
    let p=c%edge;let local=(p.z*edge+p.y)*edge+p.x;
    return unpack2x16snorm(fields[first+entry+(local>>1u)])[local&1u]*m.extent.w;
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


struct ObjectBounds { lo:vec4f, hi:vec4f, scale:vec4f }
fn worldBoundsWord(word:u32)->u32 {return bounds[word>>2u][word&3u];}
fn worldBoundsValid(count:u32)->bool {
 if(arrayLength(&bounds)<6u){return false;}
 let a=bounds[0];let b=bounds[1];let words=arrayLength(&bounds)*4u;
 return a.x==1463963697u&&a.y==1u&&a.z==count&&
  count<=a.w&&a.w<=1024u&&count<=arrayLength(&instances)&&b.x==6u&&b.y==max(1u,a.w)*3u&&b.z==1u&&
  (b.x+b.y)*4u<=words&&bounds[5].w==words&&words<=309404u;
}
fn worldBoundsAt(row:u32)->ObjectBounds {
 let first=bounds[1].x+row*3u;
 return ObjectBounds(bitcast<vec4f>(bounds[first]),bitcast<vec4f>(bounds[first+1u]),bitcast<vec4f>(bounds[first+2u]));
}
fn worldBoundsIndexValid(count:u32,radius:f32)->bool {
 if(!worldBoundsValid(count)||bounds[1].w!=1u){return false;}
 let shape=bounds[2];let grid=bitcast<vec4f>(bounds[3]);let spans=bounds[4];let tail=bounds[5];
 if(any(shape.xyz<vec3u(1u))||any(shape.xyz>vec3u(32u))||bitcast<f32>(shape.w)!=radius||
  !all(abs(grid.xyz)<=vec3f(3.402823466e+38))||!(grid.w>0.0)||grid.w>3.402823466e+38){return false;}
 let cells=shape.x*shape.y*shape.z;let first=(bounds[1].x+bounds[1].y)*4u;
 if(any((vec4u(spans.x,spans.y,spans.w,tail.y)&vec4u(3u))!=vec4u(0u))){return false;}
 return spans.x>=first&&spans.x<=tail.w&&cells+1u<=tail.w-spans.x&&
  spans.y>=spans.x+cells+1u&&spans.y<=tail.w&&spans.z<=262144u&&spans.z<=tail.w-spans.y&&
  spans.w>=spans.y+spans.z&&spans.w<=tail.w&&tail.x<=128u&&tail.x<=tail.w-spans.w&&
  tail.y>=spans.w+tail.x&&tail.y<=tail.w&&tail.z<=count&&tail.z*2u<=tail.w-tail.y;
}
// x=0: full roster [y,z). x=1: remaining CSR [y,z), next oversized index w.
fn worldBoundsCursor(position:vec3f,count:u32,radius:f32)->vec4u {
 let scan=vec4u(0u,0u,count,0u);
 if(!worldBoundsIndexValid(count,radius)){return scan;}
 let dims=bounds[2].xyz;let grid=bitcast<vec4f>(bounds[3]);let q=(position-grid.xyz)/grid.w;
 // Outside the admitted index domain retains the complete original scan.
 if(!all(abs(q)<=vec3f(3.402823466e+38))||any(q<vec3f(0))||any(q>=vec3f(dims))){return scan;}
 let cell=vec3u(floor(q));let linear=(cell.z*dims.y+cell.y)*dims.x+cell.x;
 let start=worldBoundsWord(bounds[4].x+linear);let end=worldBoundsWord(bounds[4].x+linear+1u);
 if(start>end||end>bounds[4].z){return scan;}
 for(var k=0u;k<bounds[5].x;k++){if(worldBoundsWord(bounds[4].w+k)>=count){return scan;}}
 for(var k=start;k<end;k++){if(worldBoundsWord(bounds[4].y+k)>=count){return scan;}}
 return vec4u(1u,start,end,0u);
}
fn worldBoundsCursorCount(cursor:vec4u)->u32 {
 if(cursor.x==0u){return cursor.z-cursor.y;}
 return cursor.z-cursor.y+bounds[5].x-cursor.w;
}
fn worldBoundsCursorRow(cursor:ptr<function,vec4u>)->u32 {
 let current=*cursor;
 if(current.x==0u){(*cursor).y++;return current.y;}
 var extra=0xffffffffu;var regular=0xffffffffu;
 if(current.w<bounds[5].x){extra=worldBoundsWord(bounds[4].w+current.w);}
 if(current.y<current.z){regular=worldBoundsWord(bounds[4].y+current.y);}
 // Both streams are canonical-row sorted. Merge without changing tie order.
 if(extra<regular){(*cursor).w++;return extra;}
 (*cursor).y++;return regular;
}
fn worldBoundsRowForId(id:u32,count:u32,radius:f32)->u32 {
 if(!worldBoundsValid(count)){return 0xffffffffu;}
 if(worldBoundsIndexValid(count,radius)){
  var lo=0u;var hi=bounds[5].z;
  while(lo<hi){let mid=lo+(hi-lo)/2u;let key=worldBoundsWord(bounds[5].y+mid*2u);if(key<id){lo=mid+1u;}else{hi=mid;}}
  if(lo<bounds[5].z&&worldBoundsWord(bounds[5].y+lo*2u)==id){
   let row=worldBoundsWord(bounds[5].y+lo*2u+1u);
   if(row<count&&sdfInstanceWord(row,16u)==id){return row;}
  }
 }
 // Incomplete/malformed identity acceleration never hides a canonical instance.
 for(var i=0u;i<count;i++){if(sdfInstanceWord(i,16u)==id){return i;}}
 return 0xffffffffu;
}

struct Settings { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f, source:vec4u }
struct GlobalVoxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
@group(0) @binding(0) var<storage,read> instances: array<RawInstance>;
@group(0) @binding(1) var<storage,read> fields: array<u32>;
@group(0) @binding(2) var<storage,read> bounds: array<vec4u>;
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
  if(!worldBoundsValid(settings.dimensionsCount.w)){
    voxels[index]=GlobalVoxel(0,0,2u,0xffffffffu);return;
  }
  let world=settings.originSpacing.xyz+vec3f(cell)*settings.originSpacing.w;
  var distance=settings.ranges.x;var nearest=0xffffffffu;var missing=false;
  var oneSided=false;var twoSided=false;
  for(var i=0u;i<settings.dimensionsCount.w;i++){
    if(sdfInstanceMask(i)==0u){continue;}
    if(!sdfInstanceValid(i)){missing=true;continue;}
    let m=sdfInstanceAt(i);
    let b=worldBoundsAt(i);let p=(m.inverse*vec4f(world,1)).xyz;
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
