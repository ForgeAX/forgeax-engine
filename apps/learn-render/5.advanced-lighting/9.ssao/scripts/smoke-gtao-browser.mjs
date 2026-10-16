import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFrameModel, openReplay, tapeDigest } from '@forgeax/engine-rhi-debug';
import { rhi, createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { verifyDemoCapture, requestReplayDeviceForTape } from '../../../../shared/scripts/rhi-debug-verify.mjs';
import { writeReferencePng } from '../../../../shared/png-codec.mjs';

const appDir = resolve(import.meta.dirname, '..');
const lifted = process.argv.includes('--lifted');
const room = process.argv.includes('--room');
assert.ok(!(room && lifted), 'Room and isolated lifted-cube checks are separate scenes');
let tape;
const result = await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-9-ssao',
  label: 'GTAO dynamic OFF/ON and fresh replay',
  appDir,
  urlSuffix: `?algorithm=gtao${lifted ? '&lift=1' : ''}${room ? '&scene=room' : ''}`,
  mode: 'pixel',
  liveHook: '__captureSsao',
  ...(lifted ? {} : { capturePrepareHook: '__verifySsao' }),
  reportHook: '__ssaoEvidence',
  assertTape: (input) => { tape = input.tape; },
});
assert.ok(tape);
const model = buildFrameModel(tape);
const calc = model.works.find((work) => work.pipeline.shaders.some((s) => s.entryPoint === 'fs_ssao_calc'));
const blur = model.works.find((work) => work.pipeline.shaders.some((s) => s.entryPoint === 'fs_ssao_blur'));
assert.ok(calc && blur, 'Both AO producer works must exist');
assert.ok(calc.workIndex < blur.workIndex, 'Visibility precedes filtering');
assert.equal(blur.bindings.find((b) => b.groupIndex === 0 && b.binding === 7)?.resourceId,
  calc.attachments.colorViewHandleIds[0], 'Filter consumes the recorded visibility output');
const lighting = model.works.find((work) => work.pipeline.shaders.some((s) => s.entryPoint === 'fs_standard_deferred'));
assert.ok(lighting && lighting.workIndex > blur.workIndex);
assert.ok(lighting.bindings.some((binding) => binding.resourceId === blur.attachments.colorViewHandleIds[0]),
  'Lighting consumes the recorded filtered visibility');
const gbuffer = model.works.filter((work) => work.pipeline.shaders.some((s) => s.entryPoint === 'fs_gbuffer'));
assert.ok(gbuffer.length > 0 && gbuffer.every((work) => work.workIndex < calc.workIndex));
assert.ok(gbuffer.some((work) => work.attachments.colorViewHandleIds.includes(
  calc.bindings.find((binding) => binding.groupIndex === 0 && binding.binding === 4)?.resourceId)),
  'AO reads normals written by this frame');
const depthView = calc.bindings.find((binding) => binding.groupIndex === 0 && binding.binding === 5)?.resourceId;
const depthSource = model.resources.find((resource) => resource.resourceId === depthView)?.descriptor?.sourceHandleId;
assert.ok(depthSource, 'AO depth view must have a captured source texture');
assert.ok(gbuffer.some((work) => model.resources.find((resource) =>
  resource.resourceId === work.attachments.depthStencilViewHandleId)?.descriptor?.sourceHandleId === depthSource),
  'AO reads depth written by this frame');
assert.ok(calc.pipeline.shaders.some((s) => s.source?.includes('gtaoVisibility')), 'Production GTAO shader is captured');
for (const binding of [0, 4, 5]) assert.ok(calc.bindings.some((b) => b.binding === binding), `Missing AO input ${binding}`);
const adapter = (await rhi.requestAdapter()).unwrap();
const device = (await requestReplayDeviceForTape(adapter, tape)).unwrap();
const replay = (await openReplay(tape, { device, createShaderModule })).unwrap();
const evidence = [];
try {
  for (const work of [calc, blur]) {
    const inspection = (await replay.inspectWork(work.workIndex, ['pipeline', 'bindings', 'pixels'])).unwrap();
    const attachment = inspection.attachment;
    assert.ok(attachment, 'AO attachment readback is required');
    // Visibility is .r in both; the raw target also carries the octahedral
    // center normal (.gb) the filter weights taps with.
    const packed = work === calc;
    assert.equal(attachment.format, packed ? 'rgba8unorm' : 'r8unorm');
    const stride = packed ? 4 : 1;
    const bytes = attachment.bytes.filter((_, i) => i % stride === 0);
    if (packed) {
      const normals = new Set();
      for (let i = 0; i < attachment.bytes.length; i += 4) {
        normals.add((attachment.bytes[i + 1] << 8) | attachment.bytes[i + 2]);
      }
      assert.ok(normals.size >= 2, 'Raw normal channels must distinguish floor and cube faces');
    }
    const min = bytes.reduce((a, b) => Math.min(a, b), 255);
    const max = bytes.reduce((a, b) => Math.max(a, b), 0);
    console.log(JSON.stringify({ workIndex: work.workIndex, min, max }));
    if (lifted) assert.equal(min, 255, 'Lifted geometry must leave exact unoccluded visibility');
    else assert.ok(min < 245 && max === 255, 'AO must contain both occluded and open pixels');
    const uniform = work.bindings.find((b) => b.binding === 0 && b.groupIndex === 0);
    assert.ok(uniform?.resourceId);
    const contents = (await replay.readResource(uniform.resourceId, { offset: 0, size: 256 })).unwrap();
    assert.equal(new DataView(contents.bytes.buffer, contents.bytes.byteOffset).getFloat32(208, true), 1, 'Captured uniform must select GTAO');
    const name = work === calc ? 'gtao-raw' : 'gtao-filtered';
    const rgba = new Uint8Array(attachment.width * attachment.height * 4);
    for (let i = 0; i < bytes.length; i++) rgba.set([bytes[i], bytes[i], bytes[i], 255], i * 4);
    writeFileSync(resolve(appDir, '.forgeax-debug', result.runId, `${name}.png`), writeReferencePng(rgba, attachment.width, attachment.height));
    evidence.push({ name, workIndex: work.workIndex, eventIndex: work.eventIndex, bindings: inspection.bindings, min, max, width: attachment.width, height: attachment.height });
  }
} finally {
  (await replay.dispose()).unwrap();
}
const artifactPath = resolve(appDir, '.forgeax-debug', result.runId, 'frame.rhitape');
const report = { ...result, artifact: { path: artifactPath, digest: tapeDigest(new Uint8Array(readFileSync(artifactPath))) },
  lineage: { gbuffer: gbuffer.map((w) => w.workIndex), calc: calc.workIndex, blur: blur.workIndex, lighting: lighting.workIndex, depthSource },
  works: evidence, unseededResources: model.unseededResources };
writeFileSync(resolve(appDir, '.forgeax-debug', result.runId, 'gtao-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ artifact: report.artifact, pixel: report.pixel, producerReport: report.producerReport, works: evidence.map(({ name, workIndex, min, max }) => ({ name, workIndex, min, max })) }));
