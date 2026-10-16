import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const files = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'standard-surface.wgsl',
] as const;

const profiles = [
  { name: 'receiver opt-out', backfaces: false, defines: {}, clearcoat: 0 },
  { name: 'base backfaces', backfaces: true, defines: {}, clearcoat: 0 },
  {
    name: 'clearcoat backfaces',
    backfaces: true,
    defines: { CLEARCOAT_AVAILABLE: true },
    clearcoat: 0.65,
  },
  {
    name: 'diffuse transmission backfaces',
    backfaces: true,
    defines: { DIFFUSE_TRANSMISSION_AVAILABLE: true },
    clearcoat: 0,
  },
  {
    name: 'refraction backfaces',
    backfaces: true,
    defines: { TRANSMISSION_AVAILABLE: true },
    clearcoat: 0,
  },
];
const cases = files.flatMap((file) =>
  (file === 'standard-surface.wgsl'
    ? [...profiles, { name: 'runtime clearcoat', backfaces: true, defines: {}, clearcoat: 0.65 }]
    : profiles
  ).map((profile) => ({ file, ...profile })),
);

function receiverClause(file: (typeof files)[number]): string {
  const text = source(file);
  const start = text.search(/(?:let|var) directionalShadow =/);
  const end = text.indexOf(
    file === 'standard-surface.wgsl' ? '  let directionalBase' : '  color +=',
    start,
  );
  if (start < 0 || end < 0) throw new Error(`Missing directional receiver in ${file}`);
  // Observe the real call site without changing the sampled shadow function.
  return text.slice(start, end).replaceAll('evalDirectionalShadowFactorAtPixel(', 'countedShadow(');
}

const common = `
#define_import_path forgeax_view::common
struct View {
  lightDir: vec3<f32>, lightColor: vec3<f32>,
  depthBias: f32, normalBias: f32, cascadeCount: f32, cascadeBlend: f32,
  splitPlanes: array<vec4<f32>, 4>, directionalShadowFilter: vec4<f32>,
  lightViewProj_A: mat4x4<f32>, lightViewProj_B: mat4x4<f32>,
  lightViewProj_C: mat4x4<f32>, lightViewProj_D: mat4x4<f32>,
}
const identity = mat4x4<f32>(vec4(1.0,0.0,0.0,0.0), vec4(0.0,1.0,0.0,0.0),
  vec4(0.0,0.0,1.0,0.0), vec4(0.0,0.0,0.0,1.0));
const view = View(vec3(0.0,0.0,-1.0), vec3(1.0), 0.001, 0.02, 3.0, 0.2,
  array<vec4<f32>,4>(vec4(2.0,0.25,1.0,0.0), vec4(4.0,0.25,1.0,0.0),
    vec4(6.0,0.25,1.0,0.0), vec4(6.0,0.25,1.0,0.0)),
  vec4(3.0,0.01,4.0,0.0), identity, identity, identity, identity);
@group(0) @binding(0) var shadowMap: texture_depth_2d_array;
@group(0) @binding(1) var shadowSampler: sampler_comparison;
`;

it.each(cases)('$file preserves PCF5 radiance: $name', async (profile) => {
  const { file, backfaces, defines, clearcoat } = profile;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn receiver regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const depth = device.createTexture({
    size: [8, 8, 6],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const color = device.createTexture({
    size: [16, 4],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const reference = device.createTexture({
    size: [16, 4],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 2 * 16 * 4 * 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const fullscreen = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4(f32((i << 1u) & 2u)*2.0-1.0, 1.0-f32(i & 2u)*2.0, 0.0, 1.0);
}`;
    const seed = device.createShaderModule({
      code: `${fullscreen}
override layer: u32;
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  return select(0.35, 0.65, (u32(p.x) + u32(p.y) + layer) % 3u == 0u);
}`,
    });
    const seedPipelines = await Promise.all(
      Array.from({ length: 6 }, (_, layer) =>
        device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module: seed, entryPoint: 'vs' },
          fragment: { module: seed, entryPoint: 'fs', targets: [], constants: { layer } },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
        }),
      ),
    );
    const layerBase = file === 'default-standard-pbr.wgsl' ? 'directionalLayerBase' : '0u';
    const code = await composeShader(
      `
#import forgeax_pbr::lighting_directional::{evalDirectionalShadowFactorAtPixel, evalDirectionalNoShadow}
#import forgeax_view::common::{view}
var<private> shadowCalls: u32;
fn countedShadow(n: vec3<f32>, p: vec3<f32>, z: f32, base: u32, pixel: vec2<f32>) -> f32 {
  shadowCalls += 1u;
  return evalDirectionalShadowFactorAtPixel(n, p, z, base, pixel);
}
struct Input { worldPos: vec3<f32>, viewZ: f32, clip: vec4<f32> }
struct Factors { receiveShadows: bool, clearcoat: f32 }
struct Output { @location(0) actual: vec4<f32>, @location(1) reference: vec4<f32> }
fn standardViewZ(input: Input) -> f32 { return input.viewZ; }
${fullscreen}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> Output {
  let x = u32(p.x);
  let y = u32(p.y);
  let receiveShadows = y % 2u != 0u;
  let factors = Factors(receiveShadows, ${clearcoat});
  let depths = array<f32,4>(1.0, 1.9, 3.9, 7.0);
  let in = Input(vec3((f32(x)-8.0)/4.0,0.0,0.5), -depths[x % 4u], p);
  let normalZ = array<f32,4>(1.0, 0.0, -1.0, -0.000001);
  let n = normalize(vec3(select(-0.4,0.4,y >= 2u),0.0,${backfaces ? 'normalZ[x % 4u]' : '1.0'}));
  let physicalNormal = n;
  // A normal map or a two-sided surface can disagree with the receiver plane.
  let directionalShadowNormal = ${backfaces ? 'normalize(vec3(-0.4,0.0,select(-1.0,1.0,y >= 2u)))' : 'n'};
  let directionalLayerBase = select(0u,3u,y >= 2u);
  ${receiverClause(file)}
  let expected = select(1.0,
    evalDirectionalShadowFactorAtPixel(${file === 'standard-surface.wgsl' ? 'n' : 'directionalShadowNormal'}, in.worldPos, in.viewZ, ${layerBase}, p.xy), receiveShadows);
  var unshadowed = vec3<f32>(1.0);
  if (${backfaces}) {
    var transmission = vec3<f32>(0.0);
#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
    transmission = ${file === 'standard-surface.wgsl' ? 'vec3<f32>(0.0)' : 'vec3<f32>(0.2,0.4,0.6)'};
#endif
    let direction = normalize(vec3<f32>(0.2,0.1,1.0));
    unshadowed = evalDirectionalNoShadow(n, direction, vec3<f32>(0.8,0.4,0.2),
      0.0, 0.25, vec3<f32>(0.04), transmission, false);
    if (factors.clearcoat != 0.0) {
      unshadowed += factors.clearcoat * evalDirectionalNoShadow(${file === 'standard-surface.wgsl' ? 'n' : '-n'},
        direction, vec3<f32>(0.0), 1.0, 0.16, vec3<f32>(0.04), vec3<f32>(0.0), false);
    }
  }
  return Output(vec4(directionalShadow * unshadowed, f32(shadowCalls)),
    vec4(expected * unshadowed, 1.0));
}`,
      {
        'forgeax_view::common': common,
        'forgeax_pbr::lighting_directional': source('lighting-directional.wgsl'),
        'forgeax_pbr::brdf': source('brdf.wgsl'),
        'forgeax_pbr::shadow_pcf': source('shadow-pcf.wgsl'),
      },
      defines,
    );
    const module = device.createShaderModule({ code });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: 'rgba32float' }, { format: 'rgba32float' }],
      },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depth.createView({ dimension: '2d-array' }) },
        {
          binding: 1,
          resource: device.createSampler({
            compare: 'greater',
            minFilter: 'linear',
            magFilter: 'linear',
          }),
        },
      ],
    });
    const encoder = device.createCommandEncoder();
    for (const [layer, seedPipeline] of seedPipelines.entries()) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      pass.setPipeline(seedPipeline);
      pass.draw(3);
      pass.end();
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: color.createView(), loadOp: 'clear', storeOp: 'store' },
        { view: reference.createView(), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: color },
      { buffer: readback, bytesPerRow: 256 },
      [16, 4],
    );
    encoder.copyTextureToBuffer(
      { texture: reference },
      { buffer: readback, offset: 1024, bytesPerRow: 256 },
      [16, 4],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect(errors).toEqual([]);
    expect(pixels.length).toBe(512);
    expect(pixels.every(Number.isFinite)).toBe(true);
    const lit: number[] = [];
    const calls: number[] = [];
    for (let i = 0; i < 64; i++) {
      const receiveShadows = Math.floor(i / 16) % 2 === 1;
      expect(pixels[256 + i * 4 + 3]).toBe(1);
      for (let channel = 0; channel < 3; channel++) {
        expect(pixels[i * 4 + channel], `PCF5 pixel ${i} channel ${channel}`).toBe(
          pixels[256 + i * 4 + channel],
        );
      }
      calls.push(pixels[i * 4 + 3] ?? Number.NaN);
      if (receiveShadows) lit.push(pixels[i * 4] ?? Number.NaN);
      else if (!backfaces) expect(pixels[i * 4]).toBe(1);
    }
    if (!backfaces) {
      expect(Math.min(...lit)).toBeLessThan(0.9);
      expect(Math.max(...lit)).toBe(1);
    } else {
      expect(Math.max(...lit)).toBeGreaterThan(0);
    }
    const preserveBackfaces = Object.keys(defines).length > 0 || clearcoat !== 0;
    expect(calls, 'Only receivers execute the directional shadow function').toEqual(
      Array.from({ length: 64 }, (_, i) => {
        const receive = Math.floor(i / 16) % 2;
        return receive && (!backfaces || preserveBackfaces || i % 4 === 0) ? 1 : 0;
      }),
    );
  } finally {
    depth.destroy();
    color.destroy();
    reference.destroy();
    readback.destroy();
    device.destroy();
  }
});
