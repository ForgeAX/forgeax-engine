import { expect, it } from 'vitest';
import {
  loadEngineShaderEntries,
  loadPackageMaterialShaderEntries,
} from '../engine-inputs/load-engine-shader-entries.js';
import { engineManifestFiles, publishedVariantDefines } from '../index.js';

// Logical rows bound compiled publication work and storage. Native source
// publication composes only selected rows; these counts are not GPU prewarm.
// Independent alpha, LOD and clipping demand must survive the complete roster.
// Change the snapshot deliberately when an axis or permutation rule changes.
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
          ? { 'false/false': 3640, 'false/true': 640, 'true/false': 3504, 'true/true': 3488 }
          : { 'false/false': 224, 'false/true': 32, 'true/false': 160, 'true/true': 160 };
      // Independent full-receiver lean lighting adds 96 rows per active lane;
      // its 32 lean-input rows also retain the dormant Water format.
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
    if (key === 'forgeax::default-standard-pbr' || key === 'forgeax::pbr-skin') {
      expect(variants.filter((row) => row.COVERAGE_ONLY)).toHaveLength(
        key === 'forgeax::default-standard-pbr' ? 40 : 12,
      );
    }
    if (key === 'forgeax::engine-standard-deferred-lighting') {
      expect(
        variants.filter(
          (row) => !row.DEFERRED_DIFFUSE_GI_AVAILABLE && !row.DEFERRED_LIGHT_PROBE_AVAILABLE,
        ),
      ).toHaveLength(16);
    }
    if (
      key === 'forgeax::vfx-render.particles.mesh' ||
      key === 'forgeax::vfx-render.particles.mesh-inputs'
    ) {
      expect(variants.filter((row) => row.LEAN_LIGHTING === false)).toHaveLength(12);
      const modifierFree = variants.filter((row) => row.LEAN_LIGHTING === true);
      expect(modifierFree).toHaveLength(8);
      expect(modifierFree.every((row) => row.STORAGE_BUFFER_AVAILABLE === true)).toBe(true);
    }
    if (
      key === 'forgeax::standard-terrain' ||
      key === 'forgeax::standard-terrain-detail' ||
      key === 'forgeax::standard-terrain-ids'
    ) {
      const added = variants.filter((row) => !row.DIRECTIONAL_SHADOW_SIMPLE && row.LEAN_LIGHTING);
      expect(added).toHaveLength(16);
      expect(variants.filter((row) => !added.includes(row))).toHaveLength(128);
    }
  }
  const total = Object.values(rows).reduce((sum, count) => sum + count, 0);
  expect({ total, rows }).toMatchInlineSnapshot(`
    {
      "rows": {
        "forgeax::default-shadow-caster": 576,
        "forgeax::default-standard-pbr": 11272,
        "forgeax::default-unlit": 416,
        "forgeax::engine-ray-path-tracer": 2,
        "forgeax::engine-standard-deferred-lighting": 64,
        "forgeax::msdf-text": 6,
        "forgeax::pbr-skin": 1164,
        "forgeax::sprite": 12,
        "forgeax::sprite-lit": 12,
        "forgeax::standard-terrain": 144,
        "forgeax::standard-terrain-detail": 144,
        "forgeax::standard-terrain-detail-shadow": 16,
        "forgeax::standard-terrain-ids": 144,
        "forgeax::standard-terrain-ids-shadow": 16,
        "forgeax::standard-terrain-shadow": 16,
        "forgeax::vfx-render.particles.beam": 3,
        "forgeax::vfx-render.particles.beam-inputs": 3,
        "forgeax::vfx-render.particles.billboard": 3,
        "forgeax::vfx-render.particles.billboard-inputs": 3,
        "forgeax::vfx-render.particles.billboard-water-sphere": 3,
        "forgeax::vfx-render.particles.mesh": 20,
        "forgeax::vfx-render.particles.mesh-inputs": 20,
        "forgeax::vfx-render.particles.mesh-inputs-unlit": 3,
        "forgeax::vfx-render.particles.mesh-shadow": 2,
        "forgeax::vfx-render.particles.mesh-unlit": 3,
        "forgeax::vfx-render.particles.ribbon": 3,
        "forgeax::vfx-render.particles.ribbon-inputs": 3,
        "forgeax::vfx-render.particles.trail": 3,
        "forgeax::vfx-render.particles.trail-inputs": 3,
      },
      "total": 14079,
    }
  `);
});
