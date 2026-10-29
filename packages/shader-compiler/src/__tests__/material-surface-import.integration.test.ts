import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../material/pack-cooker.js';

it('cooks selective helpers with transitive calls from a complete reusable Surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'material-surface-import-'));
  try {
    const body = `#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(sharedValue(input.positionOS.x)), input.vertexNormalWS,
    0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`;
    await writeFile(
      join(root, 'helper.wgsl'),
      `#define_import_path test::helper
fn nestedValue(value: f32) -> f32 { return abs(value); }
fn sharedValue(value: f32) -> f32 { return nestedValue(value) * 0.5; }
${body}`,
    );
    await writeFile(
      join(root, 'selected.wgsl'),
      `#define_import_path test::selected
#import test::helper::{sharedValue}
${body}`,
    );
    const cooked = await createMaterialPackCooker([root]).cook({
      guid: '01900000-0000-7000-8000-000000009998',
      sourcePath: join(root, 'material.pack.json'),
      source: {
        kind: 'material',
        parameters: standardSurfaceParameters([]),
        passes: [
          {
            name: 'Forward',
            program: {
              module: 'forgeax_material::standard',
              moduleSlots: { surface: 'test::selected' },
            },
          },
        ],
      },
    });
    expect(cooked.payload).toHaveProperty('cooked');
    expect(Object.keys(cooked.artifacts).length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
