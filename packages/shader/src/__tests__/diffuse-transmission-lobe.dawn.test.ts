import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const functionSource = (file: string, name: string) => {
  const body = source(file).match(new RegExp(`fn ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
  if (!body) throw new Error(`Missing shader function ${name}`);
  return body;
};

// Execute the shared punctual body on the real backend: the KHR diffuse
// transmission lobe is (1/pi) * tint * max(-N.L, 0) with the light's own
// attenuation, and it must leave the front-lit reflection response untouched.
it('punctual body adds a normalized back-face Lambert lobe only for transmissive albedo', async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn diffuse-transmission regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const bytes = 5 * 16;
  const output = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const compiled = await compiler.compileShader(
      `
        #import forgeax_pbr::brdf::{standardOpaqueBrdf}
        ${functionSource('lighting-attenuation.wgsl', 'evalDistanceAttenuation')}
        ${functionSource('lighting-punctual.wgsl', 'evalPunctualBody')}
        @group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>, 5>;
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let normal = vec3<f32>(0.0, 1.0, 0.0);
          let viewDir = vec3<f32>(0.0, 1.0, 0.0);
          let back = id.x < 2u || id.x == 4u;
          let lightPos = select(vec3<f32>(0.0, 2.0, 0.0), vec3<f32>(0.0, -2.0, 0.0), back);
          var transmission = vec3<f32>(0.0);
          if (id.x == 0u || id.x == 3u) { transmission = vec3<f32>(1.0); }
          if (id.x == 4u) { transmission = vec3<f32>(0.2, 0.5, 1.0); }
          let value = evalPunctualBody(lightPos, vec3<f32>(1.0), 0.0, 2.0, vec3<f32>(0.0), normal,
            viewDir, vec3<f32>(0.5), 0.0, 0.25, vec3<f32>(0.04), transmission, false);
          result[id.x] = vec4<f32>(value, 1.0);
        }`,
      {
        id: 'forgeax::diffuse-transmission-lobe-regression',
        imports: { 'forgeax_pbr::brdf': source('brdf.wgsl') },
      },
    );
    if (!compiled.ok) throw compiled.error;
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    const compilation = await module.getCompilationInfo();
    expect(
      compilation.messages
        .filter((message) => message.type === 'error')
        .map((message) => message.message),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(5);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    expect(values.every(Number.isFinite)).toBe(true);
    const backLit = 1 / (Math.PI * 4);
    // Back light, white transmission: exactly the normalized Lambert BTDF.
    for (const channel of [0, 1, 2]) expect(values[channel]).toBeCloseTo(backLit, 5);
    // Back light, opaque: the reflection lobe contributes nothing.
    for (const channel of [4, 5, 6]) expect(values[channel]).toBe(0);
    // Front light: transmission does not change the reflected response.
    for (const channel of [8, 9, 10]) {
      expect(values[channel]).toBeGreaterThan(0);
      expect(values[channel + 4]).toBeCloseTo(values[channel] ?? Number.NaN, 6);
    }
    // Tinted transmission scales per channel.
    expect(values[16]).toBeCloseTo(0.2 * backLit, 5);
    expect(values[17]).toBeCloseTo(0.5 * backLit, 5);
    expect(values[18]).toBeCloseTo(backLit, 5);
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
