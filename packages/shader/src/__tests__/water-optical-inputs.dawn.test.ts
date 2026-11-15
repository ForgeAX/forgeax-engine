import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const water = readFileSync(new URL('single-layer-water.wgsl', root), 'utf8');
const standard = readFileSync(new URL('standard-lighting.wgsl', root), 'utf8');
const color = water.slice(water.indexOf('fn waterColor('));
const imports = Object.fromEntries(
  [
    'atmosphere-coordinates',
    'atmosphere-optics',
    'atmosphere-sampling',
    'atmosphere-table-access',
    'atmosphere-visibility',
    'cloud',
    'cloud/geometry',
    'cloud/shadow',
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

async function compose(source: string, atmosphere = false): Promise<string> {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const compiled = await compiler.compileShader(source, {
    id: 'water-optical-inputs',
    imports,
    defines: {
      STORAGE_BUFFER_AVAILABLE: true,
      CLUSTER_FORWARD_AVAILABLE: false,
      PROBE_BLEND_AVAILABLE: false,
      WATER_USE_REFLECTIONS: true,
      ...(atmosphere ? { ATMOSPHERE_AVAILABLE: true } : {}),
    },
  });
  if (!compiled.ok) throw compiled.error;
  return compiled.value.wgsl;
}

async function dispatch(
  device: GPUDevice,
  code: string,
  entries: GPUBindGroupEntry[],
  count: number,
  vectors: number,
): Promise<Float32Array> {
  const size = count * vectors * 16;
  const output = device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  device.pushErrorScope('validation');
  try {
    const module = device.createShaderModule({ code });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [...entries, { binding: 100, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(count);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    return values;
  } finally {
    output.destroy();
    readback.destroy();
    expect((await device.popErrorScope())?.message).toBeUndefined();
  }
}

function directionAtlas(device: GPUDevice, blueOffset: number): GPUTexture {
  const width = 336;
  const height = 64;
  const bytes = new Uint8Array(width * height * 4);
  for (let mip = -2; mip <= 4; mip++) {
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const u = ((x - 0.5) / 14) * 2 - 1;
          const v = ((y - 0.5) / 14) * 2 - 1;
          const direction = [
            [1, v, u],
            [-u, 1, -v],
            [-u, v, 1],
            [-1, v, -u],
            [-u, -1, v],
            [u, v, -1],
          ][face];
          if (direction === undefined) throw new Error('Missing CubeUV face');
          const length = Math.hypot(...direction);
          const pixel =
            ((Math.floor(face / 3) * 16 + y) * width + (4 - mip) * 48 + (face % 3) * 16 + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            const angular = ((direction[channel] ?? 0) / length + 1) * 0.3;
            const level = ((mip + 2) / 6) * 0.2;
            bytes[pixel + channel] = Math.round(
              (angular + level + (channel === 2 ? blueOffset : 0)) * 255,
            );
          }
          bytes[pixel + 3] = 255;
        }
      }
    }
  }
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, bytes, { bytesPerRow: width * 4 }, [width, height]);
  return texture;
}

it('SLW hit history uses motion only from the opaque hit layer', async () => {
  const trace = readFileSync(new URL('ssr-trace.wgsl', root), 'utf8');
  const temporal = readFileSync(new URL('scene-temporal.wgsl', root), 'utf8').replace(
    /^#define_import_path[^\n]*\n/m,
    '',
  );
  const depth = readFileSync(new URL('depth-pyramid-sample.wgsl', root), 'utf8').replace(
    /^#define_import_path[^\n]*\n/m,
    '',
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('SLW hit history regression requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const cases = [
    { depth: [100, 100, 110, 0], motion: [0.125, -0.0625, 1, 0], acceptsMotion: true },
    { depth: [2, 100, 110, 0], motion: [0.125, -0.0625, 1, 0], acceptsMotion: false },
    { depth: [100, 100, 110, 0], motion: [0.125, -0.0625, 0, 0], acceptsMotion: false },
    { depth: [-1, 100, 110, 0], motion: [0.125, -0.0625, 1, 0], acceptsMotion: false },
    { depth: [0.11, 0.11, 0.13, 0], motion: [0.125, -0.0625, 1, 0], acceptsMotion: true },
    { depth: [333.333, 333.333, 350, 0], motion: [0.125, -0.0625, 1, 0], acceptsMotion: true },
    { depth: [100.5, 100, 110, 0], motion: [0.125, -0.0625, 1, 0], acceptsMotion: false },
    { depth: [100, 0, 110, 0], motion: [0.125, -0.0625, 1, 0], acceptsMotion: false },
    { depth: [100, 100, 110, 0], motion: [Number.NaN, -0.0625, 1, 0], acceptsMotion: false },
  ];
  const samples = new Float32Array(cases.flatMap((sample) => [...sample.depth, ...sample.motion]));
  const sampleBuffer = device.createBuffer({
    size: samples.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const viewBuffer = device.createBuffer({
    size: 208,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const declarations = `
struct View {
  inverseViewProj: mat4x4<f32>, temporalCurrentViewProj: mat4x4<f32>,
  temporalPreviousViewProj: mat4x4<f32>, temporalProjection: vec4<f32>,
}
struct Sample { depths: vec4<f32>, motion: vec4<f32> }
@group(0) @binding(0) var<uniform> view: View;
fn rawDepth(distance: f32) -> f32 {
  if (distance <= 0.0) { return 0.0; }
  let near = view.temporalProjection.x;
  let far = view.temporalProjection.y;
  return select(near * (far - distance) / (distance * (far - near)),
    (far - distance) / (far - near), view.temporalProjection.z > 0.5);
}
`;
  try {
    device.queue.writeBuffer(sampleBuffer, 0, samples);
    for (const orthographic of [false, true]) {
      const near = 0.08;
      const far = 400;
      const projection = orthographic
        ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 / (far - near), 0, 0, 0, far / (far - near), 1]
        : [
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            near / (far - near),
            -1,
            0,
            0,
            (near * far) / (far - near),
            0,
          ];
      const inverse = orthographic
        ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, far - near, 0, 0, 0, -far, 1]
        : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, (far - near) / (near * far), 0, 0, -1, 1 / far];
      const previous = [...projection];
      if (orthographic) {
        previous[12] = 0.125;
        previous[13] = -0.25;
      } else {
        previous[8] = -0.125;
        previous[9] = 0.25;
      }
      device.queue.writeBuffer(
        viewBuffer,
        0,
        new Float32Array([
          ...inverse,
          ...projection,
          ...previous,
          near,
          far,
          Number(orthographic),
          0,
        ]),
      );
      const sceneTemporal = device.createTexture({
        size: [cases.length, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      const sceneDepth = device.createTexture({
        size: [cases.length, 1],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      try {
        const module = device.createShaderModule({
          code: `
${declarations}
@group(0) @binding(1) var<storage, read> samples: array<Sample>;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
struct Seed { @location(0) temporal: vec4<f32>, @builtin(frag_depth) depth: f32 }
@fragment fn fs_main(@builtin(position) pixel: vec4<f32>) -> Seed {
  let sample = samples[u32(pixel.x)];
  let packedDepth = select(log2(1.0 + max(sample.depths.x, 0.0)), -1.0, sample.depths.x < 0.0);
  return Seed(vec4<f32>(sample.motion.xy, packedDepth, select(2.0, 0.0, sample.motion.z > 0.5)), rawDepth(sample.depths.y));
}`,
        });
        const pipeline = await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs_main' },
          fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
          depthStencil: { format: 'depth32float', depthCompare: 'always', depthWriteEnabled: true },
        });
        const bindings = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: viewBuffer } },
            { binding: 1, resource: { buffer: sampleBuffer } },
          ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: sceneTemporal.createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, -1, 1],
            },
          ],
          depthStencilAttachment: {
            view: sceneDepth.createView(),
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const result = await dispatch(
          device,
          `
${declarations}
${temporal}
${depth}
struct WaterSsrHit { found: bool, uv: vec2<f32>, depth: f32 }
@group(0) @binding(1) var sceneTemporal: texture_2d<f32>;
@group(0) @binding(2) var sceneDepth: texture_depth_2d;
@group(0) @binding(3) var<storage, read> samples: array<Sample>;
@group(0) @binding(100) var<storage, read_write> result: array<vec4<f32>>;
${functionSource(trace, 'isFinite')}
${functionSource(trace, 'waterHitPreviousScreen')}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let uv = vec2<f32>((f32(id.x) + 0.5) / f32(arrayLength(&samples)), 0.5);
  let hit = WaterSsrHit(true, uv, rawDepth(samples[id.x].depths.z));
  result[id.x] = vec4<f32>(waterHitPreviousScreen(hit), textureLoad(sceneDepth, vec2<i32>(i32(id.x), 0), 0), 1.0);
}`,
          [
            { binding: 0, resource: { buffer: viewBuffer } },
            { binding: 1, resource: sceneTemporal.createView() },
            { binding: 2, resource: sceneDepth.createView() },
            { binding: 3, resource: { buffer: sampleBuffer } },
          ],
          cases.length,
          1,
        );
        for (const [index, sample] of cases.entries()) {
          const uv = (index + 0.5) / cases.length;
          expect(result[index * 4], `orthographic=${orthographic}, case=${index}, x`).toBeCloseTo(
            uv + (sample.acceptsMotion ? -0.125 : 0.0625),
            5,
          );
          expect(
            result[index * 4 + 1],
            `orthographic=${orthographic}, case=${index}, y`,
          ).toBeCloseTo(0.5 + (sample.acceptsMotion ? 0.0625 : 0.125), 5);
        }
      } finally {
        sceneTemporal.destroy();
        sceneDepth.destroy();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    sampleBuffer.destroy();
    viewBuffer.destroy();
    device.destroy();
  }
});

it('SLW capture selects its source direction through real PMREM and probe fallback', async () => {
  const captureStart = color.indexOf('  var captureSky =');
  const captureEnd = color.indexOf('  let coverage =', captureStart);
  const capture = color.slice(captureStart, captureEnd);
  expect(capture.length).toBeGreaterThan(100);
  const standardEnvironment = functionSource(standard, 'evaluateStandardEnvironment');
  const standardStart = standardEnvironment.indexOf('  let specular =');
  const standardEnd = standardEnvironment.indexOf('  let fresnel =', standardStart);
  const standardDirection =
    / {2}let reflectionDirection =[^;]+;/s.exec(standardEnvironment.slice(0, standardStart))?.[0] ??
    '';
  const standardImport = /#import forgeax_pbr::standard_lighting::\{([^}]+)\}/.exec(water)?.[1];
  const code = await compose(`
#import forgeax_pbr::standard_lighting::{${standardImport}}
#import forgeax_pbr::ibl_sampling::{environmentReflectionDirection}
#import forgeax_pbr::pmrem::{samplePmrem}
@group(0) @binding(101) var mediumPrefilterMap: texture_2d<f32>;
@group(0) @binding(102) var skylightPrefilterMap: texture_2d<f32>;
@group(0) @binding(103) var mediumPrefilterSampler: sampler;
@group(0) @binding(100) var<storage, read_write> result: array<vec4<f32>>;
struct Input { positionWS: vec3<f32> }
struct Behind { depthM: f32 }
fn capture(sky: SkylightUniforms, normal: vec3<f32>, toCamera: vec3<f32>, roughness: f32, worldPosition: vec3<f32>) -> vec4<f32> {
  let mediumSkylight = sky;
  let input = Input(worldPosition);
  let behind = Behind(2.125);
  let surfaceDepthM = 2.0;
  let envBrdf = 0.3;
${capture}
  return vec4<f32>(captureSky, reflectionWeight);
}
fn standardCapture(sky: SkylightUniforms, normal: vec3<f32>, direction: vec3<f32>, roughness: f32, worldPosition: vec3<f32>, prefilterMap: texture_2d<f32>, prefilterSampler: sampler, skylightPrefilterMap: texture_2d<f32>) -> vec3<f32> {
${standardDirection}
${standardEnvironment.slice(standardStart, standardEnd)}
  return specular;
}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x % 3u;
  let mode = id.x / 3u;
  let probe = mode > 0u;
  let roughness = select(array<f32, 3>(0.0, 0.6, 1.0)[index], 0.6, probe);
  let position = vec3<f32>(select(0.0, array<f32, 3>(0.0, 1.9, 3.0)[index], probe), 0.0, 0.0);
  var sky: SkylightUniforms;
  sky.intensity = select(2.0, -2.0, probe);
  sky.colorR = select(0.8, 0.0, probe);
  sky.colorG = select(0.6, 0.0, probe);
  sky.colorB = select(0.4, 0.0, probe);
  sky.rotation = select(vec4<f32>(0.0, 0.70710678118, 0.0, 0.70710678118), vec4<f32>(2.0, 2.0, 2.0, select(0.0, 1.0, mode == 2u)), probe);
  sky.diffuseScale = vec4<f32>(0.4, 0.7, 0.9, 0.0);
  sky.diffuseRotation = vec4<f32>(0.0, 0.70710678118, 0.0, 0.70710678118);
  let normal = vec3<f32>(0.0, 1.0, 0.0);
  let toCamera = vec3<f32>(0.8, 0.6, 0.0);
  // UE legacy SLW golden directions at r=0, 0.6, 1. Standard retains its Three direction.
  let waterDirection = array<vec3<f32>, 3>(vec3<f32>(-0.8, 0.6, 0.0), vec3<f32>(-0.59392, 0.70304, 0.0), normal)[select(index, 1u, probe)];
  let standardGolden = array<vec3<f32>, 3>(vec3<f32>(-0.8, 0.6, 0.0), normalize(vec3<f32>(-0.69632, 0.65184, 0.0)), normal)[select(index, 1u, probe)];
  let weight = select(1.0, array<f32, 3>(1.0, 0.5, 0.0)[index], probe);
  let skyScale = select(vec3<f32>(1.6, 1.2, 0.8), sky.diffuseScale.xyz, probe);
  result[id.x * 4u] = capture(sky, normal, toCamera, roughness, position);
  result[id.x * 4u + 1u] = vec4<f32>(standardCapture(sky, normal, toCamera, roughness, position, mediumPrefilterMap, mediumPrefilterSampler, skylightPrefilterMap), 1.0);
  var waterGlobal = samplePmrem(mediumPrefilterMap, mediumPrefilterSampler, vec3<f32>(-waterDirection.z, -waterDirection.y, waterDirection.x), roughness) * skyScale;
  var standardGlobal = samplePmrem(mediumPrefilterMap, mediumPrefilterSampler, vec3<f32>(-standardGolden.z, -standardGolden.y, standardGolden.x), roughness) * skyScale;
  if (probe) {
    waterGlobal = samplePmrem(skylightPrefilterMap, mediumPrefilterSampler, vec3<f32>(-waterDirection.z, -waterDirection.y, waterDirection.x), roughness) * skyScale;
    standardGlobal = samplePmrem(skylightPrefilterMap, mediumPrefilterSampler, vec3<f32>(-standardGolden.z, -standardGolden.y, standardGolden.x), roughness) * skyScale;
    var waterLocal = waterDirection;
    var standardLocal = standardGolden;
    if (mode == 2u && index < 2u) {
      // Both golden rays leave these fixtures through the box's +Y plane.
      waterLocal = position + waterDirection * (2.0 / waterDirection.y);
      standardLocal = position + standardGolden * (2.0 / standardGolden.y);
    }
    waterGlobal = mix(waterGlobal, samplePmrem(mediumPrefilterMap, mediumPrefilterSampler, waterLocal, roughness), weight);
    standardGlobal = mix(standardGlobal, samplePmrem(mediumPrefilterMap, mediumPrefilterSampler, standardLocal, roughness), weight);
  }
  result[id.x * 4u + 2u] = vec4<f32>(waterGlobal, 0.075);
  result[id.x * 4u + 3u] = vec4<f32>(standardGlobal, 1.0);
}`);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Water optical regression requires Dawn');
  const device = await adapter.requestDevice();
  const local = directionAtlas(device, 0);
  const global = directionAtlas(device, 0.1);
  try {
    const actual = await dispatch(
      device,
      code,
      [
        { binding: 101, resource: local.createView() },
        { binding: 102, resource: global.createView() },
        {
          binding: 103,
          resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
        },
      ],
      9,
      4,
    );
    for (let sample = 0; sample < 9; sample++) {
      for (let lane = 0; lane < 4; lane++) {
        expect
          .soft(actual[sample * 16 + lane], `Water ${sample}/${lane}`)
          .toBeCloseTo(actual[sample * 16 + 8 + lane] ?? 0, 5);
        expect
          .soft(actual[sample * 16 + 4 + lane], `Standard ${sample}/${lane}`)
          .toBeCloseTo(actual[sample * 16 + 12 + lane] ?? 0, 5);
      }
    }
  } finally {
    local.destroy();
    global.destroy();
    device.destroy();
  }
});

it('SLW volume uses fixed ground solar and an independent surface cloud sample once', async () => {
  const scatteredStart = color.indexOf('  let scattered =');
  const solarStart = color.lastIndexOf('  let volumeSun =', scatteredStart);
  const solar = color.slice(
    solarStart < 0 ? scatteredStart : solarStart,
    color.indexOf('  let envBrdf =', scatteredStart),
  );
  const solarNames = [...new Set([...solar.matchAll(/\b(view_\w+)\(/g)].map((match) => match[1]))];
  const code = await compose(
    `
#import forgeax_view::common::{View, AtmosphereMedium, atmosphereTransmittance}
#import forgeax_cloud::layer::{cloud_direct_solar_factor, cloudShadowSampler}
#import forgeax_atmosphere::optics::{atmosphere_solar_transmittance}
${solarNames.length === 0 ? '' : `#import forgeax_view::atmosphere::{${solarNames.join(', ')}}`}
@group(0) @binding(100) var<storage, read_write> result: array<vec4<f32>>;
var<private> view: View;
struct Input { positionWS: vec3<f32> }
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let atmosphereEnabled = id.x < 4u || id.x == 6u;
  let cloudEnabled = id.x < 6u;
  let height = array<f32, 8>(0.0, 0.0, 20000.0, 80000.0, 0.0, 20000.0, 0.0, 0.0)[id.x];
  let input = Input(vec3<f32>(select(-25.0, 25.0, id.x % 2u == 1u), height, 0.0));
  view.atmosphere = AtmosphereMedium(vec4<f32>(0.0, 123.0, 0.0, 6360.0), vec4<f32>(0.005802, 0.013558, 0.0331, 8.0), vec4<f32>(0.003996, 0.000444, 1.2, 0.8), vec4<f32>(0.00065, 0.001881, 0.000085, 25.0), vec4<f32>(0.4, 0.4, 0.4, 15.0), vec4<f32>(60.0, 1.0, 0.0, 1.0));
  view.atmosphereControl.w = select(0.0, 2.0, atmosphereEnabled);
  view.lightDir = vec3<f32>(-0.8, -0.6, 0.0);
  view.lightColor = vec3<f32>(2.0, 3.0, 4.0);
  view.cameraPos = vec3<f32>(1000.0, height * 2.0, -500.0);
  view.cloudShadowRight = vec4<f32>(1.0, 0.0, 0.0, 0.0);
  view.cloudShadowUp = vec3<f32>(0.0, 0.0, 1.0);
  view.cloudShadowProjection = vec4<f32>(100.0, select(0.0, 1.0, cloudEnabled), 0.0, 0.0);
  let shadow = select(1.0, 0.25, id.x == 2u || id.x == 3u);
  let phase = 0.125;
  let integral = vec3<f32>(0.7);
  let ambient = vec3<f32>(0.03);
${solar}
  let ground = atmosphere_solar_transmittance(view.atmosphere, vec3<f32>(0.0, 6360.5, 0.0), vec3<f32>(0.8, 0.6, 0.0), atmosphereTransmittance, cloudShadowSampler);
  let expectedAtmosphere = select(vec3<f32>(1.0), ground, atmosphereEnabled);
  let expectedCloud = cloud_direct_solar_factor(input.positionWS, view.cloudShadowOrigin.xyz, view.cloudShadowRight.xyz, view.cloudShadowUp.xyz, view.cloudShadowProjection);
  result[id.x * 2u] = vec4<f32>(scattered, 1.0);
  result[id.x * 2u + 1u] = vec4<f32>(integral * (ambient + view.lightColor * shadow * phase * expectedAtmosphere * expectedCloud), 1.0);
}`,
    true,
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Water solar regression requires Dawn');
  const device = await adapter.requestDevice();
  const lut = device.createTexture({
    size: [32, 16],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const cloud = device.createTexture({
    size: [2, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const bytes = new Uint8Array(32 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 32; x++)
      bytes.set([64 + x * 4, 32 + y * 8, 180 - x * 3, 255], (y * 32 + x) * 4);
  device.queue.writeTexture({ texture: lut }, bytes, { bytesPerRow: 128 }, [32, 16]);
  device.queue.writeTexture(
    { texture: cloud },
    new Uint8Array([64, 0, 0, 255, 191, 0, 0, 255]),
    { bytesPerRow: 8 },
    [2, 1],
  );
  try {
    const actual = await dispatch(
      device,
      code,
      [
        { binding: 16, resource: cloud.createView() },
        { binding: 17, resource: device.createSampler() },
        { binding: 18, resource: lut.createView() },
      ],
      8,
      2,
    );
    expect(actual[0]).toBeGreaterThan(0.021);
    expect(actual[8]).toBeGreaterThan(actual[0] ?? 0);
    for (let sample = 0; sample < 8; sample++)
      for (let lane = 0; lane < 4; lane++)
        expect
          .soft(actual[sample * 8 + lane], `solar ${sample}/${lane}`)
          .toBeCloseTo(actual[sample * 8 + 4 + lane] ?? 0, 5);
  } finally {
    lut.destroy();
    cloud.destroy();
    device.destroy();
  }
});

it('SLW bilateral color/depth footprint applies the UE gather bias before valid-only fallback', async () => {
  const selectionStart = color.indexOf('  let distorted = waterSceneSample');
  const selection = color.slice(selectionStart, color.indexOf('  // Full-quality', selectionStart));
  const clampStart = color.indexOf('  distortedUv = clamp(');
  const clamp = color.slice(clampStart, color.indexOf(';', clampStart) + 1);
  const temporal = readFileSync(new URL('scene-temporal.wgsl', root), 'utf8');
  const code = `
struct View { worldViewProj: mat4x4<f32>, inverseViewProj: mat4x4<f32>, temporalProjection: vec4<f32> }
struct WaterSceneSample { color: vec3<f32>, depthM: f32, valid: bool }
var<private> view: View;
@group(0) @binding(1) var surfaceRawDepthTexture: texture_2d<f32>;
@group(0) @binding(2) var surfaceBackdropTexture: texture_2d<f32>;
@group(0) @binding(100) var<storage, read_write> result: array<vec4<f32>>;
${functionSource(temporal, 'sceneViewZ')}
${functionSource(water, 'waterWorld')}
${functionSource(water, 'waterViewDepth')}
${functionSource(water, 'waterSceneSample')}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  view.worldViewProj = mat4x4<f32>(vec4<f32>(1.0, 0.0, 0.0, 0.0), vec4<f32>(0.0, 1.0, 0.0, 0.0), vec4<f32>(0.0, 0.0, 1.0, 0.0), vec4<f32>(0.0, 0.0, 0.0, 1.0));
  view.inverseViewProj = view.worldViewProj;
  view.temporalProjection = vec4<f32>(1.0, 11.0, 1.0, 0.0);
  let surfaceDepthM = 4.0;
  let gradientM = 0.0;
  let original = waterSceneSample(vec2<f32>(0.175, 0.2), surfaceDepthM, gradientM);
  var distortedUv = array<vec2<f32>, 4>(vec2<f32>(0.175, 0.2), vec2<f32>(0.425, 0.45), vec2<f32>(0.75), vec2<f32>(0.0))[id.x];
  if (id.x == 3u) {
    let uv = vec2<f32>(0.5);
    let size = vec2<f32>(4.0);
    let bufferOffset = vec2<f32>(-0.5);
    let biasFade = 1.0;
    let shallowFade = 1.0;
${clamp}
  }
${selection}
  result[id.x * 2u] = vec4<f32>(behind.color, behind.depthM);
  result[id.x * 2u + 1u] = vec4<f32>(select(0.0, 1.0, original.valid), select(0.0, 1.0, distorted.valid), distortedUv);
}`;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Water gather regression requires Dawn');
  const device = await adapter.requestDevice();
  const depth = device.createTexture({
    size: [4, 4],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const backdrop = device.createTexture({
    size: [4, 4],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const depths = new Float32Array(16).fill(0.3);
  const pixels = new Float32Array(64);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      if (x >= 2 && y >= 1) depths[y * 4 + x] = 1;
      pixels.set([x, y, x + y, 1], (y * 4 + x) * 4);
    }
  device.queue.writeTexture({ texture: depth }, depths, { bytesPerRow: 16 }, [4, 4]);
  device.queue.writeTexture({ texture: backdrop }, pixels, { bytesPerRow: 64 }, [4, 4]);
  try {
    const actual = await dispatch(
      device,
      code,
      [
        { binding: 1, resource: depth.createView() },
        { binding: 2, resource: backdrop.createView() },
      ],
      4,
      2,
    );
    const expected = [
      [0.201953125, 0.301953125, 0.50390625, 8],
      [1, 1.301953125, 2.301953125, 8],
      [0.201953125, 0.301953125, 0.50390625, 8],
      [0.051953125, 0.051953125, 0.10390625, 8],
    ];
    for (const [sample, values] of expected.entries())
      for (let lane = 0; lane < 4; lane++)
        expect
          .soft(actual[sample * 8 + lane], `gather ${sample}/${lane}`)
          .toBeCloseTo(values[lane] ?? 0, 5);
    expect(actual[2 * 8 + 5]).toBe(0);
    expect(actual[3 * 8 + 5]).toBe(1);
    expect(actual[3 * 8 + 6]).toBeCloseTo(0.1375, 6);
    expect(actual[3 * 8 + 7]).toBeCloseTo(0.1375, 6);
  } finally {
    depth.destroy();
    backdrop.destroy();
    device.destroy();
  }
});
