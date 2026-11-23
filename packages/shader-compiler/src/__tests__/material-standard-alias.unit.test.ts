import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../material/pack-cooker.js';

describe('cookMaterialAsset', () => {
  it('projects an engine-owned Standard source into a Pack-owned material alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-standard-alias-'));
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const engineRoot = resolve(packageRoot, '../shader/src');
    const sourcePath = resolve(root, 'material-alias.pack.json');
    await writeFile(sourcePath, '{}');
    // Alias identity needs the real Engine template and one simple depth Surface.
    // Full Forward/physical/color/ray publications have dedicated real gates.
    await writeFile(
      join(root, 'surface.wgsl'),
      `#define_import_path game::alias-surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(0.6), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0, 0.0);
}`,
    );
    try {
      const draft = await createMaterialPackCooker().cook({
        guid: 'material-standard-alias-test',
        source: {
          kind: 'material',
          // Alias identity needs one real Standard interface; the complete
          // physical-layer fixture separately covers every texture binding.
          parameters: standardSurfaceParameters([]),
          passes: [
            {
              name: 'Depth',
              program: {
                module: 'game::standard-alias',
                moduleSlots: { surface: 'game::alias-surface' },
              },
            },
          ],
        },
        sourceKey: relative(root, resolve(engineRoot, 'default-standard-pbr.wgsl')),
        sourcePath,
        refs: [],
      });
      const artifact = Object.values(draft.artifacts)[0];
      expect(artifact).toBeDefined();
      if (artifact === undefined) return;
      expect(draft.payload).toMatchObject({
        cooked: {
          refs: { modules: ['forgeax_material::standard'] },
          resolved: {
            passes: [{ program: { module: 'forgeax_material::standard' } }],
          },
        },
      });
      const record = validateCookedMaterialRecord(
        (draft.payload as { cooked: unknown }).cooked,
      ).unwrap();
      const raster = record.programs
        .flatMap((program) => program.selections)
        .filter((selection) => selection.context.pipeline !== 'ray');
      expect(
        raster.every(
          (selection) =>
            selection.address !== undefined &&
            selection.entry !== undefined &&
            selection.abi !== undefined,
        ),
      ).toBe(true);
      expect(
        new Set(
          raster
            .filter((selection) => selection.context.capability === 'uniform-fallback')
            .map((selection) => selection.context.backend),
        ),
      ).toEqual(new Set(['webgpu', 'webgl2']));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
