import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker';

it.each([
  false,
  true,
])('publishes custom Surface textures beside built-in resources (helper=%s)', async (helper) => {
  const root = await mkdtemp(join(tmpdir(), 'surface-resources-'));
  try {
    const sampling = `#define_import_path test::sample_layers
#import forgeax_material::parameters::{material, paletteTexture, paletteTexture_sampler, albedoLayers, albedoLayers_sampler}
fn sample_layers(uv: vec2<f32>, layer: i32) -> vec4<f32> {
  return textureSample(paletteTexture, paletteTexture_sampler, uv) *
    textureSample(albedoLayers, albedoLayers_sampler, uv, layer) * material.baseColor;
}`;
    await writeFile(join(root, 'sample.wgsl'), sampling);
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path test::layered_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
${helper ? '#import test::sample_layers::{sample_layers}' : sampling.replace('#define_import_path test::sample_layers', '')}
#import forgeax_material::parameters::{normalTexture, normalTexture_sampler}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let color = sample_layers(input.uv0, i32(round(input.uv1.x)));
  let normal = textureSample(normalTexture, normalTexture_sampler, input.uv0).rgb;
  return SurfaceData(color.rgb, normalize(input.vertexNormalWS + normal * 0.1), 0.0, 0.5, vec3<f32>(0.0), 1.0, color.a, 0.5);
}`,
    );
    const source: MaterialAsset = {
      kind: 'material',
      colorSpace: 'linear',
      parameters: standardSurfaceParameters([
        { name: 'paletteTexture', type: 'texture' },
        { name: 'albedoLayers', type: 'texture_2d_array' },
        { name: 'normalTexture', type: 'texture' },
      ]),
      passes: [
        {
          name: 'forward',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'test::layered_surface' },
          },
        },
        {
          name: 'deferred',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'test::layered_surface' },
          },
        },
        {
          name: 'shadow-caster',
          program: {
            module: 'forgeax::default-shadow-caster',
            moduleSlots: { surface: 'test::layered_surface' },
          },
        },
      ],
    };
    const cooked = await createMaterialPackCooker([root]).cook({ guid: 'layered-surface', source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const bounded = record.programs
      .flatMap((program) => program.selections)
      .filter(
        (selection) =>
          selection.context.pipeline !== 'ray' &&
          (selection.context.geometry === 'mesh' || selection.context.geometry === 'skinned'),
      );
    expect(bounded.length).toBeGreaterThan(0);
    for (const selection of bounded) expect(selection.abi?.positionBounds).toBe('standard-input');
    for (const pass of ['forward', 'deferred', 'shadow-caster']) {
      for (const address of ['direct', 'scene-index']) {
        const programs = record.programs.filter((program) =>
          program.selections.some(
            (selection) =>
              selection.pass === pass &&
              selection.address === address &&
              selection.context.capability === 'storage-buffer',
          ),
        );
        expect(programs.length, `${pass}/${address}`).toBeGreaterThan(0);
        for (const program of programs) {
          const wgsl = new TextDecoder().decode(program.artifact.bytes);
          expect(wgsl).toMatch(/texture_2d_array<f32>/);
          expect(wgsl).toContain('textureSample');
          const selection = program.selections.find(
            (selection) => selection.pass === pass && selection.address === address,
          );
          expect(selection?.abi?.vertexInputs.some((input) => input.semantic === 'uv1')).toBe(true);
          if (address === 'scene-index')
            expect(selection?.abi?.sceneIndexEntry).toBe('vs_scene_index');
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it.each([
  ['undeclared', 'paletteTexture', 'shader-compile-failed'],
  ['load-only', 'normalTexture', 'material-shader-binding-mismatch'],
] as const)(
  'rejects %s Surface resource sampling',
  async (invalid, texture, code) => {
    const root = await mkdtemp(join(tmpdir(), 'invalid-surface-resources-'));
    try {
      await writeFile(
        join(root, 'surface.wgsl'),
        `#define_import_path test::invalid_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{${texture}, ${texture}_sampler}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let color = textureSample(${texture}, ${texture}_sampler, input.uv0);
  return SurfaceData(color.rgb, input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, color.a, 0.0);
}`,
      );
      const source: MaterialAsset = {
        kind: 'material',
        parameters: standardSurfaceParameters(
          invalid === 'undeclared'
            ? []
            : [{ name: texture, type: 'texture', sampleType: 'unfilterable-float' }],
        ),
        passes: [
          {
            name: 'forward',
            program: {
              module: 'forgeax_material::standard',
              moduleSlots: { surface: 'test::invalid_surface' },
            },
          },
        ],
      };
      await expect(
        createMaterialPackCooker([root]).cook({ guid: 'invalid-surface', source }),
      ).rejects.toMatchObject({ code });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
