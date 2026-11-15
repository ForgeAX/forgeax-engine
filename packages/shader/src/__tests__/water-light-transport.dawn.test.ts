import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('SLW transports the selected scene through independent view and light paths', async () => {
  const source = readFileSync(new URL('../single-layer-water.wgsl', import.meta.url), 'utf8');
  const color = source.slice(source.indexOf('fn waterColor('));
  const mediumStart = color.indexOf('\n', color.indexOf('if (distorted.valid)')) + 1;
  const medium = color.slice(mediumStart, color.indexOf('  let g =', mediumStart));
  const transmissionStart = color.indexOf('  let colorScale =');
  const transmission = color.slice(
    transmissionStart,
    color.indexOf('  let baseMaterialCoverageOverWater', transmissionStart),
  );
  const brdfStart = source.indexOf('fn waterEnvBrdf(');
  const brdf = source.slice(brdfStart, source.indexOf('struct WaterColorOutput', brdfStart));
  const worldStart = source.indexOf('fn waterWorld(');
  const world = source.slice(worldStart, source.indexOf('fn waterViewDepth(', worldStart));
  const deviceStart = source.indexOf('fn waterDeviceDepth(');
  const deviceDepth =
    deviceStart < 0 ? '' : source.slice(deviceStart, source.indexOf('\n}', deviceStart) + 2);
  expect(medium.length).toBeGreaterThan(100);
  expect(transmission.length).toBeGreaterThan(100);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Water transport regression requires Dawn');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const output = device.createBuffer({
    size: 192,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 192,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const lut = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: lut },
    new Uint8Array([153, 51, 0, 255]),
    { bytesPerRow: 4 },
    [1, 1],
  );
  try {
    const module = device.createShaderModule({
      code: `
struct View { inverseViewProj: mat4x4<f32>, temporalProjection: vec4<f32> }
struct Surface { maxDistanceMeters: f32, scattering: vec3<f32>, absorption: vec3<f32>, colorScaleBehindWater: vec3<f32> }
struct Behind { color: vec3<f32>, depthM: f32 }
struct Input { positionWS: vec3<f32> }
var<private> view: View;
@group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@group(0) @binding(1) var mediumBrdfLut: texture_2d<f32>;
@group(0) @binding(2) var mediumPrefilterSampler: sampler;
${world}
${deviceDepth}
${brdf}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let orthographic = id.x >= 2u;
  let a = 0.1 / 99.9;
  let b = 10.0 / 99.9;
  view.temporalProjection = vec4<f32>(0.1, 100.0, select(0.0, 1.0, orthographic), 0.0);
  view.inverseViewProj = mat4x4<f32>(vec4<f32>(1.0, 0.0, 0.0, 0.0), vec4<f32>(0.0, 1.0, 0.0, 0.0),
    vec4<f32>(0.0, 5.0 / b, 0.0, 1.0 / b), vec4<f32>(0.0, 5.0 * a / b, -1.0, a / b));
  if (orthographic) {
    view.inverseViewProj = mat4x4<f32>(vec4<f32>(1.0, 0.0, 0.0, 0.0), vec4<f32>(0.0, 1.0, 0.0, 0.0),
      vec4<f32>(0.0, 0.0, 99.9, 0.0), vec4<f32>(0.0, 5.0, -100.0, 1.0));
  }
  let frontFacing = id.x % 2u == 0u;
  let surface = Surface(100.0, vec3<f32>(0.05), vec3<f32>(1.25, 0.083333, 0.035714), vec3<f32>(0.8, 0.9, 1.0));
  let behind = Behind(vec3<f32>(2.0, 3.0, 4.0), 8.0);
  let input = Input(vec3<f32>(0.0, 6.0, 0.0));
  let uv = vec2<f32>(0.25, 0.625);
  let surfaceDepthM = 2.0;
${medium}
  let envBrdf = waterEnvBrdf(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), 1.3099384, 0.1);
  let scattered = vec3<f32>(0.1, 0.2, 0.3);
${transmission}
  result[id.x * 3u] = vec4<f32>(transmittance, distanceM);
  result[id.x * 3u + 1u] = vec4<f32>(transmission, envBrdf);
  result[id.x * 3u + 2u] = vec4<f32>(volume, 1.0);
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: output } },
        { binding: 1, resource: lut.createView() },
        { binding: 2, resource: device.createSampler() },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(4);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 192);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    const ior = Math.fround(1.3099384);
    const f0 = ((ior - 1) / (ior + 1)) ** 2;
    const expectedBrdf = f0 * 0.6 + Math.min(1, 50 * f0) * 0.2;
    for (let sample = 0; sample < 4; sample++) {
      const lightDistance = sample >= 2 ? 1.25 : 3;
      expect.soft(actual[sample * 12 + 3], `view distance ${sample}`).toBeCloseTo(6, 5);
      expect.soft(actual[sample * 12 + 7], `EnvBRDF ${sample}`).toBeCloseTo(expectedBrdf, 5);
      for (let channel = 0; channel < 3; channel++) {
        const extinction = [1.3, 0.133333, 0.085714][channel] ?? 0;
        const viewTransmission = Math.exp(-6 * extinction);
        const expectedTransmission =
          viewTransmission *
          Math.exp(-lightDistance * extinction) *
          ([2, 3, 4][channel] ?? 0) *
          ([0.8, 0.9, 1][channel] ?? 0);
        expect
          .soft(actual[sample * 12 + channel], `view transmission ${sample}/${channel}`)
          .toBeCloseTo(viewTransmission, 5);
        expect
          .soft(actual[sample * 12 + 4 + channel], `light transmission ${sample}/${channel}`)
          .toBeCloseTo(expectedTransmission, 5);
        expect
          .soft(actual[sample * 12 + 8 + channel], `volume ${sample}/${channel}`)
          .toBeCloseTo((channel + 1) * 0.1 * (1 - expectedBrdf) + expectedTransmission, 5);
      }
    }
    expect(errors).toEqual([]);
    readback.unmap();
  } finally {
    lut.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
