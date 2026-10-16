import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker';

it('cooks numeric suffixes and colliding compiler spellings through direct and scene-index programs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'material-identifiers-'));
  try {
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path test::identifiers
#import forgeax_material::parameters::{material}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(material.rainShelter0.xyz + material.rainShelter0_.xyz, input.geometricNormalWS, 0.0, 0.5, vec3f(0.0), 1.0, 1.0, 0.0);
}`,
    );
    const source: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'forward',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'test::identifiers' },
          },
        },
      ],
      // The author contract retains both names even when Naga renames them.
      parameters: standardSurfaceParameters([
        { name: 'rainShelter0', type: 'vec4' },
        { name: 'rainShelter0_', type: 'vec4' },
      ]),
      values: { rainShelter0: [1, 0, 0, 1], rainShelter0_: [0, 1, 0, 1] },
    };
    const result = await createMaterialPackCooker([root]).cook({ guid: 'identifiers', source });
    const record = validateCookedMaterialRecord(
      (result.payload as { cooked: unknown }).cooked,
    ).unwrap();
    for (const address of ['direct', 'scene-index']) {
      expect(
        record.programs.filter((program) =>
          program.selections.some(
            (selection) =>
              selection.context.pipeline !== 'ray' &&
              selection.context.capability === 'storage-buffer' &&
              selection.context.visibleSurface !== true &&
              selection.address === address,
          ),
        ),
      ).toHaveLength(1); // Surface never reads vertexColor: colorless program only
    }
    const wgsl = Object.values(result.artifacts)
      .map((a) => new TextDecoder().decode(a.bytes))
      .join('\n');
    expect(wgsl).toContain('rainShelter0_');
    expect(wgsl).toContain('rainShelter0_1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
