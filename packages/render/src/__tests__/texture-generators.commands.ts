import type {
  Asset,
  ManifestEntry,
  TextureGeneratorAsset,
  TextureGeneratorPrograms,
} from '@forgeax/engine-types';
import { sha256, validateTextureGenerator } from '@forgeax/engine-types';
import type {} from 'vitest/browser';
import waterImpulsePack from '../../../content/assets/water/impulse-noise.pack';
import waterSurfacePack from '../../../content/assets/water/surface-textures.pack';
import waterVolumePack from '../../../content/assets/water/volume-noise.pack';
import { CONTENT_SOURCE_KEYS } from '../../../content/src/ids';
import { getCompilerFingerprint } from '../../../naga/src/index';
import {
  TEXTURE_GENERATOR_VERTEX_ENTRY,
  TEXTURE_GENERATOR_VERTEX_SOURCE,
} from '../../../shader/src/texture-generator-source';
import { compileShader } from '../../../shader-compiler/src/index';
import { createTextureGeneratorPackCooker } from '../../../shader-compiler/src/texture-generator-cooker';

export const textureGeneratorFixtureSources = [
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

export async function prepareTextureGeneratorPrograms(): Promise<TextureGeneratorPrograms> {
  const entries: ManifestEntry[] = [];
  for (const [id, source] of textureGeneratorFixtureSources) {
    const result = (
      await compileShader(`${source}\n${TEXTURE_GENERATOR_VERTEX_SOURCE}`, {
        id: id,
        renderEntries: {
          vertex: TEXTURE_GENERATOR_VERTEX_ENTRY,
          fragment: id.endsWith('paint') ? 'paint' : 'normal',
          colorFormats: id.endsWith('paint')
            ? ['rgba8unorm-srgb', 'rgba8unorm', 'r16float']
            : ['rgba8unorm'],
        },
      })
    ).unwrap();
    entries.push({
      ...result.manifestEntry,
      glsl: '',
      identifier: id,
      sourceDigest: sha256(result.wgsl),
    });
  }
  return {
    compilerFingerprint: (await getCompilerFingerprint()).unwrap(),
    entries,
    passes: [
      {
        module: 'test::gpu-paint',
        fragmentEntry: 'paint',
        colorFormats: ['rgba8unorm-srgb', 'rgba8unorm', 'r16float'],
      },
      { module: 'test::gpu-normal', fragmentEntry: 'normal', colorFormats: ['rgba8unorm'] },
    ],
  };
}
export async function prepareDerivedTextureGeneratorPrograms(): Promise<TextureGeneratorPrograms> {
  const module = 'test::gpu-derived';
  const source = `
    struct Params { _textureLayer: u32, sliceValues: array<vec4<f32>, 2> };
    @group(0) @binding(0) var<uniform> params: Params;
    @group(0) @binding(1) var source: texture_2d<f32>;
    @fragment fn derived() -> @location(0) vec4<f32> {
      return vec4<f32>(textureLoad(source, vec2<i32>(0), 4).r, params.sliceValues[params._textureLayer].g, 0.0, 1.0);
    }
  `;
  const result = (
    await compileShader(`${source}\n${TEXTURE_GENERATOR_VERTEX_SOURCE}`, {
      id: module,
      renderEntries: {
        vertex: TEXTURE_GENERATOR_VERTEX_ENTRY,
        fragment: 'derived',
        colorFormats: ['rgba8unorm'],
      },
    })
  ).unwrap();
  return {
    compilerFingerprint: (await getCompilerFingerprint()).unwrap(),
    entries: [
      { ...result.manifestEntry, glsl: '', identifier: module, sourceDigest: sha256(result.wgsl) },
    ],
    passes: [{ module, fragmentEntry: 'derived', colorFormats: ['rgba8unorm'] }],
  };
}
export async function prepareWaterVolumeRecipe(): Promise<TextureGeneratorAsset> {
  const outputs = (await waterVolumePack.build({} as never)).unwrap();
  const texture = outputs[CONTENT_SOURCE_KEYS.waterTexture('volume-noise')];
  if (texture?.kind !== 'gpu-texture') throw new Error('Water volume must publish a GPU texture');
  const source = Object.values(outputs).find((asset) => asset.kind === 'texture-generator');
  const cooker = createTextureGeneratorPackCooker();
  const product = await cooker.cook({ guid: texture.source.generator, source }, {} as never);
  if (Object.keys(product.artifacts).length !== 0) throw new Error('Unexpected baked Water voxels');
  return validateTextureGenerator(product.payload, true).unwrap();
}

export async function prepareWaterSurfaceTextures(): Promise<Readonly<Record<string, Asset>>> {
  return prepareWaterTexturePack((await waterSurfacePack.build({} as never)).unwrap());
}

export async function prepareWaterImpulseNoise(): Promise<Readonly<Record<string, Asset>>> {
  return prepareWaterTexturePack((await waterImpulsePack.build({} as never)).unwrap());
}

async function prepareWaterTexturePack(authored: Readonly<Record<string, Asset>>) {
  const cooker = createTextureGeneratorPackCooker();
  const results = await Promise.all(
    Object.entries(authored).map(async ([key, source]) => {
      if (source.kind !== 'texture-generator') return [key, source] as const;
      const product = await cooker.cook({ guid: key, source }, {} as never);
      if (Object.keys(product.artifacts).length !== 0)
        throw new Error('Unexpected baked Water pixels');
      return [key, validateTextureGenerator(product.payload, true).unwrap()] as const;
    }),
  );
  return Object.fromEntries(results);
}

export const textureGeneratorCommands = {
  prepareWaterImpulseNoise: () => prepareWaterImpulseNoise(),
  prepareWaterSurfaceTextures: () => prepareWaterSurfaceTextures(),
  prepareWaterVolumeRecipe: () => prepareWaterVolumeRecipe(),
  prepareTextureGeneratorPrograms: () => prepareTextureGeneratorPrograms(),
  prepareDerivedTextureGeneratorPrograms: () => prepareDerivedTextureGeneratorPrograms(),
};
declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareWaterImpulseNoise(): Promise<Readonly<Record<string, Asset>>>;
    prepareWaterSurfaceTextures(): Promise<Readonly<Record<string, Asset>>>;
    prepareWaterVolumeRecipe(): Promise<TextureGeneratorAsset>;
    prepareTextureGeneratorPrograms(): Promise<TextureGeneratorPrograms>;
    prepareDerivedTextureGeneratorPrograms(): Promise<TextureGeneratorPrograms>;
  }
}
