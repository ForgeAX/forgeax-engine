import type { Texture } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';
import { readbackTexturePixels } from '../readback';

const FORMATS = ['rgba16float', 'r32uint', 'r32uint', 'r32uint', 'r32uint', 'rgba32uint'] as const;
const SOURCE = `
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) draw: u32,
}
struct Output {
  @location(0) color: vec4f,
  @location(1) a: u32,
  @location(2) b: u32,
  @location(3) c: u32,
  @location(4) d: u32,
  @location(5) identity: vec4u,
}
@vertex fn vs(@builtin(vertex_index) i: u32, @builtin(instance_index) draw: u32) -> Vertex {
  let points = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  return Vertex(vec4f(points[i], 0, 1), draw);
}
@fragment fn fs(in: Vertex) -> Output {
  if (u32(in.position.x) == 1u) { discard; }
  let value = 0xf0000000u + in.draw;
  return Output(vec4f(f32(in.draw),0,0,1), 1u, 2u, 3u, 4u,
    vec4u(value, 0xffffffffu - in.draw, 0x5912296bu, 3u));
}`;

/** Six attachments exercise the aligned 48-byte/sample layout and exact last-target reads. */
export async function verifyUint4Readback() {
  const recorder = attachRecorder(webgpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  if ((adapter.limits.maxColorAttachmentBytesPerSample ?? 32) < 48) {
    (await recorder.dispose()).unwrap();
    return { status: 'unavailable' as const, reason: 'maxColorAttachmentBytesPerSample < 48' };
  }
  const request = { requiredLimits: { maxColorAttachmentBytesPerSample: 48 } };
  const device = (await adapter.requestDevice(request)).unwrap();
  const textures: Texture[] = [];
  try {
    const shader = (await recorder.backend.createShaderModule(device, { code: SOURCE })).unwrap();
    for (const format of FORMATS)
      textures.push(
        device
          .createTexture({
            label: `six-target-${format}`,
            size: { width: 4, height: 2 },
            format,
            usage: 0x11,
          })
          .unwrap(),
      );
    const views = textures.map((texture) => device.createTextureView(texture, {}).unwrap());
    const pipeline = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vs', buffers: [] },
        fragment: {
          module: shader,
          entryPoint: 'fs',
          targets: FORMATS.map((format) => ({ format })),
        },
      })
      .unwrap();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: views.map((view) => ({
        view,
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
    });
    pass.setPipeline(pipeline);
    pass.draw(3, 1, 0, 0);
    pass.setScissorRect(2, 0, 2, 1);
    pass.draw(3, 1, 0, 1);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const captured = (await pending).unwrap();
    const output = textures[5];
    if (output === undefined) throw new Error('missing integer output texture');
    const live = await readbackTexturePixels(device, output, 4, 2, { bytesPerTexel: 16 });
    const tape = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(tape);
    const resource = model.works[0]?.attachments?.colorViewHandleIds[5];
    if (resource === undefined || model.works.length !== 2)
      throw new Error('missing six-target work');
    const fresh = (
      await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice(request)
    ).unwrap();
    {
      const opened = await openReplay(tape, {
        device: fresh,
        createShaderModule: webgpu.createShaderModule,
      });
      const replay = opened.unwrap();
      try {
        const before = (await replay.readResourceAtWork(resource, 0)).unwrap();
        const after = (await replay.readResourceAtWork(resource, 1)).unwrap();
        return {
          status: 'available' as const,
          captured,
          live,
          before,
          after,
          workCount: model.works.length,
        };
      } finally {
        (await replay.dispose()).unwrap();
      }
    }
  } finally {
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
