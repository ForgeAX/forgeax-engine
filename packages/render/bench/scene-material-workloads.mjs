// Physical-GPU diagnostic. Run with the shared GPU EX lock.
// Built packages, public Renderer receipts/timing/inspection; no parallel counters.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder, createPlaneGeometry } from '@forgeax/engine-geometry';
import { Camera, CameraView, CubeCamera, DirectionalLight, Materials, MeshFilter, MeshRenderer, PlanarReflection, ProjectedDecal, ReflectionProbe } from '@forgeax/engine-render';
import { constructRendererHost } from '@forgeax/engine-render/internal/construct-renderer';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { create, globals } from '@forgeax/engine-dawn-node';
import { writeReferencePng } from '../../../apps/shared/png-codec.mjs';
import { makeCanvas, rgba, spawnScene, timingFacts, trackDiagnosticErrors, value } from './scene-material-scaling.mjs';

const root = resolve(import.meta.dirname, '../../..');
const out = resolve(process.argv[2] ?? 'artifacts/scene-material-scaling/workloads');
const suite = process.argv[3] ?? 'visibility';
const sampling = { warmup: 16, order: ['A', 'B', 'B', 'A'], groups: 4, framesPerWindow: 8 };
const quantile = (values, p) => { const s = values.filter(Number.isFinite).sort((a,b) => a-b); return s.length ? s[Math.ceil(s.length*p)-1] : null; };
const stats = (samples, key) => ({ p50: quantile(samples.map(s => s[key]), .5), p95: quantile(samples.map(s => s[key]), .95) });
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error('Dawn adapter unavailable');
const adapterInfo = Object.fromEntries(['vendor','architecture','device','description','backendType'].map(key => [key,adapter.info?.[key] ?? null]));
const report = { sourceHead: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), backend: {runner:`dawn-node/${process.version}`,adapter:adapterInfo,cpu:cpus()[0]?.model}, resolution:[512,512], sampling, resourceScope:'Renderer graph generations and GPU lane logical allocation; driver residency unavailable', cases:[] };
await mkdir(out,{recursive:true});

async function run(config) {
 const devices=new Set(),textures=[];
 const manifest=await readFile(resolve(root,'shared-build-inputs/shaders/manifest.json'),'utf8');
 const errors=[];
 const restoreDiagnostics=trackDiagnosticErrors(errors);
 const host=value(await constructRendererHost(makeCanvas(devices,textures,errors),{rhi,gpuPassTiming:{}},{shaderManifestUrl:`data:application/json,${encodeURIComponent(manifest)}`}));
 const renderer=host.renderer;
 const world=new World();
 const scene=spawnScene(world,config.count ?? 1000,false);
 const lease=value(renderer.attach(world));
 const unsubscribe=renderer.subscribe(event=>{if(event.kind==='error')errors.push(event.error);});
 value(renderer.setProfile({...renderer.inspect().profile,gpuOcclusion:false,...(suite==='decals'?{renderPath:'deferred'}:{})}));
 const spawnMesh=(mesh,material,pos,scale)=>value(world.spawn({component:Transform,data:{pos,scale}},{component:MeshFilter,data:{assetHandle:world.allocSharedRef('MeshAsset',mesh)}},{component:MeshRenderer,data:{materials:[world.allocSharedRef('MaterialAsset',material)]}}));
 const targets=[],decals=[],probes=[],planars=[];
 let lodMeshes;
 const target=(shape,size)=>{ const t=value(renderer.createRenderTarget({shape,width:size,height:size,format:'rgba8unorm',mipLevels:1,sampleCount:1,sampled:true,readback:true}));targets.push({target:t,size,shape});return world.allocSharedRef('RenderTarget',t); };
 if(suite==='lod') {
  const makeLevel=low=>{const mesh=value(createPlaneGeometry(low?.112:.14,.14,low?1:4,low?1:4));const count=mesh.attributes.position.length/3;return value(createMeshBuilder({attributes:{...mesh.attributes,color:Float32Array.from({length:count*4},(_,i)=>i%4===(low?1:0)||i%4===3?1:0)},indices:mesh.indices}).build());};
  const lowerGuid=host.assets.parseGuid('019a0000-0000-7000-8000-000000000322');value(host.assets.catalog(lowerGuid,makeLevel(true)));
  const rootMesh=makeLevel(false);lodMeshes=Object.fromEntries(['A','B'].map(mode=>[mode,world.allocSharedRef('MeshAsset',{...rootMesh,lods:[{mesh:lowerGuid,screenCoverage:.03}],lodHysteresis:mode==='B'?.1:0})]));
  const material=world.allocSharedRef('MaterialAsset',Materials.standard({baseColor:[1,1,1,1],roughness:1,specular:0,renderState:{cullMode:'none'}}));
  for(const {entity} of scene.entities)value(world.set(entity,MeshRenderer,{materials:[material]}));
  const half=Math.hypot(.07,.07)/config.height;value(world.set(scene.camera,Camera,{projection:1,left:-half,right:half,bottom:-half,top:half}));
  value(world.set(scene.light,DirectionalLight,{castShadow:false}));
 }
 if(suite==='visibility') {
  const extent=scene.side*.18;
  spawnMesh(value(createBoxGeometry(config.occlusion==='high'?extent*.8:extent*.1,extent,0.08)),Materials.standard({baseColor:[.1,.1,.1,1],roughness:.8}),[0,0,1],[1,1,1]);
 }
 if(suite==='decals') {
  spawnMesh(value(createPlaneGeometry(scene.side*.18,scene.side*.18)),Materials.standard({baseColor:[.3,.3,.3,1],roughness:.65}),[0,0,.15],[1,1,1]);
  const material=world.allocSharedRef('MaterialAsset',Materials.standard({baseColor:[.8,.1,.1,1],roughness:.1}));
  for(let i=0;i<config.decals;i++)decals.push(value(world.spawn({component:Transform,data:{pos:[(i%8-3.5)*.35,(Math.floor(i/8)-3.5)*.35,.15],scale:config.coverage==='near'?[20,20,15]:[.4,.4,.2]}},{component:ProjectedDecal,data:{material,opacity:1,roughnessOpacity:1}})));
 }
 if(suite==='capture') {
  // An unlit marker makes both reflected and cube-facing content observable.
  // A directional-lit grid viewed from behind can legitimately be dark.
  spawnMesh(value(createBoxGeometry(1.4,1.4,.4)),Materials.unlit([.9,.15,.04,1]),[0,0,1],[1,1,1]);
  if(config.kind==='planar') {
   for(let i=0;i<config.views;i++) {
    const camera=i===0?scene.camera:value(world.spawn({component:Transform,data:{pos:[0,0,scene.side*.19]}},{component:Camera,data:{fov:Math.PI/3,aspect:1,near:.1,far:100,antialias:0,bloom:0}}));
    value(world.addComponent(camera,{component:CameraView,data:{viewport:[i/config.views,0,1/config.views,1],order:i}}));
    value(world.addComponent(camera,{component:PlanarReflection,data:{target:target('2d',128),normal:[0,0,1],distance:1,updateIntervalFrames:1}}));
    planars.push(camera);
   }
  } else if(config.kind==='cube') {
   for(let i=0;i<config.cubes;i++)value(world.spawn({component:Transform,data:{pos:[0,0,2]}},{component:CubeCamera,data:{target:target('cube',config.resolution),faceBudget:1,updateIntent:2}}));
  } else {
   for(let i=0;i<config.probes;i++)probes.push(value(world.spawn({component:Transform,data:{pos:[0,0,2]}},{component:ReflectionProbe,data:{resolution:config.resolution,halfExtents:[20,20,20],updateIntent:0,priority:i}})));
  }
 }
 let currentMode;
 const configure=(mode)=>{
  if(mode===currentMode)return;
  currentMode=mode;
  if(suite==='lod')for(const {entity} of scene.entities)value(world.set(entity,MeshFilter,{assetHandle:lodMeshes[mode]}));
  if(suite==='visibility')value(renderer.setProfile({...renderer.inspect().profile,gpuOcclusion:mode==='B'}));
  if(suite==='decals')for(const decal of decals)value(world.set(decal,ProjectedDecal,{opacity:mode==='B'?1:0,roughnessOpacity:mode==='B'?1:0}));
  if(suite==='capture') {
   for(const camera of planars)value(world.set(camera,PlanarReflection,{updateIntervalFrames:mode==='A'?4:1}));
   for(const probe of probes)value(world.set(probe,ReflectionProbe,{updateIntent:mode==='A'?0:2}));
  }
 };
 const frame=async(mode,picture=false)=>{
  configure(mode);
  const start=performance.now();value(world.update(1/60));value(propagateTransforms(world));const cpuWorldMs=performance.now()-start;
  if(picture)value(renderer.requestObservation(['final-display']));
  const tickets=picture?targets.map(t=>value(renderer.requestTargetReadback(t.target,{mipLevel:0,layer:t.shape==='cube'?5:0}))):[];
  const drawStart=performance.now();const receipt=value(renderer.draw({leases:[lease],camera:{lease},environment:{lease},...(config.geometryLane===undefined?{}:{geometryLane:config.geometryLane})}));const cpuDrawMs=performance.now()-drawStart;
  const waitStart=performance.now();value(await receipt.completed);const completionWaitMs=performance.now()-waitStart;
  const observed=value(await renderer.observe(receipt,{include:picture?['timings','final-display','target-readbacks']:['timings'],...(picture?{targetReadbacks:tickets}:{})}));
  const inspection=renderer.inspect();
  return {cpuWorldMs,cpuDrawMs,cpuTotalMs:cpuWorldMs+cpuDrawMs,completionWaitMs,...timingFacts(observed),resources:{graph:inspection.renderGraphResourceAllocation,generations:inspection.renderGraphGenerationAllocation,gpuLane:inspection.renderScene.gpuDriven.resourceAllocation},gpuDriven:inspection.renderScene.gpuDriven,shadowRaster:inspection.shadowRaster,views:inspection.views,reflectionProbes:inspection.reflectionProbes,frameCaches:inspection.renderScene.frameCaches,...(picture?{observation:observed,inspection}:{})};
 };
 const raw={A:[],B:[]},pictures={};
 try {
  // Probe filtering is bounded across frames; finish the once publication first.
  const warmup=suite==='capture'&&config.kind==='probe'?config.probes*40:suite==='capture'&&config.kind==='cube'?60:sampling.warmup;
  for(const mode of ['A','B']) {
   for(let i=0;i<warmup;i++)await frame(mode);
   if(config.kind==='probe') {
    const inspection=renderer.inspect().reflectionProbes;
    const expected=config.id==='probe-256-six-budget'?5:config.probes;
    if(inspection.acceptedCount!==expected||inspection.activeCount!==expected)throw new Error(`Probe admission/publication falsifier: expected ${expected}, accepted ${inspection.acceptedCount}, active ${inspection.activeCount}`);
   }
   await writeFile(resolve(out,`${config.id}-${mode}-warmup-inspection.json`),JSON.stringify(renderer.inspect(),null,2));
   const picture=await frame(mode,true);pictures[mode]=rgba(picture.observation.observations.find(o=>o.domain==='final-display'));
   await writeFile(resolve(out,`${config.id}-${mode}.png`),writeReferencePng(pictures[mode],512,512));
   await writeFile(resolve(out,`${config.id}-${mode}-inspection.json`),JSON.stringify(picture.inspection,null,2));
   for(const [index,readback] of (picture.observation.targetReadbacks ?? []).entries()) {
    const targetInfo=targets[index];const pixels=new Uint8Array(targetInfo.size*targetInfo.size*4);
    for(let y=0;y<targetInfo.size;y++)pixels.set(readback.bytes.subarray(y*readback.bytesPerRow,y*readback.bytesPerRow+targetInfo.size*4),y*targetInfo.size*4);
    await writeFile(resolve(out,`${config.id}-${mode}-target-${index}.png`),writeReferencePng(pixels,targetInfo.size,targetInfo.size));
    if(!pixels.some((channel,i)=>i%4!==3&&channel>32))throw new Error(`${config.id} target ${index} has no marker content`);
   }
  }
  for(let group=0;group<sampling.groups;group++)for(let window=0;window<4;window++) {
   const mode=sampling.order[window];await frame(mode);
   for(let index=0;index<sampling.framesPerWindow;index++)raw[mode].push({group,window,index,...await frame(mode)});
  }
  const cameraJump=[];
  if(suite==='visibility') {
   for(const x of [scene.side*.18,0,-scene.side*.18,0]) {
    value(world.set(scene.camera,Transform,{pos:[x,0,scene.side*.19]}));
    const pair={};for(const mode of ['A','B'])pair[mode]=rgba((await frame(mode,true)).observation.observations.find(o=>o.domain==='final-display'));
    let sum=0;for(let i=0;i<pair.A.length;i++)if(i%4!==3)sum+=((pair.A[i]-pair.B[i])/255)**2;
    const rms=Math.sqrt(sum/(512*512*3));cameraJump.push({x,rms,threshold:.05});if(rms>.05)throw new Error(`camera jump parity ${rms}`);
   }
  }
  let sum=0;for(let i=0;i<pictures.A.length;i++)if(i%4!==3)sum+=((pictures.A[i]-pictures.B[i])/255)**2;
  const parityRms=Math.sqrt(sum/(512*512*3));
  if(suite==='lod'&&config.geometryLane!=='direct'&&parityRms===0)throw new Error('LOD crossfade falsifier: automatic lane produced identical hard-selection pixels');
  if(suite==='lod'&&config.geometryLane==='direct'&&parityRms!==0)throw new Error('LOD direct fallback falsifier: hard selection pixels changed');
  if((suite==='visibility'||config.kind==='planar')&&parityRms>.05)throw new Error(`fixed scene parity ${parityRms}`);
  const unexpected=errors.filter(error=>config.id!=='probe-256-six-budget'||error.code!=='reflection-probe-budget-exceeded');
  await writeFile(resolve(out,`${config.id}-raw.json`),JSON.stringify(raw));
  const result={...config,warmup,controls:suite==='lod'?{A:'hard selection, hysteresis 0',B:'relative hysteresis .1 (half-band .003); rigid automatic lane crossfades, direct lane hard selects',lightCasting:false}:suite==='visibility'?{A:'HZB off',B:'HZB on'}:suite==='decals'?{A:'decal opacity zero',B:'decal channels on'}:config.kind==='planar'?{A:'cadence 4',B:'cadence 1'}:config.kind==='probe'?{A:'once, filtered and steady',B:'continuous capture'}:{A:'continuous cube',B:'continuous cube (repeat control)'},statistics:Object.fromEntries(['A','B'].map(mode=>[mode,Object.fromEntries(['cpuWorldMs','cpuDrawMs','cpuTotalMs','completionWaitMs','gpuPassEnvelopeMs'].map(key=>[key,stats(raw[mode],key)]))])),parityRms,cameraJump,errors};
  console.error(JSON.stringify(result));if(unexpected.length)throw new Error(`Unexpected Renderer errors: ${JSON.stringify(unexpected)}`);return result;
 } finally {unsubscribe();lease.dispose();await renderer.dispose();for(const device of devices)await device.queue.onSubmittedWorkDone();for(const texture of textures)texture.destroy();for(const device of devices)device.destroy();restoreDiagnostics();}
}

const cases=suite==='lod'?[{id:'lod-auto-near',height:.0315,count:1000},{id:'lod-auto-far',height:.0285,count:1000},{id:'lod-direct-fallback',height:.0315,count:1000,geometryLane:'direct'}]:suite==='visibility'?[1000,10000].flatMap(count=>['low','high'].map(occlusion=>({id:`hzb-${count}-${occlusion}`,count,occlusion}))):suite==='decals'?[1,16,64].flatMap(decals=>['local','near'].map(coverage=>({id:`decals-${decals}-${coverage}`,decals,coverage}))):suite==='capture'?[{id:'planar-one',kind:'planar',views:1},{id:'planar-two',kind:'planar',views:2},{id:'cube-64-one',kind:'cube',cubes:1,resolution:64},{id:'cube-256-three',kind:'cube',cubes:3,resolution:256},{id:'probe-64-three',kind:'probe',probes:3,resolution:64},{id:'probe-256-six-budget',kind:'probe',probes:6,resolution:256}]:[];
if(!cases.length)throw new Error(`Unknown suite ${suite}`);
const selected=cases.filter(config=>process.argv[4]===undefined||config.id===process.argv[4]);
if(!selected.length)throw new Error(`Unknown ${suite} case ${process.argv[4]}`);
for(const config of selected)report.cases.push(await run(config));
await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
process.exit(0);
