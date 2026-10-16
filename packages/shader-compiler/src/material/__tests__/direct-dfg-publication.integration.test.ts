import { fileURLToPath } from 'node:url';
import { STANDARD_DIRECT_DFG_LUT_BINDING } from '@forgeax/engine-shader';
import {
  type AssetGuid,
  type MaterialAsset,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook.js';
import { collectMaterialSources } from '../pack-cooker.js';
import { cookRayMaterial } from '../ray-material.js';
import { buildMaterialSourceCatalog, type MaterialSourceCatalog } from '../source-catalog.js';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../variant-context.js';

let sources: MaterialSourceCatalog;
beforeAll(async () => {
  const engine = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  sources = buildMaterialSourceCatalog(await collectMaterialSources([engine], [engine])).unwrap();
});

function material(module: string, lut: boolean): MaterialAsset {
  return {
    kind: 'material',
    parameters: standardSurfaceParameters(
      lut ? [{ name: 'directMultiscatteringLut', type: 'u32', default: 1 }] : [],
    ),
    passes: [{ name: 'forward', program: { module } }],
    values: lut ? { directMultiscatteringLut: 1 } : {},
  };
}

describe('Direct DFG production shader publication', { timeout: 30_000 }, () => {
  it.each([
    ['forgeax::default-standard-pbr', 'mesh'],
    ['forgeax::pbr-skin', 'skinned'],
  ] as const)('reflects opt-in texture and exact u32 ABI on %s', async (module, geometry) => {
    const context = { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, geometry };
    const table = { fit: material(module, false), lut: material(module, true) };
    const fit = (await cookMaterialAsset({ material: 'fit', table, sources, context })).unwrap();
    const lut = (await cookMaterialAsset({ material: 'lut', table, sources, context })).unwrap();
    const fitPass = fit.passes[0];
    const lutPass = lut.passes[0];
    expect(fitPass).toBeDefined();
    expect(lutPass).toBeDefined();
    const fitGroup = fitPass?.compile.bindings.find((group) => group.label === '@group(1)');
    const lutGroup = lutPass?.compile.bindings.find((group) => group.label === '@group(1)');
    expect(
      fitGroup?.entries.some((entry) => entry.binding === STANDARD_DIRECT_DFG_LUT_BINDING),
    ).toBe(false);
    expect(
      lutGroup?.entries.find((entry) => entry.binding === STANDARD_DIRECT_DFG_LUT_BINDING),
    ).toMatchObject({
      texture: { sampleType: 'float', viewDimension: '2d' },
    });
    expect(lutGroup?.entries.filter((entry) => entry.sampler).length).toBe(
      fitGroup?.entries.filter((entry) => entry.sampler).length,
    );
    const uniform = lutPass?.compile.reflection.boundGlobals.find(
      (global) => global.group === 1 && global.binding === 0,
    );
    expect(uniform?.members).toContainEqual(
      expect.objectContaining({
        name: 'directMultiscatteringLut',
        type: 'u32',
      }),
    );
    expect(lutPass?.sourceClosureDigest).not.toBe(fitPass?.sourceClosureDigest);
    expect(lutPass?.compile.wgsl).not.toContain('array<u32, 256>');
    expect(fitPass?.compile.wgsl).not.toContain('array<u32, 256>');

    const disabled = (
      await cookMaterialAsset({
        material: 'child',
        sources,
        context,
        table: {
          ...table,
          child: {
            kind: 'material',
            parent: 'lut' as unknown as AssetGuid,
            values: { directMultiscatteringLut: 0 },
          },
        },
      })
    ).unwrap().passes[0];
    expect(disabled?.layoutIdentity).toBe(lutPass?.layoutIdentity);
    expect(disabled?.sourceClosureDigest).toBe(lutPass?.sourceClosureDigest);
    expect(disabled?.compile.wgsl).toBe(lutPass?.compile.wgsl);
  });

  it.each([
    'ray-hit',
    'card-capture',
  ] as const)('publishes the declared selection through %s', async (context) => {
    const result = (
      await cookRayMaterial({
        material: 'lut',
        table: { lut: material('forgeax::default-standard-pbr', true) },
        sources,
        context,
      })
    ).unwrap();
    expect(result.program.paramSchema).toContainEqual({
      name: 'directMultiscatteringLut',
      type: 'u32',
      default: 1,
    });
    // The surface producer must actually read the field to publish its selection.
    expect(/\.directMultiscatteringLut\b/.test(result.program.wgsl)).toBe(true);
  });
});
