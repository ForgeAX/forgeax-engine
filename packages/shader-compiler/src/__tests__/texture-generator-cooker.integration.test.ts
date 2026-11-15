import { prepareDirectPackTransport } from '@forgeax/engine-import';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import { validateTextureGenerator } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createTextureGeneratorPackCooker } from '../texture-generator-cooker.js';

const textureGeneratorFixtureSources = [
  [
    'test::gpu-paint',
    `
struct Params { seed: u32, wear: f32 };
@group(0) @binding(0) var<uniform> params: Params;
struct Paint { @location(0) albedo: vec4<f32>, @location(1) orm: vec4<f32>, @location(2) height: f32 };
@fragment fn paint(@builtin(position) position: vec4<f32>) -> Paint {
 let checker = f32((u32(position.x) + u32(position.y) + params.seed) % 2u);
 var result: Paint;
 result.albedo = vec4<f32>(vec3<f32>(checker * (1.0 - params.wear)), 1.0);
 result.orm = vec4<f32>(1.0, params.wear, 0.2, 1.0);
 result.height = checker;
 return result;
}`,
  ],
  [
    'test::gpu-normal',
    `
@group(0) @binding(0) var height: texture_2d<f32>;
@fragment fn normal(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
 let size = vec2<i32>(textureDimensions(height));
 let p = vec2<i32>(position.xy);
 let dx = textureLoad(height, (p + vec2<i32>(1, 0)) % size, 0).r - textureLoad(height, p, 0).r;
 let dy = textureLoad(height, (p + vec2<i32>(0, 1)) % size, 0).r - textureLoad(height, p, 0).r;
 let n = normalize(vec3<f32>(-dx, -dy, 1.0));
 return vec4<f32>(n * 0.5 + 0.5, 1.0);
}`,
  ],
] as const;

it('prepares a portable program closure with shader dependencies and no pixel artifacts', async () => {
  const shape = { viewDimension: '2d', extent: { width: 16, height: 16 } } as const;
  const linear = {
    shape,
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'generate' },
  } as const;
  const recipe = {
    kind: 'texture-generator',
    values: { seed: 42, wear: 0 },
    inputs: {},
    outputs: {
      albedo: { ...linear, format: 'rgba8unorm-srgb', colorSpace: 'srgb' },
      orm: linear,
      normal: linear,
    },
    transient: { height: { shape, format: 'r16float' } },
    passes: [
      {
        kind: 'raster',
        program: { module: 'test::gpu-paint', fragmentEntry: 'paint' },
        reads: {},
        writes: ['albedo', 'orm', 'height'],
      },
      {
        kind: 'raster',
        program: { module: 'test::gpu-normal', fragmentEntry: 'normal' },
        reads: { height: { kind: 'local', name: 'height' } },
        writes: ['normal'],
      },
    ],
  };
  const project: { moduleId: string; path: string; source: string }[] =
    textureGeneratorFixtureSources.map(([moduleId, source], index) => ({
      moduleId: moduleId,
      path: `/fixture/${index}.wgsl`,
      source: `#define_import_path ${moduleId}\n${source}`,
    }));
  project.push({
    moduleId: 'test::unused',
    path: '/fixture/unused.wgsl',
    source: '#define_import_path test::unused\n#import missing::surface::shade\n',
  });
  const cooker = createTextureGeneratorPackCooker([], {
    sourceSnapshot: { roots: [], engine: [], project, identity: 'fixture' },
  });
  const product = await cooker.cook(
    { guid: 'db36d338-b320-5d2f-8472-4eb7aad98610', source: recipe },
    {} as never,
  );
  expect(validateTextureGenerator(product.payload, true).ok).toBe(true);
  expect(product.sourceDependencies).toEqual(['/fixture/0.wgsl', '/fixture/1.wgsl']);
  expect(product.artifacts).toEqual({});
  expect(JSON.stringify(product.payload)).not.toContain('"data"');
  const parsed = parsePackSourceJson({
    schemaVersion: '3.0.0',
    packageId: '01900000-0000-7000-8000-000000000010',
    assets: {
      'generator/paint': { kind: 'texture-generator', payload: recipe, refs: [] },
      'gpu-texture/paint/albedo': {
        kind: 'gpu-texture',
        payload: {
          kind: 'gpu-texture',
          source: {
            kind: 'generated',
            generator: 'db36d338-b320-5d2f-8472-4eb7aad98610',
            output: 'albedo',
          },
        },
        refs: ['db36d338-b320-5d2f-8472-4eb7aad98610'],
      },
    },
  }).unwrap();
  if (parsed.format !== 'direct') throw new Error('expected authored Pack');
  const direct = (
    await prepareDirectPackTransport({
      projected: projectDirectPackJson(parsed),
      sourcePath: '/fixture/paint.pack.json',
      sourceRevision: 'sha256:fixture',
      cookers: [cooker],
      policy: {
        base: '/',
        packagePath: 'fixture.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
      },
    })
  ).unwrap();
  const published = direct.finalized.pack.assets;
  expect(published).toHaveLength(2);
  const generated = published.find((asset) => asset.kind === 'gpu-texture');
  if (!generated) throw new Error('Generated texture missing');
  expect(generated.payload).toEqual({
    kind: 'gpu-texture',
    source: {
      kind: 'generated',
      generator: 'db36d338-b320-5d2f-8472-4eb7aad98610',
      output: 'albedo',
    },
  });
  expect(generated.artifacts).toEqual({});

  const payload = product.payload as Record<string, unknown>;
  const programs = payload.programs as { entries: { wgsl: string }[] };
  const first = programs.entries[0];
  if (!first) throw new Error('Program missing');
  first.wgsl += '\n// changed';
  expect(validateTextureGenerator(payload, true).ok).toBe(false);
});
