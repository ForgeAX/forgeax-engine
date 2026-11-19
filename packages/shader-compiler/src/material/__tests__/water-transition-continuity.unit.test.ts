import { fileURLToPath } from 'node:url';
import { definePackageId } from '@forgeax/engine-pack/source';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../../compile.js';
import { cookMaterialAsset } from '../cook.js';
import { collectMaterialSources } from '../pack-cooker.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

// Production source collection, material resolution, composition and Naga reflection.
// No authored duplicate of the continuity math is used as a compilation oracle.
describe('production Water terminal continuity shader contract', () => {
  it('compiles the nearest actual Dawn entry with production numeric support modules', async () => {
    // Cross-owner test fixtures are runtime inputs, not compiler project source.
    const {
      continuityComputeSource,
      continuityMorphComputeSource,
      continuityShaderDefines,
      continuityShaderImports,
    } = await import(
      /* @vite-ignore */ new URL(
        '../../../../shader/src/__tests__/water-transition-continuity.fixture.ts',
        import.meta.url,
      ).href
    );
    const compiled = (
      await compileShader(continuityComputeSource, {
        id: 'continuity-dawn-source',
        imports: continuityShaderImports(),
        defines: continuityShaderDefines,
      })
    ).unwrap();
    expect(
      compiled.reflection.entryPoints?.some(
        (p) => p.name === 'main' && p.bindings.some((b) => b.group === 2 && b.binding === 22),
      ),
    ).toBe(true);
    const morph = (
      await compileShader(continuityMorphComputeSource, {
        id: 'continuity-morph-source',
        imports: continuityShaderImports(),
        defines: continuityShaderDefines,
      })
    ).unwrap();
    expect(
      morph.reflection.entryPoints
        ?.find((p) => p.name === 'main')
        ?.bindings.map((b) => [b.group, b.binding]),
    ).toEqual([
      [0, 0],
      [2, 21],
      [2, 22],
    ]);
  });
  it('compiles both ordinary and transition materials with the same existing fragment/vertex tile binding', async () => {
    const { buildWaterMaterialFamily } = (await import(
      /* @vite-ignore */ new URL('../../../../water/dist/index.mjs', import.meta.url).href
    )) as typeof import('../../../../water/dist/index.js');
    const root = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
    const collected = await collectMaterialSources([root], [root]);
    const sources = buildMaterialSourceCatalog({
      roots: [root],
      engine: collected.engine,
      project: [],
    }).unwrap();
    const family = buildWaterMaterialFamily(
      definePackageId('019a0000-0000-7000-8000-000000000519'),
    );
    for (const key of ['ocean', 'river-to-ocean'] as const) {
      const pass = cookMaterialAsset({
        material: family.guids[key],
        table: Object.fromEntries(
          Object.entries(family.outputs).map(([path, asset]) => [
            family.guids[path.split('/').at(-1) as keyof typeof family.guids],
            asset,
          ]),
        ),
        sources,
      });
      const cooked = (await pass).unwrap();
      const forward = cooked.passes.find((p) => p.pass === 'forward');
      expect(forward?.abi.systemInputs).toEqual({ water: 'water-frame/3' });
      expect(forward?.abi.surface?.deformation?.version).toBe('water-deformation/1');
      for (const stage of ['vertex', 'fragment'] as const) {
        const points =
          forward?.compile.reflection.entryPoints?.filter((p) => p.stage === stage) ?? [];
        expect(points.some((p) => p.bindings.some((b) => b.group === 2 && b.binding === 22))).toBe(
          true,
        );
      }
    }
  }, 30000);
});
