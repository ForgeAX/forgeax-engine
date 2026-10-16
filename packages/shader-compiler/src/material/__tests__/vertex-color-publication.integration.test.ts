import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker';

it('publishes and selects color and plain ABI programs for one custom Surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surface-color-publication-'));
  try {
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path test::color
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(input.vertexColor.rgb, input.geometricNormalWS, 0.0, 0.5, input.vertexColor.rgb, 1.0, 1.0, 0.0);
}`,
    );
    const source: MaterialAsset = {
      kind: 'material',
      parameters: standardSurfaceParameters([]),
      passes: [
        {
          name: 'forward',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'test::color' },
          },
        },
      ],
    };
    const cooked = await createMaterialPackCooker([root]).cook({ guid: 'colors', source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    for (const capability of [
      'storage-buffer-minimum',
      'storage-buffer-projector',
      'storage-buffer',
      'storage-buffer-atmosphere',
    ]) {
      for (const visibleSurface of [false, true]) {
        for (const address of ['direct', 'scene-index'] as const) {
          const keys = new Set<string>();
          for (const color of [false, true]) {
            const matches = record.programs.filter((p) =>
              p.selections.some(
                (s) =>
                  s.address === address &&
                  s.context.pipeline !== 'ray' &&
                  s.context.capability === capability &&
                  (s.context.visibleSurface === true) === visibleSurface &&
                  s.abi?.vertexInputs.some((input) => input.semantic === 'color') === color,
              ),
            );
            expect(matches).toHaveLength(1);
            const artifact = matches[0];
            if (artifact === undefined) throw new Error('missing cooked variant');
            keys.add(artifact.specializationKey);
            expect(artifact).toBeDefined();
            const wgsl = new TextDecoder().decode(artifact?.artifact.bytes);
            expect(/@location\(14\)/.test(wgsl)).toBe(color);
          }
          expect(keys.size).toBe(2);
        }
      }
    }
    // Both portable contexts retain distinct plain/color selections. Their
    // shared capability must not collapse the backend-owned compilation.
    for (const backend of ['webgpu', 'webgl2']) {
      for (const color of [false, true]) {
        const matches = record.programs.filter((program) =>
          program.selections.some(
            (selection) =>
              selection.address === 'direct' &&
              selection.context.backend === backend &&
              selection.context.capability === 'uniform-fallback' &&
              selection.abi?.vertexInputs.some((input) => input.semantic === 'color') === color,
          ),
        );
        expect(matches).toHaveLength(1);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('publishes only the plain ABI when the Surface closure never reads vertexColor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surface-colorless-publication-'));
  try {
    // The helper mentions vertexColor only in comments; neither module reads it.
    await writeFile(
      join(root, 'helper.wgsl'),
      `#define_import_path test::plain_helper
// vertexColor is not consumed here: the palette travels in uv1.
/* input.vertexColor would be the constant 1 on colorless meshes. */
fn palette(uv : vec2<f32>) -> vec3<f32> { return vec3<f32>(uv, 0.5); }`,
    );
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path test::plain
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import test::plain_helper::{palette}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(palette(input.uv1), input.geometricNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`,
    );
    const source: MaterialAsset = {
      kind: 'material',
      parameters: standardSurfaceParameters([]),
      passes: [
        {
          name: 'forward',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'test::plain' },
          },
        },
      ],
    };
    const cooked = await createMaterialPackCooker([root]).cook({ guid: 'plain', source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const raster = record.programs.flatMap((p) =>
      p.selections.filter((s) => s.context.pipeline !== 'ray'),
    );
    expect(raster.length).toBeGreaterThan(0);
    expect(
      raster.some((s) => s.abi?.vertexInputs.some((input) => input.semantic === 'color') === true),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('keeps the color ABI when only an imported Surface helper reads vertexColor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surface-helper-color-publication-'));
  try {
    await writeFile(
      join(root, 'helper.wgsl'),
      `#define_import_path test::tint_helper
#import forgeax_material::surface_v1::{SurfaceInput}
fn tint(input : SurfaceInput) -> vec3<f32> { return input.vertexColor.rgb; }`,
    );
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path test::tinted
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import test::tint_helper::{tint}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(tint(input), input.geometricNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`,
    );
    const source: MaterialAsset = {
      kind: 'material',
      parameters: standardSurfaceParameters([]),
      passes: [
        {
          name: 'forward',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'test::tinted' },
          },
        },
      ],
    };
    const cooked = await createMaterialPackCooker([root]).cook({ guid: 'tinted', source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    expect(
      record.programs.some((p) =>
        p.selections.some(
          (s) =>
            s.context.pipeline !== 'ray' &&
            s.abi?.vertexInputs.some((input) => input.semantic === 'color') === true,
        ),
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
