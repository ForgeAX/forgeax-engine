import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const imports = Object.fromEntries(
  [
    'atmosphere-coordinates',
    'atmosphere-optics',
    'atmosphere-table-access',
    'atmosphere-sampling',
    'atmosphere-visibility',
    'cloud',
    'cloud/geometry',
    'cloud/shadow',
    'brdf',
    'ibl-sampling',
    'ibl-pmrem',
    'ibl-shared',
    'sky-sh-polynomial',
    'lighting-attenuation',
    'lighting-directional',
    'lighting-ies-profile',
    'lighting-probe',
    'lighting-punctual',
    'lighting-rect-area',
    'lighting-spot-modifiers',
    'lighting-spot-projector',
    'shadow-pcf',
    'standard-gbuffer',
    'standard-lighting',
    'standard-cluster',
    'view-atmosphere',
    'common',
  ].flatMap((name) => {
    const source = readFileSync(new URL(`${name}.wgsl`, root), 'utf8');
    const path = /^#define_import_path\s+(\S+)/m.exec(source)?.[1];
    return path === undefined ? [] : [[path, source]];
  }),
);

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  const open = source.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  if (start < 0 || depth !== 0) throw new Error(`Missing production function ${name}`);
  return source.slice(start, end);
}

const normals = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
] as const;

const cases = [
  { intensity: 2, ground: false, ambient: false },
  { intensity: 2, ground: true, ambient: false },
  { intensity: 2, ground: true, ambient: true },
  { intensity: -2, ground: false, ambient: true },
  { intensity: -2, ground: true, ambient: true },
  { intensity: -1, ground: true, ambient: true },
] as const;

it.each([
  'single-layer-water',
  'single-layer-medium',
])('%s consumes the complete Skylight diffuse contract', async (name) => {
  const source = readFileSync(new URL(`${name}.wgsl`, root), 'utf8');
  const prepareMediumSkylightShaderSource = () => {
    const type = /var<uniform> mediumSkylight:\s*(\w+)/.exec(source)?.[1];
    if (type === undefined) throw new Error('Missing medium Skylight uniform');
    const declaration = new RegExp(`struct ${type}\\s*\\{[^}]*\\};?`).exec(source)?.[0] ?? '';
    const standardNames = /#import forgeax_pbr::standard_lighting::\{([^}]+)\}/.exec(source)?.[1];
    const standardImport = `#import forgeax_pbr::standard_lighting::{${standardNames ?? 'SkylightUniforms'}}`;
    const water = name === 'single-layer-water';
    const skyColorStart = source.indexOf('  let skyColor =', source.indexOf('fn waterColor('));
    const diffuseStart = source.indexOf('  let skyDiffuse =', source.indexOf('fn waterColor('));
    const blockStart = skyColorStart < 0 ? diffuseStart : skyColorStart;
    const blockEnd = source.indexOf('  let ambient =', blockStart);
    if (water && (blockStart < 0 || blockEnd <= blockStart))
      throw new Error('Missing Water Skylight diffuse block');
    const body = water
      ? `fn sampleMediumDiffuse(normal: vec3<f32>, pixel: vec4<f32>, probe: vec2<u32>) -> vec3<f32> {
${source.slice(blockStart, blockEnd)}
  return skyDiffuse;
}`
      : functionSource(source, 'sampleMediumDiffuse');
    const captureStart = source.indexOf('  var captureSky =', source.indexOf('fn waterColor('));
    const captureEnd = source.indexOf('  let coverage =', captureStart);
    const directionStart = source.lastIndexOf('  let direction =', captureStart);
    const capture = water
      ? `struct Input { positionWS: vec3<f32> }
struct Behind { depthM: f32 }
fn capture(normal: vec3<f32>, toCamera: vec3<f32>, roughness: f32, worldPosition: vec3<f32>) -> vec3<f32> {
  let input = Input(worldPosition);
  let behind = Behind(8.0);
  let surfaceDepthM = 2.0;
  let envBrdf = 0.0;
${skyColorStart < 0 ? '' : source.slice(skyColorStart, diffuseStart)}
${directionStart > blockEnd ? source.slice(directionStart, captureStart) : ''}
${source.slice(captureStart, captureEnd)}
  return captureSky;
}`
      : `${functionSource(source, 'sampleSkyReflection')}
fn capture(normal: vec3<f32>, toCamera: vec3<f32>, roughness: f32, worldPosition: vec3<f32>) -> vec3<f32> {
  return sampleSkyReflection(normal, toCamera, roughness${/fn sampleSkyReflection\([^)]*worldPosition/s.test(source) ? ', worldPosition' : ''});
}`;
    return { type, declaration, standardImport, body, capture };
  };
  const { type, declaration, standardImport, body, capture } = prepareMediumSkylightShaderSource();
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const compiled = await compiler.compileShader(
    `${standardImport}
#import forgeax_pbr::sky_sh_polynomial::{SkyShPolynomial}
#import forgeax_pbr::ibl_sampling::{environmentReflectionDirection}
#import forgeax_pbr::ibl_shared::{inverseRotateEnvironment}
#import forgeax_pbr::pmrem::{samplePmrem}
${declaration}
@group(0) @binding(101) var<uniform> mediumSkylight: ${type};
@group(0) @binding(102) var<uniform> mediumSkySh: SkyShPolynomial;
@group(0) @binding(104) var<storage, read_write> result: array<vec4<f32>>;
@group(0) @binding(105) var mediumPrefilterMap: texture_2d<f32>;
@group(0) @binding(107) var mediumPrefilterSampler: sampler;
${body}
${capture}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let normals = array<vec3<f32>, 3>(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0));
  let center = vec3<f32>(mediumSkylight.colorR, mediumSkylight.colorG, mediumSkylight.colorB);
  let offset = select(select(0.0, 3.0, id.x == 1u), 1.9, id.x == 2u);
  result[id.x * 2u] = vec4<f32>(sampleMediumDiffuse(normals[id.x], vec4<f32>(0.0), vec2<u32>(0u)), 1.0);
  result[id.x * 2u + 1u] = vec4<f32>(capture(normals[id.x], normals[id.x], 0.1, center + vec3<f32>(offset, 0.0, 0.0)), 1.0);
}`,
    {
      id: `${name}-skylight-contract`,
      imports,
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        CLUSTER_FORWARD_AVAILABLE: false,
        PROBE_BLEND_AVAILABLE: false,
        WATER_USE_REFLECTIONS: true,
        WATER_USE_SSR: false,
      },
    },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Medium Skylight regression requires Dawn');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const uniform = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const view = device.createBuffer({ size: 1408, usage: GPUBufferUsage.UNIFORM });
  const skySh = device.createBuffer({
    size: 112,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const coefficients = new Float32Array(28);
  for (let channel = 0; channel < 3; channel++) coefficients.set([0.1, 0.15, 0, 0.4], channel * 4);
  device.queue.writeBuffer(skySh, 0, coefficients);
  const reflectionMaps = [[204, 102, 51, 255]].map((color) => {
    const texture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, new Uint8Array(color), { bytesPerRow: 4 }, [1, 1]);
    return texture;
  });
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 101,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', minBindingSize: 96 },
        },
        {
          binding: 102,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', minBindingSize: 112 },
        },
        {
          binding: 104,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage', minBindingSize: 96 },
        },
        { binding: 105, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: '2d' } },
        { binding: 107, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: view } },
        { binding: 101, resource: { buffer: uniform } },
        { binding: 102, resource: { buffer: skySh } },
        { binding: 104, resource: { buffer: output } },
        { binding: 105, resource: reflectionMaps[0]?.createView() as GPUTextureView },
        { binding: 107, resource: device.createSampler() },
      ],
    });
    for (const entry of cases) {
      const tint = [0.8, 0.4, 0.2];
      const probeScale = [0.4, 0.7, 0.9];
      const ground = [0.1, 0.3, 0.7];
      const ambient = entry.ambient ? [0.03, 0.06, 0.09] : [0, 0, 0];
      device.queue.writeBuffer(
        uniform,
        0,
        new Float32Array([
          entry.intensity,
          ...tint,
          ...(entry.intensity < 0 ? [2, 2, 2, 1] : [0, 1, 0, 0]),
          ...probeScale,
          0,
          0,
          0,
          0,
          1,
          ...ambient,
          0,
          ...ground,
          entry.ground ? 1 : 0,
        ]),
      );
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(3);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 96);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      expect(errors).toEqual([]);
      const assertMediumSkylightChannels = () => {
        for (const [index, normal] of normals.entries()) {
          // The ordinary 180-degree sky rotation flips X. A reflection probe
          // uses the independent identity rotation for diffuse sky lighting.
          const localX = entry.intensity < 0 ? normal[0] : -normal[0];
          const irradiance = 0.4 + 0.1 * localX + 0.15 * normal[1];
          for (let channel = 0; channel < 3; channel++) {
            const skyScale =
              entry.intensity < 0
                ? (probeScale[channel] ?? 0)
                : (tint[channel] ?? 0) * entry.intensity;
            const blend = normal[1] * 0.5 + 0.5;
            const scale = entry.ground
              ? (ground[channel] ?? 0) * (1 - blend) + skyScale * blend
              : skyScale;
            const expected = irradiance * scale + (ambient[channel] ?? 0) / Math.PI;
            expect(
              actual[index * 8 + channel],
              JSON.stringify({ name, entry, index, channel }),
            ).toBeCloseTo(expected, 5);
            const local = [0.8, 0.4, 0.2][channel] ?? 0;
            const radiance =
              entry.intensity < 0
                ? local * (-entry.intensity - 1)
                : local * (tint[channel] ?? 0) * entry.intensity;
            expect(
              actual[index * 8 + 4 + channel],
              `capture ${JSON.stringify({ name, entry, index, channel })}`,
            ).toBeCloseTo(radiance, 5);
          }
        }
      };
      assertMediumSkylightChannels();
    }
    expect(errors).toEqual([]);
  } finally {
    view.destroy();
    skySh.destroy();
    for (const texture of reflectionMaps) texture.destroy();
    uniform.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
