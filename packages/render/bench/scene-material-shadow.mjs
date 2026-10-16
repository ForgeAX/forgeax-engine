// Build this source diagnostic with tsup so Renderer and ShadowViewStatePool
// share one implementation. The control explicitly invalidates the existing
// owner before update; it adds no player option or alternate shadow writer.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { DirectionalLight, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { Mobility, MobilityKindValue, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { create, globals } from '@forgeax/engine-dawn-node';
import { constructRendererHost } from '../src/construct-renderer.ts';
import { ShadowViewStatePool } from '../src/gpu-driven/shadow-views.ts';
import { writeReferencePng } from '../../../apps/shared/png-codec.mjs';
import { makeCanvas, rgba, spawnScene, timingFacts, trackDiagnosticErrors, value } from './scene-material-scaling.mjs';

const root=resolve(process.cwd());
const output=resolve(process.argv[2] ?? 'artifacts/scene-material-scaling/shadow');
await mkdir(output,{recursive:true});
Object.assign(globalThis,globals);
const gpu=create([]);Object.defineProperty(globalThis,'navigator',{configurable:true,value:{gpu}});
const adapter=await gpu.requestAdapter();if(!adapter)throw new Error('Dawn adapter unavailable');
let reuse=true;
const originalUpdate=ShadowViewStatePool.prototype.update;
ShadowViewStatePool.prototype.update=function(...args){if(!reuse)this.invalidate('content-changed');return originalUpdate.apply(this,args);};
const sampling={warmup:16,order:['A','B','B','A'],groups:4,framesPerWindow:8};
const quantile=(values,p)=>{const s=values.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s[Math.ceil(s.length*p)-1]:null;};
const report={sampling,controls:{A:'same GPU raster with ShadowViewStatePool reuse invalidated',B:'ordinary owner reuse'},adapter:Object.fromEntries(['vendor','architecture','device','description'].map(key=>[key,adapter.info?.[key]??null])),resolution:[512,512],shadowResolution:512,resourceScope:'graph generations and GPU lane logical allocation',cases:[]};
for(const dirtyRatio of [0,.01,1]) {
 const id=`shadow-${dirtyRatio===0?'stable':dirtyRatio===1?'churn':'local-dirty'}`;
 if(process.argv[3]!==undefined&&process.argv[3]!==id)continue;
 const errors=[],devices=new Set(),textures=[];const restore=trackDiagnosticErrors(errors);
 const manifest=await readFile(resolve(root,'shared-build-inputs/shaders/manifest.json'),'utf8');
 const renderer=value(await constructRendererHost(makeCanvas(devices,textures,errors),{rhi,gpuPassTiming:{}},{shaderManifestUrl:`data:application/json,${encodeURIComponent(manifest)}`})).renderer;
 const world=new World(),scene=spawnScene(world,1000,false),lease=value(renderer.attach(world));
 for(let index=Math.ceil(1000*dirtyRatio);index<scene.entities.length;index++)value(world.addComponent(scene.entities[index].entity,{component:Mobility,data:{kind:MobilityKindValue.static}}));
 value(renderer.setProfile({...renderer.inspect().profile,renderPath:'deferred',ssao:false,gpuOcclusion:false}));
 value(world.set(scene.light,DirectionalLight,{mapSize:512,shadowDistance:15,castShadow:true}));
 value(world.spawn({component:Transform,data:{pos:[0,0,-.2]}},{component:MeshFilter,data:{assetHandle:world.allocSharedRef('MeshAsset',value(createPlaneGeometry(6,6)))}},{component:MeshRenderer,data:{materials:[world.allocSharedRef('MaterialAsset',Materials.standard({baseColor:[.4,.4,.4,1],roughness:.7}))]}}));
 const unsub=renderer.subscribe(event=>{if(event.kind==='error')errors.push(event.error);});
 let phase=0;
 const raw={A:[],B:[]},images={};
 const frame=async(mode,picture=false)=>{
  reuse=mode==='B';const start=performance.now();
  for(let i=0;i<Math.ceil(1000*dirtyRatio);i++){const {entity,pos}=scene.entities[i];value(world.set(entity,Transform,{pos:[pos[0],pos[1],Math.sin(phase*.1+i)*.025]}));}
  phase++;value(world.update(1/60));value(propagateTransforms(world));const cpuWorldMs=performance.now()-start;
  if(picture)value(renderer.requestObservation(['final-display']));
  const before=performance.now();const receipt=value(renderer.draw({leases:[lease],camera:{lease},environment:{lease}}));const cpuDrawMs=performance.now()-before;
  const waitStart=performance.now();value(await receipt.completed);const completionWaitMs=performance.now()-waitStart;
  const observed=value(await renderer.observe(receipt,{include:picture?['timings','final-display']:['timings']}));
  const inspected=renderer.inspect();if(errors.length)throw new Error(JSON.stringify(errors));
  if(picture){images[mode]=rgba(observed.observations.find(o=>o.domain==='final-display'));await writeFile(resolve(output,`${id}-${mode}.png`),writeReferencePng(images[mode],512,512));}
  return {cpuWorldMs,cpuDrawMs,cpuTotalMs:cpuWorldMs+cpuDrawMs,completionWaitMs,...timingFacts(observed),shadowRaster:inspected.shadowRaster,gpuDriven:inspected.renderScene.gpuDriven,resources:{graph:inspected.renderGraphResourceAllocation,generations:inspected.renderGraphGenerationAllocation,gpuLane:inspected.renderScene.gpuDriven.resourceAllocation}};
 };
 try {
  for(const mode of ['A','B']){for(let i=0;i<16;i++)await frame(mode);phase=0;await frame(mode,true);}
  for(let group=0;group<4;group++)for(let window=0;window<4;window++){const mode=sampling.order[window];await frame(mode);for(let index=0;index<8;index++)raw[mode].push({group,window,index,...await frame(mode)});}
  // A same-size graph recompile must retain accepted static depth.
  reuse=true;value(renderer.setProfile({...renderer.inspect().profile,ssao:true}));await frame('B');
  value(renderer.setProfile({...renderer.inspect().profile,ssao:false}));phase=0;const afterRecompile=await frame('B',true);
  let sum=0;for(let i=0;i<images.A.length;i++)if(i%4!==3)sum+=((images.A[i]-images.B[i])/255)**2;
  const rms=Math.sqrt(sum/(512*512*3));
  const result={id,dirtyRatio,staticCasters:1000-Math.ceil(1000*dirtyRatio),dynamicCasters:Math.ceil(1000*dirtyRatio),parity:{rms,threshold:.05},statistics:Object.fromEntries(['A','B'].map(mode=>[mode,Object.fromEntries(['cpuWorldMs','cpuDrawMs','cpuTotalMs','completionWaitMs','gpuPassEnvelopeMs'].map(key=>[key,{p50:quantile(raw[mode].map(s=>s[key]),.5),p95:quantile(raw[mode].map(s=>s[key]),.95)}]))])),afterRecompile,errors};
  await writeFile(resolve(output,`${id}-raw.json`),JSON.stringify(raw));console.error(JSON.stringify(result));if(rms>.05)throw new Error(`${id} stale shadow parity ${rms}`);report.cases.push(result);
 }finally{unsub();lease.dispose();await renderer.dispose();for(const device of devices)await device.queue.onSubmittedWorkDone();for(const texture of textures)texture.destroy();for(const device of devices)device.destroy();restore();}
}
if(!report.cases.length)throw new Error(`Unknown shadow case ${process.argv[3]}`);
ShadowViewStatePool.prototype.update=originalUpdate;
await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));process.exit(0);
