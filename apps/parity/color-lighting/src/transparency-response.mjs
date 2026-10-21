import { createPublicationAssets } from '@forgeax/engine-runtime/internal/renderer-host';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createRenderer } from '@forgeax/engine';
import { World } from '@forgeax/engine/ecs';
import { createPlaneGeometry } from '@forgeax/engine/geometry';
import { Camera, Fog, Materials, MeshFilter, MeshRenderer, TONEMAP_LINEAR, TONEMAP_REINHARD } from '@forgeax/engine/render';
import { propagateTransforms, Transform } from '@forgeax/engine/scene';
import { halfFloat } from '@forgeax/engine/math';
import * as webgpu from '@forgeax/engine/rhi-webgpu';
import * as THREE from 'three/webgpu';
import { fog, float, vec3, exp, positionView, texture } from 'three/tsl';

const size=128;
const unwrap=result=>{if(!result?.ok)throw result?.error??new Error('Missing result');return result.value;};
const recorder=new URLSearchParams(location.search).has('capture')?(await import('@forgeax/engine/rhi-debug')).attachRecorder(webgpu).unwrap():undefined;
const renderer=unwrap(await createRenderer(document.querySelector('#forgeax'),{rhi:recorder?.backend.rhi??webgpu.rhi},forgeaxBundlerAdapter()));
const three=new THREE.WebGPURenderer({canvas:document.querySelector('#three'),antialias:false,alpha:true});await three.init();three.setSize(size,size,false);
const planes=[{z:-4,size:5,color:[.1,2,.5],alpha:.35},{z:-2,size:1.4,color:[4,.4,.1],alpha:.4}];
const fogColor=[.3,.4,.5], background=[.05,.1,.3];
const cameraValues={fov:Math.PI/3,aspect:1,near:.1,far:30,antialias:0,bloom:0};
async function nativeWorld(p,target) {
 const assets=await createPublicationAssets(forgeaxBundlerAdapter());
 const world=new World({assets});
 const camera={...cameraValues,clearColor:p.transparent?[0,0,0,0]:[...background,1],tonemap:p.tone==='reinhard'?TONEMAP_REINHARD:TONEMAP_LINEAR};
 world.spawn({component:Transform,data:{}},{component:Camera,data:camera}).unwrap();
 if(target)world.spawn({component:Transform,data:{}},{component:Camera,data:{...camera,target:world.allocSharedRef('RenderTarget',target)}}).unwrap();
 for(const plane of planes) {
  const premult=p.blend==='premultiplied', color=plane.color.map(v=>v*(premult?plane.alpha:1));
  const mesh=assets.create(createPlaneGeometry(plane.size,plane.size).unwrap()).unwrap();
  const material=assets.create(Materials.unlit([...color,plane.alpha],{queue:3000,renderState:{cullMode:'none',depthWriteEnabled:false,blend:{color:{srcFactor:premult?'one':'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}})).unwrap();
  world.spawn({component:Transform,data:{pos:[0,0,plane.z]}},{component:MeshFilter,data:{assetHandle:mesh}},{component:MeshRenderer,data:{materials:[material]}}).unwrap();
 }
 if(p.fog)world.spawn({component:Fog,data:{color:fogColor,density:.08,heightFalloff:0}}).unwrap();
 return world;
}
function decode(bytes,metadata) {
 const rgba=new Float32Array(size*size*4),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const half=metadata.format==='rgba16float', bgra=metadata.format.startsWith('bgra');
 for(let y=0;y<size;y++)for(let x=0;x<size;x++)for(let c=0;c<4;c++) {
  const lane=bgra&&c!==3?2-c:c;
  rgba[(y*size+x)*4+c]=half?halfFloat.f16ToF32(view.getUint16(y*metadata.bytesPerRow+x*8+c*2,true)):bytes[y*metadata.bytesPerRow+x*4+lane]/255;
 }
 return rgba;
}
async function native(p,capture) {
 const target=unwrap(renderer.createRenderTarget({shape:'2d',width:size,height:size,format:'rgba16float',mipLevels:1,sampleCount:1,sampled:true,readback:true}));
 const world=await nativeWorld(p,target),lease=unwrap(renderer.attach(world));
 unwrap(renderer.setProfile({...renderer.inspect().profile,renderPath:p.path}));
 try {
  let ready;
  world.update(1/60).unwrap();propagateTransforms(world).unwrap();
  const draw=async(armed=false)=>{if(armed)unwrap(renderer.requestObservation(['linear-hdr','final-display']));const receipt=unwrap(renderer.draw({leases:[lease],camera:{lease},environment:{lease}}));unwrap(await receipt.completed);return receipt;};
  for(let i=0;i<120;i++){ready=await draw();if(ready.presentation==='ready')break;await new Promise(r=>setTimeout(r,2));}
  if(ready.presentation!=='ready')throw new Error('Scene did not become ready');
  const ticket=unwrap(renderer.requestTargetReadback(target,{mipLevel:0}));
  let pending;
  if(capture){if(!recorder)throw new Error('Open with ?capture');pending=recorder.captureFrame();unwrap(await recorder.frameBoundary());}
  const frame=await draw(true);
  if(capture){unwrap(await recorder.frameBoundary());const tape=unwrap(await pending);const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([tape.bytes]));link.download='transparency.rhitape';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),10000);}
  const observed=unwrap(await renderer.observe(frame,{include:['linear-hdr','final-display','target-readbacks'],targetReadbacks:[ticket]}));
  const result={};
  for(const item of observed.observations)result[item.domain]=decode(item.bytes,item.metadata);
  const readback=observed.targetReadbacks[0];if(!readback)throw new Error('Missing target readback');
  result.offscreen=decode(readback.bytes,{...readback,format:'rgba16float'});result.surface=renderer.inspect().surface;
  return result;
 } finally {lease.dispose();unwrap(renderer.destroyRenderTarget(target));}
}
async function reference(p) {
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,30);
 three.setClearColor(new THREE.Color().setRGB(...(p.transparent?[0,0,0]:background)),p.transparent?0:1);
 if(p.fog)scene.fogNode=fog(vec3(...fogColor),float(1).sub(exp(positionView.length().mul(-.08))));
 for(const plane of planes) {
  const material=new THREE.MeshBasicNodeMaterial({color:new THREE.Color().setRGB(...plane.color),opacity:plane.alpha,transparent:true,depthWrite:false,side:THREE.DoubleSide,premultipliedAlpha:p.blend==='premultiplied'});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(plane.size,plane.size),material);mesh.position.z=plane.z;scene.add(mesh);
 }
 const target=new THREE.RenderTarget(size,size,{type:THREE.HalfFloatType,colorSpace:THREE.LinearSRGBColorSpace});
 try {
  three.toneMapping=THREE.NoToneMapping;three.setRenderTarget(target);three.render(scene,camera);
  const raw=await three.readRenderTargetPixelsAsync(target,0,0,size,size);
  const linear=Float32Array.from(raw,halfFloat.f16ToF32);
  // Explicit full-frame output stage is the reference for native HDR composition.
  three.setRenderTarget(null);three.toneMapping=p.tone==='reinhard'?THREE.ReinhardToneMapping:THREE.NoToneMapping;
  const material=new THREE.NodeMaterial();material.fragmentNode=texture(target.texture);material.toneMapped=true;
  const quad=new THREE.QuadMesh(material);await quad.renderAsync(three);material.dispose();
  return {linear};
 } finally {scene.traverse(o=>{if(o.isMesh){o.geometry.dispose();o.material.dispose();}});target.dispose();}
}
const srgb=x=>x<=.0031308?12.92*Math.max(0,x):1.055*Math.max(0,x)**(1/2.4)-.055;
function metrics(a,b) {
 let sum=0,max=0,count=0;
 for(let y=20;y<size-20;y++)for(let x=20;x<size-20;x++)for(let c=0;c<4;c++) {const i=(y*size+x)*4+c,d=Math.abs(a[i]-b[i]);if(!Number.isFinite(d))throw new Error('Non-finite pixel');sum+=d;max=Math.max(max,d);count++;}
 return {mean:sum/count,max};
}
async function run(options={},capture=false) {
 const p={path:'forward',blend:'straight',fog:false,tone:'linear',transparent:false,...options};
 const expected=await reference(p),actual=await native(p,capture);
 // Test the declared native order: per-depth fog -> linear HDR blend -> tone -> output.
 const output=Float32Array.from(actual['linear-hdr'],(v,i)=>i%4===3?v:Math.min(1,srgb(p.tone==='reinhard'?v/(1+v):v)));
 const report={...p,threeRevision:THREE.REVISION,linear:metrics(actual['linear-hdr'],expected.linear),offscreen:metrics(actual.offscreen,expected.linear),outputOrder:metrics(actual['final-display'],output),center:{linear:Array.from(actual['linear-hdr'].slice((64*size+64)*4,(64*size+64)*4+4)),display:Array.from(actual['final-display'].slice((64*size+64)*4,(64*size+64)*4+4))},surface:actual.surface};
 document.querySelector('#status').textContent=JSON.stringify(report,null,2);
 for(const key of ['path','blend','tone'])document.getElementById(key).value=p[key];
 document.querySelector('#fog').checked=p.fog;document.querySelector('#alpha').checked=p.transparent;return report;
}
globalThis.transparencyResponse={run};globalThis.transparencyResponse.initial=await run();
for(const el of document.querySelectorAll('select,input'))el.onchange=()=>run({path:document.querySelector('#path').value,blend:document.querySelector('#blend').value,tone:document.querySelector('#tone').value,fog:document.querySelector('#fog').checked,transparent:document.querySelector('#alpha').checked});
