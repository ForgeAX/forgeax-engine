import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';
import { readbackTexturePixels } from '../readback';
import { replayDeviceRequest } from '../replay/device-request';

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

const SOURCE = `enable primitive_index;
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) instance: u32,
}
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Vertex {
  let positions = array<vec2f, 6>(
    vec2f(-1, 0), vec2f(1, 0), vec2f(-1, 1),
    vec2f(-1, 1), vec2f(1, 0), vec2f(1, 1));
  var out: Vertex;
  out.position = vec4f(positions[vertex] - vec2f(0, f32(instance - 9u)), 0, 1);
  out.instance = 0xf0000000u + instance;
  return out;
}
@fragment fn fs(in: Vertex, @builtin(primitive_index) primitive: u32) -> @location(0) vec2u {
  if (u32(in.position.x) == 3u) { discard; }
  return vec2u(in.instance, primitive);
}`;

/** Real raster identity: draw-local primitive IDs, firstInstance, MASK and fresh replay. */
export async function verifyPrimitiveIdentity() {
  const recorder = attachRecorder(webgpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  if (!adapter.features.has('primitive-index')) {
    (await recorder.dispose()).unwrap();
    return { status: 'unavailable' as const, reason: 'primitive-index' };
  }
  const device = (await adapter.requestDevice({ requiredFeatures: ['primitive-index'] })).unwrap();
  const shader = (await recorder.backend.createShaderModule(device, { code: SOURCE })).unwrap();
  const texture = device
    .createTexture({
      label: 'visible-primitive-identity',
      size: { width: 8, height: 8, depthOrArrayLayers: 1 },
      format: 'rg32uint',
      usage: 0x11,
    })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const indices = device.createBuffer({ size: 24, usage: 0x18 }).unwrap();
  device.queue.writeBuffer(indices, 0, new Uint32Array([0, 1, 2, 3, 4, 5])).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rg32uint' }] },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const capture = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.draw(6, 2, 0, 9);
  pass.setScissorRect(4, 0, 4, 4);
  pass.setIndexBuffer(indices, 'uint32');
  pass.drawIndexed(3, 1, 3, 0, 9);
  pass.end();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  (await recorder.frameBoundary()).unwrap();
  const captured = (await capture).unwrap();
  const live = await readbackTexturePixels(device, texture, 8, 8, { bytesPerTexel: 8 });
  const tape = decodeTape(captured.bytes).unwrap();
  const model = buildFrameModel(tape);
  equal(
    model.works.map((work) => work.workIndex),
    [0, 1],
    'work order',
  );
  const resource = model.works[0]?.attachments?.colorViewHandleIds[0];
  if (resource === undefined) throw new Error('missing identity attachment');

  const freshAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const descriptor = replayDeviceRequest(tape, freshAdapter.features, {});
  const fresh = (await freshAdapter.requestDevice(descriptor)).unwrap();
  const replay = (
    await openReplay(tape, {
      device: fresh,
      createShaderModule: webgpu.createShaderModule,
    })
  ).unwrap();
  try {
    const before = (await replay.readResourceAtWork(resource, 0)).unwrap();
    const after = (await replay.readResourceAtWork(resource, 1)).unwrap();
    const pixel = (bytes: Uint8Array, x: number, y: number) => {
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      return [...words.subarray((y * 8 + x) * 2, (y * 8 + x) * 2 + 2)];
    };
    equal([before.format, before.width, before.height], ['rg32uint', 8, 8], 'readback descriptor');
    equal(pixel(before.bytes, 1, 2), [0xf0000009, 0], 'first draw (1, 2)');
    equal(pixel(before.bytes, 6, 1), [0xf0000009, 1], 'first draw (6, 1)');
    equal(pixel(before.bytes, 1, 6), [0xf000000a, 0], 'first draw (1, 6)');
    equal(pixel(before.bytes, 6, 5), [0xf000000a, 1], 'first draw (6, 5)');
    equal(pixel(before.bytes, 3, 2), [0, 0], 'first draw (3, 2)');
    // firstIndex selects the second source triangle, but the draw's primitive index restarts.
    equal(pixel(after.bytes, 6, 1), [0xf0000009, 0], 'second draw (6, 1)');
    equal(pixel(after.bytes, 6, 5), [0xf000000a, 1], 'second draw (6, 5)');
    equal([...after.bytes], [...live], 'live/fresh replay bytes');
    return {
      status: 'available' as const,
      captured,
      live,
      before: before.bytes,
      after: after.bytes,
      workCount: model.works.length,
    };
  } finally {
    (await replay.dispose()).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
