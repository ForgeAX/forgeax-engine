/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { VIEW_UNIFORM_BYTES } from '../../../record/view-ubo';
import { cloudRendererProgram } from '../../authoring/renderer-program';
import { cookedCloudShadowProjection } from '../shadow';

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
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: output } }],
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
      137,
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
    ];
    for (let index = 0; index < expected.length; index++) {
      expect(
        Math.abs((values[index] ?? Number.NaN) - (expected[index] ?? Number.NaN)),
      ).toBeLessThan(index === 8 ? 0.01 : 1e-4);
    }
  } finally {
    readback.destroy();
    output.destroy();
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
      Math.exp(-Math.min(values[2] ?? 0, (values[1] ?? 0) * (60 - (values[0] ?? 0)))),
    ).toBeCloseTo(Math.exp(-3), 6);
  } finally {
    readback.destroy();
    filtered.destroy();
    raw.destroy();
    device.destroy();
  }
});

it('renders complete cooked shadow columns independently of camera entry limits', async () => {
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
    params.set([64, 1, 0, 1], 40);
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
    expect(values[pixel]).toBeCloseTo(near + (far - near) / 128, -2);
    expect(values[pixel + 1]).toBeCloseTo(1e-6, 10);
    const tau = values[pixel + 2] ?? Number.NaN;
    expect(Math.abs(tau - (far - near) * 1e-6)).toBeLessThan(1e-4);
    expect(Math.abs(Math.exp(-tau) - Math.exp(-(far - near) * 1e-6))).toBeLessThan(1e-4);
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
}, 30000);
