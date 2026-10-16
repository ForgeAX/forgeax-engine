import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';
import { readbackTexturePixels } from '../readback';

export async function verifyRasterPassLabels() {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const shader = (
    await recorder.backend.createShaderModule(device, {
      code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
// Avoid the 127.5 UNORM tie; this label/replay fixture requires exact bytes.
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.25, 128.0 / 255.0, 0.75, 1); }`,
    })
  ).unwrap();
  const texture = device
    .createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x11 })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const labels = [undefined, '', 'surface.capture', 'surface.capture'];
  const capture = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  for (const label of labels) {
    const encoder = device.createCommandEncoder().unwrap();
    const descriptor = {
      ...(label === undefined ? {} : { label }),
      colorAttachments: [{ view, loadOp: 'clear' as const, storeOp: 'store' as const }],
    };
    const pass = encoder.beginRenderPass(descriptor);
    descriptor.label = 'changed-after-begin';
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  }
  await device.queue.onSubmittedWorkDone();
  (await recorder.frameBoundary()).unwrap();
  const bytes = (await capture).unwrap().bytes;
  const live = await readbackTexturePixels(device, texture, 1, 1);
  expect([...live]).toEqual([64, 128, 191, 255]);
  device.destroyTexture(texture).unwrap();
  (await recorder.dispose()).unwrap();

  const tape = decodeTape(bytes).unwrap();
  expect(
    tape.events
      .filter((event) => event.kind === 'beginRenderPass')
      .map((event) => event.desc.label),
  ).toEqual(labels);
  const model = buildFrameModel(tape);
  expect(model.works).toHaveLength(4);
  const target = model.works[3]?.attachments?.colorViewHandleIds[0];
  expect(target).toBeDefined();
  if (target === undefined) throw new Error('missing captured attachment');
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const observed: (string | undefined)[] = [];
  const create = fresh.createCommandEncoder.bind(fresh);
  fresh.createCommandEncoder = (descriptor) => {
    const result = create(descriptor);
    if (result.ok) {
      const encoder = result.value;
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (passDescriptor) => {
        observed.push(passDescriptor.label);
        return begin(passDescriptor);
      };
    }
    return result;
  };
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const replayed = (await replay.readResourceAtWork(target, 3)).unwrap().bytes;
    expect(observed).toEqual(labels);
    expect(replayed).toEqual(live);
    return { bytes, live, replayed, labels: labels.map((label) => label ?? null) };
  } finally {
    (await replay.dispose()).unwrap();
  }
}
