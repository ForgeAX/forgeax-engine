import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type FrameModel,
  type openReplay,
} from '@forgeax/engine/rhi-debug';
import * as webgpu from '@forgeax/engine/rhi-webgpu';

export type ReplayBackend = Parameters<typeof openReplay>[1];
export type Tape = Extract<ReturnType<typeof decodeTape>, { ok: true }>['value'];

export const TAPE_COLOR = [255, 51, 0, 255] as const;

export interface RecordedFrame {
  readonly tape: Tape;
  readonly bytes: Uint8Array;
  readonly model: FrameModel;
}

const SHADER = `
@group(0) @binding(0) var<uniform> tint: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return tint; }`;

export async function recordSolidFrame(): Promise<RecordedFrame> {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const tint = device.createBuffer({ size: 16, usage: 0x48 }).unwrap();
  device.queue.writeBuffer(tint, 0, new Float32Array(TAPE_COLOR.map((c) => c / 255))).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform' as const } }],
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { kind: 'buffer' as const, value: { buffer: tint, size: 16 } } },
      ],
    })
    .unwrap();
  const shader = (await recorder.backend.createShaderModule(device, { code: SHADER })).unwrap();
  const texture = device
    .createTexture({ size: { width: 4, height: 4 }, format: 'rgba8unorm', usage: 0x11 })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    })
    .unwrap();
  try {
    await device.queue.onSubmittedWorkDone();
    const captured = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await captured).unwrap().bytes;
    const tape = decodeTape(bytes).unwrap();
    return { tape, bytes, model: buildFrameModel(tape) };
  } finally {
    device.destroyBuffer(tint).unwrap();
    device.destroyTexture(texture).unwrap();
    (await recorder.dispose()).unwrap();
  }
}

export async function freshReplayBackend(): Promise<ReplayBackend> {
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  return { device, createShaderModule: webgpu.createShaderModule };
}

export function firstPixel(bytes: Uint8Array): readonly number[] {
  return [...bytes.subarray(0, 4)];
}
