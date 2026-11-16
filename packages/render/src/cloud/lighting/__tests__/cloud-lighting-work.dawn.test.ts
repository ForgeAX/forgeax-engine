/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';

it('does not enter secondary tracing for covered or out-of-bounds BSM, vacuum, or pure absorption', async () => {
  const engine = await loadEngineShaderEntries();
  const trace = engine.imports['forgeax_cloud::trace'];
  if (!trace) throw new Error('Missing production trace');
  // Count actual function entries, not returned shadow values. The old BSM path
  // overwrites its unused result and therefore passes an image-only regression.
  const marker = 'settings: CloudSampledTraceSettings, lighting: CloudTraceLighting) -> f32 {';
  expect(trace.includes(marker)).toBe(true);
  const instrumented =
    trace.replace(marker, `${marker}\n secondaryCalls += 1u;`) +
    `
var<private> secondaryCalls: u32;
fn secondary_call_count() -> u32 { return secondaryCalls; }
`;
  const source = `
#import forgeax_cloud::trace::{CloudSampledTraceSettings, CloudTraceLighting, trace_sampled_cloud_lit, secondary_call_count}
#import forgeax_cloud::medium::{CloudDensityControls}
@group(0) @binding(0) var<storage, read_write> result: array<vec4f>;
@group(0) @binding(1) var white: texture_2d<f32>;
@group(0) @binding(2) var body: texture_3d<f32>;
@group(0) @binding(3) var filtering: sampler;
@group(0) @binding(4) var shadowMap: texture_2d<f32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let test = id.x;
  let sigma = select(0.0001, 0.0, test == 1u);
  let albedo = select(vec4f(0.8), vec4f(0.0), test == 2u);
  let density = CloudDensityControls(256000.0, 1.0, sigma, albedo, 1.0, 0.0, 1.0, 1.0, 0.0);
  let settings = CloudSampledTraceSettings(vec4f(5000.0,10000.0,350000.0,50000.0),6360000.0,1000000.0,15000.0,2u,2u,2u,true,false,false,0.0,0.5);
  var lighting: CloudTraceLighting;
  lighting.directionToLight = vec3f(0.0,1.0,0.0);
  lighting.illuminance = vec3f(1.0);
  lighting.enabled = true;
  lighting.phase = vec4f(0.15,-0.2,0.0,0.0);
  lighting.multipleScattering = vec4f(0.5,0.5,0.5,0.0);
  lighting.shadow = vec4f(1.0,10.0,15000.0,0.0);
  lighting.mapSettings = vec4f(select(0.0,1.0,test == 0u || test == 4u),0.0,64.0,1.0);
  lighting.mapOrigin = vec4f(select(20000.0,80000.0,test == 4u),10000.0,0.0,40000.0);
  lighting.mapRight = vec4f(1.0,0.0,0.0,50000.0);
  lighting.mapUp = vec4f(0.0,0.0,1.0,0.0);
  lighting.mapDirection = vec4f(0.0,1.0,0.0,1.0);
  let value = trace_sampled_cloud_lit(vec3f(0.0),vec3f(0.0,6360000.0,0.0),vec3f(0.0,1.0,0.0),vec3f(0.0),density,white,white,white,body,filtering,vec3f(0.0),settings,select(1000000.0,10000.0,test==5u),lighting,shadowMap,white,white);
  result[test * 2u] = vec4f(value.trace.radiance,value.trace.transmittance);
  result[test * 2u + 1u] = vec4f(f32(secondary_call_count()),value.nearRepresentativeDepthMeters,value.trace.representativeDepthMeters,value.near.transmittance);
}`;
  const compiled = await compileShader(source, {
    id: 'cloud-lighting-work.wgsl',
    imports: { ...engine.imports, 'forgeax_cloud::trace': instrumented },
  });
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1')
    expect(adapter.info.isFallbackAdapter).toBe(false);
  const device = await adapter.requestDevice();
  const resources: { destroy(): void }[] = [];
  const buffer = (usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size: 192, usage });
    resources.push(value);
    return value;
  };
  const texture = (format: GPUTextureFormat, dimension: GPUTextureDimension, width = 1) => {
    const value = device.createTexture({
      format,
      dimension,
      size: [width, 1, 1],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    resources.push(value);
    return value;
  };
  try {
    const output = buffer(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const white = texture('rgba8unorm', '2d');
    const body = texture('rgba8unorm', '3d');
    const map = texture('rgba32float', '2d', 2);
    for (const tex of [white, body])
      device.queue.writeTexture(
        { texture: tex },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1, 1],
      );
    device.queue.writeTexture(
      { texture: map },
      new Float32Array([0, 0.0001, 0.2, 1, 0, 0.0002, 0.4, 1]),
      { bytesPerRow: 32 },
      [2, 1, 1],
    );
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
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
        entries: [
          { binding: 0, resource: { buffer: output } },
          { binding: 1, resource: white.createView() },
          { binding: 2, resource: body.createView() },
          {
            binding: 3,
            resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
          },
          { binding: 4, resource: map.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(6);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 192);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect([values[4], values[12], values[20], values[36]]).toEqual([0, 0, 0, 0]);
    expect(Array.from(values.slice(32, 36))).toEqual(Array.from(values.slice(0, 4)));
    expect(values[28]).toBeGreaterThan(0); // Positive Raymarch control.
    expect(Array.from(values.slice(8, 12))).toEqual([0, 0, 0, 1]);
    expect(Array.from(values.slice(16, 19))).toEqual([0, 0, 0]);
    expect(values[19]).toBeGreaterThan(0);
    expect(values[19]).toBeLessThan(1);
    expect(values[0]).toBeGreaterThan(values[24] ?? Number.POSITIVE_INFINITY);
    // Two actual positive midpoints: the foreground clips between them.
    // Near has exactly the first midpoint; far includes the independently
    // attenuated second midpoint and must not be reused as the near distance.
    expect(values[45]).toBeCloseTo(7500, 1);
    const nearT = values[47] ?? Number.NaN;
    expect(values[46]).toBeCloseTo((7500 + 12500 * nearT) / (1 + nearT), 1);
    expect(values[46]).toBeGreaterThan(values[45] ?? Number.POSITIVE_INFINITY);
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
});
