import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';

export async function verifyIntegerReadback(format: 'r32uint' | 'rg32uint' = 'r32uint') {
  const channels = format === 'rg32uint' ? 2 : 1;
  const recorder = attachRecorder(webgpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const shader = (
    await recorder.backend.createShaderModule(device, {
      code: `@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
      let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
      return vec4f(p[i],0,1);
    }
    @fragment fn fs(@builtin(position) p:vec4f)->@location(0) ${channels === 2 ? 'vec2u' : 'u32'} {
      let values = array<u32,3>(0x5912296bu,0xffabcdefu,0xffffffffu);
      return ${channels === 2 ? 'vec2u(values[u32(p.x)], ~values[u32(p.x)])' : 'values[u32(p.x)]'};
    }`,
    })
  ).unwrap();
  const texture = device
    .createTexture({
      size: { width: 3, height: 2, depthOrArrayLayers: 1 },
      format,
      usage: 0x10,
    })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] },
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
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  (await recorder.frameBoundary()).unwrap();
  const tape = decodeTape((await capture).unwrap().bytes).unwrap();
  const work = buildFrameModel(tape).works[0];
  if (work?.attachments?.colorViewHandleIds[0] === undefined)
    throw new Error('missing integer output work');
  const resourceId = work.attachments.colorViewHandleIds[0];
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const result = await replay.readResourceAtWork(resourceId, work.workIndex);
    expect(result.ok, JSON.stringify(result.ok ? {} : result.error)).toBe(true);
    const read = result.unwrap();
    expect(read).toMatchObject({
      format,
      width: 3,
      height: 2,
      provenance: { selectedWorkIndex: 0 },
    });
    const expected = [
      0x5912296b, 0xffabcdef, 0xffffffff, 0x5912296b, 0xffabcdef, 0xffffffff,
    ].flatMap((value) => (channels === 2 ? [value, ~value >>> 0] : [value]));
    expect([...new Uint32Array(read.bytes.buffer, read.bytes.byteOffset, 6 * channels)]).toEqual(
      expected,
    );
    const inspected = (await replay.inspectWork(0, ['pixels'])).unwrap();
    expect(inspected.attachment?.bytes).toEqual(read.bytes);
  } finally {
    (await replay.dispose()).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
