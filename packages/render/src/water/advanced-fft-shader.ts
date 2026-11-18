/** Positive Stockham butterflies preserve the source's no-normalization convention. */
let rgba16floatAdvancedFftSource: string | undefined;
let rgba32floatAdvancedFftSource: string | undefined;

export function advancedFftShader(format: 'rgba16float' | 'rgba32float'): string {
  if (format === 'rgba16float') {
    if (rgba16floatAdvancedFftSource === undefined)
      rgba16floatAdvancedFftSource = buildAdvancedFftShader(format);
    return rgba16floatAdvancedFftSource;
  }
  if (format === 'rgba32float') {
    if (rgba32floatAdvancedFftSource === undefined)
      rgba32floatAdvancedFftSource = buildAdvancedFftShader(format);
    return rgba32floatAdvancedFftSource;
  }
  return buildAdvancedFftShader(format);
}

function buildAdvancedFftShader(format: 'rgba16float' | 'rgba32float'): string {
  return `
@group(0) @binding(0) var inputGrid:texture_2d<f32>;
@group(0) @binding(1) var outputGrid:texture_storage_2d<rgba32float,write>;
@group(0) @binding(2) var<storage,read> p:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> noise:array<vec4<f32>>;
@group(0) @binding(4) var outputNormal:texture_storage_2d<${format},write>;
@group(0) @binding(7) var outputVisualNormal:texture_storage_2d<${format},write>;
${ADVANCED_GRID_VERTEX_WGSL}
@group(0) @binding(5) var<storage,read_write> vertices:array<GridVertex>;
@group(0) @binding(6) var<storage,read_write> triangles:array<u32>;
const TAU=6.283185307179586;
fn noiseAt(uv:vec2<f32>)->vec4<f32>{
  let dimensions=vec2<i32>(p[3].xy);let pixel=fract(uv)*vec2<f32>(dimensions)-0.5;let low=vec2<i32>(floor(pixel));let t=fract(pixel);
  let a=(low%dimensions+dimensions)%dimensions;let b=(a+1)%dimensions;
  return mix(mix(noise[u32(a.y*dimensions.x+a.x)],noise[u32(a.y*dimensions.x+b.x)],t.x),mix(noise[u32(b.y*dimensions.x+a.x)],noise[u32(b.y*dimensions.x+b.x)],t.x),t.y);
}
@compute @workgroup_size(1) fn retain(){textureStore(outputGrid,vec2<i32>(0),textureLoad(inputGrid,vec2<i32>(0),0));}
@compute @workgroup_size(8,8) fn createVertices(@builtin(global_invocation_id) id:vec3<u32>){
  let n=u32(p[0].x);if(any(id.xy>vec2<u32>(n))){return;}
  let uv=vec2<f32>(id.xy)/f32(n);let at=(uv-0.5)*p[0].yz;
  vertices[id.y*(n+1u)+id.x]=GridVertex(vec4<f32>(at.x,0.0,at.y,1.0),vec4<f32>(0.0,1.0,0.0,0.0),vec4<f32>(1.0,0.0,0.0,-1.0),vec4<f32>(uv,0.0,0.0),vec4<f32>(1.0));
}
@compute @workgroup_size(8,8) fn createTriangles(@builtin(global_invocation_id) id:vec3<u32>){
  let n=u32(p[0].x);if(any(id.xy>=vec2<u32>(n))){return;}
  let a=id.y*(n+1u)+id.x;let b=a+1u;let c=a+n+1u;let d=c+1u;let offset=(id.y*n+id.x)*6u;
  triangles[offset]=d;triangles[offset+1u]=b;triangles[offset+2u]=a;
  triangles[offset+3u]=a;triangles[offset+4u]=c;triangles[offset+5u]=d;
}
@compute @workgroup_size(8,8) fn init(@builtin(global_invocation_id) id:vec3<u32>){
  if(any(id.xy>=vec2<u32>(u32(p[0].x)))){return;}
  textureStore(outputGrid,vec2<i32>(id.xy),vec4<f32>(0.0));
  textureStore(outputNormal,vec2<i32>(id.xy),vec4<f32>(0.0,0.0,1.0,0.0));
}
@compute @workgroup_size(8,8) fn spectrum(@builtin(global_invocation_id) id:vec3<u32>){
  let n=i32(p[0].x);let index=vec2<i32>(id.xy);if(any(index>=vec2<i32>(n))){return;}
  let half=n/2;var kIndex=index;var direction=1.0;
  let wrappedAngle=((p[1].x%360.0)+360.0)%360.0;let windAngle=-wrappedAngle*TAU/360.0;
  if(p[1].x>=180.0){direction = -direction;}
  if(p[1].y<0.0){direction = -direction;}
  if(kIndex.y>half){kIndex.y-=n;direction = -direction;}
  if(kIndex.x>half){kIndex.x-=n;if(kIndex.y==0){direction = -direction;}}
  var result=vec2<f32>(0.0);
  if(all(index!=vec2<i32>(half))&&any(kIndex!=vec2<i32>(0))){
    let k=vec2<f32>(kIndex)*TAU/p[0].y;let kMag=length(k);
    let windDirection=vec2<f32>(cos(windAngle),sin(windAngle));
    let principal=select(0.01,p[1].y*p[1].y*TAU/p[1].z,abs(p[1].y)>0.00001);
    let cosine=dot(k/kMag,windDirection);let alignment=select(f32(clamp(i32(p[1].w),1,20)),clamp(p[1].w,1.0,20.0),p[3].w>0.5);
    let squared=dot(vec2<f32>(kIndex),vec2<f32>(kIndex));
    let amplitude=sqrt(abs(p[2].x)*pow(cosine*cosine,alignment)/(exp(1.0/pow(kMag*principal,2.0))*squared*squared));
    let folded=select(index,vec2<i32>(n)-index,index>vec2<i32>(half));
    let uv=vec2<f32>(folded)/f32(half);let forward=fract(20.0*length(noiseAt(uv)));let backward=fract(20.0*length(noiseAt(uv+0.25)));
    // The source's extra sqrt(k) leaves this 0.1 coefficient after SI conversion.
    let phase=direction*0.1*sqrt(TAU/p[0].y*p[1].z)*sqrt(kMag)*(p[2].y*p[0].z);
    let a=phase+TAU*forward;let b=phase+TAU*backward;
    result=amplitude*(vec2<f32>(cos(a),sin(a))+p[2].z*vec2<f32>(cos(b),-sin(b)));
  }
  textureStore(outputGrid,index,vec4<f32>(result,0.0,0.0));
}
${advancedStockhamButterflyWgsl()}
@compute @workgroup_size(8,8) fn publish(@builtin(global_invocation_id) id:vec3<u32>){
  let n=u32(p[0].x);if(any(id.xy>=vec2<u32>(n))){return;}
  let index=vec2<i32>(id.xy);let center=textureLoad(inputGrid,index,0).x;
  let right=textureLoad(inputGrid,vec2<i32>((id.xy+vec2<u32>(1,0))%n),0).x;
  let up=textureLoad(inputGrid,vec2<i32>((id.xy+vec2<u32>(0,1))%n),0).x;
  let spacing=p[2].w/f32(n);let crossValue=cross(vec3<f32>(spacing,0.0,right-center),vec3<f32>(0.0,spacing,up-center));
  let normal=select(vec3<f32>(0.0,0.0,1.0),normalize(crossValue),dot(crossValue,crossValue)>0.0000000000001);
  textureStore(outputNormal,index,vec4<f32>(normal,center));
}
@compute @workgroup_size(8,8) fn publishVisualNormalDetail(@builtin(global_invocation_id) id:vec3<u32>){
  let n=u32(p[0].x);if(any(id.xy>=vec2<u32>(n))){return;}
  let index=vec2<i32>(id.xy);
  let center=textureLoad(inputGrid,index,0).x;
  let right=textureLoad(inputGrid,vec2<i32>((id.xy+vec2<u32>(1,0))%n),0).x;
  let forwardZ=textureLoad(inputGrid,vec2<i32>((id.xy+vec2<u32>(0,1))%n),0).x;
  let spacing=p[2].w/f32(n);
  let tangentX=right-center;let tangentZ=forwardZ-center;
  // This is the signed +Y-up contract vector after dividing its positive common
  // spacing factor. Scale before normalize so valid small/large domains retain
  // their slope instead of crossing an absolute length threshold or overflowing.
  let normalValue=vec3<f32>(-tangentX,spacing,-tangentZ);
  let maximumComponent=max(max(abs(normalValue.x),abs(normalValue.y)),abs(normalValue.z));
  var normal=vec3<f32>(0.0,1.0,0.0);
  if(maximumComponent>0.0){normal=normalize(normalValue/maximumComponent);}
  textureStore(outputVisualNormal,index,vec4<f32>(normal,center));
}
`;
}

import { ADVANCED_GRID_VERTEX_WGSL } from './advanced-grid-mesh';

/** Forward and inverse transforms share Stockham indexing with an explicit direction. */
export function advancedStockhamButterflyWgsl(paired = false): string {
  return `
@compute @workgroup_size(8,8) fn butterfly(@builtin(global_invocation_id) id:vec3<u32>){
  let n=u32(p[0].x);if(any(id.xy>=vec2<u32>(n))){return;}
  let axis=u32(p[3].z);let span=u32(p[3].w);let coordinate=select(id.x,id.y,axis==1u);
  let offset=coordinate%span;let thread=(coordinate/(2u*span))*span+offset;
  let negative=(coordinate%(2u*span))>=span;
  let first=select(vec2<u32>(thread,id.y),vec2<u32>(id.x,thread),axis==1u);
  let second=first+select(vec2<u32>(n/2u,0u),vec2<u32>(0u,n/2u),axis==1u);
  let a=textureLoad(inputGrid,vec2<i32>(first),0);let b=textureLoad(inputGrid,vec2<i32>(second),0);
  let theta=TAU*f32(offset)/f32(2u*span)${paired ? '*p[4].x' : ''};let rotation=vec2<f32>(cos(theta),sin(theta));
  let rotated=vec2<f32>(b.x*rotation.x-b.y*rotation.y,b.x*rotation.y+b.y*rotation.x);
  ${paired ? 'let rotatedSecond=vec2<f32>(b.z*rotation.x-b.w*rotation.y,b.z*rotation.y+b.w*rotation.x);' : ''}
  textureStore(outputGrid,vec2<i32>(id.xy),vec4<f32>(a.xy+select(rotated,-rotated,negative),${paired ? 'a.zw+select(rotatedSecond,-rotatedSecond,negative)' : '0.0,0.0'}));
}
`;
}
