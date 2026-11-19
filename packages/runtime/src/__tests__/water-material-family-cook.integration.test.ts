import { AssetGuid, PackageId } from '@forgeax/engine-pack/source';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookMaterialAsset,
  createShaderProgramCompiler,
  type MaterialSourceCatalog,
  materialShaderSourceRoots,
} from '@forgeax/engine-shader-compiler';
import type { MaterialTable } from '@forgeax/engine-types';
import {
  buildWaterMaterialFamily,
  WATER_MATERIAL_FAMILY_KEYS,
  WATER_SURFACE_PARAMETERS,
} from '@forgeax/engine-water';
import { beforeAll, describe, expect, it } from 'vitest';

const packageId = PackageId.parse('019fc0e7-1000-7000-8000-000000000004');
if (!packageId.ok) throw packageId.error;
const family = buildWaterMaterialFamily(
  packageId.value,
  'material/water',
  Object.fromEntries(
    WATER_SURFACE_PARAMETERS.filter((parameter) => parameter.type.startsWith('texture')).map(
      (parameter, index) => [
        parameter.name,
        AssetGuid.format(AssetGuid.derive(packageId.value, `texture/resource-${index}`)),
      ],
    ),
  ),
);
const table: MaterialTable = Object.fromEntries(
  WATER_MATERIAL_FAMILY_KEYS.map((key) => {
    const asset = family.outputs[`material/water/${key}`];
    if (asset === undefined) throw new Error(`Missing Water family fixture ${key}`);
    return [family.guids[key], asset];
  }),
);
const compile = createShaderProgramCompiler();
let sources: MaterialSourceCatalog;

beforeAll(async () => {
  const roots = materialShaderSourceRoots();
  const collected = await collectMaterialSources(roots, roots);
  sources = buildMaterialSourceCatalog({
    roots,
    engine: collected.engine,
    project: collected.project,
  }).unwrap();
});

describe('stock Water material family native cooking', () => {
  it.each(
    WATER_MATERIAL_FAMILY_KEYS,
  )('compiles the fully textured %s branch with its inherited pass contract', async (key) => {
    const cooked = await cookMaterialAsset(
      { material: family.guids[key], table, sources },
      compile,
    );
    expect(
      cooked.ok,
      cooked.ok ? '' : `${cooked.error.message}\n${JSON.stringify(cooked.error.detail)}`,
    ).toBe(true);
    if (!cooked.ok) return;
    expect(cooked.value.passes.length).toBeGreaterThan(0);
    for (const pass of cooked.value.passes) {
      if (cooked.value.resolved.asset.surface?.model === 'single-layer-water') {
        expect(pass.sceneCompile, `${key}/${pass.pass}`).toBeDefined();
        expect(pass.abi.systemInputs).toEqual({ water: 'water-frame/3' });
      }
      for (const program of [
        pass.compile,
        ...(pass.sceneCompile === undefined ? [] : [pass.sceneCompile]),
      ]) {
        const bindings = program.reflection.boundGlobals.map(
          (binding) => `${binding.group}:${binding.binding}`,
        );
        expect(new Set(bindings).size, `${key}/${pass.pass}`).toBe(bindings.length);
        expect(program.reflection.entryPoints?.some((point) => point.stage === 'vertex')).toBe(
          true,
        );
      }
    }
    if (['ocean', 'river-to-ocean', 'ocean-lod'].includes(key)) {
      const forward = cooked.value.passes.find((pass) => pass.pass === 'forward');
      expect(
        forward?.compile.reflection.boundGlobals.some(
          (binding) =>
            binding.group === 1 && binding.name?.includes('waterVolumeNoiseTexture') === true,
        ),
      ).toBe(true);
    }
  }, 30_000);
});
