import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import type { MaterialAsset } from '@forgeax/engine-types';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { beforeAll, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

// The installed SDK failed this exact authored Surface after renderer recovery
// selected WebGL2. Cook its real source; no driver or synthetic program fixture.
const source: MaterialAsset = {
  kind: 'material',
  parameters: standardSurfaceParameters([
    { name: 'ironColor', type: 'color' },
    { name: 'rustDark', type: 'color' },
    { name: 'rustBright', type: 'color' },
    { name: 'noiseScale', type: 'f32' },
  ]),
  values: {
    ironColor: [0.4, 0.45, 0.47, 1],
    rustDark: [0.42, 0.085, 0.018, 1],
    rustBright: [0.95, 0.34, 0.055, 1],
    noiseScale: 1.85,
  },
  passes: [
    {
      name: 'forward',
      program: {
        module: 'forgeax_material::standard',
        fragmentEntry: 'fs_main',
        moduleSlots: { surface: 'game_3d::rusted_iron_surface' },
      },
    },
  ],
};

let record: CookedMaterialRecord;

beforeAll(async () => {
  const root = fileURLToPath(
    new URL('../../../../../templates/game-3d/assets/shaders/', import.meta.url),
  );
  const cooked = await createMaterialPackCooker([root]).cook({
    guid: '6c771936-3236-50c4-956c-ec4baa8fd381',
    source,
  });
  record = validateCookedMaterialRecord((cooked.payload as { cooked: unknown }).cooked).unwrap();
}, 60_000);

it.each([
  ['webgpu', 'storage-buffer'],
  ['webgpu', 'uniform-fallback'],
  ['webgl2', 'uniform-fallback'],
] as const)('publishes one direct authored program for %s/%s', (backend, capability) => {
  const programs = record.programs.filter((program) =>
    program.selections.some(
      (selection) =>
        selection.context.pipeline !== 'ray' &&
        selection.pass === 'forward' &&
        selection.context.backend === backend &&
        selection.context.capability === capability &&
        selection.context.geometry === 'mesh' &&
        selection.context.visibleSurface !== true &&
        selection.address === 'direct',
    ),
  );
  expect(programs).toHaveLength(1);
  expect(programs[0]?.artifact.bytes.byteLength).toBeGreaterThan(0);
  if (capability === 'uniform-fallback') {
    expect(
      record.programs.some((program) =>
        program.selections.some(
          (selection) =>
            selection.context.backend === backend &&
            selection.context.capability === capability &&
            selection.address === 'scene-index',
        ),
      ),
    ).toBe(false);
  }
});

it('cooks a custom mesh shader through the real WebGL2 uniform View ABI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-custom-webgl2-'));
  try {
    await writeFile(
      join(root, 'toon.wgsl'),
      `#define_import_path game::toon
#import forgeax_view::common::{view, meshes, instances}
#import forgeax_material::parameters::{material}
struct Input { @location(0) position: vec3<f32> }
@vertex fn vs_main(input: Input, @builtin(instance_index) index: u32) -> @builtin(position) vec4<f32> {
  return view.worldViewProj * meshes[0].worldFromLocal * instances[index].localFromInstance * vec4<f32>(input.position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return material.tint; }
`,
    );
    const cooked = await createMaterialPackCooker([root]).cook({
      guid: 'custom-toon',
      source: {
        kind: 'material',
        parameters: [{ name: 'tint', type: 'color' }],
        passes: [{ name: 'Forward', program: { module: 'game::toon' } }],
      },
    });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    expect(cooked.inputFingerprint).not.toBe(record.receipt.identity.sourceClosureDigest);
    const selected = (
      backend: 'webgpu' | 'webgl2',
      capability: 'storage-buffer' | 'uniform-fallback',
    ) =>
      record.programs.filter((program) =>
        program.selections.some(
          (selection) =>
            selection.pass === 'Forward' &&
            selection.context.backend === backend &&
            selection.context.capability === capability &&
            selection.address === 'direct',
        ),
      );
    expect(selected('webgpu', 'storage-buffer')).toHaveLength(1);
    expect(selected('webgl2', 'uniform-fallback')).toHaveLength(1);
    const native = new TextDecoder().decode(
      selected('webgpu', 'storage-buffer')[0]?.artifact.bytes,
    );
    const fallback = new TextDecoder().decode(
      selected('webgl2', 'uniform-fallback')[0]?.artifact.bytes,
    );
    expect(native).toMatch(/var<storage> meshes/);
    expect(fallback).toMatch(/var<uniform> meshes/);
    expect(fallback).toMatch(/var<uniform> instances/);
    expect(fallback).not.toMatch(/var<storage/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('publishes a storage-backed Standard program for a 16-texture WebGPU device', () => {
  const minimum = record.programs.filter((program) =>
    program.selections.some(
      (selection) =>
        selection.pass === 'forward' &&
        selection.context.backend === 'webgpu' &&
        selection.context.capability === 'storage-buffer-minimum' &&
        selection.context.geometry === 'mesh' &&
        selection.address === 'direct' &&
        selection.context.visibleSurface !== true,
    ),
  );
  expect(minimum).toHaveLength(1);
  const wgsl = new TextDecoder().decode(minimum[0]?.artifact.bytes);
  expect(wgsl).toMatch(/var<storage(?:,\s*read)?>/);
  expect(wgsl).not.toMatch(/@group\(0\)\s+@binding\((?:9|11|12|13|14|15|16|17)\)/);
  expect(wgsl).toContain('fs_opaque');
});

it('publishes the intermediate projector topology without extended-lighting bindings', () => {
  const projector = record.programs.filter((program) =>
    program.selections.some(
      (selection) =>
        selection.pass === 'forward' &&
        selection.context.backend === 'webgpu' &&
        selection.context.capability === 'storage-buffer-projector' &&
        selection.context.geometry === 'mesh' &&
        selection.address === 'direct' &&
        selection.context.visibleSurface !== true,
    ),
  );
  expect(projector).toHaveLength(1);
  const wgsl = new TextDecoder().decode(projector[0]?.artifact.bytes);
  expect(wgsl).toMatch(/@group\(0\)\s+@binding\(11\)\s+var \w+: texture_2d<f32>/);
  expect(wgsl).toMatch(/@group\(0\)\s+@binding\(12\)\s+var \w+: sampler/);
  expect(wgsl).not.toMatch(/@group\(0\)\s+@binding\((?:9|13|14|15)\)/);
});
