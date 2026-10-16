import { create, globals } from '@forgeax/engine-dawn-node';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import * as webgpu from '../../../../packages/rhi-webgpu/dist/index.mjs';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '../../../../packages/rhi-debug/dist/index.mjs';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const directory = resolve(process.env.FORGEAX_AUDIO_EVIDENCE ?? 'artifacts/audio-controls');
await mkdir(resolve(directory, 'replay'), { recursive: true });
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', {
  value: { gpu: create(process.platform === 'darwin' ? ['backend=metal'] : []) },
  configurable: true,
});
const capture = JSON.parse(await readFile(resolve(directory, 'capture.json'), 'utf8'));
const rows = [];
for (const source of capture.rows) {
  const bytes = new Uint8Array(await readFile(resolve(directory, `${source.phase}.rhitape`)));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== source.digest) throw new Error('capture digest mismatch');
  const tape = decodeTape(bytes).unwrap(),
    model = buildFrameModel(tape);
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const limits = {};
  for (const key in adapter.limits)
    if (typeof adapter.limits[key] === 'number') limits[key] = adapter.limits[key];
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, limits))
  ).unwrap();
  const raw = device.nativeDevice().unwrap(),
    errors = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const session = (
    await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const firstBar = model.works[2],
      last = model.works.at(-1);
    if (
      model.works.length !== 27 ||
      model.works.slice(0, 26).some((work) => work.kind !== 'drawIndexed')
    )
      throw new Error('scene draw roster changed');
    if (last.kind !== 'draw') throw new Error('fullscreen composition is not a draw');
    const initialization = tape.events.flatMap((event, eventIndex) =>
      event.kind === 'beginRenderPass'
        ? [
            {
              eventIndex,
              depthView: event.depthStencilViewHandleId,
              depthLoadOp: event.desc.depthStencilAttachment?.depthLoadOp,
              colorViews: event.colorAttachmentViewHandleIds,
              colorLoadOps: event.desc.colorAttachments.map((attachment) => attachment.loadOp),
            },
          ]
        : [],
    );
    if (
      !initialization.some(
        (pass) =>
          pass.depthView === firstBar.attachments.depthStencilViewHandleId &&
          pass.depthLoadOp === 'clear',
      )
    )
      throw new Error('unseeded depth has no captured clear');
    if (
      !initialization.some(
        (pass) =>
          pass.colorViews.includes(last.attachments.colorViewHandleIds[0]) &&
          pass.colorLoadOps.includes('clear'),
      )
    )
      throw new Error('output has no captured initialization');
    const inspected = (
      await session.inspectWork(firstBar.workIndex, ['pipeline', 'bindings'])
    ).unwrap();
    if (inspected.pipeline.status !== 'available') throw new Error('missing bar pipeline');
    const uniform = firstBar.bindings.find(
      (binding) => binding.groupIndex === 2 && binding.binding === 0,
    );
    if (!uniform || uniform.dynamicOffset !== 512) throw new Error('mesh slot binding changed');
    const transforms = (
      await session.readResourceAtWork(uniform.resourceId, last.workIndex)
    ).unwrap();
    const view = new DataView(
      transforms.bytes.buffer,
      transforms.bytes.byteOffset,
      transforms.bytes.byteLength,
    );
    const bars = model.works.slice(2, 26).map((work) => {
      const binding = work.bindings.find(
        (binding) => binding.groupIndex === 2 && binding.binding === 0,
      );
      const offset = (binding.bufferOffset ?? 0) + (binding.dynamicOffset ?? 0);
      return {
        workIndex: work.workIndex,
        resourceId: binding.resourceId,
        effectiveByteOffset: offset,
        scale: [0, 5, 10].map((i) => view.getFloat32(offset + i * 4, true)),
        position: [12, 13, 14].map((i) => view.getFloat32(offset + i * 4, true)),
      };
    });
    if (bars.some((bar) => bar.scale.some((value) => !Number.isFinite(value))))
      throw new Error('nonfinite mesh transform');
    const maxHeight = Math.max(...bars.map((bar) => bar.scale[1]));
    if (source.phase === 'paused' && Math.abs(maxHeight - 0.02) > 1e-5)
      throw new Error('paused spectrum still drives GPU bars');
    if (source.phase === 'dry' && maxHeight < 0.1) throw new Error('spectrum geometry absent');
    const attachment =
      last.attachments.colorResolveViewHandleIds[0] ?? last.attachments.colorViewHandleIds[0];
    const output = (await session.readResourceAtWork(attachment, last.workIndex)).unwrap();
    const rgba = output.bytes.slice();
    if (output.format.startsWith('bgra'))
      for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
    const live = PNG.sync.read(await readFile(resolve(directory, `${source.phase}-canvas.png`)));
    if (live.width !== output.width || live.height !== output.height)
      throw new Error('live/replay extent mismatch');
    const histogram = new Uint32Array(256);
    let total = 0,
      max = 0;
    for (let i = 0; i < rgba.length; i++) {
      const difference = Math.abs(rgba[i] - live.data[i]);
      histogram[difference]++;
      total += difference;
      max = Math.max(max, difference);
    }
    const quantile = (p) => {
      let seen = 0;
      for (let i = 0; i < histogram.length; i++) {
        seen += histogram[i];
        if (seen >= rgba.length * p) return i / 255;
      }
      return 1;
    };
    const parity = {
      mean: total / rgba.length / 255,
      p95: quantile(0.95),
      p99: quantile(0.99),
      max: max / 255,
    };
    const channelMeans = [0, 0, 0, 0];
    for (let i = 0; i < rgba.length; i++)
      channelMeans[i % 4] += Math.abs(rgba[i] - live.data[i]) / 255 / (rgba.length / 4);
    console.log(
      JSON.stringify({
        phase: source.phase,
        format: output.format,
        width: output.width,
        height: output.height,
        channelMeans,
        first: Array.from(rgba.slice(0, 16)),
        live: Array.from(live.data.slice(0, 16)),
      }),
    );
    if (parity.p99 > 2 / 255)
      throw new Error(`live/replay parity failed: ${JSON.stringify(parity)}`);
    await device.queue.onSubmittedWorkDone();
    if (errors.length) throw new Error(JSON.stringify(errors));
    await writeFile(
      resolve(directory, 'replay', `${source.phase}.png`),
      writeReferencePng(rgba, output.width, output.height),
    );
    await writeFile(resolve(directory, `${source.phase}.rhitape.gz`), gzipSync(bytes));
    // The two unseeded targets are initialized by the captured scene depth clear
    // and fullscreen composition. All sampled/bound buffer content is seeded.
    if (
      model.unseededResources.some(
        (resource) => !['depth32float-stencil8', 'bgra8unorm'].includes(resource.format),
      )
    )
      throw new Error('unexplained unseeded resource');
    rows.push({
      phase: source.phase,
      digest,
      workCount: model.works.length,
      resourceCount: model.resources.length,
      selectedWork: {
        workIndex: firstBar.workIndex,
        eventIndex: firstBar.eventIndex,
        pipelineHandleId: firstBar.pipeline.pipelineHandleId,
        entryPoints: inspected.pipeline.shaders.map((shader) => shader.entryPoint),
      },
      uniform: {
        resourceId: uniform.resourceId,
        bufferOffset: uniform.bufferOffset,
        dynamicOffset: uniform.dynamicOffset,
        bufferSize: uniform.bufferSize,
      },
      bars,
      maxHeight,
      initialization,
      unseededResources: model.unseededResources,
      parity,
      errors,
    });
    console.log(
      JSON.stringify({
        phase: source.phase,
        digest,
        workCount: model.works.length,
        maxHeight,
        parity,
        errors,
      }),
    );
  } finally {
    (await session.dispose()).unwrap();
    raw.destroy();
  }
}
await writeFile(
  resolve(directory, 'replay', 'report.json'),
  `${JSON.stringify({ status: 'pass', backend: 'Dawn Metal fresh device', rows }, null, 2)}\n`,
);
process.exit(0);
