import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame, SCREEN_PROBE_FRAME_BYTES } from '../../raytracing/screen-probe-plan';

it('stratifies each receiver angular sequence independently of placement jitter and adaptive slots', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-ray-sequence',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Angular sequence requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (size: number, usage: number) => {
    const value = device.createBuffer({ size, usage });
    owned.push(value);
    return value;
  };
  const controls: Record<string, number[]> = {};
  let status = 'running';
  try {
    const frame = buffer(SCREEN_PROBE_FRAME_BYTES, 64 | 8),
      probes = buffer(6 * 32, 128 | 8),
      count = buffer(4, 128 | 8),
      rays = buffer(6 * 64 * 32, 128 | 4),
      staging = buffer(rays.size, 1 | 8);
    device.queue.writeBuffer(count, 0, new Uint32Array([2]));
    const layout = device.createBindGroupLayout({
      entries: SCREEN_PROBE_STAGES.generateProbeRays.slots.map((slot) => ({
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        visibility: 4,
        buffer: {
          type: slot === 'frame' ? 'uniform' : slot === 'rays' ? 'storage' : 'read-only-storage',
        },
      })),
    });
    const sampleLayout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: binding === 0 ? 'uniform' : 'read-only-storage' },
      })),
    });
    // The production stage always receives the shared field group. An
    // untraced field keeps this uniform-sequence control independent of light.
    const fieldBytes = packIrradianceFieldUniform(
      { origin: [-4, -4, -4], spacing: 8, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
    );
    const field = buffer(fieldBytes.byteLength, 64 | 8);
    device.queue.writeBuffer(field, 0, fieldBytes);
    const retained = buffer(8 * IRRADIANCE_FIELD_PROBE_STRIDE * 16, 128);
    const moments = buffer(8 * 64 * 8, 128);
    const meta = buffer(8 * 16, 128);
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sampleLayout] }),
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'generateProbeRays',
      },
    });
    const group = device.createBindGroup({
      layout,
      entries: [
        [0, frame],
        [7, probes],
        [9, count],
        [12, rays],
      ].map(([binding, value]) => ({
        binding: binding as number,
        resource: { buffer: value as GPUBuffer },
      })),
    });
    const sample = device.createBindGroup({
      layout: sampleLayout,
      entries: [field, retained, moments, meta].map((value, binding) => ({
        binding,
        resource: { buffer: value },
      })),
    });
    const adaptivePixels = [1 | (2 << 16), 7 | (1 << 16)];
    const execute = async (frameIndex: number, swapped: boolean) => {
      device.queue.writeBuffer(
        frame,
        0,
        packScreenProbeFrame({
          layout: {
            width: 16,
            height: 4,
            tilesX: 4,
            tilesY: 1,
            uniformCount: 4,
            adaptiveCapacity: 2,
            probeCount: 6,
          },
          downsample: 4,
          frameIndex,
          importance: 'uniform',
          screenSteps: 0,
          sceneHistory: false,
          pixelHistory: false,
          probeHistory: false,
          maxFrames: 10,
          environment: [0, 0, 0],
          maxDistance: 4,
          thickness: 0.02,
          shortRangeAo: 0,
          worldBias: 0.25,
          cardMargin: 0.125,
          query: new Uint8Array(8),
          reprojection: undefined,
        }),
      );
      const records = new Float32Array(6 * 8),
        words = new Uint32Array(records.buffer);
      for (let probe = 0; probe < 6; probe++) {
        records.set([probe, 0, 0, 1, 0, 0, 1], probe * 8);
        const pixel =
          probe < 4 ? probe * 4 + (frameIndex % 4) : adaptivePixels[(probe - 4) ^ Number(swapped)];
        assert(pixel !== undefined);
        words[probe * 8 + 7] = pixel;
      }
      device.queue.writeBuffer(probes, 0, records);
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, sample);
      pass.dispatchWorkgroups(6);
      pass.end();
      encoder.copyBufferToBuffer(rays, 0, staging, 0, rays.size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const actual = new Float32Array(staging.getMappedRange()).slice();
      staging.unmap();
      const result: Record<string, number[]> = {};
      for (let probe = 0; probe < 6; probe++) {
        const key = probe < 4 ? `uniform:${probe}` : `adaptive:${words[probe * 8 + 7]}`;
        result[key] = Array.from(actual.subarray(probe * 64 * 8, (probe + 1) * 64 * 8));
      }
      return result;
    };
    const checks: { name: string; actual: unknown; expected: unknown }[] = [];
    for (const first of [0, 47, 101]) {
      const frames: Record<string, number[]>[] = [];
      for (let phase = 0; phase < 8; phase++)
        frames.push(await execute(first + phase, phase % 2 === 1));
      const initial = frames[0];
      assert(initial !== undefined);
      for (const key of Object.keys(initial)) {
        const jitter: number[] = [];
        for (const frame of frames) {
          const data = frame[key];
          assert(data !== undefined);
          const bits = new Uint32Array(new Float32Array(data).buffer);
          const texels = new Set<number>();
          for (let ray = 0; ray < 64; ray++) {
            const at = ray * 8,
              info = bits[at + 3];
            assert(info !== undefined);
            expect(info & 512).toBe(512);
            expect((info >> 12) & 7).toBe(1);
            texels.add(info & 63);
            expect(Math.hypot(...data.slice(at, at + 3))).toBeCloseTo(1, 6);
          }
          expect(texels.size).toBe(64);
          // Texel 27 stays on the interior +Z octahedral face. Inverting the
          // actual emitted direction exposes its two within-cell coordinates.
          const at = 27 * 8,
            direction = data.slice(at, at + 3),
            l1 = direction.reduce((s, v) => s + Math.abs(v), 0);
          jitter.push(
            (((direction[0] ?? Number.NaN) / l1) * 0.5 + 0.5) * 8 - 3,
            (((direction[1] ?? Number.NaN) / l1) * 0.5 + 0.5) * 8 - 3,
          );
        }
        controls[`${first}:${key}:jitter`] = jitter;
        for (const axis of [0, 1]) {
          const bins = jitter.filter((_, i) => i % 2 === axis).map((v) => Math.floor(v * 8));
          checks.push({
            name: `${first}:${key}:axis${axis}`,
            actual: [...bins].sort((a, b) => a - b),
            expected: [0, 1, 2, 3, 4, 5, 6, 7],
          });
        }
      }
      const repeated = await execute(first + 8, true);
      for (const key of Object.keys(repeated))
        checks.push({
          name: `${first}:${key}:period-and-slot-invariance`,
          actual: repeated[key],
          expected: initial[key],
        });
    }
    expect(errors).toEqual([]);
    for (const check of checks) expect(check.actual, check.name).toEqual(check.expected);
    status = 'pass';
  } finally {
    if (status !== 'pass') status = 'fail';
    owned.forEach((value) => {
      value.destroy();
    });
    device.destroy();
    mkdirSync('artifacts/screen-probe/ray-sequence', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/ray-sequence/result.json',
      `${JSON.stringify({ status, controls, errors }, null, 2)}\n`,
    );
  }
}, 30_000);
