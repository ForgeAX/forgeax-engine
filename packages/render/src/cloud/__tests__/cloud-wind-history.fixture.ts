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
import { expect } from 'vitest';
import { equalBytes } from '../../../../../scripts/test/byte-equality.mjs';
import { cloudKernelVertex, loadCloudKernel } from './cloud-mode0-kernels.fixture';

// Exact binary16 inputs and an independent meter-space wind displacement oracle.
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
  const previous = texture('rgba16float', 6);
  const previousPosition = texture('rgba16float', 6);
  const output = texture('rgba16float', 17);
  const params = buffer(176, 72);
  fill(source, [0, 0, 0, 0x3800]);
  fill(current, [0x3800, 0x3800, 0x3800, 0x3c00], [0x3400, 0x3400, 0x3400, 0x3c00]);
  fill(previous, [0x3800, 0x3800, 0x3800, 0x3c00]);
  const cloud = new Float32Array(44);
  cloud[5] = 0.5; // current time
  cloud[40] = 1;
  device.queue.writeBuffer(params, 0, cloud);
  try {
    const code = `${await loadCloudKernel('reconstruct')}\n${await loadCloudKernel('coordinates')}
${await cloudKernelVertex()}
struct CloudHistoryProbeParams { lanes:array<vec4f,11> }
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(2) var<uniform> params:CloudHistoryProbeParams;
@group(0) @binding(5) var current:texture_2d<f32>;
@group(0) @binding(8) var previous:texture_2d<f32>;
@group(0) @binding(10) var previousDepth:texture_2d<f32>;
@fragment fn fs_main(input:FullscreenOutput)->@location(0) vec4f {
  let pixel=vec2i(input.position.xy);
  let wind=cloud_advected_model_position(vec3f(0.0,0.0,1000.0),vec3f(0.0,500.0,0.0),params.lanes[1].y);
  if (all(pixel==vec2i(0))) { return vec4f(wind/1000.0,1.0); }
  let depth=vec4f(5000.0,10000.0,10000.0,10000.0);
  let currentSample=CloudReconstructionSample(textureLoad(current,pixel,0),vec4f(0.0,0.0,0.0,1.0),depth);
  let oldDepth=textureLoad(previousDepth,pixel,0).z;
  let old=CloudReconstructionSample(textureLoad(previous,pixel,0),currentSample.near,vec4f(5000.0,oldDepth*8000.0,10000.0,10000.0));
  let reconstructed=cloud_reconstruct_sample(currentSample,old,vec2u(1u,0u),vec2u(0u),vec2f(0.5),params.lanes[10].x>0.5 && params.lanes[10].y<0.5,1.0,1.0,1000.0,100000.0);
  return vec4f(reconstructed.far.rgb,textureLoad(source,pixel,0).a);
}`;
    const module = (await recorder.backend.createShaderModule(device, { code })).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main', buffers: [] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
      })
      .unwrap() as import('@forgeax/engine-rhi').RenderPipeline & RhiRenderPipelineOps;
    const group1 = device
      .createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: { kind: 'textureView', value: device.createTextureView(source, {}).unwrap() },
          },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: params } } },
          ...[current, previous, previousPosition].map((t, i) => ({
            binding: [5, 8, 10][i] ?? 5,
            resource: {
              kind: 'textureView' as const,
              value: device.createTextureView(t, {}).unwrap(),
            },
          })),
        ],
      })
      .unwrap();
    const cases = [
      { name: 'continuous-wind', z: 0x3d00, reset: 0, valid: 1, expected: 0x3800 }, // .5
      { name: 'bounded-depth-change', z: 0x3c00, reset: 0, valid: 1, expected: 0x3800 }, // 2000 m is inclusive
      { name: 'disoccluded', z: 0x4000, reset: 0, valid: 1, expected: 0x3400 },
      { name: 'cut', z: 0x3d00, reset: 1, valid: 1, expected: 0x3400 },
      { name: 'missing', z: 0x3d00, reset: 0, valid: 0, expected: 0x3400 },
    ];
    const results: Array<{
      name: string;
      actual: number;
      expected: number;
      advectedYHalfBits: number;
      advectedYNegativeZero: boolean;
    }> = [];
    for (const entry of cases) {
      fill(previousPosition, [0, 0, entry.z, 0x3c00]);
      cloud[40] = entry.valid;
      cloud[41] = entry.reset;
      device.queue.writeBuffer(params, 0, cloud);
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
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
      pass.setBindGroup(0, group1);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      await save(`${entry.name}.rhitape`, captured.bytes);
      const bytes = await readbackTexturePixels(device, output, 3, 3, { bytesPerTexel: 8 });
      await save(`${entry.name}.rgba16`, bytes);
      const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(raw.getUint16(0, true), 'advected model X = -1000 m').toBe(0xbc00);
      const advectedYHalfBits = raw.getUint16(2, true);
      // Both binary16 signed zeros represent the same physical zero displacement.
      expect(advectedYHalfBits & 0x7fff, 'advected model Y = 0 m (+0 or -0)').toBe(0);
      expect(raw.getUint16(4, true), 'advected model Z = -250 m').toBe(0xb400);
      results.push({
        name: entry.name,
        actual: raw.getUint16(32, true),
        expected: entry.expected,
        advectedYHalfBits,
        advectedYNegativeZero: advectedYHalfBits === 0x8000,
      });
      expect(
        raw.getUint16(38, true),
        'scene alpha remains independent of cloud transmittance',
      ).toBe(0x3800);
      const tape = decodeTape(captured.bytes).unwrap();
      const model = buildFrameModel(tape);
      const work = model.works.find((w) =>
        w.pipeline.shaders.some((shader) =>
          shader.source?.includes('struct CloudHistoryProbeParams'),
        ),
      );
      expect(work).toBeDefined();
      if (!work) throw new Error('Missing production cloud history kernel probe');
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
        expect(equalBytes(inspected.attachment?.bytes, bytes)).toBe(true);
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
