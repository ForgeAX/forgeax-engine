import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';

async function assertRadianceAtlas(displaced: boolean) {
  const builtin = await loadEngineShaderEntries();
  // The stage and the coverage witness consume the same source in this checkout.
  const imports = {
    ...builtin.imports,
    'forgeax_ray::irradiance_field_sample': await readFile(
      new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
      'utf8',
    ),
  };
  const atlas = builtin.rayScreenProbeAtlas;
  const source = await readFile(
    new URL('../../../../shader/src/ray-screen-probe-atlas.wgsl', import.meta.url),
    'utf8',
  );
  const defines = { IRRADIANCE_FIELD_VISIBILITY: true, IRRADIANCE_FIELD_RADIANCE_ATLAS: true };
  const pack = (
    await compileShader(source, {
      id: atlas.id,
      imports,
      defines,
      computeEntry: 'packRadianceAtlas',
    })
  ).unwrap();
  const sampled = (
    await compileShader(
      `
#import forgeax_ray::irradiance_field_sample::{irradianceFieldCone, irradianceFieldLevel, irradianceFieldAtlasSample, screenRadianceCoverage, screenRadianceCoverageFromTrace, sampleScreenRadianceCache}
@group(0) @binding(0) var<storage, read> directions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn readCones(@builtin(global_invocation_id) gid: vec3u) {
  let input = directions[gid.x];
  let direction = normalize(input.xyz);
  let probe = u32(input.w);
  result[gid.x * 4u] = irradianceFieldLevel(probe, 64u, 8u, direction);
  result[gid.x * 4u + 1u] = irradianceFieldCone(probe, direction, 0.25);
  result[gid.x * 4u + 2u] = irradianceFieldAtlasSample(probe, direction);
  let position = select(vec3f(0.5), vec3f(20.0), probe == 5u);
  let coverage = screenRadianceCoverage(position);
  let light = sampleScreenRadianceCache(coverage, position, direction);
  let retained = screenRadianceCoverageFromTrace(position, coverage.level, coverage.traceDistance);
  let reused = sampleScreenRadianceCache(retained, position, direction);
  let invalid = screenRadianceCoverageFromTrace(position, 4u, max(coverage.traceDistance, 1.0));
  let equivalent = all(bitcast<vec4u>(light) == bitcast<vec4u>(reused)) &&
    invalid.traceDistance == 0.0;
  result[gid.x * 4u + 3u] = vec4f(coverage.traceDistance, f32(coverage.level), light.r, select(-2.0, light.w, equivalent));
}
`,
      { id: 'irradiance-field-atlas-witness', imports, defines },
    )
  ).unwrap();

  const probes = 16;
  const field = new Float32Array(probes * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
  const fillFieldRadiance = () => {
    for (let p = 0; p < probes; p++) {
      for (let i = 0; i < 64; i++) {
        const x = i % 8;
        const y = i >>> 3;
        const sample =
          p === 0
            ? [x * 0.25 - 0.875, y * 0.5, (x + y + 2) * 0.125, 1]
            : p === 1
              ? [0, 0, 0, 1]
              : p === 2
                ? [99, 33, 51, 0]
                : p === 3
                  ? [21, 4, 2, i === 0 ? 1 : 0]
                  : p === 4
                    ? [100_000, 1, 3, 1]
                    : [3, 17, 5, 1];
        field.set(sample, (p * IRRADIANCE_FIELD_PROBE_STRIDE + 64 + i) * 4);
      }
    }
  };
  fillFieldRadiance();
  const directions = [
    [1, 1e-6, -1],
    [1, -1e-6, -1],
    [1e-6, 1, -1],
    [-1e-6, 1, -1],
    [1e-6, 1e-6, -1],
    [-1e-6, -1e-6, -1],
    [0.23, 0.49, 1],
    [-0.93, -0.81, -1],
  ].flatMap((d) => Array.from({ length: 6 }, (_, probe) => [...d, probe]));
  const uniforms = new Uint32Array(64);
  const fieldFloats = new Float32Array(uniforms.buffer);
  fieldFloats[3] = 1;
  fieldFloats[19] = Math.sqrt(3);
  uniforms.set([2, 2, 2, probes], 4);
  uniforms.set([2, 8], 12);
  new Int32Array(uniforms.buffer).set([2, 2, 2, 0, 2, 2, 2, 0], 48);
  const states = new Uint32Array(probes * 4);
  for (let probe = 0; probe < probes; probe++) states[probe * 4 + 1] = 1;
  // Legacy x offset of one quarter of a probe cell, packed as f16.
  if (displaced) states[8 * 4 + 2] = 0x3400;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('The radiance atlas comparison needs an actual adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const makeBuffer = (size: number, usage: number) => {
    const buf = device.createBuffer({ size, usage });
    owned.push(buf);
    return buf;
  };
  const texture = device.createTexture({ size: [44, 80], format: 'rgba16float', usage: 4 | 8 });
  const view = texture.createView();
  try {
    const probeData = makeBuffer(field.byteLength, 128 | 8);
    const farData = makeBuffer(field.byteLength, 128 | 8);
    const farRadiance = field.slice();
    for (let probe = 8; probe < probes; probe++) {
      for (let i = 0; i < 64; i++)
        farRadiance.set([8, 6, 4, 1], (probe * IRRADIANCE_FIELD_PROBE_STRIDE + 64 + i) * 4);
    }
    device.queue.writeBuffer(farData, 0, farRadiance);
    const probeField = makeBuffer(uniforms.byteLength, 64 | 8);
    const farField = makeBuffer(uniforms.byteLength, 64 | 8);
    const farUniforms = uniforms.slice();
    farUniforms[15] = 2;
    device.queue.writeBuffer(farField, 0, farUniforms);
    const meta = makeBuffer(states.byteLength, 128 | 8);
    device.queue.writeBuffer(meta, 0, states);
    const directionData = new Float32Array(directions.flat());
    const directionBuffer = makeBuffer(directionData.byteLength, 128 | 8);
    const output = makeBuffer(directions.length * 64, 128 | 4);
    const readback = makeBuffer(output.size, 1 | 8);
    device.queue.writeBuffer(probeData, 0, field);
    device.queue.writeBuffer(probeField, 0, uniforms);
    device.queue.writeBuffer(directionBuffer, 0, directionData);
    const packPipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: pack.wgsl }),
        entryPoint: 'packRadianceAtlas',
      },
    });
    const samplePipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: sampled.wgsl }),
        entryPoint: 'readCones',
      },
    });
    const group = (pipeline: GPUComputePipeline, index: number, entries: GPUBindGroupEntry[]) =>
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries });
    const irradiance = { binding: 1, resource: { buffer: probeData } };
    const encoder = device.createCommandEncoder();
    const writer = encoder.beginComputePass();
    writer.setPipeline(packPipeline);
    writer.setBindGroup(0, group(packPipeline, 0, [{ binding: 36, resource: view }]));
    const packDomain = (fieldBuffer: GPUBuffer, data: GPUBuffer) =>
      group(packPipeline, 1, [
        { binding: 0, resource: { buffer: fieldBuffer } },
        { binding: 1, resource: { buffer: data } },
        { binding: 3, resource: { buffer: meta } },
      ]);
    writer.setBindGroup(1, packDomain(probeField, probeData));
    writer.dispatchWorkgroups(probes);
    writer.setBindGroup(1, packDomain(farField, farData));
    writer.dispatchWorkgroups(probes);
    writer.end();
    const reader = encoder.beginComputePass();
    reader.setPipeline(samplePipeline);
    reader.setBindGroup(
      0,
      group(samplePipeline, 0, [
        { binding: 0, resource: { buffer: directionBuffer } },
        { binding: 1, resource: { buffer: output } },
        { binding: 37, resource: view },
        {
          binding: 38,
          resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
        },
      ]),
    );
    reader.setBindGroup(
      1,
      group(samplePipeline, 1, [{ binding: 0, resource: { buffer: probeField } }, irradiance]),
    );
    reader.dispatchWorkgroups(directions.length);
    reader.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    let atlasSamples = 0;
    let sparseSupport = 0;
    for (let i = 0; i < directions.length; i++) {
      const probe = directions[i]?.[3];
      const offset = i * 16;
      const baseline = Array.from(values.subarray(offset, offset + 4));
      const atlasCone = Array.from(values.subarray(offset + 4, offset + 8));
      const rawAtlas = Array.from(values.subarray(offset + 8, offset + 12));
      expect(atlasCone[3], `support at row ${i}`).toBe(baseline[3]);
      if (probe === 0) {
        expect(rawAtlas[3]).toBe(1);
        for (let c = 0; c < 3; c++)
          expect(Math.abs((atlasCone[c] ?? NaN) - (baseline[c] ?? NaN))).toBeLessThan(0.008);
        atlasSamples++;
      } else {
        expect(atlasCone, `light at row ${i}`).toEqual(baseline);
      }
      if (probe === 1) expect(atlasCone).toEqual([0, 0, 0, 1]);
      if (probe === 2 || probe === 4) expect(rawAtlas[3]).toBe(0);
      if (probe === 3 && baseline[3] === 1) sparseSupport++;
      const handoff = Array.from(values.subarray(offset + 12, offset + 16));
      if (probe === 5) {
        expect(rawAtlas).toEqual([3, 17, 5, 1]);
        expect(handoff).toEqual([0, 0, 0, 0]);
      } else if (displaced) {
        expect(handoff).toEqual([0, 0, 0, 0]);
      } else {
        // Incomplete fine cells require real coarse coverage.
        expect(handoff[0]).toBeCloseTo(4 * Math.sqrt(3), 5);
        expect(handoff[1]).toBe(1);
        expect(handoff[2]).toBeGreaterThan(5);
        expect(handoff[2]).toBeLessThan(11);
        expect(handoff[3]).toBe(1);
      }
    }
    expect(atlasSamples).toBe(8);
    expect(sparseSupport).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    texture.destroy();
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
}

it('matches the buffer cone across atlas seams and keeps unsupported light distinct from black', () =>
  assertRadianceAtlas(false));

it('rejects a displaced far radiance slot until it is retraced on the lattice', () =>
  assertRadianceAtlas(true));
