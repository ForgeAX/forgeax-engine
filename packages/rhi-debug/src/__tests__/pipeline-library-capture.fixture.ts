import type { PipelineLibraryManifest } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { decodeTape } from '../protocol/codec';
import { attachRecorder } from '../recorder/session';
import { openReplay } from '../replay/session';

const vertex = `@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}`;
const fragment = '@fragment fn fs()->@location(0) vec4f {return vec4f(1,.25,.125,1);}';

export async function verifyPreparedPipelineCapture() {
  const attachment = attachRecorder(webgpu).unwrap();
  try {
    const adapter = (await attachment.backend.rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const library = device.pipelineLibrary;
    if (library === undefined) throw new Error('Recorder dropped the native pipeline library');
    const manifest: PipelineLibraryManifest = {
      version: 1,
      backend: 'webgpu',
      shaders: [{ code: vertex }, { code: fragment }],
      bindGroupLayouts: [],
      pipelineLayouts: [],
      renderPipelines: [
        {
          layout: 'auto',
          vertex: { module: 0, entryPoint: 'vs', buffers: [] },
          fragment: { module: 1, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
        },
      ],
      computePipelines: [],
    };
    (await library.prepare(manifest)).unwrap();
    const prepared = library.inspect();
    expect(prepared.compilationCompleted).toBeGreaterThan(0);
    const vs = (await attachment.backend.createShaderModule(device, { code: vertex })).unwrap();
    const fs = (await attachment.backend.createShaderModule(device, { code: fragment })).unwrap();
    const pending = device.createRenderPipelineAsync?.({
      layout: 'auto',
      vertex: { module: vs, entryPoint: 'vs', buffers: [] },
      fragment: { module: fs, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    if (pending === undefined) throw new Error('Recorder dropped asynchronous pipeline creation');
    const pipeline = (await pending).unwrap();
    expect(library.inspect().pipelineHits).toBeGreaterThan(prepared.pipelineHits);
    const texture = device
      .createTexture({ size: { width: 128, height: 128 }, format: 'rgba8unorm', usage: 0x11 })
      .unwrap();
    const view = device.createTextureView(texture, {}).unwrap();
    let capture: ReturnType<typeof attachment.captureFrame> | undefined;
    let completed = 0;
    for (let frame = 0; frame < 60; frame++) {
      if (frame === 59) capture = attachment.captureFrame();
      (await attachment.frameBoundary()).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        label: 'prepared-pipeline-capture',
        colorAttachments: [
          { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      completed++;
      (await attachment.frameBoundary()).unwrap();
    }
    expect(completed).toBe(60);
    if (capture === undefined) throw new Error('Missing steady capture');
    const encoded = (await capture).unwrap(),
      tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    expect(model.works).toHaveLength(1);
    expect(model.works[0]?.pipeline.status).toBe('available');
    const rawAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const fresh = (
      await rawAdapter.requestDevice({ requiredFeatures: ['timestamp-query'] })
    ).unwrap();
    const session = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const observed = (await session.inspectWork(0, ['pixels'])).unwrap();
      const pixels = observed.attachment?.bytes;
      if (pixels === undefined) throw new Error('Fresh replay did not produce target pixels');
      const center = (64 * 128 + 64) * 4;
      expect([...pixels.subarray(center, center + 4)]).toEqual([255, 64, 32, 255]);
      const timing = (await session.timePasses()).unwrap();
      expect(timing.passes).toHaveLength(1);
      expect(timing.passes[0]?.label).toBe('prepared-pipeline-capture');
      expect(timing.passes[0]?.workIndices).toEqual([0]);
      const duration = timing.passes[0]?.gpuNanoseconds;
      expect(typeof duration).toBe('number');
      expect(duration).toBeGreaterThanOrEqual(0);
      return {
        completed,
        tapeBytes: encoded.byteLength,
        centerPixel: [...pixels.subarray(center, center + 4)],
        prepared,
        timing,
      };
    } finally {
      await session.dispose();
      device.destroyTexture(texture).unwrap();
    }
  } finally {
    (await attachment.dispose()).unwrap();
  }
}
