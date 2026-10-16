import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { decodeTape, buildFrameModel, openReplay, halfToFloat } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { readReferencePng, writeReferencePng } from '../../../shared/png-codec.mjs';

const path = resolve(process.argv[2]);
const directory = resolve(dirname(path), `${basename(path, '.rhitape')}-inspection`);
mkdirSync(directory, { recursive: true });
const bytes = new Uint8Array(readFileSync(path));
const tape = decodeTape(bytes).unwrap(), model = buildFrameModel(tape);
const work = entry => {
  const matches = model.works.filter(w => w.pipeline.shaders.some(s => s.entryPoint === entry));
  assert.equal(matches.length, 1, `Expected one ${entry}`);
  return matches[0];
};
const trace = work('ssr_trace'), temporal = work('ssr_temporal'), compose = work('fs_ssr_compose');
const taa = model.works.find(w => w.pipeline.shaders.some(s => s.source?.includes('fn blendTaaHistory')));
const binding = (w,b) => {
  const row = w.bindings.find(row => row.groupIndex === 0 && row.binding === b);
  assert.ok(row?.resourceId, `Missing ${b} at work ${w.workIndex}`);
  return row.resourceId;
};
assert.equal(binding(trace,4), binding(temporal,0));
assert.equal(binding(trace,8), binding(temporal,11));
if (taa) {
  const mask = taa.bindings.find(row => row.groupIndex === 1 && row.binding === 10);
  assert.equal(mask?.resourceId, binding(temporal,10), 'TAA reads the SSR-produced presentation mask');
}
const backend = await bootstrapDawn('SSR motion recovery', tape);
const replay = (await openReplay(tape,{ device: backend.freshDevice,
  createShaderModule: (device, descriptor) => backend.rhiWebgpu.createShaderModule(device, descriptor) })).unwrap();
const locations = [[640,780],[630,800],[650,820],[600,800],[700,800],[657,827],[656,830],[657,826],
  [474,422],[603,553],[678,533],[669,641],[677,539],[718,726],[680,485]];
const reads = [];
try {
  const final = model.works.at(-1);
  const display = (await replay.readResourceAtWork(final.attachments.colorViewHandleIds[0],final.workIndex)).unwrap();
  assert.equal(display.format,'rgba8unorm');
  assert.ok(locations.every(([x,y]) => x < display.width && y < display.height),
    'Motion probes must lie inside the recorded display extent');
  const read = async (name, id, index, half = false) => {
    const r = (await replay.readResourceAtWork(id,index)).unwrap();
    assert.equal(r.provenance.selectedWorkIndex,index);
    const view = new DataView(r.bytes.buffer,r.bytes.byteOffset,r.bytes.byteLength);
    const channels = r.format.startsWith('rgba') ? 4 : 1;
    const value = (x,y,c) => {
      const p = (y*r.width+x)*channels+c;
      if (r.format.endsWith('16float')) return halfToFloat(view.getUint16(p*2,true));
      if (r.format.endsWith('32float')) return view.getFloat32(p*4,true);
      assert.ok(r.format === 'rgba8unorm' || r.format === 'r8unorm'); return r.bytes[p]/255;
    };
    const pixels = locations.map(([x,y]) => {
      // TAAU keeps display history at presentation size while SSR and scene
      // inputs follow the submitted internal extent. Derive each probe from
      // its real readback instead of assuming every intermediate is half-size.
      const resourcePixel = {
        x: Math.floor((x + 0.5) * r.width / display.width),
        y: Math.floor((y + 0.5) * r.height / display.height),
      };
      return { x,y,resourcePixel,
        values: Array.from({length: channels},(_,c) => value(resourcePixel.x,resourcePixel.y,c)) };
    });
    // Whole-resource extrema and nonzero counts expose missed local probes.
    // History alpha is signed depth; it is deliberately not labelled confidence.
    const channelStats = Array.from({length:channels},(_,c) => {
      let minimum=Infinity, maximum=-Infinity, nonzero=0, nonfinite=0;
      const codes = r.format === 'rgba8unorm' ? new Array(256).fill(0) : undefined;
      for (let y=0;y<r.height;y++) for (let x=0;x<r.width;x++) {
        const v=value(x,y,c);
        if (!Number.isFinite(v)) { nonfinite++; continue; }
        minimum=Math.min(minimum,v); maximum=Math.max(maximum,v);
        if (v !== 0) nonzero++;
        if (codes) codes[Math.round(v*255)]++;
      }
      return {minimum,maximum,nonzero,nonfinite,...(codes ? {codes} : {})};
    });
    reads.push({name,workIndex:index,resourceId:id,format:r.format,extent:[r.width,r.height],
      provenance:r.provenance,channelStats,pixels});
    if (half && channels === 4 && name !== 'previous-history') {
      const png = new Uint8Array(r.width*r.height*4);
      for (let y=0;y<r.height;y++) for (let x=0;x<r.width;x++) {
        const confidence = Math.round(Math.max(0,Math.min(1,value(x,y,3)))*255);
        png.set([confidence,confidence,confidence,255],(y*r.width+x)*4);
      }
      writeFileSync(resolve(directory,`${name}-confidence.png`),writeReferencePng(png,r.width,r.height));
      if (name === 'history-surface') {
        for (let y=0;y<r.height;y++) for (let x=0;x<r.width;x++) {
          const mask = Math.round(value(x,y,0)*255);
          png.set([mask,mask,mask,255],(y*r.width+x)*4);
        }
        writeFileSync(resolve(directory,'secondary-reactivity.png'),writeReferencePng(png,r.width,r.height));
      }
    }
    return r;
  };
  await read('trace',binding(trace,4),trace.workIndex,true);
  await read('hit-reactivity',binding(trace,8),trace.workIndex,true);
  await read('previous-history',binding(temporal,3),temporal.workIndex,true);
  await read('previous-surface',binding(temporal,9),temporal.workIndex,true);
  await read('history-surface',binding(temporal,10),temporal.workIndex,true);
  await read('resolved',binding(temporal,7),temporal.workIndex,true);
  await read('composed',compose.attachments.colorViewHandleIds[0],compose.workIndex);
  if (taa) {
    const input = b => {
      const row=taa.bindings.find(row=>row.groupIndex===1 && row.binding===b);
      assert.ok(row?.resourceId); return row.resourceId;
    };
    await read('taa-current-temporal',input(6),taa.workIndex);
    await read('taa-previous-temporal',input(4),taa.workIndex);
    await read('taa-previous-stability',input(9),taa.workIndex);
    await read('taa',taa.attachments.colorViewHandleIds[0],taa.workIndex);
    await read('taa-stability',taa.attachments.colorViewHandleIds[2],taa.workIndex);
  }
  const r = display;
  assert.equal(r.format,'rgba8unorm');
  writeFileSync(resolve(directory,'replayed-display.png'),writeReferencePng(r.bytes,r.width,r.height));
  let comparison;
  if (process.argv[3]) {
    const live = readReferencePng(resolve(process.argv[3]));
    assert.equal(live.width,r.width); assert.equal(live.height,r.height);
    const errors = [];
    for (let p=0;p<r.bytes.length;p+=4) errors.push(Math.max(...[0,1,2].map(c => Math.abs(r.bytes[p+c]-live.pixels[p+c]))));
    errors.sort((a,b)=>a-b);
    comparison = { pixels:errors.length,maximum:errors.at(-1),p95:errors[Math.ceil(errors.length*0.95)-1],above4:errors.filter(e=>e>4).length };
    assert.equal(comparison.maximum,0,'Fresh replay must match the captured display exactly');
  }
  const report = { mode:'unmodified-fresh-device-motion-replay',digest:createHash('sha256').update(bytes).digest('hex'),
    unseeded:model.unseededResources,works:model.works.map(w=>({workIndex:w.workIndex,entries:w.pipeline.shaders.map(s=>s.entryPoint)})),reads,comparison };
  writeFileSync(resolve(directory,'motion-replay.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { replay.dispose(); }
process.exit(0);
