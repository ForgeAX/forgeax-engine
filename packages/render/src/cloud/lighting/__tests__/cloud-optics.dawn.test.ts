/// <reference types="@webgpu/types" />
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';

const PHASE_SOURCE = `
#import forgeax_cloud::lighting::{cloud_henyey_greenstein, cloud_double_henyey_greenstein}
@group(0) @binding(0) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= arrayLength(&inputs) { return; }
  let p = inputs[id.x];
  outputs[id.x] = vec4f(cloud_henyey_greenstein(p.x, p.w),
    cloud_double_henyey_greenstein(p.x, p.y, p.z, p.w), p.w, p.x);
}`;

const OCTAVE_SOURCE = `
#import forgeax_cloud::lighting::{cloud_optical_octaves}
@group(0) @binding(0) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= arrayLength(&inputs) / 3u { return; }
  let medium = inputs[id.x * 3u];
  let coefficients = inputs[id.x * 3u + 1u];
  let flags = inputs[id.x * 3u + 2u];
  let octaves = cloud_optical_octaves(medium.w, medium.xyz, coefficients.w,
    coefficients.x, coefficients.y, coefficients.z, u32(flags.x), flags.y > 0.5, flags.z > 0.5);
  for (var n = 0u; n < 3u; n += 1u) {
    outputs[id.x * 6u + n * 2u] = vec4f(octaves[n].scatteringPerMeter, octaves[n].extinctionPerMeter);
    outputs[id.x * 6u + n * 2u + 1u] = vec4f(octaves[n].phase, 0.0, 0.0, 0.0);
  }
}`;

async function compile(source: string, id: string) {
  const engine = await loadEngineShaderEntries();
  const result = await compileShader(source, { id, imports: engine.imports });
  if (!result.ok) throw result.error;
  return {
    wgsl: result.value.wgsl,
    sourceDigest: createHash('sha256').update(result.value.wgsl).digest('hex'),
  };
}

it('compiles production optics imports without a GPU', async () => {
  for (const [id, source] of [
    ['phase', PHASE_SOURCE],
    ['octaves', OCTAVE_SOURCE],
  ] as const) {
    const compiled = await compile(source, `cloud-optics-${id}.wgsl`);
    expect(compiled.wgsl).toContain('@compute');
    process.stdout.write(
      `cloud-optics-compile ${JSON.stringify({ id, sourceDigest: compiled.sourceDigest, compiledBytes: compiled.wgsl.length })}\n`,
    );
  }
});

async function readHardware(
  source: string,
  id: string,
  input: Float32Array,
  rows: number,
  outputFloats: number,
) {
  const compiled = await compile(source, id);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware GPU required');
  const timestamp = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: timestamp ? ['timestamp-query'] : [],
  });
  const resources: { destroy(): void }[] = [];
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage });
    resources.push(value);
    return value;
  };
  try {
    const inputBuffer = buffer(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const output = buffer(outputFloats * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(outputFloats * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    device.queue.writeBuffer(inputBuffer, 0, input);
    const module = device.createShaderModule({ code: compiled.wgsl });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const query = timestamp ? device.createQuerySet({ type: 'timestamp', count: 2 }) : undefined;
    if (query) resources.push(query);
    const resolved = query
      ? buffer(16, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC)
      : undefined;
    const timeReadback = query
      ? buffer(16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
      : undefined;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass(
      query
        ? {
            timestampWrites: {
              querySet: query,
              beginningOfPassWriteIndex: 0,
              endOfPassWriteIndex: 1,
            },
          }
        : {},
    );
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputBuffer } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(rows / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputFloats * 4);
    if (query && resolved && timeReadback) {
      encoder.resolveQuerySet(query, 0, 2, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, timeReadback, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    let gpuPassMilliseconds: number | null = null;
    if (timeReadback) {
      await timeReadback.mapAsync(GPUMapMode.READ);
      const times = new BigUint64Array(timeReadback.getMappedRange());
      const begin = times[0];
      const end = times[1];
      if (begin === undefined || end === undefined) throw new Error('Missing GPU timestamps');
      gpuPassMilliseconds = Number(end - begin) / 1e6;
      timeReadback.unmap();
    }
    process.stdout.write(
      `cloud-optics-hardware ${JSON.stringify({
        id,
        sourceDigest: compiled.sourceDigest,
        inputDigest: createHash('sha256').update(new Uint8Array(input.buffer)).digest('hex'),
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
        isFallbackAdapter: adapter.info.isFallbackAdapter,
        rows,
        gpuPassMilliseconds,
        timingScope: 'single compute pass; no summation; excludes copy/compile/readback',
        inputPolicy: 'Float32Array upload; FP64 reference evaluates these exact quantized inputs',
      })}\n`,
    );
    return values;
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
}

// Closed HG formula in FP64. No production CPU helper or stabilized WGSL expression.
function hg(g: number, mu: number): number {
  return (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * mu) ** 1.5);
}

it.skipIf(process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE !== '1')(
  'reads hardware full-angle HG and double lobes against independent FP64 quadrature',
  async () => {
    const lobes = [
      ...[-0.999, -0.7, 0, 0.7, 0.999].map((g) => [g, g, 0]),
      [0.999, -0.7, 0.35],
      [0.7, -0.999, 0.65],
      [0.7, -0.7, 0.5],
    ];
    const samples = 8192;
    const rowsPerLobe = samples * 2 + 3;
    const input = new Float32Array(lobes.length * rowsPerLobe * 4);
    const weights = new Float64Array(rowsPerLobe);
    let maxCosineQuantizationError = 0;
    for (let index = 0; index < samples; index++) {
      const t = (index + 0.5) / samples;
      maxCosineQuantizationError = Math.max(
        maxCosineQuantizationError,
        Math.abs(Math.fround(1 - t ** 4) - (1 - t ** 4)),
      );
      for (let side = 0; side < 2; side++) {
        const row = index * 2 + side;
        weights[row] = (4 * t ** 3) / samples;
        for (const [lobe, authored] of lobes.entries()) {
          input.set(
            [...authored, (side === 0 ? -1 : 1) * (1 - t ** 4)],
            (lobe * rowsPerLobe + row) * 4,
          );
        }
      }
    }
    // Exact forward/backward and perpendicular controls supplement the open quadrature.
    for (const [lobe, authored] of lobes.entries()) {
      for (let point = 0; point < 3; point++) {
        input.set([...authored, point - 1], (lobe * rowsPerLobe + samples * 2 + point) * 4);
      }
    }
    const output = await readHardware(
      PHASE_SOURCE,
      'cloud-optics-phase.wgsl',
      input,
      input.length / 4,
      input.length,
    );
    for (let lobe = 0; lobe < lobes.length; lobe++) {
      let singleIntegral = 0;
      let doubleIntegral = 0;
      let referenceSingleIntegral = 0;
      let referenceDoubleIntegral = 0;
      let maxRelativeError = 0;
      let maxInputEchoError = 0;
      for (let row = 0; row < rowsPerLobe; row++) {
        const offset = (lobe * rowsPerLobe + row) * 4;
        const [g, g2, blend, mu] = Array.from(input.slice(offset, offset + 4)) as [
          number,
          number,
          number,
          number,
        ];
        const expectedSingle = hg(g, mu);
        const expectedDouble = (1 - blend) * expectedSingle + blend * hg(g2, mu);
        for (const [channel, expected] of [
          [0, expectedSingle],
          [1, expectedDouble],
        ] as const) {
          const actual = output[offset + channel] ?? Number.NaN;
          maxRelativeError = Math.max(maxRelativeError, Math.abs(actual / expected - 1));
        }
        maxInputEchoError = Math.max(
          maxInputEchoError,
          Math.abs((output[offset + 2] ?? Number.NaN) - mu),
          Math.abs((output[offset + 3] ?? Number.NaN) - g),
        );
        const weight = (weights[row] ?? Number.NaN) * 2 * Math.PI;
        singleIntegral += (output[offset] ?? Number.NaN) * weight;
        doubleIntegral += (output[offset + 1] ?? Number.NaN) * weight;
        referenceSingleIntegral += expectedSingle * weight;
        referenceDoubleIntegral += expectedDouble * weight;
      }
      process.stdout.write(
        `cloud-optics-phase-error ${JSON.stringify({
          authoredLobes: lobes[lobe],
          quantizedLobes: Array.from(
            input.slice(lobe * rowsPerLobe * 4, lobe * rowsPerLobe * 4 + 3),
          ),
          samplesPerHemisphere: samples,
          maxCosineQuantizationError,
          cosinePolicy: 'mu=+/- (1-t^4), midpoints, rounded to f32 before upload',
          singleIntegral,
          doubleIntegral,
          referenceSingleIntegral,
          referenceDoubleIntegral,
          maxRelativeError,
        })}\n`,
      );
      expect(maxRelativeError).toBeLessThanOrEqual(0.01);
      expect(maxInputEchoError).toBe(0);
      for (const integral of [
        singleIntegral,
        doubleIntegral,
        referenceSingleIntegral,
        referenceDoubleIntegral,
      ]) {
        expect(Math.abs(integral - 1)).toBeLessThanOrEqual(0.01);
      }
    }
  },
);

function referenceOctaveCoefficients(p: readonly number[]): number[] {
  const sigma = p[3] ?? Number.NaN;
  const phase = p[7] ?? Number.NaN;
  const octaves = p[8] ?? Number.NaN;
  const gray = p[9] === 1;
  const contributionInput = p[4] ?? Number.NaN;
  const contribution = Math.max(
    0,
    p[10] === 1 ? Math.min(1, contributionInput) : contributionInput,
  );
  const occlusion = Math.min(1, Math.max(0, p[5] ?? Number.NaN));
  const eccentricity = Math.min(1, Math.max(0, p[6] ?? Number.NaN));
  const expected: number[] = [];
  for (let n = 0; n < 3; n++) {
    const exponent = 2 ** n - 1;
    const active = n <= octaves;
    for (let channel = 0; channel < 3; channel++) {
      expected.push(
        active ? sigma * (p[gray ? 0 : channel] ?? Number.NaN) * contribution ** exponent : 0,
      );
    }
    expected.push(active ? sigma * occlusion ** exponent : 0);
    expected.push(
      active
        ? n === 0
          ? phase
          : (1 - eccentricity ** (2 ** (n - 1))) / (4 * Math.PI) +
            phase * eccentricity ** (2 ** (n - 1))
        : 0,
      0,
      0,
      0,
    );
  }
  return expected;
}

it.skipIf(process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE !== '1')(
  'reads hardware MS coefficient matrix with independent exponent references and no-MS controls',
  async () => {
    const cases: number[][] = [];
    for (const octaves of [0, 1, 2]) {
      for (const gray of [0, 1]) {
        for (const clamp of [0, 1]) {
          for (const coefficients of [
            [0.5, 0.4, 0.3],
            [2, 1.2, 1.3],
            [-0.5, -0.2, -0.3],
          ]) {
            cases.push([0.8, 0.4, 0.2, 0.25, ...coefficients, 0.3, octaves, gray, clamp, 0]);
          }
        }
      }
    }
    const input = new Float32Array(cases.flat());
    const output = await readHardware(
      OCTAVE_SOURCE,
      'cloud-optics-octaves.wgsl',
      input,
      cases.length,
      cases.length * 24,
    );
    let maxRelativeError = 0;
    for (let row = 0; row < cases.length; row++) {
      const p = Array.from(input.slice(row * 12, row * 12 + 12));
      const expected = referenceOctaveCoefficients(p);
      const actual = Array.from(output.slice(row * 24, row * 24 + 24));
      for (let channel = 0; channel < expected.length; channel++) {
        const value = actual[channel] ?? Number.NaN;
        const target = expected[channel] ?? Number.NaN;
        expect(Number.isFinite(value)).toBe(true);
        if (target === 0) expect(value).toBe(0);
        else maxRelativeError = Math.max(maxRelativeError, Math.abs(value / target - 1));
      }
      // Matched n=0 row is the no-MS control for every gray/clamp/coefficient tuple.
      const control = row % 12;
      expect(actual.slice(0, 8)).toEqual(Array.from(output.slice(control * 24, control * 24 + 8)));
      process.stdout.write(
        `cloud-optics-ms-case ${JSON.stringify({
          row,
          quantizedInput: p,
          expected,
          actual,
          noMsControlRow: control,
        })}\n`,
      );
    }
    process.stdout.write(
      `cloud-optics-ms-error ${JSON.stringify({
        cases: cases.length,
        maxRelativeError,
        coefficientRelativeTolerance: 1e-5,
        reference: 'scattering/extinction exponent 2^n-1; phase exponent 2^(n-1); n=0 is base',
        transportScope:
          'Coefficient kernel only. Physical T and Cooked L/T remain owned by cloud-uniform-lighting.dawn.test.ts; extra-octave extinction must not attenuate view T.',
      })}\n`,
    );
    expect(maxRelativeError).toBeLessThanOrEqual(1e-5);
  },
);
