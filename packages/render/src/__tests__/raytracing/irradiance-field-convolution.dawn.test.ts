import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  IRRADIANCE_FIELD_DERIVE_WGSL,
  IRRADIANCE_FIELD_FAR_RADIANCE,
  IRRADIANCE_FIELD_UPDATE_WGSL,
  packIrradianceFieldFrame,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';

type Signal = 'affine' | 'quadratic' | 'constant-shift';

function incidentRadiance(signal: Signal, x: number, y: number, z: number): number[] {
  if (signal === 'constant-shift') {
    const cap = x < -0.7 ? 20 : 0;
    return [cap, 10, cap + 10];
  }
  return [x, y, z].map((v) => 1 + 0.9 * (signal === 'affine' ? v : (3 * v * v - 1) / 2));
}

for (const [signal, far] of [
  ['affine', false],
  ['quadratic', false],
  ['constant-shift', false],
  ['constant-shift', true],
] as const)
  it(`preserves a directional ${signal} radiance signal in the ${far ? 'far octahedral' : 'near'} producer`, async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Cosine convolution requires a real GPU adapter');
    const device = await adapter.requestDevice(),
      owned: GPUBuffer[] = [],
      errors: string[] = [];
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const buffer = (data: Uint8Array, usage = 128) => {
      const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
      owned.push(value);
      device.queue.writeBuffer(value, 0, data);
      return value;
    };
    const bytes = (data: Float32Array | Uint32Array) => new Uint8Array(data.buffer);
    try {
      const count = signal === 'constant-shift' ? 256 : 4096,
        data = new Float32Array(count * 8);
      for (let i = 0; i < count; i++) {
        let z = 1 - (2 * (i + 0.5)) / count;
        const radius = Math.sqrt(1 - z * z),
          phi = i * Math.PI * (3 - Math.sqrt(5));
        let x = radius * Math.cos(phi),
          y = radius * Math.sin(phi);
        if (far) {
          x = ((i % 16) + 0.5) / 8 - 1;
          y = (Math.floor(i / 16) + 0.5) / 8 - 1;
          z = 1 - Math.abs(x) - Math.abs(y);
          if (z < 0) [x, y] = [(1 - Math.abs(y)) * Math.sign(x), (1 - Math.abs(x)) * Math.sign(y)];
          const norm = Math.hypot(x, y, z);
          x /= norm;
          y /= norm;
          z /= norm;
        }
        const radiance = incidentRadiance(signal, x, y, z);
        data.set([...radiance, 8, x, y, z, 0], i * 8);
      }
      const rays = buffer(bytes(data)),
        probes = buffer(bytes(new Float32Array(IRRADIANCE_FIELD_PROBE_STRIDE * 4)), 128 | 4);
      const moments = buffer(bytes(new Float32Array(64 * 2))),
        meta = buffer(bytes(new Uint32Array(4)));
      const fieldData = packIrradianceFieldUniform(
        { origin: [0, 0, 0], spacing: 1, dimensions: [1, 1, 1], probeCount: 1, levels: 1 },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [1, 1, 1] }],
      );
      if (far) new Uint32Array(fieldData.buffer)[15] = IRRADIANCE_FIELD_FAR_RADIANCE;
      const field = buffer(fieldData, 64);
      const frame = buffer(
        packIrradianceFieldFrame({
          worldSource: { traversal: 'unused' },
          probeBudget: 1,
          raysPerProbe: count,
          frameIndex: 0,
          tileOffset: 0,
          tileBudget: 0,
          tileCount: 0,
          lightCount: 0,
          cardResolution: 1,
          atlasWidth: 1,
          radiosity: false,
          environment: [0, 0, 0],
          hysteresis: 0,
          maxDistance: 10,
          surfaceBias: 0,
          depthClamp: 8,
          cardMargin: 0,
          gather: [1, 1, 1, 1],
          query: new Uint8Array(8),
          reflections: [0, 0],
        }),
        64,
      );
      const list = buffer(bytes(new Uint32Array(1)));
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      for (const [code, entryPoint] of [
        [IRRADIANCE_FIELD_UPDATE_WGSL, 'updateProbes'],
        [IRRADIANCE_FIELD_DERIVE_WGSL, 'deriveProbes'],
      ] as const) {
        const pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code }), entryPoint },
        });
        const roster =
          entryPoint === 'updateProbes'
            ? [rays, probes, moments, meta, field, frame, list]
            : [undefined, probes, undefined, undefined, undefined, frame, list];
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: roster.flatMap((value, binding) =>
            value ? [{ binding, resource: { buffer: value } }] : [],
          ),
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
      }
      pass.end();
      const readback = device.createBuffer({ size: probes.size, usage: 1 | 8 });
      owned.push(readback);
      encoder.copyBufferToBuffer(probes, 0, readback, 0, probes.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const values = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      const records = [];
      for (let texel = 0; texel < 64; texel++) {
        let x = (((texel % 8) + 0.5) / 8) * 2 - 1,
          y = ((Math.floor(texel / 8) + 0.5) / 8) * 2 - 1;
        const z = 1 - Math.abs(x) - Math.abs(y);
        if (z < 0) {
          const oldX = x;
          x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
          y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
        }
        const length = Math.hypot(x, y, z),
          direction = [x / length, y / length, z / length];
        if (signal === 'constant-shift') {
          const actual = Array.from(values.subarray(texel * 4, texel * 4 + 3));
          const constant = actual[1] ?? Number.NaN;
          const shifted = (actual[2] ?? Number.NaN) - (actual[0] ?? Number.NaN);
          // R = nonnegative bright cap, G = constant 10, B = R + G.
          // Linear angular reconstruction must preserve the constant shift
          // before the public nonnegative boundary. No copied kernel formula
          // or Engine ray/geometry result supplies this invariant.
          records.push({
            texel,
            direction,
            actual,
            constant,
            shifted,
            expectedShift: 10,
            error: [Math.abs(constant - 10), Math.abs(shifted - 10)],
          });
          continue;
        }
        const expected = direction.map((v) =>
            signal === 'affine' ? 1 + 0.6 * v : 1 + (0.225 * (3 * v * v - 1)) / 2,
          ),
          actual = Array.from(values.subarray(texel * 4, texel * 4 + 3));
        records.push({
          texel,
          direction,
          expected,
          actual,
          error: actual.map((v, c) => Math.abs(v - (expected[c] ?? Number.NaN))),
        });
      }
      if (process.env.FORGEAX_GI_CONVOLUTION_RESULT)
        writeFileSync(
          signal === 'affine'
            ? process.env.FORGEAX_GI_CONVOLUTION_RESULT
            : process.env.FORGEAX_GI_CONVOLUTION_RESULT.replace(
                /\.json$/,
                `.${signal}${far ? '-far' : ''}.json`,
              ),
          JSON.stringify(
            {
              signal,
              scope:
                signal === 'constant-shift'
                  ? 'Actual producer update and derive: constant-shift invariance of the linear intermediate, not full-scene or public nonnegative-output acceptance.'
                  : 'Actual producer update and derive compared with independent low-order spherical integrals.',
              adapter: {
                vendor: adapter.info.vendor,
                architecture: adapter.info.architecture,
                device: adapter.info.device,
                description: adapter.info.description,
              },
              records,
              maximumError: Math.max(...records.flatMap((r) => r.error)),
              errors,
            },
            null,
            2,
          ),
        );
      expect(errors).toEqual([]);
      // Independent integrals: a linear signal transfers with 2/3; P2 with 1/4.
      // Constant or affine fields alone cannot establish the second-order gain.
      // The exact unblurred 64-direction quadrature stays below 0.012 for
      // these smooth signals. A 0.015 allowance covers discretization and the
      // 4096-ray reference sampling without accepting the extra low-order blur.
      expect(Math.max(...records.flatMap((r) => r.error))).toBeLessThan(
        signal === 'constant-shift' ? 0.002 : 0.015,
      );
    } finally {
      for (const value of owned) value.destroy();
      device.destroy();
    }
  });
