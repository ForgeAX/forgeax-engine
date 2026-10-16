import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing probe test value');
  return value;
}

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
    return [required(/^#define_import_path\s+(\S+)/m.exec(source)?.[1]), source];
  }),
);

for (const template of ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl']) {
  for (const sceneIndex of [false, true]) {
    it(`${template} ${sceneIndex ? 'scene-index' : 'direct'} reads SH only for contributing probes`, async () => {
      const compiler = await import(
        /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
      );
      const templateSource = readFileSync(resolve(shaderRoot, template), 'utf8');
      const start = templateSource.indexOf('  var probeShPreblend :');
      const end = templateSource.indexOf('  let environment =', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const productionBlock = templateSource.slice(start, end);
      // Count requested coefficient reads without replacing the production
      // header/identity/control flow. This is a work falsifier, not a claim
      // about uninstrumented driver memory traffic or GPU timing.
      const coefficientRead = /probeBlendRecords\[(probeBase \+ \du)\]/g;
      expect([...productionBlock.matchAll(coefficientRead)]).toHaveLength(9);
      const block = productionBlock.replace(coefficientRead, 'readCoefficient($1)');
      const compiled = await compiler.compileShader(
        `#import forgeax_pbr::standard_lighting::{SkylightUniforms, evaluateStandardEnvironment}
struct Input { materialAddress: vec4<u32> };
struct Parameters { address: vec4<u32>, expected: vec4<f32> };
@group(0) @binding(100) var<storage, read> probeBlendRecords: array<vec4<f32>>;
@group(0) @binding(101) var<uniform> parameters: Parameters;
@group(0) @binding(102) var irradiance: texture_cube<f32>;
@group(0) @binding(103) var prefilter: texture_cube<f32>;
@group(0) @binding(104) var brdf: texture_2d<f32>;
@group(0) @binding(105) var sampleState: sampler;
var<private> coefficientReads: u32;
fn readCoefficient(index: u32) -> vec4<f32> {
  coefficientReads += 1u;
  return probeBlendRecords[index];
}
fn environment(sh: array<vec4<f32>, 9>, blend: f32) -> vec3<f32> {
  let sky = SkylightUniforms(0.55, 1.0, 1.0, 1.0,
    vec4<f32>(0.0, 0.0, 0.0, 1.0), vec4<f32>(1.0), vec4<f32>(0.0, 0.0, 0.0, 1.0));
  let result = evaluateStandardEnvironment(vec3<f32>(0.0), vec3<f32>(0.0, 0.0, 1.0),
    vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.7, 0.5, 0.3),
    vec3<f32>(0.4, 0.2, 0.1) * parameters.expected.y, 0.0, 0.6, vec3<f32>(0.04),
    sky, irradiance, sampleState, prefilter, sampleState, brdf, prefilter, sh, blend);
  return result.diffuse + result.specular;
}
fn candidate() -> vec4<f32> {
  let in = Input(parameters.address);
${block}
  return vec4<f32>(environment(probeShPreblend, probeLocalBlendFraction), f32(coefficientReads));
}
fn reference() -> vec4<f32> {
  var sh: array<vec4<f32>, 9>;
  sh[0] = vec4<f32>(4.0, 2.0, 1.0, 0.0) * parameters.expected.z;
  return vec4<f32>(environment(sh, parameters.expected.x), 1.0);
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  if (p.x < 1.0) { return candidate(); }
  return reference();
}`,
        {
          id: `probe-sh-load-${template}-${sceneIndex}`,
          imports,
          defines: {
            STORAGE_BUFFER_AVAILABLE: true,
            CLUSTER_FORWARD_AVAILABLE: false,
            PROBE_BLEND_AVAILABLE: true,
            GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
          },
          renderEntries: { vertex: 'vs', fragment: 'fs' },
        },
      );
      if (!compiled.ok) throw compiled.error;
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) throw new Error('Dawn adapter unavailable');
      const device = await adapter.requestDevice();
      const errors: string[] = [];
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const record = device.createBuffer({
        size: 512,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const uniform = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const readback = device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      const output = device.createTexture({
        size: [2, 1],
        format: 'rgba32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const textures = [6, 6, 1].map((layers) =>
        device.createTexture({
          size: [1, 1, layers],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        }),
      );
      try {
        for (const [i, texture] of textures.entries()) {
          const bytes = new Uint8Array((i < 2 ? 6 : 1) * 4);
          for (let j = 0; j < bytes.length; j += 4)
            bytes.set(i === 2 ? [128, 64, 0, 255] : [128, 128, 128, 255], j);
          device.queue.writeTexture({ texture }, bytes, { bytesPerRow: 4, rowsPerImage: 1 }, [
            1,
            1,
            i < 2 ? 6 : 1,
          ]);
        }
        const module = device.createShaderModule({ code: compiled.value.wgsl });
        const pipeline = await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
        });
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 100, resource: { buffer: record } },
            { binding: 101, resource: { buffer: uniform } },
            { binding: 102, resource: required(textures[0]).createView({ dimension: 'cube' }) },
            { binding: 103, resource: required(textures[1]).createView({ dimension: 'cube' }) },
            { binding: 104, resource: required(textures[2]).createView() },
            {
              binding: 105,
              resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
            },
          ],
        });
        const cases = [
          { name: 'empty', header: [0, 0, 0, 0], blend: 0, factor: 1 },
          { name: 'zero', header: [0, 7, 0, 0], blend: 0, factor: 1 },
          { name: 'negative', header: [0, 7, -0.3, 0], blend: 0, factor: 1 },
          { name: 'positive', header: [0, 7, 0.65, 0], blend: 0.65, factor: 1 },
          { name: 'black-probe', header: [0, 7, 1, 0], blend: 1, factor: 0 },
          ...(sceneIndex
            ? [
                { name: 'stale-generation', header: [0, 8, 0.65, 0], blend: 0, factor: 1 },
                { name: 'wrong-slot', header: [5, 7, 0.65, 0], blend: 0, factor: 1 },
              ]
            : []),
        ];
        const observations: { name: string; transmission: number; rgb: number[]; reads: number }[] =
          [];
        for (const transmission of [0, 1])
          for (const sample of cases) {
            const data = new Float32Array(128),
              base = sceneIndex ? 64 : 0;
            data.set(sample.header, base);
            data.set([4 * sample.factor, 2 * sample.factor, sample.factor, 0], base + 4);
            const parameters = new ArrayBuffer(32);
            new Uint32Array(parameters, 0, 4).set([0, 1, 7, 0]);
            new Float32Array(parameters, 16, 4).set([sample.blend, transmission, sample.factor, 0]);
            device.queue.writeBuffer(record, 0, data);
            device.queue.writeBuffer(uniform, 0, parameters);
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
              [2, 1],
            );
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const pixels = new Float32Array(readback.getMappedRange()).slice(0, 8);
            readback.unmap();
            expect(Array.from(pixels).every(Number.isFinite), sample.name).toBe(true);
            for (let channel = 0; channel < 3; channel++)
              expect(
                Math.abs((pixels[channel] ?? Number.NaN) - (pixels[channel + 4] ?? Number.NaN)),
                sample.name,
              ).toBeLessThanOrEqual(1e-6);
            observations.push({
              name: sample.name,
              transmission,
              rgb: Array.from(pixels.slice(0, 3)),
              reads: pixels[3] ?? Number.NaN,
            });
          }
        expect(errors).toEqual([]);
        for (const observation of observations) {
          const sample = required(cases.find((value) => value.name === observation.name));
          expect(
            observation.reads,
            `${observation.name} transmission=${observation.transmission}`,
          ).toBe(sample.blend > 0 ? 9 : 0);
        }
        for (const transmission of [0, 1]) {
          const empty = required(
            observations.find(
              (value) => value.name === 'zero' && value.transmission === transmission,
            ),
          );
          const lit = required(
            observations.find(
              (value) => value.name === 'positive' && value.transmission === transmission,
            ),
          );
          expect(
            Math.abs((lit.rgb[0] ?? Number.NaN) - (empty.rgb[0] ?? Number.NaN)),
          ).toBeGreaterThan(0.01);
        }
      } finally {
        for (const texture of textures) texture.destroy();
        output.destroy();
        record.destroy();
        uniform.destroy();
        readback.destroy();
        device.destroy();
      }
    }, 120_000);
  }
}
