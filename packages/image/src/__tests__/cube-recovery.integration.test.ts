import type { ImportContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { importCubeSource } from '../lut/cube-producer.js';

const GUID = '019ffa97-3000-7000-8000-000000000902';
const SOURCE_KEY = 'color-grading/recovery';

function context(source: string, bytes: Uint8Array): ImportContext {
  return {
    source,
    subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'texture' as const, sourceKey: SOURCE_KEY }],
    importSettings: {},
    readSource: async () => ({ ok: true as const, value: bytes }),
    readSibling: async () => {
      throw new Error('not used');
    },
    decodeImage: async () => {
      throw new Error('not used');
    },
  };
}

function cubeSource(): string {
  const rows = Array.from({ length: 16 ** 3 }, () => '0.5 0.5 0.5');
  return ['LUT_3D_SIZE 16', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1', ...rows, ''].join('\n');
}

describe('cube source recovery', () => {
  it('rejects invalid source before Pack and retries the same identity after repair', async () => {
    const source = 'assets/recovery.cube';
    const invalid = await importCubeSource(
      context(source, new TextEncoder().encode('LUT_3D_SIZE 16')),
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.code).toBe('source-validation-failed');
    expect(JSON.stringify(invalid.error.detail)).toContain(`${source}#DOMAIN_MIN/MAX`);
    expect(JSON.stringify(invalid.error.detail)).toContain('cube-source-parser');

    const repaired = await importCubeSource(
      context(source, new TextEncoder().encode(cubeSource())),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.sourceDependencies).toEqual([source]);
    expect(repaired.value.assets[0]).toMatchObject({ guid: GUID, kind: 'texture' });
    expect(repaired.value.assets[0]?.payload).toMatchObject({
      shape: { viewDimension: '3d', extent: { width: 16, height: 16, depth: 16 } },
      format: 'rgba16float',
    });
  });
});
