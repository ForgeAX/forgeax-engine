import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { standardSurfaceParameters, type AssetHandle, type TextureAsset } from '@forgeax/engine-types';
import { observeTerrainLayerAllocation } from './terrain-layer-allocation';
import { GpuResidencyCache } from '../src/device/gpu-residency';
import { defaultMaterialSnapshot } from '../src/render-system-extract';
import { TerrainLayers } from '../src/terrain/layers';
import { TerrainSourceCache } from '../src/terrain/source';

/** Opt-in paired GPU measurement. The baseline is the removed four baked RGBA16F reads. */
export async function measureTerrainLayerCost(sampling: string, pattern: 'uniform' | 'checker' = 'uniform') {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })).unwrap();
  const raw = _internal_getRawDevice(device);
  if (raw === undefined || !raw.features.has('timestamp-query')) throw new Error('timestamp-query is required');
  raw.pushErrorScope('validation');
  const registry = new AssetRegistry(), world = new World({ assets: registry });
  const channels = ['baseColorTexture','normalTexture','metallicRoughnessTexture','occlusionTexture','emissiveTexture'] as const;
  const data = Uint8Array.from(Array.from({length:256*256},(_, i)=>pattern === 'uniform' ? [128,128,128,255] : [96 + ((i % 256) & 31), 96 + ((i >>> 8) & 31), 96 + ((i + (i >>> 8)) & 63), 255]).flat());
  const textureHandles: AssetHandle<'texture'>[][] = [];
  const layers = Array.from({length:32},()=> {
    const values = Object.fromEntries(channels.map(name=>[name,registry.create({kind:'texture',format:'rgba8unorm',colorSpace:'linear',shape:{viewDimension:'2d',extent:{width:256,height:256}},mips:{kind:'none'},data}).unwrap()]));
    textureHandles.push(Object.values(values));
    const material = registry.create({kind:'material',colorSpace:'linear',parameters:standardSurfaceParameters(channels.map(name=>({name,type:'texture' as const}))),values:{...values,baseColor:[1,1,1,1],emissive:[1,1,1],emissiveIntensity:1,roughness:0.5,metallic:0.5},passes:[{name:'forward',program:{module:'forgeax_material::standard'}}]}).unwrap();
    return {material,blend:'weight' as const};
  });
  const weights = new Float32Array(4*32); for(let pixel=0;pixel<4;pixel++)for(let layer=0;layer<4;layer++)weights[pixel*32+layer]=0.25;
  const root = registry.create({kind:'terrain',columns:2,rows:2,spacing:1,subsectionVertices:2,heights:new Float32Array(4),weights,layers}).unwrap();
  const allocation = observeTerrainLayerAllocation(device);
  const coldStarted = performance.now();
  const sourceCache = new TerrainSourceCache();
  const store = new GpuResidencyCache();store.configureGpuDevice(device,undefined,device.caps);
  const owner = new TerrainLayers(() => store,()=>device,{createShaderModule:descriptor=>rhi.createShaderModuleImmediate(device,descriptor)});
  const snapshot = {...defaultMaterialSnapshot()};owner.bind(snapshot,owner.capture(world,sourceCache.resolve(world,root)));
  const layerBindings = ['terrainColorLayers', 'terrainNormalHeightLayers', 'terrainOrmLayers', 'terrainEmissionLayers'].map(name => {
    const binding = owner.texture(snapshot, name); if (binding === undefined) throw new Error('layer capture unavailable'); return binding;
  });
  const coldPreparationCpuMs = performance.now() - coldStarted;
  const common=`struct SurfaceInput { uv0:vec2<f32> }\n@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> { let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));return vec4<f32>(p[i],0.0,1.0);}`;
  const current = raw.createShaderModule({code:`${common}\n@group(0) @binding(1) var samp:sampler;\n@group(0) @binding(2) var terrainColorLayers:texture_2d_array<f32>;\n@group(0) @binding(3) var terrainNormalHeightLayers:texture_2d_array<f32>;\n@group(0) @binding(4) var terrainOrmLayers:texture_2d_array<f32>;\n@group(0) @binding(5) var terrainEmissionLayers:texture_2d_array<f32>;\n${sampling.replace(/^#.*\n/gm,'').replace(/terrain\w+_sampler/g, 'samp')}\n@fragment fn fs(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{var sum=vec4<f32>(0.0);for(var i=0;i<4;i++){let s=terrain_layer(i,SurfaceInput(p.xy/512.0));sum+=s.color+s.normalHeight+vec4<f32>(s.orm,0.0)+vec4<f32>(s.emission,0.0);}return sum${pattern === 'checker' ? '*0.25' : ''};}`});
  const baseline = raw.createShaderModule({code:`${common}\n@group(0) @binding(1) var samp:sampler;\n@group(0) @binding(2) var colors:texture_2d_array<f32>;\n@group(0) @binding(3) var normals:texture_2d_array<f32>;\n@group(0) @binding(4) var orm:texture_2d_array<f32>;\n@group(0) @binding(5) var emissions:texture_2d_array<f32>;\n@fragment fn fs(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{var sum=vec4<f32>(0.0);for(var i=0;i<4;i++){sum+=textureSampleLevel(colors,samp,p.xy/512.0,i,0.0)+textureSampleLevel(normals,samp,p.xy/512.0,i,0.0)+textureSampleLevel(orm,samp,p.xy/512.0,i,0.0)+textureSampleLevel(emissions,samp,p.xy/512.0,i,0.0);}return sum${pattern === 'checker' ? '*0.25' : ''};}`});
  const currentLayout=raw.createBindGroupLayout({entries:[{binding:1,visibility:2,sampler:{type:'filtering'}},...[2,3,4,5].map(binding=>({binding,visibility:2,texture:{sampleType:'float' as const,viewDimension:'2d-array' as const}}))]});
  const oldLayout=raw.createBindGroupLayout({entries:[{binding:1,visibility:2,sampler:{type:'filtering'}},...[2,3,4,5].map(binding=>({binding,visibility:2,texture:{sampleType:'float' as const,viewDimension:'2d-array' as const}}))]});
  const pipeline=(module:GPUShaderModule,layout:GPUBindGroupLayout)=>raw.createRenderPipeline({layout:raw.createPipelineLayout({bindGroupLayouts:[layout]}),vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});
  const pipelines=[pipeline(baseline,oldLayout),pipeline(current,currentLayout)];
  function half(value:number){const bits=new Uint32Array(new Float32Array([value]).buffer)[0]??0;const e=((bits>>>23)&255)-127+15,m=bits&0x7fffff;return ((bits >>> 16) & 0x8000) | (e<=0?e < -10?0:(((m|0x800000)>>>(1-e))+0x1000)>>>13:(e<<10)+((m+0x1000)>>>13));}
  const v=128/255,n=v*2-1;
  const baked=[[v,v,v,1],[n,n,Math.sqrt(1-2*n*n),0],[v,v*0.5,v*0.5,0],[v,v,v,0]].map((value, channel)=>{
    const texture=raw.createTexture({size:[256,256,32],format:'rgba16float',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
    const bytes=new Uint16Array(256*256*32*4),pixel=value.map(half);
    for(let i=0;i<bytes.length;i+=4) {
      if (pattern === 'uniform') bytes.set(pixel,i);
      else {
        const source = i % data.length;
        const r = data[source]! / 255, g = data[source + 1]! / 255, b = data[source + 2]! / 255;
        const nx = r * 2 - 1, ny = g * 2 - 1;
        const values = channel === 0 ? [r, g, b, 1] : channel === 1 ? [nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)), 0] : channel === 2 ? [r, g * 0.5, b * 0.5, 0] : [r, g, b, 0];
        bytes.set(values.map(half), i);
      }
    }
    raw.queue.writeTexture({texture},bytes,{bytesPerRow:256*8,rowsPerImage:256},[256,256,32]);return texture;
  });
  const groups=[raw.createBindGroup({layout:oldLayout,entries:[{binding:1,resource:raw.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'})},...baked.map((texture,i)=>({binding:i+2,resource:texture.createView({dimension:'2d-array'})}))]}),device.createBindGroup({layout:currentLayout as unknown as import('@forgeax/engine-rhi').BindGroupLayout,entries:[{binding:1,resource:{kind:'sampler',value:layerBindings[0]!.sampler}},...layerBindings.map((binding,i)=>({binding:i+2,resource:{kind:'textureView' as const,value:binding.textureView}}))]}).unwrap() as unknown as GPUBindGroup];
  const target=raw.createTexture({size:[512,512],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),view=target.createView();
  const queries=raw.createQuerySet({type:'timestamp',count:2}),resolve=raw.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),read=raw.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const coldEncodeStarted = performance.now();
  const upload=store.prepareTextureMips().unwrap();
  const coldEncodeCpuMs = performance.now() - coldEncodeStarted;
  const coldSubmitStarted = performance.now();
  if(upload!==undefined){device.queue.submit(upload.buffer === undefined ? [] : [upload.buffer]).unwrap();upload.complete(true);}await raw.queue.onSubmittedWorkDone();
  const preparation = [{ name: 'cold', cpuMs: coldPreparationCpuMs + coldEncodeCpuMs, submitToCompleteWallMs: performance.now() - coldSubmitStarted, allocation: allocation.snapshot() }];
  const sample = async (index: number) => {
      const encoder=raw.createCommandEncoder();const pass=encoder.beginRenderPass({colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}],timestampWrites:{querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});
      pass.setPipeline(pipelines[index]!);pass.setBindGroup(0,groups[index]!);pass.draw(3);pass.end();encoder.resolveQuerySet(queries,0,2,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,16);raw.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const ticks=new BigUint64Array(read.getMappedRange());const ms=Number((ticks[1]??0n)-(ticks[0]??0n))/1e6;read.unmap();return ms;
  };
  const rounds = async (arms: readonly [number, number]) => {
    const values: number[][] = [[], []];
    for (let round = 0; round < 70; round++) for (const arm of round % 2 === 0 ? [0, 1] : [1, 0]) {
      const ms = await sample(arms[arm]!);
      if (round >= 10) values[arm]!.push(ms);
    }
    return values;
  };
  try {
    // Fixed pre-measurement A/A control: same shader, backend, image and submission path.
    const calibration = await rounds([0, 0]);
    const samples = await rounds([0, 1]);
    // Read every output pixel outside timestamped rounds; performance requires parity.
    const pixels = raw.createBuffer({size:512*512*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const outputs: Uint16Array[] = [];
    try {
      for (let index=0; index<2; index++) {
        const encoder=raw.createCommandEncoder();
        const pass=encoder.beginRenderPass({colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
        pass.setPipeline(pipelines[index]!);pass.setBindGroup(0,groups[index]!);pass.draw(3);pass.end();
        encoder.copyTextureToBuffer({texture:target},{buffer:pixels,bytesPerRow:512*8,rowsPerImage:512},[512,512]);
        raw.queue.submit([encoder.finish()]);await pixels.mapAsync(GPUMapMode.READ);
        outputs.push(new Uint16Array(pixels.getMappedRange().slice(0)));pixels.unmap();
      }
    } finally {pixels.destroy();}
    const f16=(word:number)=>{const sign=word&0x8000?-1:1, exponent=(word>>>10)&31, mantissa=word&1023;return sign*(exponent===0?mantissa*2**-24:(1+mantissa/1024)*2**(exponent-15));};
    let maximumError=0, maximumIndex=0;
    for(let i=0;i<outputs[0]!.length;i++){const error=Math.abs(f16(outputs[0]![i]!)-f16(outputs[1]![i]!));if(error>maximumError){maximumError=error;maximumIndex=i;}}
    if(!Number.isFinite(maximumError)||maximumError>0.005)throw new Error(`Terrain output mismatch: ${maximumError}, component ${maximumIndex}, baseline ${f16(outputs[0]![maximumIndex]!)}, current ${f16(outputs[1]![maximumIndex]!)}`);
    const observer = registry.observe().unwrap();
    const phase = async (name: string, action: () => void) => {
      allocation.reset();
      const started = performance.now();
      action();
      const batch = observer.read().unwrap();
      for (const change of batch.changes) {
        const content = runtimeAssets(registry).borrow<TextureAsset>(change.handle).unwrap();
        store.adoptTextureChange(change, content.kind === 'texture' ? content : undefined, world).unwrap();
      }
      owner.adopt(world, batch.changes);
      sourceCache.adopt(world, batch.changes);
      batch.accept();
      const next = { ...defaultMaterialSnapshot() };
      owner.bind(next, owner.capture(world, sourceCache.resolve(world, root)));
      owner.texture(next, 'terrainColorLayers');
      const updates = store.prepareTextureMips().unwrap();
      const cpuMs = performance.now() - started;
      const submitted = performance.now();
      if (updates !== undefined) { device.queue.submit(updates.buffer === undefined ? [] : [updates.buffer]).unwrap(); updates.complete(true); }
      await raw.queue.onSubmittedWorkDone();
      preparation.push({ name, cpuMs, submitToCompleteWallMs: performance.now() - submitted, allocation: allocation.snapshot() });
    };
    await phase('unchanged', () => {});
    await phase('unselected-pixel', () => registry.writeRange(textureHandles[31]![0]!, { origin: { x: 1, y: 1 }, size: { width: 1, height: 1 }, data: new Uint8Array([0, 255, 0, 255]) }).unwrap());
    await phase('material-value', () => registry.update(layers[0]!.material, { values: { baseColor: [0.5, 1, 1, 1] } }).unwrap());
    await phase('selected-pixel', () => registry.writeRange(textureHandles[0]![0]!, { origin: { x: 1, y: 1 }, size: { width: 1, height: 1 }, data: new Uint8Array([0, 255, 0, 255]) }).unwrap());
    await phase('selected-resize', () => registry.update(textureHandles[0]![0]!, { shape: { viewDimension: '2d', extent: { width: 128, height: 256 } }, data: data.slice(0, 128 * 256 * 4) }).unwrap());
    owner.dispose(); store.destroyAll(); await raw.queue.onSubmittedWorkDone();
    const retired = allocation.snapshot();
    const error=await raw.popErrorScope();if(error!==null)throw error;
    const summary=samples.map(input=>{const values=[...input].sort((a,b)=>a-b);return{medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.floor(values.length*0.95)],samples:values.length};});
    return {pattern,noise:pairedNoise(calibration, samples),calibration,workload:{pixels:512*512,activeLayers:4,declaredLayers:32,sourceImages:160,imageExtent:256,sourcePixel:pattern === 'uniform' ? [128,128,128,255] : undefined},parity:{maximumError,epsilon:0.005},preparation,retired,baselineAllocatedTextureBytes:4*256*256*32*8,samples,baseline:summary[0],shared:summary[1],medianRatio:(summary[1]?.medianMs??0)/(summary[0]?.medianMs??1)};
  } finally {owner.dispose();store.destroyAll();allocation.dispose();for(const texture of baked)texture.destroy();target.destroy();queries.destroy();resolve.destroy();read.destroy();}
}


/** Deterministic 99% bootstrap interval for median paired A/A timestamp differences.
 * Freeze its symmetric radius before comparing the unchanged/current pair. */
function pairedNoise(control: number[][], measured: number[][]) {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const differences = (samples: number[][]) => samples[0]!.map((value, index) => samples[1]![index]! - value);
  const baseline = differences(control);
  let seed = 0x54455252;
  const bootstrap = Array.from({ length: 4096 }, () => median(Array.from({ length: baseline.length }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return baseline[(seed >>> 0) % baseline.length]!;
  }))).sort((a, b) => a - b);
  const interval = [bootstrap[Math.floor(bootstrap.length * 0.005)]!, bootstrap[Math.floor(bootstrap.length * 0.995)]!];
  const radiusMs = Math.max(...interval.map(Math.abs));
  const currentMedianDifferenceMs = median(differences(measured));
  return { method: 'paired A/A median difference; deterministic 4096-resample 99% interval', controlIntervalMs: interval, fixedRadiusMs: radiusMs, currentMedianDifferenceMs, withinMeasuredNoise: currentMedianDifferenceMs <= radiusMs };
}
