import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import {
  derive,
  isMaterialProgramBindingContract,
  type MaterialAsset,
  materialLightingInputBindings,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

const source = `#define_import_path game::lit_smoke
#import forgeax_view::common::{view}
#import forgeax_material::parameters::{material, flipbook, flipbook_sampler}
#import forgeax_material::lighting_inputs::{irradianceMap, irradianceSampler, prefilterMap, prefilterSampler, brdfLut, skylight, skylightPrefilterMap}
@group(0) @binding(1) var sceneDepth: texture_depth_2d;
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return view.worldViewProj * vec4<f32>(position, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let diffuse = textureSampleLevel(irradianceMap, irradianceSampler, vec3<f32>(0,1,0), 0).rgb;
  let local = textureSampleLevel(prefilterMap, prefilterSampler, vec2<f32>(.5), 0).rgb;
  let global = textureSampleLevel(skylightPrefilterMap, prefilterSampler, vec2<f32>(.5), 0).rgb;
  let brdf = textureLoad(brdfLut, vec2<i32>(0), 0).rgb;
  let sprite = textureSample(flipbook, flipbook_sampler, vec2<f32>(.5));
  let depth = textureLoad(sceneDepth, vec2<i32>(position.xy), 0);
  return vec4<f32>((diffuse + local + global + brdf + skylight.ambientIrradiance.xyz) * material.tint.rgb * sprite.rgb + vec3<f32>(depth), sprite.a);
}
`;
const parameters = [
  { name: 'tint', type: 'color' },
  { name: 'flipbook', type: 'texture' },
] as const;
const asset = (): MaterialAsset => ({
  kind: 'material',
  parameters,
  passes: [
    {
      name: 'color',
      program: {
        module: 'game::lit_smoke',
        bindings: 'render-lit-material-and-scene-depth',
        sceneDepth: 'before-pass',
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_main',
      },
      renderState: { tags: { LightMode: 'Forward' }, queue: 3000, depthWriteEnabled: false },
    },
  ],
});

async function withSource<T>(text: string, run: (root: string) => T | Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'lit-material-cook-'));
  try {
    await writeFile(join(root, 'lit-smoke.wgsl'), text);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('cooks custom smoke with its own schema, real Engine IBL and depth into a validated publication', async () => {
  expect(isMaterialProgramBindingContract('render-lit-material-and-scene-depth')).toBe(true);
  const product = await withSource(source, (root) =>
    createMaterialPackCooker([root]).cook({
      guid: '4aad2b27-4dd3-4989-85d1-a7893bb20f56',
      source: asset(),
    }),
  );
  const record = validateCookedMaterialRecord(
    (product.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expect(record.resolved.parameters.map((parameter) => parameter.name)).toEqual([
    'tint',
    'flipbook',
  ]);
  const bindings = materialLightingInputBindings(
    derive([
      { name: 'tint', type: 'color' },
      { name: 'flipbook', type: 'texture2d' },
    ]).userRegionBindingEnd,
  );
  expect(bindings.irradianceMap).not.toBe(17);
  const selections = record.programs.flatMap((program) => program.selections);
  expect(selections.length).toBeGreaterThan(0);
  expect(new Set(selections.map((selection) => selection.context.backend))).toEqual(
    new Set(['webgpu', 'webgl2']),
  );
  for (const selection of selections) {
    if (selection.pass !== 'color') continue;
    expect(selection.abi?.bindings).toBe('render-lit-material-and-scene-depth');
    const reads = selection.abi?.entryPoints?.flatMap((entry) =>
      entry.bindings.filter((binding) => binding.group === 1).map((binding) => binding.binding),
    );
    expect(reads).toEqual(expect.arrayContaining(Object.values(bindings)));
  }
  expect(
    Object.values(product.artifacts).some((artifact) =>
      new TextDecoder().decode(artifact.bytes).includes('irradianceMap'),
    ),
  ).toBe(true);
}, 120_000);

it('rejects an unrelated project binding rather than granting a broad Engine-resource exemption', async () => {
  const invalid = source
    .replace('@vertex fn', '@group(1) @binding(63) var unexpected: texture_2d<f32>;\n@vertex fn')
    .replace(
      'let depth =',
      'let arbitrary = textureLoad(unexpected, vec2<i32>(0), 0).rgb;\n  let depth =',
    )
    .replace('diffuse + local + global + brdf', 'arbitrary + diffuse + local + global + brdf');
  await expect(
    withSource(invalid, (root) =>
      createMaterialPackCooker([root], { profile: 'webgpu-storage' }).cook({
        guid: '4aad2b27-4dd3-4989-85d1-a7893bb20f56',
        source: asset(),
      }),
    ),
  ).rejects.toMatchObject({ code: 'material-derived-interface-mismatch' });
}, 120_000);

it('rejects a project declaration that impersonates an unused reserved Engine input', async () => {
  const binding = materialLightingInputBindings(
    derive([
      { name: 'tint', type: 'color' },
      { name: 'flipbook', type: 'texture2d' },
    ]).userRegionBindingEnd,
  ).skylightPrefilterMap;
  const invalid = source
    .replace(', skylightPrefilterMap}', '}')
    .replace(
      '@vertex fn',
      `@group(1) @binding(${binding}) var skylightPrefilterMap: texture_2d<f32>;\n@vertex fn`,
    );
  await expect(
    withSource(invalid, (root) =>
      createMaterialPackCooker([root], { profile: 'webgpu-storage' }).cook({
        guid: '4aad2b27-4dd3-4989-85d1-a7893bb20f56',
        source: asset(),
      }),
    ),
  ).rejects.toMatchObject({ code: 'shader-compile-failed' });
}, 120_000);

function lightingOnlySource(vertex: boolean): string {
  return `#define_import_path game::lit_smoke
#import forgeax_view::common::{view}
#import forgeax_material::lighting_inputs::{irradianceMap, irradianceSampler, prefilterMap, prefilterSampler, brdfLut, skylight, skylightPrefilterMap}
@group(0) @binding(1) var sceneDepth: texture_depth_2d;
fn environment() -> vec3<f32> {
  let diffuse = textureSampleLevel(irradianceMap, irradianceSampler, vec3<f32>(0,1,0), 0).rgb;
  let local = textureSampleLevel(prefilterMap, prefilterSampler, vec2<f32>(.5), 0).rgb;
  let global = textureSampleLevel(skylightPrefilterMap, prefilterSampler, vec2<f32>(.5), 0).rgb;
  return diffuse + local + global + textureLoad(brdfLut, vec2<i32>(0), 0).rgb + skylight.ambientIrradiance.xyz;
}
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return view.worldViewProj * vec4<f32>(position ${vertex ? '+ environment() * 0.001' : ''}, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(environment() + vec3<f32>(textureLoad(sceneDepth, vec2<i32>(position.xy), 0)), 1);
}
`;
}

it.each([
  false,
  true,
])('cooks lighting-only empty parameters without a user UBO (vertex sampling: %s)', async (vertex) => {
  const definition = asset();
  if (definition.passes === undefined) throw new Error('fixture requires a root material');
  const material: MaterialAsset = { kind: 'material', parameters: [], passes: definition.passes };
  const product = await withSource(lightingOnlySource(vertex), (root) =>
    createMaterialPackCooker([root], { profile: 'webgpu-storage' }).cook({
      guid: '4aad2b27-4dd3-4989-85d1-a7893bb20f56',
      source: material,
    }),
  );
  const record = validateCookedMaterialRecord(
    (product.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expect(record.resolved.parameters).toEqual([]);
  expect(derive([]).userRegionBindingEnd).toBe(0);
  const bindings = materialLightingInputBindings(0);
  expect(bindings.irradianceMap).toBe(0);
  for (const program of record.programs) {
    const text = new TextDecoder().decode(product.artifacts[program.artifact.path]?.bytes);
    expect(text).toMatch(/@group\(1\)\s*@binding\(0\)\s*var\s+irradianceMap/);
    expect(text).not.toMatch(/@group\(1\)\s*@binding\(0\)\s*var<uniform>/);
    for (const selection of program.selections) {
      expect(selection.abi?.materialRow.byteLength).toBe(0);
      expect(selection.abi?.resourceSlots).toEqual([]);
      const reads = selection.abi?.entryPoints?.flatMap((entry) =>
        entry.bindings.filter((binding) => binding.group === 1).map((binding) => binding.binding),
      );
      expect(reads).toEqual(expect.arrayContaining(Object.values(bindings)));
      const vertexReads =
        selection.abi?.entryPoints
          ?.filter((entry) => entry.stage === 'vertex')
          .flatMap((entry) =>
            entry.bindings
              .filter((binding) => binding.group === 1)
              .map((binding) => binding.binding),
          ) ?? [];
      if (vertex) expect(vertexReads).toEqual(expect.arrayContaining(Object.values(bindings)));
      else expect(vertexReads).toEqual([]);
    }
  }
}, 120_000);
