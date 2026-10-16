#!/usr/bin/env node
import { create, globals } from '@forgeax/engine-dawn-node';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as webgpu from '../../../../packages/rhi-webgpu/dist/index.mjs';
import { decodeTape, buildFrameModel, openReplay, replayDeviceRequest } from '../../../../packages/rhi-debug/dist/index.mjs';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const directory = resolve(process.env.FORGEAX_ATMOSPHERE_EVIDENCE ?? 'artifacts/atmosphere/browser');
const output = resolve(directory, 'replay');
await mkdir(output, {recursive:true});
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', {value:{gpu:create(process.platform === 'darwin' ? ['backend=metal'] : [])}, configurable:true});
const report = JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8'));
const rows=[];
const half = bits => {
  const sign = bits & 32768 ? -1 : 1, exponent=(bits>>>10)&31, fraction=bits&1023;
  return sign*(exponent===31 ? (fraction===0?Infinity:NaN) : exponent===0 ? fraction*2**-24 : (1+fraction/1024)*2**(exponent-15));
};
for (const row of report.results.filter(row=>row.capture!==undefined)) {
  const tapePath=resolve(directory,row.capture.path);
  const stored=await readFile(tapePath);
  const bytes=new Uint8Array(tapePath.endsWith('.gz')?gunzipSync(stored):stored);
  const tape=decodeTape(bytes).unwrap(), model=buildFrameModel(tape);
  const adapter=(await webgpu.rhi.requestAdapter()).unwrap();
  const limits={};for(const key in adapter.limits) if(typeof adapter.limits[key]==='number')limits[key]=adapter.limits[key];
  const device=(await adapter.requestDevice(replayDeviceRequest(tape,adapter.features,limits))).unwrap();
  const raw=webgpu._internal_getRawDevice(device), errors=[];
  raw.addEventListener('uncapturederror',event=>errors.push(event.error.message));
  const replay=(await openReplay(tape,{device,createShaderModule:webgpu.createShaderModule})).unwrap();
  try {
    const last=model.works.at(-1), handle=last.attachments.colorViewHandleIds[0];
    const result=(await replay.readResourceAtWork(handle,last.workIndex)).unwrap();
    const rgba=result.bytes.slice();
    if(result.format.startsWith('bgra')) for(let i=0;i<rgba.length;i+=4) [rgba[i],rgba[i+2]]=[rgba[i+2],rgba[i]];
    const livePath=resolve(directory,row.readbackPath ?? `${row.name}.rgba`);
    const liveStored=await readFile(livePath);
    const live=new Uint8Array(livePath.endsWith('.gz')?gunzipSync(liveStored):liveStored);
    if(live.length!==rgba.length)throw new Error('Replay extent changed');
    const differences=[];for(let i=0;i<rgba.length;i++)differences.push(Math.abs(rgba[i]-live[i])/255);
    differences.sort((a,b)=>a-b);
    const parity={mean:differences.reduce((a,b)=>a+b,0)/differences.length,p95:differences[Math.floor(differences.length*.95)],p99:differences[Math.floor(differences.length*.99)],max:differences.at(-1)};
    if(parity.p99>2/255)throw new Error(`${row.name} fresh-device replay mismatch: ${JSON.stringify(parity)}`);
    await writeFile(resolve(output,`${row.name}.png`),writeReferencePng(rgba,result.width,result.height));
    // Retain linear HDR before tone mapping. This also detects half-float
    // overflow hidden by the final display transform.
    const hdrWork=model.works.findLast(work=>work.attachments?.colorViewHandleIds?.length>0 && work.workIndex<last.workIndex && work.pipeline.status==='available' && work.pipeline.shaders.some(shader=>/atmosphere_compose|fs_resolve|volume_fs|fs_main/.test(shader.entryPoint)));
    let hdr;
    if(hdrWork!==undefined){
      const value=(await replay.readResourceAtWork(hdrWork.attachments.colorViewHandleIds[0],hdrWork.workIndex)).unwrap();
      if(value.format==='rgba16float'){
        const view=new DataView(value.bytes.buffer,value.bytes.byteOffset,value.bytes.byteLength);let min=Infinity,max=-Infinity,nonfinite=0,saturated=0;
        for(let i=0;i<value.bytes.length;i+=2){const v=half(view.getUint16(i,true));if(!Number.isFinite(v))nonfinite++;else{min=Math.min(min,v);max=Math.max(max,v);if(Math.abs(v)===65504)saturated++;}}
        hdr={workIndex:hdrWork.workIndex,width:value.width,height:value.height,format:value.format,min,max,nonfinite,saturated};
        if(nonfinite||saturated)throw new Error(`${row.name} invalid HDR: ${JSON.stringify(hdr)}`);
        await writeFile(resolve(output,`${row.name}.rgba16f`),value.bytes);
      }
    }
    await raw.queue.onSubmittedWorkDone();
    if(errors.length)throw new Error(JSON.stringify(errors));
    rows.push({name:row.name,tapeSha256:createHash('sha256').update(bytes).digest('hex'),works:model.works.map(work=>({index:work.workIndex,kind:work.kind,entryPoints:work.pipeline.status==='available'?work.pipeline.shaders.map(shader=>shader.entryPoint):[],attachments:work.attachments})),unseededResources:model.unseededResources,parity,hdr,errors});
    console.log(JSON.stringify({name:row.name,works:model.works.length,parity,hdr,errors}));
  } finally { (await replay.dispose()).unwrap();raw.destroy(); }
}
await writeFile(resolve(output,'report.json'),`${JSON.stringify({status:'pass',rows},null,2)}\n`);
process.exit(0);
