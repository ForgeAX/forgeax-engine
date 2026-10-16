import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine/dawn-node';
import { buildFrameModel, decodeTape, openReplay, replayDeviceRequest, summarizeFrame } from '@forgeax/engine/rhi-debug';
import * as webgpu from '@forgeax/engine/rhi-webgpu';
import { writeReferencePng } from '../../../../apps/shared/png-codec.mjs';

const [tapePath, outputDirectory] = process.argv.slice(2);
if (!tapePath || !outputDirectory) throw new Error('usage: node inspect-rhi.mjs <capture.rhitape> <output-directory>');
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
const bytes = new Uint8Array(await readFile(tapePath));
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const tape = decodeTape(bytes).unwrap();
const model = buildFrameModel(tape);
const work = [...model.works].reverse().find((candidate) =>
  candidate.attachments?.colorResolveViewHandleIds.some(Boolean) || candidate.attachments?.colorViewHandleIds.some(Boolean),
);
if (work === undefined) throw new Error('captured frame has no color-producing work item');
const outputView = work.attachments?.colorResolveViewHandleIds.find(Boolean) ?? work.attachments?.colorViewHandleIds.find(Boolean);
if (outputView === undefined) throw new Error(`selected work ${work.workIndex} has no color output`);

Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', {
  value: { gpu: create(process.platform === 'darwin' ? ['backend=metal'] : []) },
  configurable: true,
});
const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
const limits = {};
for (const key in adapter.limits) if (typeof adapter.limits[key] === 'number') limits[key] = adapter.limits[key];
const device = (await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, limits))).unwrap();
const rawDevice = device.nativeDevice().unwrap();
const replayErrors = [];
rawDevice.addEventListener('uncapturederror', (event) => replayErrors.push(event.error.message));
const session = (await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })).unwrap();
let report;
try {
  const inspection = (await session.inspectWork(work.workIndex, ['pipeline', 'bindings'])).unwrap();
  const referencedResources = new Set([
    ...inspection.bindings.flatMap((binding) => binding.resourceId === null ? [] : [binding.resourceId]),
    ...work.vertexBuffers.map((buffer) => buffer.bufferHandleId),
    ...(work.indexBuffer === null ? [] : [work.indexBuffer.bufferHandleId]),
    ...work.attachments.colorViewHandleIds,
    ...work.attachments.colorResolveViewHandleIds.filter(Boolean),
    ...(work.attachments.depthStencilViewHandleId === null ? [] : [work.attachments.depthStencilViewHandleId]),
  ]);
  const readback = (await session.readResourceAtWork(outputView, work.workIndex)).unwrap();
  const readbackBytes = new Uint8Array(readback.bytes);
  const readbackDigest = `sha256:${createHash('sha256').update(readbackBytes).digest('hex')}`;
  const rawPath = resolve(output, `work-${work.workIndex}-readback.bin`);
  await writeFile(rawPath, readbackBytes);
  if (readbackBytes.byteLength === readback.width * readback.height * 4 &&
      ['rgba8unorm', 'bgra8unorm', 'rgba8unorm-srgb', 'bgra8unorm-srgb'].includes(readback.format)) {
    const rgba = Buffer.from(readbackBytes);
    if (readback.format.startsWith('bgra'))
      for (let index = 0; index < rgba.length; index += 4) [rgba[index], rgba[index + 2]] = [rgba[index + 2], rgba[index]];
    await writeFile(resolve(output, `work-${work.workIndex}-fresh-replay.png`), writeReferencePng(rgba, readback.width, readback.height));
  }
  await rawDevice.queue.onSubmittedWorkDone();
  report = {
    status: replayErrors.length === 0 ? 'capture-replay-readback-pass' : 'fail',
    visualAcceptance: 'not-asserted: the audio-only fixture has no mesh/material; the captured work is the standard output-transform composition.',
    capture: { path: resolve(tapePath), digest, bytes: bytes.byteLength, formatVersion: tape.header.formatVersion, rhiCaps: tape.header.rhiCaps },
    freshDevice: { backendKind: device.caps.backendKind, adapterInfo: adapter.info ?? null, features: [...adapter.features].sort(), limits },
    model: { ...summarizeFrame(model), resourceLifecycle: model.resourceLifecycle, unseededResources: model.unseededResources },
    selectedWork: {
      workIndex: work.workIndex,
      eventIndex: work.eventIndex,
      passIndex: work.passIndex,
      kind: work.kind,
      pipeline: inspection.pipeline,
      bindings: inspection.bindings,
      vertexBuffers: inspection.vertexBuffers,
      indexBuffer: inspection.indexBuffer,
      attachments: work.attachments,
      resources: model.resources.filter((resource) => referencedResources.has(resource.resourceId)),
    },
    readback: {
      resourceId: outputView,
      workIndex: work.workIndex,
      format: readback.format,
      width: readback.width,
      height: readback.height,
      bytes: readbackBytes.byteLength,
      digest: readbackDigest,
      artifact: rawPath,
      nonzeroBytes: readbackBytes.reduce((count, value) => count + Number(value !== 0), 0),
      firstBytes: [...readbackBytes.slice(0, 32)],
    },
    replayErrors,
  };
  if (replayErrors.length > 0) throw new Error(`fresh-device replay emitted ${replayErrors.length} uncaptured validation errors`);
} finally {
  (await session.dispose()).unwrap();
  rawDevice.destroy();
}
await writeFile(resolve(output, 'rhi-debug-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, digest, workIndex: work.workIndex, resourceCount: model.resources.length, bindingCount: report.selectedWork.bindings.length, readback: report.readback, freshDevice: report.freshDevice.backendKind, report: resolve(output, 'rhi-debug-report.json') }, null, 2));
