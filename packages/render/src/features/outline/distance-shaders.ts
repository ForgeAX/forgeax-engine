import type { RenderFeatureFullscreenProgramDeclaration } from '../plan';
// The native fullscreen ABI reserves depth@3 + depthSampler@4; additional
// color reads begin at binding 5 whenever scene depth is present.
// Integer seed coordinates are lossless in rgba16float: byte lanes and a
// packed <=2047 state lane preserve every source i16 pixel, including 4K/8K.
export const DISTANCE_OUTLINE_PROGRAMS: readonly RenderFeatureFullscreenProgramDeclaration[] = [
  {
    kind: 'fullscreen-program',
    name: 'forgeax.outline.distance.seed',
    source: /* wgsl */ `
struct Output{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>};
@vertex fn vs_main(@builtin(vertex_index)i:u32)->Output{let p=vec2<f32>(f32((i<<1u)&2u),f32(i&2u));return Output(vec4<f32>(p*2-1,0,1),vec2<f32>(p.x,1-p.y));}
struct Params{normal:vec4<f32>,accent:vec4<f32>,shape:vec4<f32>,accentShape:vec4<f32>,miscA:vec4<f32>,miscB:vec4<f32>,opacity:vec4<f32>,distance:vec4<f32>,region:vec4<f32>,settings:vec4<f32>,fades:array<vec4<f32>,32>};
@group(1) @binding(0)var source:texture_2d<f32>;
@group(1) @binding(1)var sourceSampler:sampler;
@group(1) @binding(2)var<uniform> params:Params;
fn point(s:vec4<f32>)->vec2<i32>{let q=vec4<u32>(s);return vec2<i32>(i32(q.x+q.y*256u),i32(q.z+(q.w&127u)*256u));}
fn valid(s:vec4<f32>)->bool{return (u32(s.w)&1024u)!=0u;}
fn flags(s:vec4<f32>)->u32{return (u32(s.w)>>7u)&7u;}
fn seed(p:vec2<i32>,bits:u32)->vec4<f32>{let q=vec2<u32>(p);return vec4<f32>(f32(q.x&255u),f32(q.x>>8u),f32(q.y&255u),f32((q.y>>8u)|(bits<<7u)|1024u));}
fn rawDepth(v:vec4<f32>)->f32{let b=vec4<u32>(v);return bitcast<f32>(b.x|(b.y<<8u)|(b.z<<16u)|(b.w<<24u));}
fn inRegion(p:vec2<i32>)->bool{let q=vec2<f32>(p);return all(q>=params.region.xy)&&all(q<params.region.zw);}
@group(1) @binding(5)var focus:texture_2d<f32>;
@group(1) @binding(6)var accent:texture_2d<f32>;
@group(1) @binding(7)var large:texture_2d<f32>;
@group(1) @binding(3)var sceneDepth:texture_depth_2d;
@fragment fn fs_main(input:Output)->@location(0)vec4<f32>{let p=vec2<i32>(input.position.xy);if(!inRegion(p)){return vec4<f32>(0);}
let size=vec2<i32>(textureDimensions(sceneDepth));let q=clamp(vec2<i32>(input.uv*vec2<f32>(size)),vec2<i32>(0),size-1);var scene=textureLoad(sceneDepth,q,0);
let z=rawDepth(textureLoad(source,p,0));let epsilon=max(scene*.000002,1e-12);if(z<=0||z<scene-epsilon){return vec4<f32>(0);}
var bits=0u;if(rawDepth(textureLoad(focus,p,0))>=scene-epsilon&&rawDepth(textureLoad(focus,p,0))>0){bits|=1u;}if(rawDepth(textureLoad(accent,p,0))>=scene-epsilon&&rawDepth(textureLoad(accent,p,0))>0){bits|=2u;}if(rawDepth(textureLoad(large,p,0))>=scene-epsilon&&rawDepth(textureLoad(large,p,0))>0){bits|=4u;}return seed(p,bits);}
`,
    reads: [
      'scene-color',
      'outline-focus',
      'outline-accent',
      'outline-large',
      { key: 'scene-depth', sampleType: 'depth' },
    ],
    params: { byteSize: 672, defaultValue: new Uint8Array(672) },
  },
  {
    kind: 'fullscreen-program',
    name: 'forgeax.outline.distance.seed.msaa',
    source: /* wgsl */ `
struct Output{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>};
@vertex fn vs_main(@builtin(vertex_index)i:u32)->Output{let p=vec2<f32>(f32((i<<1u)&2u),f32(i&2u));return Output(vec4<f32>(p*2-1,0,1),vec2<f32>(p.x,1-p.y));}
struct Params{normal:vec4<f32>,accent:vec4<f32>,shape:vec4<f32>,accentShape:vec4<f32>,miscA:vec4<f32>,miscB:vec4<f32>,opacity:vec4<f32>,distance:vec4<f32>,region:vec4<f32>,settings:vec4<f32>,fades:array<vec4<f32>,32>};
@group(1) @binding(0)var source:texture_2d<f32>;
@group(1) @binding(1)var sourceSampler:sampler;
@group(1) @binding(2)var<uniform> params:Params;
fn point(s:vec4<f32>)->vec2<i32>{let q=vec4<u32>(s);return vec2<i32>(i32(q.x+q.y*256u),i32(q.z+(q.w&127u)*256u));}
fn valid(s:vec4<f32>)->bool{return (u32(s.w)&1024u)!=0u;}
fn flags(s:vec4<f32>)->u32{return (u32(s.w)>>7u)&7u;}
fn seed(p:vec2<i32>,bits:u32)->vec4<f32>{let q=vec2<u32>(p);return vec4<f32>(f32(q.x&255u),f32(q.x>>8u),f32(q.y&255u),f32((q.y>>8u)|(bits<<7u)|1024u));}
fn rawDepth(v:vec4<f32>)->f32{let b=vec4<u32>(v);return bitcast<f32>(b.x|(b.y<<8u)|(b.z<<16u)|(b.w<<24u));}
fn inRegion(p:vec2<i32>)->bool{let q=vec2<f32>(p);return all(q>=params.region.xy)&&all(q<params.region.zw);}
@group(1) @binding(5)var focus:texture_2d<f32>;
@group(1) @binding(6)var accent:texture_2d<f32>;
@group(1) @binding(7)var large:texture_2d<f32>;
@group(1) @binding(3)var sceneDepth:texture_depth_multisampled_2d;
@fragment fn fs_main(input:Output)->@location(0)vec4<f32>{let p=vec2<i32>(input.position.xy);if(!inRegion(p)){return vec4<f32>(0);}
let size=vec2<i32>(textureDimensions(sceneDepth));let q=clamp(vec2<i32>(input.uv*vec2<f32>(size)),vec2<i32>(0),size-1);var scene=textureLoad(sceneDepth,q,0);for(var i=1;i<4;i++){scene=max(scene,textureLoad(sceneDepth,q,i));}
let z=rawDepth(textureLoad(source,p,0));let epsilon=max(scene*.000002,1e-12);if(z<=0||z<scene-epsilon){return vec4<f32>(0);}
var bits=0u;if(rawDepth(textureLoad(focus,p,0))>=scene-epsilon&&rawDepth(textureLoad(focus,p,0))>0){bits|=1u;}if(rawDepth(textureLoad(accent,p,0))>=scene-epsilon&&rawDepth(textureLoad(accent,p,0))>0){bits|=2u;}if(rawDepth(textureLoad(large,p,0))>=scene-epsilon&&rawDepth(textureLoad(large,p,0))>0){bits|=4u;}return seed(p,bits);}
`,
    reads: [
      'scene-color',
      'outline-focus',
      'outline-accent',
      'outline-large',
      { key: 'scene-depth', sampleType: 'depth' },
    ],
    params: { byteSize: 672, defaultValue: new Uint8Array(672) },
  },
  {
    kind: 'fullscreen-program',
    name: 'forgeax.outline.distance.flood',
    source: /* wgsl */ `
struct Output{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>};
@vertex fn vs_main(@builtin(vertex_index)i:u32)->Output{let p=vec2<f32>(f32((i<<1u)&2u),f32(i&2u));return Output(vec4<f32>(p*2-1,0,1),vec2<f32>(p.x,1-p.y));}
struct Params{normal:vec4<f32>,accent:vec4<f32>,shape:vec4<f32>,accentShape:vec4<f32>,miscA:vec4<f32>,miscB:vec4<f32>,opacity:vec4<f32>,distance:vec4<f32>,region:vec4<f32>,settings:vec4<f32>,fades:array<vec4<f32>,32>};
@group(1) @binding(0)var source:texture_2d<f32>;
@group(1) @binding(1)var sourceSampler:sampler;
@group(1) @binding(2)var<uniform> params:Params;
fn point(s:vec4<f32>)->vec2<i32>{let q=vec4<u32>(s);return vec2<i32>(i32(q.x+q.y*256u),i32(q.z+(q.w&127u)*256u));}
fn valid(s:vec4<f32>)->bool{return (u32(s.w)&1024u)!=0u;}
fn flags(s:vec4<f32>)->u32{return (u32(s.w)>>7u)&7u;}
fn seed(p:vec2<i32>,bits:u32)->vec4<f32>{let q=vec2<u32>(p);return vec4<f32>(f32(q.x&255u),f32(q.x>>8u),f32(q.y&255u),f32((q.y>>8u)|(bits<<7u)|1024u));}
fn rawDepth(v:vec4<f32>)->f32{let b=vec4<u32>(v);return bitcast<f32>(b.x|(b.y<<8u)|(b.z<<16u)|(b.w<<24u));}
fn inRegion(p:vec2<i32>)->bool{let q=vec2<f32>(p);return all(q>=params.region.xy)&&all(q<params.region.zw);}
@fragment fn fs_main(input:Output)->@location(0)vec4<f32>{let p=vec2<i32>(input.position.xy);if(!inRegion(p)){return vec4<f32>(0);}var best=vec4<f32>(0);var bestDistance=0xffffffffu;let stride=i32(params.settings.x);let lo=vec2<i32>(params.region.xy);let hi=vec2<i32>(params.region.zw)-1;
for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let q=clamp(p+vec2<i32>(x,y)*stride,lo,hi);let candidate=textureLoad(source,q,0);if(!valid(candidate)){continue;}let delta=p-point(candidate);let distance=u32(delta.x*delta.x+delta.y*delta.y);if(distance<bestDistance){bestDistance=distance;best=candidate;}}}return best;}
`,
    reads: ['scene-color'],
    params: { byteSize: 672, defaultValue: new Uint8Array(672) },
  },
  {
    kind: 'fullscreen-program',
    name: 'forgeax.outline.distance.composite',
    source: /* wgsl */ `
struct Output{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>};
@vertex fn vs_main(@builtin(vertex_index)i:u32)->Output{let p=vec2<f32>(f32((i<<1u)&2u),f32(i&2u));return Output(vec4<f32>(p*2-1,0,1),vec2<f32>(p.x,1-p.y));}
struct Params{normal:vec4<f32>,accent:vec4<f32>,shape:vec4<f32>,accentShape:vec4<f32>,miscA:vec4<f32>,miscB:vec4<f32>,opacity:vec4<f32>,distance:vec4<f32>,region:vec4<f32>,settings:vec4<f32>,fades:array<vec4<f32>,32>};
@group(1) @binding(0)var source:texture_2d<f32>;
@group(1) @binding(1)var sourceSampler:sampler;
@group(1) @binding(2)var<uniform> params:Params;
fn point(s:vec4<f32>)->vec2<i32>{let q=vec4<u32>(s);return vec2<i32>(i32(q.x+q.y*256u),i32(q.z+(q.w&127u)*256u));}
fn valid(s:vec4<f32>)->bool{return (u32(s.w)&1024u)!=0u;}
fn flags(s:vec4<f32>)->u32{return (u32(s.w)>>7u)&7u;}
fn seed(p:vec2<i32>,bits:u32)->vec4<f32>{let q=vec2<u32>(p);return vec4<f32>(f32(q.x&255u),f32(q.x>>8u),f32(q.y&255u),f32((q.y>>8u)|(bits<<7u)|1024u));}
fn rawDepth(v:vec4<f32>)->f32{let b=vec4<u32>(v);return bitcast<f32>(b.x|(b.y<<8u)|(b.z<<16u)|(b.w<<24u));}
fn inRegion(p:vec2<i32>)->bool{let q=vec2<f32>(p);return all(q>=params.region.xy)&&all(q<params.region.zw);}
@group(1) @binding(5)var seeds:texture_2d<f32>;
@group(1) @binding(3)var sceneDepth:texture_depth_2d;
fn linearDepth(p:vec2<i32>,size:vec2<i32>)->f32{let depthSize=vec2<i32>(textureDimensions(sceneDepth));let q=clamp(vec2<i32>((vec2<f32>(p)+.5)/vec2<f32>(size)*vec2<f32>(depthSize)),vec2<i32>(0),depthSize-1);var z=textureLoad(sceneDepth,q,0);return -(params.miscA.y*z+params.miscA.z)/(params.miscA.w*z+params.miscB.x);}
@fragment fn fs_main(input:Output)->@location(0)vec4<f32>{let p=vec2<i32>(input.position.xy);let base=textureLoad(source,p,0);if(!inRegion(p)){return base;}let s=textureLoad(seeds,p,0);if(!valid(s)){return base;}let at=point(s);if(all(at==p)){return base;}let d=length(vec2<f32>(p-at))-.5;let reach=params.shape.w;if(d>reach){return base;}
var fade=1.0;for(var i=0u;i<u32(params.distance.x);i++){let rect=params.fades[i*2u];let q=vec2<f32>(at)+.5;if(all(q>=rect.xy)&&all(q<=rect.zw)){fade=min(fade,params.fades[i*2u+1u].x);}}if(fade<=0){return base;}
let bits=flags(s);let focus=f32(bits&1u);let high=f32((bits>>1u)&1u);let large=f32((bits>>2u)&1u);let size=vec2<i32>(textureDimensions(source));let z=linearDepth(at,size);let detail=1-smoothstep(params.distance.y,params.distance.z,z);let grow=mix(1,params.miscB.z,focus)*mix(1,params.opacity.w,large*detail)*mix(params.distance.w,1,detail);
let width=mix(params.shape.x,params.accentShape.x,high)*grow;let glowRadius=mix(params.shape.y,params.accentShape.y,high)*grow;let glowStrength=mix(params.shape.z,params.accentShape.z,high);let here=linearDepth(p,size);let tolerance=params.miscB.y+z*.02;let visibility=(1-smoothstep(tolerance,tolerance*2.5,z-here))*fade;if(visibility<=0){return base;}
let core=clamp(width-d+.5,0,1);let tail=max(d-width,0);let glow=exp2(-3*tail/max(glowRadius,.001))*(1-smoothstep(reach*.65,reach,d));let breathe=1-params.accentShape.w*high*(.5+.5*sin(params.miscA.x*2.4));let tint=mix(params.normal.rgb,params.accent.rgb,high);let level=mix(params.normal.w,params.accent.w,high)*mix(1,params.miscB.w,focus);var alpha=mix(params.opacity.x,params.opacity.y,high);alpha=mix(alpha,max(alpha,params.opacity.z),max(focus,large));var color=mix(base.rgb,tint*level,core*alpha*visibility);color+=tint*level*glow*glowStrength*breathe*visibility*(1-core);return vec4<f32>(color,base.a);}
`,
    reads: ['scene-color', 'outline-seeds', { key: 'scene-depth', sampleType: 'depth' }],
    params: { byteSize: 672, defaultValue: new Uint8Array(672) },
  },
  {
    kind: 'fullscreen-program',
    name: 'forgeax.outline.distance.composite.msaa',
    source: /* wgsl */ `
struct Output{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>};
@vertex fn vs_main(@builtin(vertex_index)i:u32)->Output{let p=vec2<f32>(f32((i<<1u)&2u),f32(i&2u));return Output(vec4<f32>(p*2-1,0,1),vec2<f32>(p.x,1-p.y));}
struct Params{normal:vec4<f32>,accent:vec4<f32>,shape:vec4<f32>,accentShape:vec4<f32>,miscA:vec4<f32>,miscB:vec4<f32>,opacity:vec4<f32>,distance:vec4<f32>,region:vec4<f32>,settings:vec4<f32>,fades:array<vec4<f32>,32>};
@group(1) @binding(0)var source:texture_2d<f32>;
@group(1) @binding(1)var sourceSampler:sampler;
@group(1) @binding(2)var<uniform> params:Params;
fn point(s:vec4<f32>)->vec2<i32>{let q=vec4<u32>(s);return vec2<i32>(i32(q.x+q.y*256u),i32(q.z+(q.w&127u)*256u));}
fn valid(s:vec4<f32>)->bool{return (u32(s.w)&1024u)!=0u;}
fn flags(s:vec4<f32>)->u32{return (u32(s.w)>>7u)&7u;}
fn seed(p:vec2<i32>,bits:u32)->vec4<f32>{let q=vec2<u32>(p);return vec4<f32>(f32(q.x&255u),f32(q.x>>8u),f32(q.y&255u),f32((q.y>>8u)|(bits<<7u)|1024u));}
fn rawDepth(v:vec4<f32>)->f32{let b=vec4<u32>(v);return bitcast<f32>(b.x|(b.y<<8u)|(b.z<<16u)|(b.w<<24u));}
fn inRegion(p:vec2<i32>)->bool{let q=vec2<f32>(p);return all(q>=params.region.xy)&&all(q<params.region.zw);}
@group(1) @binding(5)var seeds:texture_2d<f32>;
@group(1) @binding(3)var sceneDepth:texture_depth_multisampled_2d;
fn linearDepth(p:vec2<i32>,size:vec2<i32>)->f32{let depthSize=vec2<i32>(textureDimensions(sceneDepth));let q=clamp(vec2<i32>((vec2<f32>(p)+.5)/vec2<f32>(size)*vec2<f32>(depthSize)),vec2<i32>(0),depthSize-1);var z=textureLoad(sceneDepth,q,0);for(var i=1;i<4;i++){z=max(z,textureLoad(sceneDepth,q,i));}return -(params.miscA.y*z+params.miscA.z)/(params.miscA.w*z+params.miscB.x);}
@fragment fn fs_main(input:Output)->@location(0)vec4<f32>{let p=vec2<i32>(input.position.xy);let base=textureLoad(source,p,0);if(!inRegion(p)){return base;}let s=textureLoad(seeds,p,0);if(!valid(s)){return base;}let at=point(s);if(all(at==p)){return base;}let d=length(vec2<f32>(p-at))-.5;let reach=params.shape.w;if(d>reach){return base;}
var fade=1.0;for(var i=0u;i<u32(params.distance.x);i++){let rect=params.fades[i*2u];let q=vec2<f32>(at)+.5;if(all(q>=rect.xy)&&all(q<=rect.zw)){fade=min(fade,params.fades[i*2u+1u].x);}}if(fade<=0){return base;}
let bits=flags(s);let focus=f32(bits&1u);let high=f32((bits>>1u)&1u);let large=f32((bits>>2u)&1u);let size=vec2<i32>(textureDimensions(source));let z=linearDepth(at,size);let detail=1-smoothstep(params.distance.y,params.distance.z,z);let grow=mix(1,params.miscB.z,focus)*mix(1,params.opacity.w,large*detail)*mix(params.distance.w,1,detail);
let width=mix(params.shape.x,params.accentShape.x,high)*grow;let glowRadius=mix(params.shape.y,params.accentShape.y,high)*grow;let glowStrength=mix(params.shape.z,params.accentShape.z,high);let here=linearDepth(p,size);let tolerance=params.miscB.y+z*.02;let visibility=(1-smoothstep(tolerance,tolerance*2.5,z-here))*fade;if(visibility<=0){return base;}
let core=clamp(width-d+.5,0,1);let tail=max(d-width,0);let glow=exp2(-3*tail/max(glowRadius,.001))*(1-smoothstep(reach*.65,reach,d));let breathe=1-params.accentShape.w*high*(.5+.5*sin(params.miscA.x*2.4));let tint=mix(params.normal.rgb,params.accent.rgb,high);let level=mix(params.normal.w,params.accent.w,high)*mix(1,params.miscB.w,focus);var alpha=mix(params.opacity.x,params.opacity.y,high);alpha=mix(alpha,max(alpha,params.opacity.z),max(focus,large));var color=mix(base.rgb,tint*level,core*alpha*visibility);color+=tint*level*glow*glowStrength*breathe*visibility*(1-core);return vec4<f32>(color,base.a);}
`,
    reads: ['scene-color', 'outline-seeds', { key: 'scene-depth', sampleType: 'depth' }],
    params: { byteSize: 672, defaultValue: new Uint8Array(672) },
  },
];
