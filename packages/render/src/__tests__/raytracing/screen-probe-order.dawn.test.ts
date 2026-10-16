import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
  SCREEN_PROBE_TEXELS,
} from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

it('keeps receiver ray samples stable across adaptive allocation order and advances frame jitter', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-order',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe allocation regression requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array, usage = 128) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage: usage | 8 | ((usage & 1) === 0 ? 4 : 0),
    });
    owned.push(value);
    if ((usage & 1) === 0) device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const directory =
    process.env.FORGEAX_SCREEN_PROBE_ORDER_ARTIFACT ?? 'artifacts/screen-probe/order';
  const receipt = {
    status: 'running',
    backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
    sourceSha256: digest(source),
    compiledSha256: digest(compiled.wgsl),
    adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
    errors,
    cases: [] as {
      importance: string;
      frame: number;
      permutation: number;
      pixels: Record<number, string>;
    }[],
  };
  try {
    const frame = buffer(new Uint8Array(SCREEN_PROBE_FRAME_BYTES), 64);
    const probes = buffer(new Uint8Array(7 * SCREEN_PROBE_RECORD_BYTES));
    const count = buffer(new Uint8Array(new Uint32Array([2]).buffer));
    const rays = buffer(new Uint8Array(7 * SCREEN_PROBE_TEXELS * 32));
    const staging = buffer(new Uint8Array(rays.size), 1);
    const module = device.createShaderModule({ code: compiled.wgsl });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'generateProbeRays' },
    });
    const inputs = { frame, probesIn: probes, adaptiveCountIn: count, rays };
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: SCREEN_PROBE_STAGES.generateProbeRays.slots.map((slot) => ({
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        resource: { buffer: inputs[slot] },
      })),
    });
    // The production stage reads the shared field even when it has no traced
    // lighting. Keep this ordering control on that same four-buffer contract.
    const field = buffer(
      packIrradianceFieldUniform(
        { origin: [-4, -4, -4], spacing: 8, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
      ),
      64,
    );
    const retained = buffer(new Uint8Array(8 * IRRADIANCE_FIELD_PROBE_STRIDE * 16));
    const moments = buffer(new Uint8Array(8 * 64 * 8));
    const meta = buffer(new Uint8Array(8 * 16));
    const sample = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [field, retained, moments, meta].map((value, binding) => ({
        binding,
        resource: { buffer: value },
      })),
    });
    const firstFrames = new Map<string, string>();
    for (const importance of ['uniform', 'brdf'] as const) {
      for (const frameIndex of [0, 1, 47]) {
        const packed = packScreenProbeFrame({
          layout: {
            width: 16,
            height: 4,
            tilesX: 4,
            tilesY: 1,
            uniformCount: 4,
            adaptiveCapacity: 3,
            probeCount: 7,
          },
          downsample: 4,
          frameIndex,
          importance,
          screenSteps: 0,
          thickness: 0.02,
          environment: [0, 0, 0],
          maxDistance: 100,
          shortRangeAo: 0,
          maxFrames: 8,
          sceneHistory: false,
          pixelHistory: false,
          probeHistory: false,
          worldBias: 0.25,
          cardMargin: 0.125,
          query: new Uint8Array(8),
          reprojection: undefined,
        });
        expect(packed.byteLength).toBe(frame.size);
        device.queue.writeBuffer(frame, 0, packed);
        let baseline: Map<number, Uint8Array> | undefined;
        for (const [permutation, pixels] of [
          [0, [3, 7, 11, 15, 1, 5, 0xffffffff]],
          [1, [3, 7, 11, 15, 5, 1, 0xffffffff]],
        ] as const) {
          const bytes = new Uint8Array(probes.size);
          const floats = new Float32Array(bytes.buffer),
            words = new Uint32Array(bytes.buffer);
          pixels.forEach((pixel, slot) => {
            const normal = pixel === 5 ? [0, 1, 0] : [0, 0, 1];
            floats.set([pixel % 16, 0, 0, 1, ...normal], slot * 8);
            words[slot * 8 + 7] = pixel;
          });
          device.queue.writeBuffer(probes, 0, bytes);
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.setBindGroup(1, sample);
          pass.dispatchWorkgroups(7);
          pass.end();
          encoder.copyBufferToBuffer(rays, 0, staging, 0, rays.size);
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(1);
          const actual = new Uint8Array(staging.getMappedRange()).slice();
          staging.unmap();
          const selected = new Map(
            pixels.map(
              (pixel, slot) =>
                [
                  pixel,
                  actual.slice(
                    slot * SCREEN_PROBE_TEXELS * 32,
                    (slot + 1) * SCREEN_PROBE_TEXELS * 32,
                  ),
                ] as const,
            ),
          );
          receipt.cases.push({
            importance,
            frame: frameIndex,
            permutation,
            pixels: Object.fromEntries([...selected].map(([pixel, data]) => [pixel, digest(data)])),
          });
          mkdirSync(directory, { recursive: true });
          writeFileSync(`${directory}/${importance}-${frameIndex}-${permutation}.bin`, actual);
          if (baseline) {
            for (const [pixel, data] of selected)
              expect(data, `receiver ${pixel} ${importance} frame ${frameIndex}`).toEqual(
                baseline.get(pixel),
              );
          } else {
            baseline = selected;
            const identity = `${importance}/1`,
              current = digest(selected.get(1) as Uint8Array);
            if (frameIndex === 0) firstFrames.set(identity, current);
            else expect(current).not.toBe(firstFrames.get(identity));
          }
        }
      }
    }
    expect(errors).toEqual([]);
    receipt.status = 'pass';
  } finally {
    if (receipt.status !== 'pass') receipt.status = 'fail';
    for (const value of owned) value.destroy();
    device.destroy();
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/result.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  }
});

it('compacts adaptive receivers in pixel order across dispatch shapes, overflow and empty controls', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-allocation',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Adaptive placement requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const buffer = (size: number, usage = 128) => {
    const value = device.createBuffer({ size, usage: usage | 8 | 4 });
    owned.push(value);
    return value;
  };
  const cases: {
    capacity: number;
    fixture: string;
    shape: readonly [number, number];
    total: number;
    sha256: string;
  }[] = [];
  let status = 'running';
  try {
    // Four candidate workgroups, with eligible receivers in every group. Empty
    // uniform records force the original geometry-agreement eligibility rule.
    const width = 64,
      height = 16,
      uniformCount = 64,
      candidates = 256;
    const frame = buffer(SCREEN_PROBE_FRAME_BYTES, 64);
    const view = buffer(VIEW_UNIFORM_BYTES, 64);
    const viewBytes = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    viewBytes.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 44);
    viewBytes.set([0, 0, 1], 24);
    device.queue.writeBuffer(view, 0, viewBytes);
    const probes = buffer((uniformCount + 64) * SCREEN_PROBE_RECORD_BYTES);
    const adaptiveCount = buffer(5 * 4);
    const tileAdaptive = buffer(candidates * 4);
    const size = probes.size + adaptiveCount.size + tileAdaptive.size;
    const staging = device.createBuffer({ size, usage: 1 | 8 });
    owned.push(staging);
    const depth = device.createTexture({
      size: [width, height],
      format: 'depth32float',
      usage: 4 | 16,
    });
    const normal = device.createTexture({ size: [width, height], format: 'r32uint', usage: 4 | 2 });
    textures.push(depth, normal);
    device.queue.writeTexture(
      { texture: normal },
      new Uint32Array(width * height).fill(2048 | (2048 << 12)),
      { bytesPerRow: width * 4 },
      [width, height],
    );
    const resources = {
      frame: { buffer: frame },
      view: { buffer: view },
      depth: depth.createView(),
      normal: normal.createView(),
      probes: { buffer: probes },
      adaptiveCount: { buffer: adaptiveCount },
      tileAdaptive: { buffer: tileAdaptive },
    };
    const sparseModule = device.createShaderModule({
      code: `
      @vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        return vec4f(p[i], 0.5, 1);
      }
      @fragment fn fragment(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
        return select(0.0, 0.5, p.x < 8.0 && p.y < 4.0);
      }`,
    });
    const sparsePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: sparseModule, entryPoint: 'vertex' },
      fragment: { module: sparseModule, entryPoint: 'fragment', targets: [] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    const module = device.createShaderModule({ code: compiled.wgsl });
    const stages = ['placeAdaptiveProbes', 'compactAdaptiveProbes'] as const;
    const kernels = stages.map((entryPoint) => {
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint },
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: SCREEN_PROBE_STAGES[entryPoint].slots.map((slot) => ({
          binding: SCREEN_PROBE_BINDINGS[slot][0],
          resource: resources[slot],
        })),
      });
      return { pipeline, group };
    });
    for (const fixture of ['full', 'sparse', 'empty']) {
      const selected = Array.from({ length: candidates }, (_, i) => i).filter(
        (i) => fixture === 'full' || (fixture === 'sparse' && i % 32 < 4 && Math.floor(i / 32) < 2),
      );
      for (const capacity of [0, 17, 64]) {
        const packed = packScreenProbeFrame({
          layout: {
            width,
            height,
            tilesX: 16,
            tilesY: 4,
            uniformCount,
            adaptiveCapacity: capacity,
            probeCount: uniformCount + capacity,
          },
          downsample: 4,
          frameIndex: 47,
          importance: 'brdf',
          screenSteps: 0,
          thickness: 0.02,
          environment: [0, 0, 0],
          maxDistance: 100,
          shortRangeAo: 0,
          maxFrames: 8,
          sceneHistory: false,
          pixelHistory: false,
          probeHistory: false,
          worldBias: 0.25,
          cardMargin: 0.125,
          query: new Uint8Array(8),
          reprojection: undefined,
        });
        device.queue.writeBuffer(frame, 0, packed);
        let baseline: Uint8Array | undefined;
        for (const shape of [
          [4, 1],
          [2, 2],
          [1, 4],
          [4, 1],
        ] as const) {
          const empty = new Uint32Array(probes.size / 4);
          for (let i = 0; i < 128; i++) empty[i * 8 + 7] = 0xffffffff;
          device.queue.writeBuffer(probes, 0, empty);
          device.queue.writeBuffer(adaptiveCount, 0, new Uint32Array(5));
          device.queue.writeBuffer(tileAdaptive, 0, new Uint32Array(candidates).fill(0xffffffff));
          const encoder = device.createCommandEncoder();
          const depthPass = encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: depth.createView(),
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              depthClearValue: fixture === 'full' ? 0.5 : 0,
            },
          });
          if (fixture === 'sparse') {
            depthPass.setPipeline(sparsePipeline);
            depthPass.draw(3);
          }
          depthPass.end();
          for (const { pipeline, group } of kernels) {
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(shape[0], shape[1]);
            pass.end();
          }
          encoder.copyBufferToBuffer(probes, 0, staging, 0, probes.size);
          encoder.copyBufferToBuffer(adaptiveCount, 0, staging, probes.size, adaptiveCount.size);
          encoder.copyBufferToBuffer(
            tileAdaptive,
            0,
            staging,
            probes.size + adaptiveCount.size,
            tileAdaptive.size,
          );
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(1);
          const actual = new Uint8Array(staging.getMappedRange()).slice();
          staging.unmap();
          const words = new Uint32Array(actual.buffer);
          const liveCount = Math.min(capacity, selected.length);
          const total = new DataView(actual.buffer).getUint32(probes.size, true);
          cases.push({
            capacity,
            fixture,
            shape,
            total,
            sha256: createHash('sha256').update(actual).digest('hex'),
          });
          expect(total).toBe(capacity > 0 ? selected.length : 0);
          for (let i = 0; i < 64; i++) {
            const receiver = selected[i] ?? 0;
            const pixel = (2 * (receiver % 32) + 1) | ((2 * Math.floor(receiver / 32) + 1) << 16);
            expect(words[(uniformCount + i) * 8 + 7], `capacity ${capacity}, receiver ${i}`).toBe(
              i < liveCount ? pixel : 0xffffffff,
            );
          }
          const mapping = probes.size / 4 + adaptiveCount.size / 4;
          for (let i = 0; i < candidates; i++) {
            const x = i % 32,
              y = Math.floor(i / 32);
            const tileSlot =
              (Math.floor(y / 2) * 16 + Math.floor(x / 2)) * 4 + (x & 1) + ((y & 1) << 1);
            const ordinal = selected.indexOf(i);
            expect(words[mapping + tileSlot]).toBe(
              ordinal >= 0 && ordinal < liveCount ? uniformCount + ordinal : 0xffffffff,
            );
          }
          if (baseline) expect(actual).toEqual(baseline);
          else baseline = actual;
        }
      }
    }
    expect(errors).toEqual([]);
    status = 'PASS';
  } finally {
    const directory =
      process.env.FORGEAX_SCREEN_PROBE_ORDER_ARTIFACT ?? 'artifacts/screen-probe/order';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/allocation.json`,
      `${JSON.stringify({ status, backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn', sourceSha256: createHash('sha256').update(source).digest('hex'), cases, errors }, null, 2)}\n`,
    );
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
});
