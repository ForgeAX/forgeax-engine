import {
  compileShader,
  reachableShaderImportIds,
  validateMaterialProgramBindings,
} from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';
import { waterInfoRasterEngineEntries } from '../engine-inputs/water-info-raster-roster';

describe('WaterInfo Engine raster material shaders', () => {
  it('publishes each raster source under its reserved material identifier', async () => {
    const entries = await loadEngineShaderEntries();
    expect(entries.waterInfoRasterWater).toMatchObject({
      reservedIdentifier: 'forgeax::water-info-raster-water',
    });
    expect(entries.waterInfoRasterGround).toMatchObject({
      reservedIdentifier: 'forgeax::water-info-raster-ground',
    });
    expect(entries.waterInfoRasterDilation).toMatchObject({
      reservedIdentifier: 'forgeax::water-info-raster-dilation',
    });
    expect(entries.waterInfoRasterWater.source).toContain('fn fs_main(');
    expect(entries.waterInfoRasterGround.source).toContain('fn fs_main(');
    expect(entries.waterInfoRasterDilation.source).toContain('fn fs_main(');
    for (const entry of [
      entries.waterInfoRasterWater,
      entries.waterInfoRasterGround,
      entries.waterInfoRasterDilation,
    ]) {
      expect(entry.program?.bindings).toBe('group-0');
      const reachable = reachableShaderImportIds(entry.source, entries.imports);
      const result = await compileShader(entry.source, {
        id: entry.id,
        imports: Object.fromEntries(
          Object.entries(entries.imports).filter(([id]) => reachable.has(id)),
        ),
      });
      expect(result.ok).toBe(true);
      if (result.ok && entry.program !== undefined) {
        expect(
          validateMaterialProgramBindings(entry.program, result.value.bindings),
        ).toBeUndefined();
      }
    }
  });

  it('shares the WaterInfo raster roster between manifest generation and Vite buildStart', async () => {
    const entries = await loadEngineShaderEntries();
    expect(waterInfoRasterEngineEntries(entries).map((entry) => entry.reservedIdentifier)).toEqual([
      'forgeax::water-info-raster-water',
      'forgeax::water-info-raster-ground',
      'forgeax::water-info-raster-dilation',
    ]);
  });
});
