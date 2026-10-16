import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';

it('samples the production reflection pyramid at roughness squared LOD with confidence weighting', async ({
  annotate,
}) => {
  const source = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/ssr-compose.wgsl'),
    'utf8',
  );
  const start = source.indexOf('fn ssrReflectionLod(');
  const end = source.indexOf('fn ssrPackedReceiverWeight(', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const temporalSource = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/ssr-temporal.wgsl'),
    'utf8',
  );
  const temporalStart = temporalSource.indexOf('fn resolveSsrTemporal(');
  const temporalEnd = temporalSource.indexOf('\n}\n', temporalStart) + 3;
  expect(temporalStart).toBeGreaterThan(0);
  expect(temporalEnd).toBeGreaterThan(temporalStart);
  const temporalHelpers = temporalSource.slice(
    temporalSource.indexOf('fn isFinite('),
    temporalSource.indexOf('fn finitePositive('),
  );
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      mipLevelCount: 3,
      // Match the production HDR pyramid, including the filtering precision.
      format: 'rgba16float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const output = device
    .createBuffer({ size: 160, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 160, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  try {
    // Distinct levels falsify accidental mip-zero-only sampling. The middle
    // level has zero confidence and must not introduce its green radiance.
    for (let level = 0; level < 3; level++) {
      const size = 4 >> level;
      const color = [
        [0x3c00, 0, 0, 0x3c00],
        // Zero-confidence presentation texels carry no RGB payload.
        [0, 0, 0, 0],
        [0, 0, 0x3c00, 0x3c00],
      ][level];
      if (color === undefined) throw new Error('Missing mip fixture color');
      const data = new Uint16Array(size * size * 4);
      for (let pixel = 0; pixel < size * size; pixel++) data.set(color, pixel * 4);
      device.queue
        .writeTexture(
          { texture, mipLevel: level, origin: [0, 0, 0] },
          data,
          { offset: 0, bytesPerRow: size * 8, rowsPerImage: size },
          { width: size, height: size, depthOrArrayLayers: 1 },
        )
        .unwrap();
    }
    const module = createShaderModuleImmediate(device, {
      code: `
@group(0) @binding(0) var radiance: texture_2d<f32>;
@group(0) @binding(1) var radianceSampler: sampler;
@group(0) @binding(2) var<storage, read_write> result: array<vec4<f32>>;
${source.slice(start, end)}
struct ProbeParams { historyValid: u32, maxHistoryWeight: f32 };
const params = ProbeParams(1u, 0.9);
${temporalHelpers}
${temporalSource.slice(temporalStart, temporalEnd)}
@compute @workgroup_size(1) fn probe() {
  result[0] = sampleRoughSsr(vec2<f32>(0.5), 0.0);
  result[1] = sampleRoughSsr(vec2<f32>(0.5), 0.5);
  result[2] = sampleRoughSsr(vec2<f32>(0.5), 1.0);
  result[3] = sampleRoughSsr(vec2<f32>(0.5), sqrt(0.75));
  // Miss -> hit must not mix black history; hit -> miss decays confidence
  // without darkening radiance; disocclusion rejects that carry immediately.
  let red = vec4<f32>(1.0, 0.0, 0.0, 1.0);
  let empty = vec4<f32>(0.0);
  result[4] = resolveSsrTemporal(red, empty, 0.0, false, vec3<f32>(0), vec3<f32>(1), true, true, true, empty);
  result[5] = resolveSsrTemporal(empty, red, 1.0, false, vec3<f32>(0), vec3<f32>(0), true, true, true, empty);
  result[6] = resolveSsrTemporal(empty, red, 1.0, false, vec3<f32>(0), vec3<f32>(0), true, false, true, empty);
  // A steady fractional thin hit retains its confidence and radiance.
  result[8] = resolveSsrTemporal(vec4<f32>(1.0, 0.0, 0.0, 0.1), red, 0.1, false, vec3<f32>(0), vec3<f32>(1), true, true, true, empty);
  result[7] = resolveSsrTemporal(red, empty, 1.0, false, vec3<f32>(0), vec3<f32>(1), true, true, true, empty);
  // An analytic thin source covers 10% on alternate jitter phases. Its
  // steady cycle-average energy is 5%, not a long run of absent sources.
  var thin = vec4<f32>(1.0, 0.0, 0.0, 0.05);
  var mass = 0.0;
  for (var phase = 0u; phase < 256u; phase++) {
    let current = select(vec4<f32>(1.0, 0.0, 0.0, 0.1), empty, phase % 2u == 1u);
    thin = resolveSsrTemporal(current, thin, thin.a, phase % 2u == 0u, vec3<f32>(0), vec3<f32>(1), true, true, true, empty);
    if (phase >= 248u) { mass += thin.r * thin.a; }
  }
  result[9] = vec4<f32>(mass / 8.0);

}`,
    }).unwrap();
    const groupLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'float', viewDimension: '2d' },
          },
          { binding: 1, visibility: GPU_SHADER_STAGE_COMPUTE, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [groupLayout] }).unwrap();
    const pipeline = device
      .createComputePipeline({ layout, compute: { module, entryPoint: 'probe' } })
      .unwrap();
    const view = device.createTextureView(texture, { baseMipLevel: 0, mipLevelCount: 3 }).unwrap();
    const sampler = device
      .createSampler({
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'linear',
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout: groupLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: view } },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 160);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = [...new Float32Array(mapped.getMappedRange().unwrap().slice(0))];
    mapped.unmap();
    await annotate('SSR thin-source energy', {
      contentType: 'application/json',
      bodyEncoding: 'utf-8',
      body: JSON.stringify({
        probe: 'roughness-mip-and-transient-miss',
        values,
        thinEnergyReference: 0.05,
        thinEnergyTolerance: 0.005,
      }),
    });
    const expected = [
      // sampleRoughSsr exposes the premultiplied presentation value; the
      // production fragment unpremultiplies once before material blending.
      1, 0, 0, 1, 0.5, 0, 0, 0.5, 0, 0, 1, 1, 0, 0, 0.5, 0.5, 1, 0, 0, 1, 1, 0, 0, 0.9, 0, 0, 0, 0,
      0.1, 0, 0, 1, 1, 0, 0, 0.1,
    ];
    for (const [i, value] of expected.entries()) expect(values[i]).toBeCloseTo(value, 5);
    expect(values[36], 'thin reflection preserves its analytic cycle-average energy').toBeCloseTo(
      0.05,
      2,
    );
  } finally {
    device.destroyTexture(texture).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
