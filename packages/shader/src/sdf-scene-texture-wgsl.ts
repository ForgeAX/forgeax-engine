import { SDF_SURFACE_POOL_LAYOUT } from './sdf-surface-pool-wgsl';

/** Transport of the existing canonical pools, independent of geometry eligibility. */
export const SDF_SCENE_TEXTURE_LAYOUT = {
  magic: 0x46585354,
  version: 1,
  headerWords: 16,
  instanceWords: SDF_SURFACE_POOL_LAYOUT.instanceWords,
} as const;

/** Binding-free adapter for SDF_SURFACE_POOL_WGSL. The caller supplies
 * texture_2d<u32> sdfSceneTexture and sdfSceneExpected()->vec4u containing
 * canonical instanceWords, fieldWords, rowLimit and a nonzero source epoch.
 * These facts must come from the source owner, never from the texture header.
 * Call sdfSceneView() before any word or count query. It validates and caches
 * the independent source facts once. Word functions never initialize implicitly;
 * before that call they expose zero, with no texture or expected-source reads.
 * Bindings and expected facts stay immutable during an invocation. The decoded
 * private header snapshot lasts one invocation; it owns no roster or clock.
 * Every candidate consumer separately enforces row<sdfSceneRowLimit(). Raw
 * allocation reads retain capacity/headroom and are not eligibility queries. */
export const SDF_SCENE_TEXTURE_READ_WGSL = `
struct SdfSceneTextureView { valid:u32, instanceWords:u32, fields:vec2u, rowLimit:u32 }
var<private> sdfSceneHeaderChecked:bool;
var<private> sdfSceneHeaderView:SdfSceneTextureView;
fn sdfSceneTextureInvalid()->SdfSceneTextureView {
 return SdfSceneTextureView(0u,0u,vec2u(0u),0u);
}
fn sdfSceneReadHeader()->SdfSceneTextureView {
 let dims=textureDimensions(sdfSceneTexture);let expected=sdfSceneExpected();
 if(dims.x==0u || dims.y==0u || expected.w==0u){return sdfSceneTextureInvalid();}
 if(dims.x>0x3fffffffu/dims.y){return sdfSceneTextureInvalid();}
 let texels=dims.x*dims.y;
 if(texels<${SDF_SCENE_TEXTURE_LAYOUT.headerWords / 4}u){return sdfSceneTextureInvalid();}
 var header:array<vec4u,4>;
 for(var i=0u;i<4u;i++){
  header[i]=textureLoad(sdfSceneTexture,vec2i(i32(i%dims.x),i32(i/dims.x)),0);
 }
 let tag=header[0];let spans=header[1];let shape=header[2];let tail=header[3];
 if(any(tag!=vec4u(${SDF_SCENE_TEXTURE_LAYOUT.magic}u,${SDF_SCENE_TEXTURE_LAYOUT.version}u,expected.w,1u)) ||
  spans.x!=${SDF_SCENE_TEXTURE_LAYOUT.headerWords}u || spans.y!=expected.x || spans.w!=expected.y ||
  shape.x!=expected.z || shape.y!=${SDF_SCENE_TEXTURE_LAYOUT.instanceWords}u || any(shape.zw!=dims) ||
  any(tail.yzw!=vec3u(0u))){return sdfSceneTextureInvalid();}
 if(spans.y%${SDF_SCENE_TEXTURE_LAYOUT.instanceWords}u!=0u || shape.x>spans.y/${SDF_SCENE_TEXTURE_LAYOUT.instanceWords}u){return sdfSceneTextureInvalid();}
 if(spans.y>0xffffffffu-${SDF_SCENE_TEXTURE_LAYOUT.headerWords}u){return sdfSceneTextureInvalid();}
 let fieldsStart=${SDF_SCENE_TEXTURE_LAYOUT.headerWords}u+spans.y;
 if(spans.z!=fieldsStart || spans.w>0xffffffffu-fieldsStart){return sdfSceneTextureInvalid();}
 if(tail.x!=fieldsStart+spans.w || tail.x>texels*4u){return sdfSceneTextureInvalid();}
 return SdfSceneTextureView(1u,spans.y,vec2u(fieldsStart,spans.w),shape.x);
}
fn sdfSceneView()->SdfSceneTextureView {
 if(!sdfSceneHeaderChecked){sdfSceneHeaderView=sdfSceneReadHeader();sdfSceneHeaderChecked=true;}
 return sdfSceneHeaderView;
}
fn sdfSceneWord(index:u32)->u32 {
 if(sdfSceneHeaderView.valid==0u || index>=sdfSceneHeaderView.fields.x+sdfSceneHeaderView.fields.y){return 0u;}
 let dims=textureDimensions(sdfSceneTexture);let texel=index>>2u;
 return textureLoad(sdfSceneTexture,vec2i(i32(texel%dims.x),i32(texel/dims.x)),0)[index&3u];
}
fn sdfFieldWordCount()->u32{return sdfSceneHeaderView.fields.y;}
fn sdfFieldWord(index:u32)->u32 {
 if(sdfSceneHeaderView.valid==0u || index>=sdfSceneHeaderView.fields.y){return 0u;}
 return sdfSceneWord(sdfSceneHeaderView.fields.x+index);
}
fn sdfInstanceRowCount()->u32{return sdfSceneHeaderView.instanceWords/${SDF_SCENE_TEXTURE_LAYOUT.instanceWords}u;}
fn sdfInstanceWord(row:u32,word:u32)->u32 {
 if(sdfSceneHeaderView.valid==0u || row>=sdfSceneHeaderView.instanceWords/${SDF_SCENE_TEXTURE_LAYOUT.instanceWords}u || word>=${SDF_SCENE_TEXTURE_LAYOUT.instanceWords}u){return 0u;}
 return sdfSceneWord(${SDF_SCENE_TEXTURE_LAYOUT.headerWords}u+row*${SDF_SCENE_TEXTURE_LAYOUT.instanceWords}u+word);
}
fn sdfSceneRowLimit()->u32{return sdfSceneHeaderView.rowLimit;}
`;
