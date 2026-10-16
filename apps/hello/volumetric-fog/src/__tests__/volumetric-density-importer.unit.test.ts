import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import { IMPORT_ERROR_HINTS } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeVolumetricDensity, volumetricDensityImporter } from '../volumetric-density-importer';

const source = (base: number, gradient: number) => ({
  format: 'forgeax-volumetric-density' as const,
  width: 64 as const,
  height: 64 as const,
  depth: 64 as const,
  base,
  gradient,
});

const officialThreeSource = {
  format: 'forgeax-volumetric-density' as const,
  width: 128 as const,
  height: 128 as const,
  depth: 128 as const,
  noise: 'improved-perlin' as const,
  scale: 10,
  repeatFactor: 5,
};

const GUID = '019f0000-0000-7000-8000-0000000003f1';

function meta(subAssets = [{ guid: GUID, sourceIndex: 0, sourceKey: 'density', kind: 'volumetric-density' }]) {
  return {
    importer: 'volumetric-density',
    source: 'density.volume.json',
    subAssets,
  };
}

function fs(bytes: Uint8Array) {
  return { readSource: async () => ({ ok: true as const, value: bytes }) };
}

async function importSource(bytes: Uint8Array, subAssets = meta().subAssets) {
  const registry = new ImporterRegistry();
  registry.register(volumetricDensityImporter());
  return runImport(meta(subAssets), registry, fs(bytes));
}

describe('volumetric density authoring', () => {
  it('emits an exact full-domain constant when gradient is zero', () => {
    const data = makeVolumetricDensity(source(96, 0));

    expect(data.length).toBe(64 * 64 * 64);
    expect(new Set(data)).toEqual(new Set([96]));
  });

  it('keeps the valid 64^3 runImport path and one authored GUID', async () => {
    const result = await importSource(new TextEncoder().encode(JSON.stringify(source(96, 0))));

    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.pack.assets).toHaveLength(1);
    expect(result.value.pack.assets[0]).toMatchObject({
      guid: GUID,
      kind: 'volumetric-density',
      payload: {
        shape: { viewDimension: '3d', extent: { width: 64, height: 64, depth: 64 } },
        format: 'r8unorm',
      },
    });
    expect(result.value.pack.assets[0]?.payload.data).toHaveLength(64 * 64 * 64);
  });

  it('keeps authored spatial scales when gradient is positive', () => {
    const data = makeVolumetricDensity(source(96, 24));
    let min = 255;
    let max = 0;
    for (const value of data) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    expect(min).toBeLessThan(max);
  });

  it('matches the pinned Three.js ImprovedNoise voxel construction', () => {
    const data = makeVolumetricDensity(officialThreeSource);

    expect(data).toHaveLength(128 * 128 * 128);
    expect(Array.from(data.slice(0, 4))).toEqual([128, 139, 109, 153]);
    expect(data[64 + 64 * 128 + 64 * 128 * 128]).toBe(128);
    expect(data[17 + 23 * 128 + 41 * 128 * 128]).toBe(143);
  });

  it('imports the official noise descriptor without changing the authored GUID', async () => {
    const result = await importSource(new TextEncoder().encode(JSON.stringify(officialThreeSource)));

    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.pack.assets[0]).toMatchObject({ guid: GUID, kind: 'volumetric-density' });
    expect(result.value.pack.assets[0]?.payload.data).toHaveLength(128 * 128 * 128);
  });

  it('returns source-validation-failed for malformed MVD JSON', async () => {
    const result = await importSource(new TextEncoder().encode('{"format":'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('source-validation-failed');
    expect(result.error.expected).toContain('valid JSON');
    expect(result.error.hint).toBe(IMPORT_ERROR_HINTS['source-validation-failed']);
    expect(result.error.detail).toMatchObject({
      diagnostics: [
        {
          code: 'mvd-json-invalid',
          sourcePath: 'density.volume.json',
          rule: 'mvd-json-parse',
          severity: 'error',
        },
      ],
    });
  });

  it('returns source-validation-failed for a non-64-cubed extent', async () => {
    const result = await importSource(
      new TextEncoder().encode(JSON.stringify({ ...source(96, 0), depth: 32 })),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('source-validation-failed');
    expect(result.error.expected).toContain('64^3');
    expect(result.error.hint).toBe(IMPORT_ERROR_HINTS['source-validation-failed']);
    expect(result.error.detail).toMatchObject({
      diagnostics: [
        {
          code: 'mvd-extent-invalid',
          sourcePath: 'density.volume.json',
          rule: 'mvd-extent-cubed',
          actual: expect.stringContaining('depth'),
        },
      ],
    });
  });

  it('returns import-produced-no-assets when Meta declares no MVD output', async () => {
    const result = await importSource(
      new TextEncoder().encode(JSON.stringify(source(96, 0))),
      [],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('import-produced-no-assets');
    expect(result.error.expected).toContain('at least one');
    expect(result.error.hint).toBe(IMPORT_ERROR_HINTS['import-produced-no-assets']);
    expect(result.error.detail).toEqual({ missingGuids: [] });
  });

  it('returns source-read-failed with the source path and cause', async () => {
    const registry = new ImporterRegistry();
    registry.register(volumetricDensityImporter());
    const result = await runImport(meta(), registry, {
      readSource: async () => ({
        ok: false as const,
        error: new Error('permission denied'),
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('source-read-failed');
    expect(result.error.expected).toContain('density.volume.json');
    expect(result.error.hint).toBe(IMPORT_ERROR_HINTS['source-read-failed']);
    expect(result.error.detail).toEqual({
      source: 'density.volume.json',
      reason: 'permission denied',
    });
  });
});
