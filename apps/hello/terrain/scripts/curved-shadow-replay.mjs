import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { buildFrameModel, decodeTape, openReplay, replayDeviceRequest } from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { readReferencePng, writeReferencePng } from '../../../shared/png-codec.mjs';

const input = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const raw = readFileSync(input);
const tape = decodeTape(raw).unwrap();
const model = buildFrameModel(tape);
const reference = readReferencePng(input.replace(/-on\.rhitape$/, '-off.png'));
const live = readReferencePng(input.replace(/\.rhitape$/, '.png'));
const { create, globals } = createRequire(resolve(import.meta.dirname, '../../../../package.json'))('webgpu');
Object.assign(globalThis, globals);
Object.defineProperty(globalThis.navigator, 'gpu', { configurable: true, value: create(['backend=metal']) });
mkdirSync(output, { recursive: true });
const rows = [];
const difference = (a,b) => {
  let changed=0, peak=0, sum=0;
  for(let i=0;i<a.length;i++)if(i%4!==3){const delta=Math.abs(a[i]-b[i]);sum+=delta;peak=Math.max(peak,delta);if(delta>2)changed++;}
  return {changedChannels:changed,peakByteDifference:peak,meanByteDifference:sum/(a.length/4*3)};
};
for (const mode of ['baseline','receiver-shadow-factor-one']) {
  const adapter = (await backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice(replayDeviceRequest(tape,adapter.features,adapter.limits))).unwrap();
  let patches=0;
  const factory = async (owner,desc) => {
    let code=desc.code;
    if(mode!=='baseline') {
      const signature=/fn evalDirectionalShadowFactor[^\{]*\{/g;
      const match=signature.exec(code);
      if(match) {
        const start=match.index+match[0].length;
        let depth=1,end=start;
        while(depth>0&&end<code.length){if(code[end]==='{')depth++;if(code[end]==='}')depth--;end++;}
        assert.equal(depth,0,'actual compiled shadow function must close');
        code=code.slice(0,start)+'\n return 1.0;\n'+code.slice(end-1);
        patches++;
      }
    }
    return backend.createShaderModule(owner,{...desc,code});
  };
  const replay=(await openReplay(tape,{device,createShaderModule:factory})).unwrap();
  try {
    const result=(await replay.inspectWork(model.works.at(-1).workIndex,['pixels'])).unwrap();
    const image=result.attachment;
    assert(image?.bytes&&image.width===live.width&&image.height===live.height);
    const pixels=image.bytes.slice();
    if(image.format.startsWith('bgra'))for(let i=0;i<pixels.length;i+=4)[pixels[i],pixels[i+2]]=[pixels[i+2],pixels[i]];
    writeFileSync(resolve(output,mode+'.png'),writeReferencePng(pixels,image.width,image.height));
    const row={mode,patches,workIndex:result.workIndex,format:image.format,liveDifference:difference(pixels,live.pixels),unshadowedReferenceDifference:difference(pixels,reference.pixels)};
    if(mode==='baseline')assert(row.liveDifference.peakByteDifference<=2,'unmodified fresh-device replay must reproduce actual live frame');
    else {assert(patches>0,'must patch actual receiver function');assert(row.unshadowedReferenceDifference.peakByteDifference<=2,'only the actual receiver shadow factor must explain the false darkening');}
    rows.push(row);
  } finally {(await replay.dispose()).unwrap();backend._internal_getRawDevice(device)?.destroy();}
}
writeFileSync(resolve(output,'report.json'),JSON.stringify({status:'DIAGNOSTIC',input:basename(input),originalTapeSha256:createHash('sha256').update(raw).digest('hex'),boundary:'Fresh-device replay keeps all recorded producers, geometry, resources, uniforms and bindings. Counterfactual replaces only the actual receiver shadow factor with one; it is cause attribution, not a product fix.',rows},null,2));
console.log(JSON.stringify(rows));
