import { expect, it } from 'vitest';
import {
  loadEngineShaderEntries,
  loadPackageMaterialShaderEntries,
} from '../engine-inputs/load-engine-shader-entries.js';
import { engineManifestFiles, publishedVariantDefines } from '../index.js';

// Every published variant row is precompiled and stays resident in the shared
// shader publication (~68.6 KB per standard row), so row counts are a memory
// budget. Changing a variant axis or a permutation rule must update this
// snapshot deliberately; see the six-layer switch table before adding an axis.
it('pins the published variant row count per engine material and program', async () => {
  const engine = await loadEngineShaderEntries();
  const cloudPrograms = engine.cloudAtmosphere.map((entry) => entry.reservedIdentifier);
  expect(cloudPrograms).toEqual(
    expect.arrayContaining([
      'forgeax::cloud-analytic-view',
      'forgeax::cloud-mode0-reconstruct',
      'forgeax::cloud-mode0-compose',
    ]),
  );
  expect(
    cloudPrograms.some((identifier) => identifier?.startsWith('forgeax::cloud-atmosphere-')),
  ).toBe(false);
  const particle = await loadPackageMaterialShaderEntries('@forgeax/engine-vfx-render');
  const rows: Record<string, number> = {};
  for (const file of engineManifestFiles(engine, particle)) {
    const variants = publishedVariantDefines(file.source);
    const rowCount = variants.length;
    if (rowCount <= 1) continue;
    const key = file.reservedIdentifier ?? file.id;
    rows[key] = (rows[key] ?? 0) + rowCount;
    if (key === 'forgeax::default-standard-pbr' || key === 'forgeax::default-shadow-caster') {
      const rowsPerWaterLane: Readonly<Record<`${boolean}/${boolean}`, number>> =
        key === 'forgeax::default-standard-pbr'
          ? { 'false/false': 2448, 'false/true': 288, 'true/false': 2288, 'true/true': 2288 }
          : { 'false/false': 64, 'false/true': 16, 'true/false': 48, 'true/true': 48 };
      // Water draws retain both formats on storage backends. Inactive ordinary
      // rows omit the unused format; the maintained lean-input lanes retain it.
      for (const waves of [false, true] as const) {
        for (const rgba16 of [false, true] as const) {
          expect(
            variants.filter(
              (variant) =>
                variant.WATER_WAVES_AVAILABLE === waves && variant.WATER_INFO_RGBA16 === rgba16,
            ),
          ).toHaveLength(rowsPerWaterLane[`${waves}/${rgba16}`]);
        }
      }
    }
  }
  const total = Object.values(rows).reduce((sum, count) => sum + count, 0);
  expect({ total, rows }).toMatchInlineSnapshot(`
    {
      "rows": {
        "forgeax::default-shadow-caster": 176,
        "forgeax::default-standard-pbr": 7312,
        "forgeax::default-unlit": 104,
        "forgeax::engine-ray-path-tracer": 2,
        "forgeax::engine-standard-deferred-lighting": 16,
        "forgeax::msdf-text": 6,
        "forgeax::pbr-skin": 864,
        "forgeax::sprite": 12,
        "forgeax::sprite-lit": 12,
        "forgeax::standard-terrain": 128,
        "forgeax::standard-terrain-ids": 128,
        "forgeax::standard-terrain-ids-shadow": 4,
        "forgeax::standard-terrain-shadow": 4,
        "forgeax::vfx-render.particles.beam": 3,
        "forgeax::vfx-render.particles.beam-inputs": 3,
        "forgeax::vfx-render.particles.billboard": 3,
        "forgeax::vfx-render.particles.billboard-inputs": 3,
        "forgeax::vfx-render.particles.billboard-water-sphere": 3,
        "forgeax::vfx-render.particles.mesh": 12,
        "forgeax::vfx-render.particles.mesh-inputs": 12,
        "forgeax::vfx-render.particles.mesh-inputs-unlit": 3,
        "forgeax::vfx-render.particles.mesh-shadow": 2,
        "forgeax::vfx-render.particles.mesh-unlit": 3,
        "forgeax::vfx-render.particles.ribbon": 3,
        "forgeax::vfx-render.particles.ribbon-inputs": 3,
        "forgeax::vfx-render.particles.trail": 3,
        "forgeax::vfx-render.particles.trail-inputs": 3,
      },
      "total": 8827,
    }
  `);
});
