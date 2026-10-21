import { halfFloat, mat4 } from '@forgeax/engine/math';
import { readShaderManifestPublication } from '@forgeax/engine/shader';
import * as THREE from 'three/webgpu';
import { texture, vec3, vec4 } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';

const size = 128;
const near = 0.1, far = 100;
function input(kind) {
  const projection = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, near, far);
  const depth = new Float32Array(size * size), reverse = new Float32Array(depth.length);
  const normals = new Float32Array(depth.length * 4), packed = new Uint32Array(depth.length);
  const slope = kind === 'slope' ? 1 : 0;
  // Give both engines the same octahedrally quantized world/view normal.
  const octY = Math.round((slope / (1 + slope) * 0.5 + 0.5) * 4095);
  const octX = 2048, x = octX * 2 / 4095 - 1, y = octY * 2 / 4095 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y), norm = Math.hypot(x, y, z);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const i = py * size + px;
    const distance = kind === 'slope' ? 4 / (1 - (1 - (py + 0.5) * 2 / size) / Math.sqrt(3))
      : kind === 'contact' && px > size / 2 ? 3.8 : kind === 'distant-edge' && px > size / 2 ? 1 : 4;
    reverse[i] = (near * far / distance - near) / (far - near);
    depth[i] = 1 - reverse[i];
    packed[i] = octX | (octY << 12) | (255 << 24);
    normals.set([x / norm, y / norm, z / norm, 1], i * 4);
  }
  return { projection, depth, reverse, normals, packed };
}
function present(id, label, values) {
  const figure = document.createElement('figure'), canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < values.length; i++) rgba.set([values[i] * 255, values[i] * 255, values[i] * 255, 255], i * 4);
  canvas.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
  const caption = document.createElement('figcaption'); caption.textContent = label;
  figure.append(canvas, caption); document.querySelector(`#${id}`).append(figure);
}
function metric(actual, reference) {
  let total = 0, maximum = 0, a = 0, b = 0, count = 0;
  // Exclude screen edges: each renderer has its own out-of-frame policy.
  for (let y = 12; y < size - 12; y++) for (let x = 12; x < size - 12; x++) {
    const i = y * size + x, d = Math.abs(actual[i] - reference[i]);
    if (!Number.isFinite(d)) throw new Error('Non-finite AO');
    total += d; maximum = Math.max(maximum, d); a += actual[i]; b += reference[i]; count++;
  }
  return { meanAbsoluteError: total / count, max: maximum, forgeaxMean: a / count, threeMean: b / count };
}
async function reference(data, scale) {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  await renderer.init(); renderer.setSize(size, size, false);
  renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const camera = new THREE.PerspectiveCamera(60, 1, near, far);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem; camera.updateProjectionMatrix();
  const depth = new THREE.DataTexture(data.depth, size, size, THREE.RedFormat, THREE.FloatType);
  const normal = new THREE.DataTexture(data.normals, size, size, THREE.RGBAFormat, THREE.FloatType);
  depth.needsUpdate = normal.needsUpdate = true;
  const raw = ao(texture(depth), texture(normal), camera); raw.scale.value = scale;
  const filtered = denoise(raw.getTextureNode(), texture(depth), texture(normal), camera);
  const target = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false, colorSpace: THREE.LinearSRGBColorSpace });
  const material = new THREE.NodeMaterial(); material.toneMapped = false;
  const quad = new THREE.QuadMesh(material);
  const output = [];
  try {
    for (const node of [raw, filtered]) {
      material.fragmentNode = vec4(vec3(node.r), 1); material.needsUpdate = true;
      renderer.setRenderTarget(target); await quad.renderAsync(renderer);
      const values = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
      output.push(Float32Array.from({ length: size * size }, (_, i) => halfFloat.f16ToF32(values[i * 4])));
    }
    return { raw: output[0], filtered: output[1] };
  } finally { raw.dispose(); filtered.noiseNode.value.dispose(); target.dispose(); material.dispose(); depth.dispose(); normal.dispose(); renderer.dispose(); }
}
async function native(manifest, data, scale) {
  const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw new Error('WebGPU unavailable');
  const device = await adapter.requestDevice(); device.pushErrorScope('validation');
  const owned = [];
  const makeTexture = (format) => { const t = device.createTexture({size:[size,size],format,usage:1|2|4|16}); owned.push(t); return t; };
  const makeBuffer = (size, usage) => { const b=device.createBuffer({size,usage});owned.push(b);return b; };
  try {
    const depthInput=makeTexture('r32float'), normal=makeTexture('r32uint'), depth=makeTexture('depth32float');
    device.queue.writeTexture({texture:depthInput},data.reverse,{bytesPerRow:size*4},[size,size]);
    device.queue.writeTexture({texture:normal},data.packed,{bytesPerRow:size*4},[size,size]);
    const seed=device.createShaderModule({code:`@group(0) @binding(0) var source:texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
      @fragment fn fs(@builtin(position)p:vec4f)->@builtin(frag_depth) f32 {return textureLoad(source,vec2i(p.xy),0).r;}`});
    const seedPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:seed,entryPoint:'vs'},fragment:{module:seed,entryPoint:'fs',targets:[]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'}});
    const encoder=device.createCommandEncoder();
    const write=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:0}});
    write.setPipeline(seedPipeline);write.setBindGroup(0,device.createBindGroup({layout:seedPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:depthInput.createView()}]}));write.draw(3);write.end();
    const entry=manifest.entries.find(e=>e.wgsl.includes('fn gtaoVisibility'));if(!entry)throw new Error('Production GTAO missing');
    const module=device.createShaderModule({code:entry.wgsl});
    const uniform=makeBuffer(256,64|8), kernel=makeBuffer(1024,64|8);
    const values=new Float32Array(64);values.set(mat4.identity(mat4.create()));values.set(data.projection,16);values.set(mat4.invert(mat4.create(),data.projection),32);values.set([scale,.25,0,16,1,1,1,1],48);device.queue.writeBuffer(uniform,0,values);
    const noise=makeTexture('rgba8unorm'), raw=makeTexture('rgba8unorm'), filtered=makeTexture('r8unorm');
    const sampler=device.createSampler();
    for(const [entryPoint,output,format] of [['fs_ssao_calc',raw,'rgba8unorm'],['fs_ssao_blur',filtered,'r8unorm']]) {
      const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs_ssao'},fragment:{module,entryPoint,targets:[{format}]}});
      const resources=entryPoint==='fs_ssao_calc'?[[0,{buffer:uniform}],[1,{buffer:kernel}],[2,noise.createView()],[3,sampler],[4,normal.createView()],[5,depth.createView()],[6,sampler]]:[[0,{buffer:uniform}],[5,depth.createView()],[6,sampler],[7,raw.createView()]];
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map(([binding,resource])=>({binding,resource}))});
      const pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store'}]});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
    }
    const rawRead=makeBuffer(size*size*4,1|8), filteredRead=makeBuffer(256*size,1|8);
    encoder.copyTextureToBuffer({texture:raw},{buffer:rawRead,bytesPerRow:size*4},[size,size]);encoder.copyTextureToBuffer({texture:filtered},{buffer:filteredRead,bytesPerRow:256},[size,size]);
    device.queue.submit([encoder.finish()]);await Promise.all([rawRead.mapAsync(1),filteredRead.mapAsync(1)]);
    const a=new Uint8Array(rawRead.getMappedRange()), b=new Uint8Array(filteredRead.getMappedRange());
    const result={raw:Float32Array.from({length:size*size},(_,i)=>a[i*4]/255),filtered:Float32Array.from({length:size*size},(_,i)=>b[Math.floor(i/size)*256+i%size]/255)};
    rawRead.unmap();filteredRead.unmap();const error=await device.popErrorScope();if(error)throw error;return result;
  } finally {for(const item of owned)item.destroy();device.destroy();}
}
async function run() {
 const manifest=await readShaderManifestPublication(await(await fetch('/shaders/manifest.json')).json());
 const report={reference:'Three r184 GTAONode + optional DenoiseNode',defaults:{radius:.25,thickness:1,samples:16,distanceExponent:1,distanceFallOff:1,scale:1},denoise:{three:'optional: 16 Poisson samples, radius=5, lumaPhi=depthPhi=normalPhi=5',forgeax:'enabled with AO: 5×5 depth/normal bilateral'},cases:[]};
 for(const kind of ['plane','slope','contact','distant-edge']) {
  const data=input(kind), actual=await native(manifest,data,1), expected=await reference(data,1);
  const section=document.createElement('section');section.id=kind;section.innerHTML=`<h2>${kind}</h2>`;document.querySelector('main').append(section);
  present(kind,'Forgeax · raw',actual.raw);present(kind,'Three · raw',expected.raw);present(kind,'Forgeax · bilateral',actual.filtered);present(kind,'Three · optional denoise',expected.filtered);
  const result={kind,raw:metric(actual.raw,expected.raw),denoised:metric(actual.filtered,expected.filtered)};
  if(kind!=='contact' && result.raw.forgeaxMean<.995)throw new Error(`Unoccluded surface darkened: ${JSON.stringify(result)}`);
  if(kind==='contact' && (result.raw.forgeaxMean>.995 || result.raw.threeMean>.995))throw new Error('Contact occlusion disappeared');
  report.cases.push(result);
 }
 const zero=await native(manifest,input('contact'),0);if(zero.raw.some(x=>x!==1)||zero.filtered.some(x=>x!==1))throw new Error('Zero intensity must be identity');
 report.zeroIntensityIdentity=true;
 document.querySelector('#status').textContent=JSON.stringify(report,null,2);globalThis.gtaoResponse=report;
}
run().catch(e=>{document.querySelector('#status').textContent=String(e.stack??e);globalThis.gtaoResponseError=String(e.stack??e);});
