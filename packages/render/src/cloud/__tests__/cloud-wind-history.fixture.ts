import type { Buffer, RhiRenderPipelineOps, Texture } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  readbackTexturePixels,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { CLOUD_RESOLVE_FULLSCREEN_WGSL } from '@forgeax/engine-shader';
import { expect } from 'vitest';

// Exact binary16 values keep the independent transport oracle free of
// encoder rounding: cloud positions are kilometres, View positions metres.
export async function verifyCloudWindHistory(
  save: (name: string, bytes: Uint8Array) => void | Promise<void> = () => {},
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const textures: Texture[] = [];
  const buffers: Buffer[] = [];
  const texture = (format: GPUTextureFormat, usage: number) => {
    const resource = device.createTexture({ size: [3, 3], format, usage }).unwrap();
    textures.push(resource);
    return resource;
  };
  const buffer = (size: number, usage: number) => {
    const resource = device.createBuffer({ size, usage }).unwrap();
    buffers.push(resource);
    return resource;
  };
  const fill = (target: Texture, rgba: number[], center?: number[]) => {
    const values = new Uint16Array(36);
    for (let i = 0; i < 9; i++) values.set(i === 4 && center ? center : rgba, i * 4);
    device.queue.writeTexture({ texture: target }, values, { bytesPerRow: 24 }, [3, 3]);
  };
  const source = texture('rgba16float', 6);
  const current = texture('rgba16float', 6);
  const transmission = texture('rgba16float', 6);
  const position = texture('rgba16float', 6);
  const previous = texture('rgba16float', 6);
  const previousPosition = texture('rgba16float', 6);
  const depth = texture('depth32float', 20);
  const output = texture('rgba16float', 17);
  const view = buffer(1280, 72);
  const params = buffer(176, 72);
  fill(source, [0, 0, 0, 0x3800]);
  fill(current, [0x3800, 0x3800, 0x3800, 0x3c00], [0x3400, 0x3400, 0x3400, 0x3c00]);
  fill(previous, [0x3800, 0x3800, 0x3800, 0x3c00]);
  fill(transmission, [0x3800, 0x3800, 0x3800, 0x3c00]);
  fill(position, [0, 0, 0x3c00, 0x3c00]); // z = 1000 m
  const uniforms = new Float32Array(320);
  for (const offset of [0, 44, 252]) for (let i = 0; i < 4; i++) uniforms[offset + i * 5] = 1;
  device.queue.writeBuffer(view, 0, uniforms);
  const cloud = new Float32Array(44);
  cloud[5] = 0.5; // current time
  cloud[10] = 500; // +250 m previous world position, beyond the 20 m tolerance
  cloud[40] = 1;
  cloud[42] = 0.5;
  device.queue.writeBuffer(params, 0, cloud);
  try {
    const module = (
      await recorder.backend.createShaderModule(device, { code: CLOUD_RESOLVE_FULLSCREEN_WGSL })
    ).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main', buffers: [] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
      })
      .unwrap() as import('@forgeax/engine-rhi').RenderPipeline & RhiRenderPipelineOps;
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
    const group0 = device
      .createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: view } } }],
      })
      .unwrap();
    const group1 = device
      .createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          {
            binding: 0,
            resource: { kind: 'textureView', value: device.createTextureView(source, {}).unwrap() },
          },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: params } } },
          {
            binding: 3,
            resource: { kind: 'textureView', value: device.createTextureView(depth, {}).unwrap() },
          },
          ...[current, transmission, position, previous, transmission, previousPosition].map(
            (t, i) => ({
              binding: i + 5,
              resource: {
                kind: 'textureView' as const,
                value: device.createTextureView(t, {}).unwrap(),
              },
            }),
          ),
        ],
      })
      .unwrap();
    const cases = [
      { name: 'advected', z: 0x3d00, reset: 0, valid: 1, expected: 0x3600 }, // .375
      { name: 'unadvected', z: 0x3c00, reset: 0, valid: 1, expected: 0x3400 }, // .25
      { name: 'disoccluded', z: 0x4000, reset: 0, valid: 1, expected: 0x3400 },
      { name: 'cut', z: 0x3d00, reset: 1, valid: 1, expected: 0x3400 },
      { name: 'missing', z: 0x3d00, reset: 0, valid: 0, expected: 0x3400 },
    ];
    const results: Array<{ name: string; actual: number; expected: number }> = [];
    for (const entry of cases) {
      fill(previousPosition, [0, 0, entry.z, 0x3c00]);
      cloud[40] = entry.valid;
      cloud[41] = entry.reset;
      device.queue.writeBuffer(params, 0, cloud);
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: device.createTextureView(depth, {}).unwrap(),
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        })
        .end();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: device.createTextureView(output, {}).unwrap(),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      await save(`${entry.name}.rhitape`, captured.bytes);
      const bytes = await readbackTexturePixels(device, output, 3, 3, { bytesPerTexel: 8 });
      await save(`${entry.name}.rgba16`, bytes);
      const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      results.push({ name: entry.name, actual: raw.getUint16(32, true), expected: entry.expected });
      expect(
        raw.getUint16(38, true),
        'scene alpha remains independent of cloud transmittance',
      ).toBe(0x3800);
      const tape = decodeTape(captured.bytes).unwrap();
      const model = buildFrameModel(tape);
      const work = model.works.find((w) =>
        w.pipeline.shaders.some((shader) => shader.source?.includes('struct CloudResolveParams')),
      );
      expect(work).toBeDefined();
      if (!work) throw new Error('Missing production cloud resolve');
      const replayAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const replayDevice = (
        await replayAdapter.requestDevice(
          replayDeviceRequest(tape, replayAdapter.features, replayAdapter.limits),
        )
      ).unwrap();
      const replay = (
        await openReplay(tape, {
          device: replayDevice,
          createShaderModule: webgpu.createShaderModule,
        })
      ).unwrap();
      try {
        const inspected = (
          await replay.inspectWork(work.workIndex, ['pipeline', 'bindings', 'pixels'])
        ).unwrap();
        expect(inspected.attachment?.format).toBe('rgba16float');
        expect(inspected.attachment?.bytes).toEqual(bytes);
        await save(`${entry.name}-replay.rgba16`, inspected.attachment?.bytes ?? new Uint8Array());
      } finally {
        (await replay.dispose()).unwrap();
      }
    }
    // biome-ignore lint/suspicious/noConsole: bounded raw GPU regression evidence
    console.info('[cloud-wind-history]', JSON.stringify(results));
    await save('results.json', new TextEncoder().encode(JSON.stringify(results)));
    for (const result of results) expect(result.actual, result.name).toBe(result.expected);
  } finally {
    for (const resource of textures) device.destroyTexture(resource).unwrap();
    for (const resource of buffers) device.destroyBuffer(resource).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
