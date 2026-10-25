import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Skylight `groundColor`: the Standard environment's diffuse scale lerps from
// the ground lane (normal down) to the sky tint (normal up), like Three.js
// HemisphereLight. A disabled lane (w = 0) keeps the uniform tint exactly.

const shaderRoot = resolve('packages/shader/src');
const imports = Object.fromEntries(
  [
    'atmosphere-coordinates',
    'atmosphere-optics',
    'atmosphere-sampling',
    'atmosphere-visibility',
    'cloud',
    'brdf',
    'ibl-sampling',
    'ibl-pmrem',
    'ibl-shared',
    'lighting-attenuation',
    'lighting-directional',
    'lighting-ies-profile',
    'lighting-probe',
    'lighting-punctual',
    'lighting-rect-area',
    'lighting-spot-modifiers',
    'lighting-spot-projector',
    'shadow-pcf',
    'standard-lighting',
    'standard-cluster',
    'view-atmosphere',
    'common',
  ].map((name) => {
    const source = readFileSync(resolve(shaderRoot, `${name}.wgsl`), 'utf8');
    const path = /^#define_import_path\s+(\S+)/m.exec(source)?.[1];
    if (path === undefined) throw new Error(`${name}.wgsl has no import path`);
    return [path, source];
  }),
);

// Pixel 0: normal +Y, pixel 1: normal -Y, pixel 2: normal +X; the view vector
// equals the normal so Fresnel and the BRDF LUT read the same texel everywhere.
const SOURCE = `#import forgeax_pbr::standard_lighting::{SkylightUniforms, evaluateStandardEnvironment}
struct Parameters { tint: vec4<f32>, ground: vec4<f32> };
@group(0) @binding(101) var<uniform> parameters: Parameters;
@group(0) @binding(102) var irradiance: texture_cube<f32>;
@group(0) @binding(103) var prefilter: texture_2d<f32>;
@group(0) @binding(104) var brdf: texture_2d<f32>;
@group(0) @binding(105) var sampleState: sampler;
fn ambient(normal: vec3<f32>) -> vec3<f32> {
  let sky = SkylightUniforms(1.0, parameters.tint.x, parameters.tint.y, parameters.tint.z,
    vec4<f32>(0.0, 0.0, 0.0, 1.0), vec4<f32>(0.0), vec4<f32>(0.0, 0.0, 0.0, 1.0), vec4<f32>(0.0),
    parameters.ground);
  var sh: array<vec4<f32>, 9>;
  let result = evaluateStandardEnvironment(vec3<f32>(0.0), normal, normal, vec3<f32>(1.0),
    vec3<f32>(0.0), 0.0, 1.0, vec3<f32>(0.04), vec4<f32>(0.04, 0.04, 0.04, 1.0), vec3<f32>(1.0),
    sky, irradiance, sampleState, prefilter, sampleState, brdf, prefilter, sh, 0.0);
  return result.diffuse;
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  var normals = array<vec3<f32>, 3>(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, -1.0, 0.0),
    vec3<f32>(1.0, 0.0, 0.0));
  return vec4<f32>(ambient(normals[min(u32(p.x), 2u)]), 1.0);
}`;

const RED = [1, 0, 0, 0];
const CASES = {
  uniform: { tint: RED, ground: [0, 0, 0, 0] },
  green: { tint: RED, ground: [0, 1, 0, 1] },
  same: { tint: RED, ground: [1, 0, 0, 1] },
} as const;

it('Skylight groundColor lerps the diffuse tint by normal.y and is off by default', async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const compiled = await compiler.compileShader(SOURCE, {
    id: 'skylight-hemisphere',
    imports,
    defines: { STORAGE_BUFFER_AVAILABLE: true, CLUSTER_FORWARD_AVAILABLE: false },
    renderEntries: { vertex: 'vs', fragment: 'fs' },
  });
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const uniform = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const output = device.createTexture({
    size: [3, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  // White irradiance cube (the solid-color fallback), grey prefilter, a BRDF LUT texel.
  const textures = [
    { layers: 6, texel: [255, 255, 255, 255] },
    { layers: 1, texel: [128, 128, 128, 255] },
    { layers: 1, texel: [128, 64, 0, 255] },
  ].map(({ layers, texel }) => {
    const texture = device.createTexture({
      size: [1, 1, layers],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const bytes = new Uint8Array(layers * 4);
    for (let i = 0; i < bytes.length; i += 4) bytes.set(texel, i);
    device.queue.writeTexture({ texture }, bytes, { bytesPerRow: 4, rowsPerImage: 1 }, [
      1,
      1,
      layers,
    ]);
    return texture;
  });
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
    });
    const [cube, prefilter, brdf] = textures as [GPUTexture, GPUTexture, GPUTexture];
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 101, resource: { buffer: uniform } },
        { binding: 102, resource: cube.createView({ dimension: 'cube' }) },
        { binding: 103, resource: prefilter.createView({ dimension: '2d' }) },
        { binding: 104, resource: brdf.createView() },
        {
          binding: 105,
          resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
        },
      ],
    });
    const render = async ({
      tint,
      ground,
    }: {
      tint: readonly number[];
      ground: readonly number[];
    }) => {
      device.queue.writeBuffer(uniform, 0, new Float32Array([...tint, ...ground]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback, bytesPerRow: 256 },
        [3, 1],
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(readback.getMappedRange()).slice(0, 12);
      readback.unmap();
      // [up, down, side] RGB
      return [0, 1, 2].map((p) => Array.from(pixels.slice(p * 4, p * 4 + 3)));
    };
    const close = (actual: number[] | undefined, expected: number[], label: string) => {
      expect(actual?.length, label).toBe(3);
      for (let c = 0; c < 3; c++)
        expect(
          Math.abs((actual?.[c] ?? Number.NaN) - (expected[c] ?? Number.NaN)),
          label,
        ).toBeLessThan(1e-5);
    };
    const uniformSky = await render(CASES.uniform);
    const lit = uniformSky[0]?.[0] ?? 0;
    expect(lit, 'red sky lights an upward normal').toBeGreaterThan(0.1);
    // Default (lane off): uniform ambient in every direction.
    for (const [i, rgb] of uniformSky.entries()) close(rgb, [lit, 0, 0], `uniform ${i}`);
    // Red sky, green ground: up keeps the sky, down takes the ground, side is the midpoint.
    const hemisphere = await render(CASES.green);
    close(hemisphere[0], [lit, 0, 0], 'hemisphere up');
    close(hemisphere[1], [0, lit, 0], 'hemisphere down');
    close(hemisphere[2], [lit / 2, lit / 2, 0], 'hemisphere side');
    // An enabled ground equal to the sky reproduces the uniform result.
    const same = await render(CASES.same);
    for (const [i, rgb] of same.entries()) close(rgb, [lit, 0, 0], `same ${i}`);
    expect(errors).toEqual([]);
  } finally {
    for (const texture of textures) texture.destroy();
    output.destroy();
    uniform.destroy();
    readback.destroy();
    device.destroy();
  }
});
