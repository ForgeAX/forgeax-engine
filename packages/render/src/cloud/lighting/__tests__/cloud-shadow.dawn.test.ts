/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { VIEW_UNIFORM_BYTES } from '../../../record/view-ubo';
import { cloudRendererProgram } from '../../authoring/renderer-program';
import { cookedCloudShadowProjection } from '../shadow';
import { cloudShadowSpatialLayout } from '../shadow-spatial-layout';

it('reads actual shadow WGSL encoding, secondary integration and distinct octave attenuation', async () => {
  const engine = await loadEngineShaderEntries();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No Dawn GPU adapter');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1') {
    expect(adapter.info.isFallbackAdapter).toBe(false);
    expect(adapter.info.vendor).not.toBe('');
    process.stdout.write(
      `cloud-shadow-device ${JSON.stringify({
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        isFallbackAdapter: adapter.info.isFallbackAdapter,
      })}\n`,
    );
  }
  const device = await adapter.requestDevice();
  const directMap = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const compiled = await compileShader(
      `
      #import forgeax_cloud::shadow::{cloud_bsm_trace_interval, cloud_shadow_accumulate, cloud_shadow_finish, cloud_shadow_optical_depth, cloud_shadow_segment, cloud_shadow_ray_octave_tau, cloud_shadow_map_octave_tau}
      #import forgeax_cloud::lighting::{cloud_henyey_greenstein}
      #import forgeax_cloud::layer::{cloud_direct_solar_factor}
      @group(0) @binding(0) var<storage, read_write> output: array<f32>;
      @compute @workgroup_size(1) fn main() {
        var acc = vec4f(200.0, 0.0, 0.0, 0.0);
        var tau = 0.0;
        for (var i = 0u; i < 10u; i++) {
          let distance = 100.0 + (f32(i) + 0.5) * 10.0;
          let sigma = select(vec3f(0.0), vec3f(0.03, 0.06, 0.0), distance >= 130.0 && distance < 170.0);
          acc = cloud_shadow_accumulate(acc, distance, sigma);
        }
        let encoded = cloud_shadow_finish(acc, 200.0, 10.0, 0.5, 2.0);
        output[0] = encoded.x; output[1] = encoded.y; output[2] = encoded.z;
        output[3] = cloud_shadow_optical_depth(encoded, 157.0);
        output[4] = cloud_shadow_optical_depth(encoded, 1000.0);
        for (var i = 0u; i < 4u; i++) {
          let segment = cloud_shadow_segment(i, 4u, 100.0);
          tau += segment.x * 0.0004 * segment.y;
        }
        output[5] = exp(-tau);
        output[6] = exp(-cloud_shadow_ray_octave_tau(2.0, 0.5, 2u));
        output[7] = exp(-cloud_shadow_map_octave_tau(2.0, 0.5, 2u));
        var integral = 0.0;
        for (var i = 0u; i < 4096u; i++) {
          let t = (f32(i) + 0.5) / 4096.0;
          let mu = 1.0 - 2.0 * t * t * t * t;
          integral += cloud_henyey_greenstein(0.8, mu) * 8.0 * t * t * t;
        }
        output[8] = integral * 6.28318530718 / 4096.0;
        let skipped = cloud_bsm_trace_interval(vec3f(0.0,6360000.0,0.0),vec3f(1.0,0.0,0.0),6360000.0,5000.0,10000.0);
        output[9] = skipped.x; output[10] = skipped.y;
        let origin = vec4f(0.0);
        let right = vec3f(1.0, 0.0, 0.0);
        let up = vec3f(0.0, 1.0, 0.0);
        let receiver = vec3f(0.0, 0.0, -503.0);
        output[11] = cloud_direct_solar_factor(receiver, origin, right, up, vec4f(100.0, 1.0, 0.0, 0.0));
        output[12] = cloud_direct_solar_factor(receiver, origin, right, up, vec4f(100.0, 1.0, 0.0, 1.0));
        output[13] = cloud_direct_solar_factor(receiver, origin, right, up, vec4f(100.0, 0.0, 0.0, 0.0));
        output[14] = cloud_direct_solar_factor(receiver, origin, right, up, vec4f(100.0, 1.0, 1.0, 1.0));
        output[15] = cloud_direct_solar_factor(vec3f(100.0, 0.0, -1.5), origin, right, up, vec4f(100.0, 1.0, 0.0, 1.0));
      }`,
      { id: 'cloud-shadow-kernel-test.wgsl', imports: engine.imports },
    );
    if (!compiled.ok) throw compiled.error;
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    device.queue.writeTexture(
      { texture: directMap },
      new Uint8Array([128, 64, 192, 255]),
      {},
      [1, 1],
    );
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: output } },
          { binding: 16, resource: directMap.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 64);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const expected = [
      0.137,
      0.015,
      0.6,
      0.3,
      0.6,
      Math.exp(-2),
      Math.exp(-0.25),
      Math.exp(-0.5),
      1,
      0,
      0,
      128 / 255,
      Math.exp((-64 / 255) * (503 - (128 / 255) * 1000)),
      1,
      1,
      1,
    ];
    for (let index = 0; index < expected.length; index++) {
      expect(
        Math.abs((values[index] ?? Number.NaN) - (expected[index] ?? Number.NaN)),
      ).toBeLessThan(index === 8 ? 0.01 : 1e-4);
    }
  } finally {
    readback.destroy();
    output.destroy();
    directMap.destroy();
    device.destroy();
  }
});

it('renders the production 2x2 BSM filter in encoding space with empty texels', async () => {
  const engine = await loadEngineShaderEntries();
  const compiled = await compileShader(engine.cloudShadowFilter.source, {
    id: 'cloud-shadow-filter-test.wgsl',
    imports: engine.imports,
  });
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No Dawn GPU adapter');
  const device = await adapter.requestDevice();
  const raw = device.createTexture({
    size: [2, 2],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const filtered = device.createTexture({
    size: [1, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
    });
    device.queue.writeTexture(
      { texture: raw },
      new Float32Array([10, 0.1, 4, 1, 20, 0.2, 8, 1, 30, 0.3, 12, 1, 100, 0, 0, 1]),
      { bytesPerRow: 32 },
      [2, 2],
    );
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: filtered.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      1,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: raw.createView() }],
      }),
    );
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: filtered },
      { buffer: readback, bytesPerRow: 256 },
      [1, 1],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice(0, 4);
    readback.unmap();
    expect(values[0]).toBe(40);
    expect(values[1]).toBeCloseTo(0.15, 6);
    expect(values[2]).toBe(6);
    expect(values[3]).toBe(1);
    expect(
      Math.exp(-Math.min(values[2] ?? 0, (values[1] ?? 0) * ((40.02 - (values[0] ?? 0)) * 1000))),
    ).toBeCloseTo(Math.exp(-3), 6);
  } finally {
    readback.destroy();
    filtered.destroy();
    raw.destroy();
    device.destroy();
  }
});

it('renders cooked shadow columns with fractional midpoints independently of camera entry limits', async () => {
  const engine = await loadEngineShaderEntries();
  const map = cookedCloudShadowProjection(
    {
      directionToLight: [Math.sqrt(1 - 0.01 ** 2), 0.01, 0],
      extentMeters: 40_000,
      depthMeters: 350_000,
      resolution: 128,
      mapSamples: 64,
      mode: 1,
      cast: true,
      biasMeters: 0,
      strength: 1,
      surfaceStrength: 1,
    },
    5000,
    10_000,
  );
  const program = cloudRendererProgram(
    `
fn evaluateCloudMedium(context: CloudMediumContext, parameters: CloudParameters) -> CloudMediumSample {
  return CloudMediumSample(0.000001, vec3f(0.0), vec3f(0.0), 1.0);
}`,
    {},
    {},
  );
  // Exercise the unchanged production camera interval alongside actual fs_shadow.
  const compiled = await compileShader(
    `${program}
@group(2) @binding(0) var<storage, read_write> cameraInterval: array<f32>;
@compute @workgroup_size(1) fn camera_probe() {
  let interval = renderer_interval(vec3f(0.0), vec3f(0.0,1.0,0.0), 200000.0);
  cameraInterval[0] = interval.x; cameraInterval[1] = interval.y;
}`,
    { id: 'cloud-shadow-coverage-test.wgsl', imports: engine.imports },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No Dawn GPU adapter');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1')
    expect(adapter.info.isFallbackAdapter).toBe(false);
  const device = await adapter.requestDevice();
  const resources: { destroy(): void }[] = [];
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage });
    resources.push(value);
    return value;
  };
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_shadow', targets: [{ format: 'rgba32float' }] },
    });
    const cameraPipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'camera_probe' },
    });
    const view = buffer(VIEW_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const uniform = buffer(256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const camera = buffer(8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(2304, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const texture = device.createTexture({
      size: [8, 8],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    resources.push(texture);
    const params = new Float32Array(64);
    params.set([5000, 10000, 1, 200000], 0);
    params[11] = -1;
    params.set(map.origin, 24);
    params.set(
      map.right.map((value) => (value * map.extentMeters) / 2),
      28,
    );
    params.set(
      map.up.map((value) => (value * map.extentMeters) / 2),
      32,
    );
    params.set(
      map.directionToLight.map((value) => -value),
      36,
    );
    params[39] = map.depthMeters;
    const sampleBudget = 64.4;
    params.set([sampleBudget, 1, 0, 1], 40);
    device.queue.writeBuffer(uniform, 0, params);
    const bindUniform = (layout: GPUBindGroupLayout) =>
      device.createBindGroup({ layout, entries: [{ binding: 2, resource: { buffer: uniform } }] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: view } }],
      }),
    );
    pass.setBindGroup(1, bindUniform(pipeline.getBindGroupLayout(1)));
    pass.draw(3);
    pass.end();
    const compute = encoder.beginComputePass();
    compute.setPipeline(cameraPipeline);
    compute.setBindGroup(1, bindUniform(cameraPipeline.getBindGroupLayout(1)));
    compute.setBindGroup(
      2,
      device.createBindGroup({
        layout: cameraPipeline.getBindGroupLayout(2),
        entries: [{ binding: 0, resource: { buffer: camera } }],
      }),
    );
    compute.dispatchWorkgroups(1);
    compute.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [8, 8]);
    encoder.copyBufferToBuffer(camera, 0, readback, 2048, 8);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect([...values.slice(512, 514)]).toEqual([-1, -1]);
    // Pixel (3,4) has uv=(.4375,.5625): its entry exceeds even 350 km.
    const origin = map.origin.map(
      (value, i) =>
        value + map.extentMeters * (-0.0625 * (map.right[i] ?? 0) + 0.0625 * (map.up[i] ?? 0)),
    );
    const radial = [origin[0] ?? 0, (origin[1] ?? 0) + 6360000, origin[2] ?? 0];
    const b = radial.reduce((sum, value, i) => sum + value * (map.directionToLight[i] ?? 0), 0);
    const c = radial.reduce((sum, value) => sum + value * value, 0);
    const near = b - Math.sqrt(b * b - c + 6375000 ** 2);
    const far = b + Math.sqrt(b * b - c + 6375000 ** 2);
    expect(near).toBeGreaterThan(350000);
    const pixel = 4 * 64 + 3 * 4;
    expect(values[pixel]).toBeCloseTo((near + (far - near) / (2 * sampleBudget)) / 1000, 1);
    expect(values[pixel + 1]).toBeCloseTo(1e-6, 10);
    const tau = values[pixel + 2] ?? Number.NaN;
    const expectedTau = ((far - near) * 64 * 1e-6) / sampleBudget;
    expect(Math.abs(tau - expectedTau)).toBeLessThan(1e-4);
    expect(Math.abs(Math.exp(-tau) - Math.exp(-expectedTau))).toBeLessThan(1e-4);
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
}, 30000);

for (const format of ['rg11b10ufloat', 'rgba16float'] as const) {
  it(`writes and reads ${format} cloud shadow attachments with kilometer front depth`, async ({
    skip,
  }) => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No Dawn GPU adapter');
    const packed = format === 'rg11b10ufloat';
    if (packed && !adapter.features.has('rg11b10ufloat-renderable')) skip();
    const device = await adapter.requestDevice({
      requiredFeatures: packed ? ['rg11b10ufloat-renderable'] : [],
    });
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const raw = device.createTexture({ size: [8, 2], format, usage });
    const filtered = device.createTexture({ size: [4, 1], format, usage });
    const output = device.createBuffer({
      size: 160,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 160,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const engine = await loadEngineShaderEntries();
      const compiled = await compileShader(
        `${engine.cloudShadowFilter.source}
#import forgeax_cloud::shadow::{cloud_shadow_finish, cloud_shadow_pack_column, cloud_shadow_map_load, cloud_shadow_optical_depth, CLOUD_SHADOW_INVALID_COLUMN}
@group(1) @binding(1) var filteredShadow: texture_2d<f32>;
@group(1) @binding(2) var<storage, read_write> observed: array<vec4f>;
@fragment fn fs_fixture(input: FullscreenOutput) -> @location(0) vec4f {
  let x = u32(input.position.x);
  let y = u32(input.position.y);
  if x == 5u { return vec4f(CLOUD_SHADOW_INVALID_COLUMN, 1.0); }
  if x == 6u { return vec4f(cloud_shadow_pack_column(2500.0, 0.0, 0.0), 1.0); }
  let depths = array<f32, 4>(1000.0, 1500.0, 2000.0, 3500.0);
  var front = 1500.0;
  if x == 2u || x == 3u { front = depths[x - 2u + y * 2u]; }
  let bias = select(0.0, 125.0, x == 7u);
  return vec4f(cloud_shadow_finish(vec4f(front, 0.0009765625, 1.0, 0.0), 2500.0, 1024.0, 1.0, bias), 1.0);
}
@compute @workgroup_size(1) fn probe() {
  let uniformColumn = textureLoad(filteredShadow, vec2i(0), 0);
  observed[0] = textureLoad(rawShadow, vec2i(0), 0);
  observed[1] = uniformColumn;
  observed[2] = textureLoad(filteredShadow, vec2i(1,0), 0);
  observed[3] = textureLoad(filteredShadow, vec2i(2,0), 0);
  observed[4] = textureLoad(rawShadow, vec2i(6,0), 0);
  observed[5] = textureLoad(rawShadow, vec2i(7,0), 0);
  observed[6] = vec4f(exp(-vec3f(
    cloud_shadow_optical_depth(uniformColumn.xyz, 1000.0),
    cloud_shadow_optical_depth(uniformColumn.xyz, 2000.0),
    cloud_shadow_optical_depth(uniformColumn.xyz, 3000.0)
  )), 1.0);
  observed[7] = vec4f(cloud_shadow_map_load(rawShadow, vec2f(4.5 / 8.0, 0.25)), 1.0);
  observed[8] = vec4f(cloud_shadow_map_load(rawShadow, vec2f(5.0 / 8.0, 0.25)), 1.0);
  observed[9] = textureLoad(rawShadow, vec2i(5,0), 0);
}`,
        { id: 'cloud-shadow-attachment-readback.wgsl', imports: engine.imports },
      );
      if (!compiled.ok) throw compiled.error;
      const module = device.createShaderModule({ code: compiled.value.wgsl });
      const errors = (await module.getCompilationInfo()).messages.filter(
        (row) => row.type === 'error',
      );
      expect(errors).toEqual([]);
      const pipeline = (entryPoint: string) =>
        device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs_main' },
          fragment: { module, entryPoint, targets: [{ format }] },
        });
      const [writer, filter, probe] = await Promise.all([
        pipeline('fs_fixture'),
        pipeline('fs_main'),
        device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'probe' },
        }),
      ]);
      const encoder = device.createCommandEncoder();
      const write = encoder.beginRenderPass({
        colorAttachments: [{ view: raw.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      write.setPipeline(writer);
      write.draw(3);
      write.end();
      const spatial = encoder.beginRenderPass({
        colorAttachments: [{ view: filtered.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      spatial.setPipeline(filter);
      spatial.setBindGroup(
        1,
        device.createBindGroup({
          layout: filter.getBindGroupLayout(1),
          entries: [{ binding: 0, resource: raw.createView() }],
        }),
      );
      spatial.draw(3);
      spatial.end();
      const query = encoder.beginComputePass();
      query.setPipeline(probe);
      query.setBindGroup(
        1,
        device.createBindGroup({
          layout: probe.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: raw.createView() },
            { binding: 1, resource: filtered.createView() },
            { binding: 2, resource: { buffer: output } },
          ],
        }),
      );
      query.dispatchWorkgroups(1);
      query.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 160);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const values = [...new Float32Array(readback.getMappedRange())];
      readback.unmap();
      const texel = (i: number) => values.slice(i * 4, i * 4 + 4);
      const uniform = [1.5, 1 / 1024, 1, 1];
      const invalid = [65024, 0, 0, 1];
      expect(texel(0)).toEqual(uniform);
      expect(texel(1)).toEqual(uniform);
      expect(texel(2)).toEqual([2, 1 / 1024, 1, 1]);
      expect(texel(3)).toEqual(invalid);
      expect(texel(4)).toEqual([2.5, 0, 0, 1]);
      expect(texel(5)).toEqual([1.625, 1 / 1024, 1, 1]);
      expect(texel(6)[0]).toBe(1);
      expect(texel(6)[1]).toBeCloseTo(Math.exp(-500 / 1024), 5);
      expect(texel(6)[2]).toBeCloseTo(Math.exp(-1), 5);
      expect(texel(7)).toEqual(uniform);
      expect(texel(8)).toEqual(invalid);
      expect(texel(9)).toEqual(invalid);
    } finally {
      readback.destroy();
      output.destroy();
      filtered.destroy();
      raw.destroy();
      device.destroy();
    }
  });
}

it('reads back all four spatial reductions of an odd UE shadow map on the GPU', async () => {
  const engine = await loadEngineShaderEntries();
  const compiled = await compileShader(engine.cloudShadowFilter.source, {
    id: 'cloud-shadow-spatial-chain-test.wgsl',
    imports: engine.imports,
  });
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No Dawn GPU adapter');
  const device = await adapter.requestDevice();
  const size = 33;
  const layout = cloudShadowSpatialLayout(size, 4, true);
  const textures: GPUTexture[] = [];
  const buffer = device.createBuffer({
    size: 4 * 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    for (const width of [size, ...layout.passes.map((pass) => pass.resolution)]) {
      textures.push(
        device.createTexture({
          size: [width, width],
          format: 'rgba32float',
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.COPY_SRC,
        }),
      );
    }
    const raw = textures[0];
    if (!raw) throw new Error('Missing raw test texture');
    const pixels = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // A bright last row and column must disappear when the odd map truncates.
        const value = x === size - 1 || y === size - 1 ? 4096 : x + 2 * y;
        pixels.set([value, value / 4096, value / 32, 1], (y * size + x) * 4);
      }
    }
    device.queue.writeTexture({ texture: raw }, pixels, { bytesPerRow: size * 16 }, [size, size]);
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
    });
    const encoder = device.createCommandEncoder();
    for (const [index, stage] of layout.passes.entries()) {
      const input = textures[index];
      const output = textures[index + 1];
      if (!input || !output) throw new Error('Missing test filter texture');
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        1,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(1),
          entries: [{ binding: 0, resource: input.createView() }],
        }),
      );
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: output, origin: [stage.resolution - 1, stage.resolution - 1] },
        { buffer, offset: index * 256, bytesPerRow: 256 },
        [1, 1],
      );
    }
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const observed = new Float32Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    for (const index of layout.passes.keys()) {
      const block = 2 ** (index + 1);
      const lastBlockMidpoint = 32 - (block + 1) / 2;
      const expected = lastBlockMidpoint * 3;
      expect([...observed.slice(index * 64, index * 64 + 4)]).toEqual([
        expected,
        expected / 4096,
        expected / 32,
        1,
      ]);
    }
  } finally {
    buffer.destroy();
    for (const texture of textures) texture.destroy();
    device.destroy();
  }
});
