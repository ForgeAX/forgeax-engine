#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { create as createDawn, globals as dawnGlobals } from '@forgeax/engine-dawn-node';
import { PNG } from 'pngjs';
import { buildFrameModel, decodeTape, openReplay, replayDeviceRequest } from '@forgeax/engine-rhi-debug';
import {
  createShaderModule as createNullShaderModule,
  rhi as nullRhi,
} from '@forgeax/engine-rhi-null';
import { createShaderModule, rhi as webgpuRhi } from '@forgeax/engine-rhi-webgpu';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const [artifactPath, livePngPath] = process.argv.slice(2);
if (artifactPath === undefined) {
  throw new Error('usage: cross-backend-replay.mjs <artifactPath> [livePngPath]');
}

const decoded = decodeTape(new Uint8Array(await readFile(artifactPath)));
if (!decoded.ok) throw new Error(`decodeTape failed: ${decoded.error.code} (${decoded.error.hint})`);
const tape = decoded.value;
const model = buildFrameModel(tape);
// A real hello-cube frame contains depth-only shadow draws and compute
// dispatches before the first colour attachment. Cross-backend pixel replay
// must select an attachment-bearing render work, not merely the first draw
// opcode (which has no readable colour target).
const workIndex = model.works.findIndex((work) => {
  if (!work.kind.startsWith('draw')) return false;
  const pass = model.passes.find((candidate) => candidate.passIndex === work.passIndex);
  const begin = pass === undefined ? undefined : tape.events[pass.beginEventIndex];
  return (
    begin?.kind === 'beginRenderPass' &&
    begin.colorAttachmentViewHandleIds.some((candidate) => candidate !== undefined)
  );
});
const frameMarkCount = tape.events.filter((event) => event.kind === 'frameMark').length;
if (workIndex < 0 || frameMarkCount === 0) {
  throw new Error(`browser tape lacks dynamic evidence: works=${model.works.length} frameMarks=${frameMarkCount}`);
}
console.log(`[m7-backend] cross-backend selected colour workIndex=${workIndex}`);

Object.assign(globalThis, dawnGlobals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
const dawnGpu = createDawn([]);
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: dawnGpu,
  configurable: true,
  writable: true,
});
dawnGpu.getPreferredCanvasFormat = () => 'rgba8unorm';
const dawnAdapterResult = await webgpuRhi.requestAdapter();
if (!dawnAdapterResult.ok) {
  throw new Error(`Dawn adapter failed: ${dawnAdapterResult.error.code} (${dawnAdapterResult.error.hint})`);
}
const dawnAdapter = dawnAdapterResult.value;
const dawnDeviceResult = await dawnAdapter.requestDevice(
  replayDeviceRequest(tape, dawnAdapter.features, dawnAdapter.limits),
);
if (!dawnDeviceResult.ok) {
  throw new Error(`Dawn device failed: ${dawnDeviceResult.error.code} (${dawnDeviceResult.error.hint})`);
}
const dawnReplayResult = await openReplay(tape, {
  device: dawnDeviceResult.value,
  createShaderModule,
});
if (!dawnReplayResult.ok) {
  throw new Error(`Dawn openReplay failed: ${dawnReplayResult.error.code} (${dawnReplayResult.error.hint}): ${JSON.stringify(dawnReplayResult.error.detail)}`);
}
const dawnInspection = await dawnReplayResult.value.inspectWork(workIndex, ['pixels']);
if (!dawnInspection.ok) {
  throw new Error(`Dawn replay inspectWork(${workIndex}) failed: ${dawnInspection.error.code} (${dawnInspection.error.hint})`);
}
const dawnReadback = dawnInspection.value.attachment;
if (
  dawnReadback?.kind !== 'texture' ||
  dawnReadback.width === undefined ||
  dawnReadback.height === undefined
) {
  throw new Error(`Dawn replay produced no color attachment: ${JSON.stringify(dawnInspection.value)}`);
}
const dawnLitBytes = dawnReadback.bytes.reduce((count, byte) => count + (byte > 8 ? 1 : 0), 0);
if (dawnReadback.width <= 0 || dawnReadback.height <= 0 || dawnLitBytes === 0) {
  throw new Error(
    `Dawn replay produced an empty render target: ${dawnReadback.width}x${dawnReadback.height} litBytes=${dawnLitBytes}`,
  );
}
let livePixelDelta;
if (livePngPath !== undefined) {
  const livePng = PNG.sync.read(await readFile(livePngPath));
  if (livePng.width !== dawnReadback.width || livePng.height !== dawnReadback.height) {
    throw new Error(
      `Dawn/live dimensions differ: dawn=${dawnReadback.width}x${dawnReadback.height} live=${livePng.width}x${livePng.height}`,
    );
  }
  let totalDelta = 0;
  for (let index = 0; index < dawnReadback.bytes.length; index += 4) {
    totalDelta +=
      (Math.abs((livePng.data[index] ?? 0) - (dawnReadback.bytes[index] ?? 0)) +
        Math.abs((livePng.data[index + 1] ?? 0) - (dawnReadback.bytes[index + 1] ?? 0)) +
        Math.abs((livePng.data[index + 2] ?? 0) - (dawnReadback.bytes[index + 2] ?? 0))) /
      3;
  }
  livePixelDelta =
    dawnReadback.bytes.length === 0
      ? Number.POSITIVE_INFINITY
      : totalDelta / (dawnReadback.bytes.length / 4);
  await writeFile(
    `${livePngPath}.dawn.png`,
    writeReferencePng(dawnReadback.bytes, dawnReadback.width, dawnReadback.height),
  );
  if (livePixelDelta > 0.1) {
    throw new Error(`Dawn/live pixel delta too large: ${livePixelDelta.toFixed(5)} > 0.1`);
  }
}
if (!(await dawnReplayResult.value.dispose()).ok) throw new Error('Dawn replay dispose failed');

const nullAdapterResult = await nullRhi.requestAdapter();
if (!nullAdapterResult.ok) throw new Error(`null adapter failed: ${nullAdapterResult.error.code}`);
const nullAdapter = nullAdapterResult.value;
const nullDeviceResult = await nullAdapter.requestDevice(
  replayDeviceRequest(tape, nullAdapter.features, nullAdapter.limits),
);
if (!nullDeviceResult.ok) throw new Error(`null device failed: ${nullDeviceResult.error.code}`);
const nullReplayResult = await openReplay(tape, {
  device: nullDeviceResult.value,
  createShaderModule: createNullShaderModule,
});
if (!nullReplayResult.ok) {
  throw new Error(`null openReplay failed: ${nullReplayResult.error.code} (${nullReplayResult.error.hint}): ${JSON.stringify(nullReplayResult.error.detail)}`);
}
const nullInspection = await nullReplayResult.value.inspectWork(workIndex);
if (!nullInspection.ok) {
  throw new Error(`null replay inspectWork(${workIndex}) failed: ${nullInspection.error.code} (${nullInspection.error.hint})`);
}
if (!(await nullReplayResult.value.dispose()).ok) throw new Error('null replay dispose failed');

console.log(
  `[m7-backend] same-scene cross-backend replay: PASS (browser .rhitape -> Dawn pixel readback + null structural replay; events=${tape.events.length}, works=${model.works.length}, frameMarks=${frameMarkCount}, dawnRt=${dawnReadback.width}x${dawnReadback.height}, dawnLitBytes=${dawnLitBytes}, livePixelDelta=${livePixelDelta === undefined ? 'not-requested' : livePixelDelta.toFixed(5)})`,
);
