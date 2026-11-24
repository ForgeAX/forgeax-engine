import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../../scripts/test/byte-equality.mjs';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_STAGES,
  SCREEN_PROBE_TRACE_STAGES,
} from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
  SCREEN_PROBE_TEXELS,
  ScreenProbeRayStatus,
} from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { gbufferNormalPixels } from './gbuffer-normal.fixture';
import { rayShaderTestImports } from './ray-shader-imports.fixture';
import { emptyOrderProbeRecords } from './screen-probe-order.fixture';

it('keeps receiver ray samples stable across adaptive allocation order and advances frame jitter', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-order',
      imports: await rayShaderTestImports(),
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
          worldSource: { traversal: 'unused' },
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
          [0, [3, 7, 11, 0xffffffff, 1, 5, 9]],
          [1, [3, 7, 11, 0xffffffff, 5, 1, 9]],
        ] as const) {
          const bytes = new Uint8Array(probes.size);
          const floats = new Float32Array(bytes.buffer),
            words = new Uint32Array(bytes.buffer);
          pixels.forEach((pixel, slot) => {
            const normal = pixel === 5 ? [0, 1, 0] : [0, 0, 1];
            floats.set([pixel % 16, 0, 0, 1, ...normal], slot * (SCREEN_PROBE_RECORD_BYTES / 4));
            words[slot * (SCREEN_PROBE_RECORD_BYTES / 4) + 7] = pixel;
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
          const output = new DataView(actual.buffer);
          // Slot 3 has no receiver. Slot 6 looks live but lies past the
          // admitted adaptive count. Neither can hand a stale ray to tracing.
          for (const slot of [3, 6]) {
            for (let ray = 0; ray < SCREEN_PROBE_TEXELS; ray++) {
              const info = output.getUint32((slot * SCREEN_PROBE_TEXELS + ray) * 32 + 12, true);
              expect((info >> 12) & 7).toBe(ScreenProbeRayStatus.culled);
            }
          }
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
              expect(
                equalBytes(data, baseline.get(pixel)),
                `receiver ${pixel} ${importance} frame ${frameIndex}`,
              ).toBe(true);
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

it('compacts only live World rays and resets the list before gathering lighting fallbacks', async () => {
  const source = readFileSync(
    new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
    'utf8',
  );
  const compiled = (
    await compileShader(source, { id: 'screen-trace-list', imports: await rayShaderTestImports() })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Trace compaction requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const owned: GPUBuffer[] = [];
  try {
    const uploadBuffer = (words: Uint32Array, usage = 128) => {
      const buffer = device.createBuffer({ size: words.byteLength, usage: usage | 8 | 4 });
      owned.push(buffer);
      device.queue.writeBuffer(buffer, 0, words);
      return buffer;
    };
    const frameWords = new Uint32Array(SCREEN_PROBE_FRAME_BYTES / 4);
    frameWords.set([2, 2, 16, 0], 4);
    const probeWords = emptyOrderProbeRecords(4);
    const probeStride = SCREEN_PROBE_RECORD_BYTES / 4;
    for (const probe of [0, 2, 3]) probeWords[probe * probeStride + 7] = probe;
    const rayWords = new Uint32Array(4 * SCREEN_PROBE_TEXELS * 8);
    const worldSlots = [0, 63, 128, 191];
    const fallbackSlots = [4, 130];
    for (const slot of [...worldSlots, 65, 192]) {
      rayWords[slot * 8 + 3] = (ScreenProbeRayStatus.world << 12) | 512;
    }
    rayWords[8 * 8 + 3] = ScreenProbeRayStatus.world << 12;
    for (const slot of fallbackSlots) {
      rayWords[slot * 8 + 3] = (ScreenProbeRayStatus.fallback << 12) | 512;
    }
    const list = uploadBuffer(new Uint32Array(257));
    const args = uploadBuffer(new Uint32Array(6));
    const resources = {
      frame: uploadBuffer(frameWords, 64),
      probesIn: uploadBuffer(probeWords),
      adaptiveCountIn: uploadBuffer(new Uint32Array([1])),
      raysIn: uploadBuffer(rayWords),
      fallbackList: list,
      fallbackListIn: list,
      traceDispatch: args,
    };
    const stride = list.size + args.size;
    const staging = device.createBuffer({ size: 3 * stride, usage: 1 | 8 });
    owned.push(staging);
    const module = device.createShaderModule({ code: compiled.wgsl });
    const encoder = device.createCommandEncoder();
    const run = (
      stage:
        | 'compactWorldTraces'
        | 'compactTraceFallbacks'
        | 'resetTraceList'
        | 'prepareTraceFallbackDispatch',
      groups: number,
    ) => {
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: stage },
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: SCREEN_PROBE_TRACE_STAGES[stage].slots.map((slot) => ({
            binding: SCREEN_PROBE_BINDINGS[slot][0],
            resource: { buffer: resources[slot] },
          })),
        }),
      );
      pass.dispatchWorkgroups(groups);
      pass.end();
    };
    const snapshot = (index: number) => {
      run('prepareTraceFallbackDispatch', 1);
      encoder.copyBufferToBuffer(list, 0, staging, index * stride, list.size);
      encoder.copyBufferToBuffer(args, 0, staging, index * stride + list.size, args.size);
    };
    run('compactWorldTraces', 4);
    snapshot(0);
    run('resetTraceList', 1);
    run('compactTraceFallbacks', 4);
    snapshot(1);
    run('resetTraceList', 1);
    snapshot(2);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    try {
      const words = new Uint32Array(staging.getMappedRange());
      for (const [index, expected] of [worldSlots, fallbackSlots, []].entries()) {
        const start = (index * stride) / 4;
        expect(words[start]).toBe(expected.length);
        expect(
          Array.from(words.slice(start + 1, start + 1 + expected.length)).sort((a, b) => a - b),
        ).toEqual(expected);
        const offset = start + list.size / 4 + 3;
        expect(Array.from(words.slice(offset, offset + 3))).toEqual([
          1,
          expected.length ? 1 : 0,
          1,
        ]);
      }
    } finally {
      staging.unmap();
    }
  } finally {
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
});

it.each([
  4, 8, 16,
] as const)('compacts %i adaptive candidates in pixel order including partial tiles', async (slots) => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const compileEntry = async (computeEntry: string) =>
    (
      await compileShader(source, {
        id: 'screen-probe-allocation',
        computeEntry,
        imports: await rayShaderTestImports(),
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
    // Empty uniform records force placement wherever the G-buffer covers.
    const width = slots === 4 ? 64 : 65;
    const height = slots === 4 ? 16 : 17;
    const tilesX = Math.ceil(width / 4),
      tilesY = Math.ceil(height / 4);
    const uniformCount = tilesX * tilesY;
    const candidates = uniformCount * slots;
    const groups = Math.ceil(candidates / 64);
    const widthInSamples = slots === 4 ? 2 : 4,
      heightInSamples = slots / widthInSamples;
    const stride = tilesX * widthInSamples;
    const coordinates = (i: number) => {
      const x = i % stride,
        y = Math.floor(i / stride);
      const tileX = Math.floor(x / widthInSamples),
        tileY = Math.floor(y / heightInSamples);
      const tileW = Math.min(4, width - tileX * 4),
        tileH = Math.min(4, height - tileY * 4);
      const sx = x % widthInSamples,
        sy = y % heightInSamples;
      const px = Math.floor(((sx + 0.5) * tileW) / widthInSamples);
      const py = Math.floor(((sy + 0.5) * tileH) / heightInSamples);
      const unique =
        Math.floor(((px + 0.5) * widthInSamples) / tileW) === sx &&
        Math.floor(((py + 0.5) * heightInSamples) / tileH) === sy;
      return {
        px: tileX * 4 + px,
        py: tileY * 4 + py,
        unique,
        slot: (tileY * tilesX + tileX) * slots + sy * widthInSamples + sx,
      };
    };
    const frame = buffer(SCREEN_PROBE_FRAME_BYTES, 64);
    const view = buffer(VIEW_UNIFORM_BYTES, 64);
    const viewBytes = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    viewBytes.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 44);
    viewBytes.set([0, 0, 1], 24);
    device.queue.writeBuffer(view, 0, viewBytes);
    const probes = buffer((uniformCount + 64) * SCREEN_PROBE_RECORD_BYTES);
    const adaptiveCount = buffer((groups + 1) * 4);
    const tileAdaptive = buffer(candidates * 4);
    const size = probes.size + adaptiveCount.size + tileAdaptive.size;
    const staging = device.createBuffer({ size, usage: 1 | 8 });
    owned.push(staging);
    const depth = device.createTexture({
      size: [width, height],
      format: 'depth32float',
      usage: 4 | 16,
    });
    const normal = device.createTexture({
      size: [width, height],
      format: 'rg32uint',
      usage: 4 | 2,
    });
    textures.push(depth, normal);
    device.queue.writeTexture(
      { texture: normal },
      gbufferNormalPixels(width * height),
      { bytesPerRow: width * 8 },
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
    const stages = ['placeAdaptiveProbes', 'compactAdaptiveProbes'] as const;
    const kernels: { pipeline: GPUComputePipeline; group: GPUBindGroup }[] = [];
    for (const entryPoint of stages) {
      const compiled = await compileEntry(entryPoint);
      const module = device.createShaderModule({ code: compiled.wgsl });
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
      kernels.push({ pipeline, group });
    }
    for (const fixture of ['full', 'sparse', 'empty']) {
      const selected = Array.from({ length: candidates }, (_, i) => i).filter((i) => {
        const { px, py, unique } = coordinates(i);
        return unique && (fixture === 'full' || (fixture === 'sparse' && px < 8 && py < 4));
      });
      function verifyTileMapping(words: Uint32Array, selected: number[], liveCount: number): void {
        const mapping = probes.size / 4 + adaptiveCount.size / 4;
        for (let i = 0; i < candidates; i++) {
          const tileSlot = coordinates(i).slot;
          const ordinal = selected.indexOf(i);
          expect(words[mapping + tileSlot]).toBe(
            ordinal >= 0 && ordinal < liveCount ? uniformCount + ordinal : 0xffffffff,
          );
        }
      }
      for (const capacity of [0, 17, 64]) {
        const packed = packScreenProbeFrame({
          worldSource: { traversal: 'unused' },
          layout: {
            width,
            height,
            tilesX,
            tilesY,
            uniformCount,
            adaptiveSlots: slots,
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
          [groups, 1],
          [Math.ceil(groups / 2), 2],
          [1, groups],
          [groups, 1],
        ] as const) {
          const empty = emptyOrderProbeRecords(probes.size / SCREEN_PROBE_RECORD_BYTES);
          device.queue.writeBuffer(probes, 0, empty);
          device.queue.writeBuffer(adaptiveCount, 0, new Uint32Array(groups + 1));
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
            const { px, py } = coordinates(receiver);
            const pixel = px | (py << 16);
            expect(
              words[(uniformCount + i) * (SCREEN_PROBE_RECORD_BYTES / 4) + 7],
              `capacity ${capacity}, receiver ${i}`,
            ).toBe(i < liveCount ? pixel : 0xffffffff);
          }
          verifyTileMapping(words, selected, liveCount);
          if (baseline) expect(equalBytes(actual, baseline)).toBe(true);
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
      `${directory}/allocation-${slots}.json`,
      `${JSON.stringify({ status, backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn', sourceSha256: createHash('sha256').update(source).digest('hex'), cases, errors }, null, 2)}\n`,
    );
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
});
