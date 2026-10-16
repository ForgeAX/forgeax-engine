import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame } from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

it('reprojects only geometrically supported Screen Probe history taps', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const coordinate = 'uv * vec2f(extent) - vec2f(0.5)';
  expect(source.split(coordinate)).toHaveLength(2);
  const modules = await Promise.all(
    [source, source.replace(coordinate, 'floor(uv * vec2f(extent))')].map(async (wgsl) =>
      (
        await compileShader(wgsl, {
          id: 'screen-probe-history-taps',
          imports: {
            'forgeax_view::common': read('common'),
            'forgeax_pbr::gbuffer': read('standard-gbuffer'),
            'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
            'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
          },
        })
      ).unwrap(),
    ),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe history requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffers: GPUBuffer[] = [];
  const make = (bytes: Uint8Array, usage = 128) => {
    const buffer = device.createBuffer({ size: bytes.byteLength, usage: usage | 12 });
    buffers.push(buffer);
    device.queue.writeBuffer(buffer, 0, bytes);
    return buffer;
  };
  const projection = [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 1, 0, 0.5, -0.5, 0, 1];
  const frameData = packScreenProbeFrame({
    layout: {
      width: 2,
      height: 2,
      tilesX: 1,
      tilesY: 1,
      uniformCount: 1,
      adaptiveCapacity: 0,
      probeCount: 1,
    },
    downsample: 2,
    frameIndex: 1,
    importance: 'uniform',
    screenSteps: 0,
    thickness: 0.02,
    environment: [0, 0, 0],
    maxDistance: 100,
    shortRangeAo: 0,
    maxFrames: 8,
    sceneHistory: false,
    pixelHistory: true,
    probeHistory: false,
    worldBias: 0,
    cardMargin: 0,
    query: new Uint8Array(8),
    reprojection: { viewProjection: projection, cameraPosition: [0, 0, 1] },
  });
  const frame = make(frameData, 64),
    viewData = new Uint8Array(VIEW_UNIFORM_BYTES);
  new Float32Array(viewData.buffer).set([0, 0, 1], 24);
  new Float32Array(viewData.buffer).set(
    [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1],
    44,
  );
  const view = make(viewData, 64),
    integrated = make(new Uint8Array(64)),
    historyIn = make(new Uint8Array(64)),
    historyOut = make(new Uint8Array(64)),
    metaIn = make(new Uint8Array(64)),
    metaOut = make(new Uint8Array(64));
  const depth = device.createTexture({ size: [2, 2], format: 'depth32float', usage: 4 | 16 });
  const normal = device.createTexture({ size: [2, 2], format: 'r32uint', usage: 4 | 2 });
  device.queue.writeTexture(
    { texture: normal },
    new Uint32Array(4).fill(2048 | (2048 << 12)),
    { bytesPerRow: 8 },
    [2, 2],
  );
  const clear = device.createCommandEncoder();
  clear
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.5,
      },
    })
    .end();
  device.queue.submit([clear.finish()]);
  const resources: Record<string, GPUBuffer | GPUTextureView> = {
    frame,
    view,
    depth: depth.createView(),
    normal: normal.createView(),
    integrated,
    historyIn,
    historyOut,
    metaIn,
    metaOut,
  };
  const layout = device.createBindGroupLayout({
    entries: SCREEN_PROBE_STAGES.temporalScreenProbes.slots.map((slot) => {
      const [binding, kind] = SCREEN_PROBE_BINDINGS[slot];
      return kind === 'depth' || kind === 'uint'
        ? {
            binding,
            visibility: 4,
            texture: { sampleType: kind === 'depth' ? ('depth' as const) : ('uint' as const) },
          }
        : {
            binding,
            visibility: 4,
            buffer: {
              type:
                kind === 'uniform'
                  ? ('uniform' as const)
                  : kind === 'storage'
                    ? ('storage' as const)
                    : ('read-only-storage' as const),
            },
          };
    }),
  });
  const group = device.createBindGroup({
    layout,
    entries: SCREEN_PROBE_STAGES.temporalScreenProbes.slots.map((slot) => ({
      binding: SCREEN_PROBE_BINDINGS[slot][0],
      resource: (() => {
        const value = resources[slot];
        if (value === undefined) throw new Error(`Missing ${slot}`);
        return 'mapAsync' in value ? { buffer: value } : value;
      })(),
    })),
  });
  const pipelines = modules.map((module) =>
    device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: module.wgsl }),
        entryPoint: 'temporalScreenProbes',
      },
    }),
  );
  const readback = device.createBuffer({ size: 128, usage: 1 | 8 });
  buffers.push(readback);
  const controls: Record<string, { output: number[]; meta: number[] }[]> = {};
  try {
    for (const mode of [
      'all',
      'normal-reject',
      'depth-reject',
      'invalid-tap',
      'all-reject',
      'black',
      'constant',
      'invalid-current',
      'edge',
      'young-tap',
      'shared-budget',
    ] as const) {
      const current = new Float32Array(16),
        history = new Float32Array(16),
        metadata = new Uint8Array(64);
      const m = new DataView(metadata.buffer);
      for (let p = 0; p < 4; p++) {
        current.set([2, 2, 2, Number(mode !== 'invalid-current')], p * 4);
        const value = mode === 'black' ? 0 : mode === 'constant' ? 2 : p * 4;
        history.set([value, value, value, 1], p * 4);
        m.setFloat32(p * 16, mode === 'depth-reject' && p === 3 ? 10 : Math.sqrt(1.00005), true);
        m.setUint32(p * 16 + 4, mode === 'normal-reject' && p === 3 ? 0x7fff7fff : 0, true);
        m.setUint32(
          p * 16 + 8,
          mode === 'shared-budget' ? 8 : mode === 'young-tap' && p === 0 ? 1 : 4,
          true,
        );
        m.setUint32(
          p * 16 + 12,
          Number(mode !== 'all-reject' && !(mode === 'invalid-tap' && p === 3)),
          true,
        );
      }
      new Uint32Array(frameData.buffer)[10] = mode === 'shared-budget' ? 6 : 2;
      new Float32Array(frameData.buffer)[36] = mode === 'edge' ? -0.5 : 0.5;
      device.queue.writeBuffer(frame, 0, frameData);
      device.queue.writeBuffer(integrated, 0, current);
      device.queue.writeBuffer(historyIn, 0, history);
      device.queue.writeBuffer(metaIn, 0, metadata);
      const results = [];
      for (const pipeline of pipelines) {
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(historyOut, 0, readback, 0, 64);
        encoder.copyBufferToBuffer(metaOut, 0, readback, 64, 64);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const data = readback.getMappedRange().slice(0);
        readback.unmap();
        results.push({
          output: Array.from(new Float32Array(data, 0, 4)),
          meta: Array.from(new Uint32Array(data, 64, 4)),
        });
      }
      controls[mode] = results;
    }
    const red = (mode: string) => controls[mode]?.[0]?.output[0];
    expect(red('all')).toBeCloseTo(5.2, 5);
    expect(controls.all?.[1]?.output[0]).toBeCloseTo(10, 5);
    for (const mode of ['normal-reject', 'depth-reject', 'invalid-tap', 'edge'])
      expect(red(mode)).toBeCloseTo(3.6, 5);
    expect(red('all-reject')).toBe(2);
    expect(controls['all-reject']?.[0]?.meta[2]).toBe(1);
    expect(red('black')).toBeCloseTo(0.4, 5);
    expect(red('constant')).toBe(2);
    expect(controls['invalid-current']?.[0]?.output).toEqual([0, 0, 0, 0]);
    expect(controls['invalid-current']?.[0]?.meta).toEqual([0, 0, 0, 0]);
    expect(red('young-tap')).toBe(4);
    expect(controls['young-tap']?.[0]?.meta[2]).toBe(2);
    expect(red('shared-budget')).toBeCloseTo(5.2, 5);
    expect(controls['shared-budget']?.[0]?.meta[2]).toBe(5);
    expect(errors).toEqual([]);
  } finally {
    mkdirSync('artifacts/screen-probe/history', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/history/result.json',
      JSON.stringify({ controls, errors }, null, 2),
    );
    for (const buffer of buffers) buffer.destroy();
    depth.destroy();
    normal.destroy();
    device.destroy();
  }
}, 120_000);
