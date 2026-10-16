import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  IRRADIANCE_FIELD_PENDING_OFFSET,
  IRRADIANCE_FIELD_RELOCATION,
  IRRADIANCE_FIELD_UNIFORM_BYTES,
  IrradianceFieldProbeState,
  irradianceFieldDepthClamp,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';

const positions = [-1.49, -1, 0, 1, 1.49, 2];
const perLevel = 4 ** 3;
const count = 2 * perLevel;
const fineValue = 0.2;
const coarseValue = 1;

it('keeps same-field clipmap endpoints convex and excludes unpublished probe histories', async () => {
  const source = `
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField, sampleRadianceCacheAt}
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(1) fn verifyFieldSampling(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= arrayLength(&positions)) { return; }
  let position = positions[gid.x].xyz;
  let normal = vec3f(0.0, 1.0, 0.0);
  results[2u * gid.x] = sampleIrradianceField(position, normal, vec3f(0.0));
  results[2u * gid.x + 1u] = sampleRadianceCacheAt(position, normal, vec3f(0.0), normal, positions[gid.x].w);
}`;
  const compiled = (
    await compileShader(source, {
      id: 'irradiance-field-same-cache-endpoints',
      imports: {
        'forgeax_ray::irradiance_field_sample': readFileSync(
          new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
          'utf8',
        ),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  expect(adapter).not.toBeNull();
  if (!adapter) throw new Error('same-field sampling requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const result: {
    status: 'running' | 'pass' | 'fail';
    failure?: string;
    blended?: number[];
    rejected: Record<number, { fallback: number[]; absent: number[] }>;
    relocatedOpenSpace?: number[];
    angularSupport?: Record<string, number[]>;
    pendingWorld?: Record<number, number[]>;
  } = { status: 'running', rejected: {} };
  const owned: GPUBuffer[] = [];
  const buffer = (bytes: Uint8Array, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size: bytes.byteLength, usage: usage | 8 });
    owned.push(value);
    device.queue.writeBuffer(value, 0, bytes);
    return value;
  };
  const bytes = (value: Float32Array | Uint32Array) => new Uint8Array(value.buffer);
  try {
    const field = buffer(
      packIrradianceFieldUniform(
        {
          origin: [-1.5, -1.5, -1.5],
          spacing: 1,
          dimensions: [4, 4, 4],
          probeCount: count,
          levels: 2,
        },
        Array.from(
          { length: 2 },
          () => ({ window: [0, 0, 0], min: [0, 0, 0], max: [4, 4, 4] }) as const,
        ),
      ),
      64,
    );
    expect(field.size).toBe(IRRADIANCE_FIELD_UNIFORM_BYTES);
    const radiance = new Float32Array(count * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
    for (let probe = 0; probe < count; probe++) {
      const value = probe < perLevel ? fineValue : coarseValue;
      for (let texel = 0; texel < IRRADIANCE_FIELD_PROBE_STRIDE; texel++)
        radiance.set([value, value, value, 1], (probe * IRRADIANCE_FIELD_PROBE_STRIDE + texel) * 4);
    }
    const irradiance = buffer(bytes(radiance), 128);
    // Open space: zero variance and depth beyond every receiver/corner segment.
    const momentData = new Float32Array(count * 64 * 2);
    for (let texel = 0; texel < count * 64; texel++) momentData.set([8, 64], texel * 2);
    const moments = buffer(bytes(momentData), 128);
    const stateData = new Uint32Array(count * 4);
    const setState = (fine: number, coarse: number) => {
      for (let probe = 0; probe < count; probe++)
        stateData.set([1, probe < perLevel ? fine : coarse, 0, 0], probe * 4);
    };
    setState(IrradianceFieldProbeState.active, IrradianceFieldProbeState.active);
    const meta = buffer(bytes(stateData), 128);
    const receivers = buffer(
      bytes(new Float32Array(positions.flatMap((z) => [0, 0, z, 1.1]))),
      128,
    );
    const output = device.createBuffer({ size: positions.length * 2 * 16, usage: 128 | 4 });
    const readback = device.createBuffer({ size: output.size, usage: 1 | 8 });
    owned.push(output, readback);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.wgsl }),
        entryPoint: 'verifyFieldSampling',
      },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: receivers } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [field, irradiance, moments, meta].map((value, binding) => ({
          binding,
          resource: { buffer: value },
        })),
      }),
    ];
    const sample = async () => {
      device.queue.writeBuffer(meta, 0, stateData);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      for (const [index, group] of groups.entries()) pass.setBindGroup(index, group);
      pass.dispatchWorkgroups(positions.length);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const values = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return values;
    };
    const blended = await sample();
    result.blended = Array.from(blended);
    for (let receiver = 0; receiver < positions.length; receiver++) {
      const z = positions[receiver];
      if (z === undefined) throw new Error('missing receiver');
      const edge = Math.min(z + 1.5, 1.5 - z, 1.5);
      const fineWeight = edge > 0 ? edge / 2 : 0;
      const expected = fineValue * fineWeight + coarseValue * (1 - fineWeight);
      for (const offset of [receiver * 8, receiver * 8 + 4]) {
        expect(blended[offset]).toBeGreaterThanOrEqual(fineValue - 1e-6);
        expect(blended[offset]).toBeLessThanOrEqual(coarseValue + 1e-6);
        expect(blended[offset]).toBeCloseTo(expected, 5);
        expect(blended[offset + 3]).toBe(1);
      }
    }
    // Kept bright texels are not evidence of a valid publication: every rejected
    // fine state must fall back to the same retained coarse level, not its stale D.
    for (const invalid of [
      IrradianceFieldProbeState.untraced,
      IrradianceFieldProbeState.inside,
      IrradianceFieldProbeState.relocated,
    ]) {
      setState(invalid, IrradianceFieldProbeState.active);
      const values = await sample();
      for (let entry = 0; entry < positions.length * 2; entry++) {
        expect(values[entry * 4]).toBeCloseTo(coarseValue, 5);
        expect(values[entry * 4 + 3]).toBe(1);
      }
      setState(invalid, invalid);
      const absent = Array.from(await sample());
      result.rejected[invalid] = { fallback: Array.from(values), absent };
      expect(absent).toEqual(Array(output.size / 4).fill(0));
    }
    // A valid retained probe may still have a relocation offset. In open space
    // its clamped zero-variance depth must cover the far corner from that actual
    // origin, not just the unrelocated lattice point. Both consumers use it.
    const relocated = 0.375;
    expect(relocated).toBeLessThanOrEqual(IRRADIANCE_FIELD_RELOCATION.limit);
    device.queue.writeBuffer(
      field,
      0,
      packIrradianceFieldUniform(
        {
          origin: [-1.5, -1.5, -1.5],
          spacing: 1,
          dimensions: [4, 4, 4],
          probeCount: perLevel,
          levels: 1,
        },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [4, 4, 4] }],
      ),
    );
    stateData.fill(0);
    // 0x3600 is exactly 0.375 in f16, matching the production meta packing.
    const corner = (1 * 4 + 1) * 4 + 1;
    stateData.set([1, IrradianceFieldProbeState.active, 0x36003600, 0x3600], corner * 4);
    // A nearby dark probe keeps normalization well-conditioned: a tiny
    // floating-point moment variance cannot turn one rejected bright corner
    // into the entire result merely because it is the only nonzero weight.
    const near = (0 * 4 + 1) * 4 + 0;
    stateData.set([1, IrradianceFieldProbeState.active, 0x36003600, 0x3600], near * 4);
    radiance.fill(
      0,
      near * IRRADIANCE_FIELD_PROBE_STRIDE * 4,
      (near + 1) * IRRADIANCE_FIELD_PROBE_STRIDE * 4,
    );
    // This is resolved black, so its support survives in every stored level.
    for (let texel = 0; texel < IRRADIANCE_FIELD_PROBE_STRIDE; texel++)
      radiance[(near * IRRADIANCE_FIELD_PROBE_STRIDE + texel) * 4 + 3] = 1;
    device.queue.writeBuffer(irradiance, 0, radiance);
    const depth = irradianceFieldDepthClamp({ spacing: 1 });
    for (let texel = 0; texel < count * 64; texel++)
      momentData.set([depth, depth * depth], texel * 2);
    device.queue.writeBuffer(moments, 0, momentData);
    device.queue.writeBuffer(
      receivers,
      0,
      new Float32Array(positions.flatMap(() => [-1.45, -1.45, -1.45, 1.1])),
    );
    result.relocatedOpenSpace = Array.from(await sample());
    const expectedCorner = (fineValue * 0.05 ** 2) / (0.05 ** 2 + 0.95 ** 2);
    for (let entry = 0; entry < positions.length * 2; entry++) {
      expect(result.relocatedOpenSpace[entry * 4], 'relocated open-space corner').toBeCloseTo(
        expectedCorner,
        6,
      );
      expect(result.relocatedOpenSpace[entry * 4 + 3]).toBe(1);
    }
    // A classified active probe may have no lit directions yet: non-resident
    // Card hits update its depth/classification while leaving radiance absent.
    // Keep bright bytes behind w=0 to distinguish rejection from resolved black.
    device.queue.writeBuffer(
      field,
      0,
      packIrradianceFieldUniform(
        {
          origin: [-1.5, -1.5, -1.5],
          spacing: 1,
          dimensions: [4, 4, 4],
          probeCount: count,
          levels: 2,
        },
        Array.from(
          { length: 2 },
          () => ({ window: [0, 0, 0], min: [0, 0, 0], max: [4, 4, 4] }) as const,
        ),
      ),
    );
    setState(IrradianceFieldProbeState.active, IrradianceFieldProbeState.active);
    for (let texel = 0; texel < count * 64; texel++) momentData.set([8, 64], texel * 2);
    device.queue.writeBuffer(moments, 0, momentData);
    result.angularSupport = {};
    const supportFailures: string[] = [];
    for (const cone of [0.1, 0.25, 0.4, 0.5, 0.75, 1.05, 1.1]) {
      device.queue.writeBuffer(
        receivers,
        0,
        new Float32Array(positions.flatMap((z) => [0, 0, z, cone])),
      );
      for (const control of [
        'missing',
        'coarse-fallback',
        'true-zero',
        'missing-fine',
        'missing-mip',
        'missing-diffuse',
        'partial-taps',
      ] as const) {
        for (let probe = 0; probe < count; probe++) {
          for (let texel = 0; texel < IRRADIANCE_FIELD_PROBE_STRIDE; texel++) {
            const fine = probe < perLevel;
            const level = texel < 64 ? 'diffuse' : texel < 128 ? 'fine' : 'mip';
            const supported =
              control !== 'missing' &&
              !(
                fine &&
                (control === 'coarse-fallback' ||
                  control === `missing-${level}` ||
                  (control === 'partial-taps' && [59, 123, 141].includes(texel)))
              );
            const value =
              control === 'true-zero' ? 0 : supported ? (fine ? fineValue : coarseValue) : 123;
            radiance.set(
              [value, value, value, Number(supported)],
              (probe * IRRADIANCE_FIELD_PROBE_STRIDE + texel) * 4,
            );
          }
        }
        device.queue.writeBuffer(irradiance, 0, radiance);
        const values = Array.from(await sample());
        result.angularSupport[`${control}-${cone}`] = values;
        for (let entry = 0; entry < positions.length * 2; entry++) {
          const receiver = Math.floor(entry / 2);
          const z = positions[receiver];
          if (z === undefined) throw new Error('missing angular receiver');
          const edge = Math.min(z + 1.5, 1.5 - z, 1.5);
          const alpha = edge > 0 ? edge / 2 : 0;
          const diffuse = entry % 2 === 0;
          const absentFine =
            control === 'coarse-fallback' ||
            (control === 'missing-diffuse' && (diffuse || cone > 0.5)) ||
            (control === 'missing-mip' && !diffuse && cone > 0.25 && cone < 1.05) ||
            (control === 'missing-fine' && !diffuse && cone < 0.5);
          const expected =
            control === 'missing' || control === 'true-zero'
              ? 0
              : absentFine
                ? coarseValue
                : fineValue * alpha + coarseValue * (1 - alpha);
          if (
            !Number.isFinite(values[entry * 4]) ||
            Math.abs((values[entry * 4] ?? NaN) - expected) > 1e-5 ||
            values[entry * 4 + 3] !== Number(control !== 'missing')
          )
            supportFailures.push(
              `${control} cone ${cone}, entry ${entry}: ${values.slice(entry * 4, entry * 4 + 4)}`,
            );
        }
      }
    }
    expect(supportFailures).toEqual([]);
    // The same retained texels remain bright while current TLAS coverage is
    // incomplete. Both diffuse and directional consumers must reject them.
    result.pendingWorld = {};
    for (const pending of [1, 5, 0]) {
      device.queue.writeBuffer(field, IRRADIANCE_FIELD_PENDING_OFFSET, new Uint32Array([pending]));
      const values = Array.from(await sample());
      result.pendingWorld[pending] = values;
      if (pending !== 0) expect(values).toEqual(Array(output.size / 4).fill(0));
      else
        for (let entry = 0; entry < positions.length * 2; entry++)
          expect(values[entry * 4 + 3]).toBe(1);
    }
    expect(errors).toEqual([]);
    result.status = 'pass';
  } catch (cause) {
    result.status = 'fail';
    result.failure = String(cause);
    throw cause;
  } finally {
    const directory = 'artifacts/irradiance-field/dawn';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/sampling-result.json`,
      JSON.stringify(
        {
          result,
          errors,
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          },
        },
        null,
        2,
      ),
    );
    for (const value of owned) value.destroy();
    device.destroy();
  }
}, 120000);
