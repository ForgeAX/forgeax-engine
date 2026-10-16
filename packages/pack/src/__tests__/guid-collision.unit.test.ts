import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scan } from '../scanner.js';

const COLLIDING_GUID = '018e7a4d-1234-7abc-8def-000000000001';
const roots: string[] = [];

const pack = (guid: string) => ({
  schemaVersion: '1.0.0',
  kind: 'internal-text-package',
  assets: [{ guid, kind: 'mesh', payload: {}, refs: [] }],
});

const meta = (guid: string, source: string) => ({
  schemaVersion: '1.0.0',
  kind: 'external-asset-package',
  importer: 'image',
  source,
  importSettings: {},
  subAssets: [{ guid, sourceIndex: 0, kind: 'texture', sourceKey: 'image/main' }],
});

async function makeRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `forgeax-guid-${name}-`));
  roots.push(root);
  return root;
}

async function expectGuidCollision(
  rootList: readonly string[],
  expectedNames: readonly string[],
): Promise<void> {
  const result = await scan(rootList);
  expect(result.ok).toBe(false);
  if (result.ok) return;

  expect(result.error.code).toBe('pack-guid-collision');
  if (result.error.code !== 'pack-guid-collision') return;

  expect(result.error.expected).toContain('pack error');
  expect(result.error.hint.length).toBeGreaterThan(0);
  const detail = result.error.detail;
  if (!('guid' in detail) || !('paths' in detail)) return;

  expect(detail.guid).toBe(COLLIDING_GUID);
  expect(detail.paths).toHaveLength(2);
  for (const name of expectedNames) {
    expect(detail.paths.some((path) => path.endsWith(name))).toBe(true);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('normalized GUID collision collection', () => {
  it('reports a pack asset and meta subAsset collision in one root', async () => {
    const root = await makeRoot('pack-meta');
    await writeFile(join(root, 'asset.pack.json'), JSON.stringify(pack(COLLIDING_GUID)));
    await writeFile(join(root, 'image.png'), Buffer.from('fixture'));
    await writeFile(
      join(root, 'image.png.meta.json'),
      JSON.stringify(meta(COLLIDING_GUID, 'image.png')),
    );

    await expectGuidCollision([root], ['asset.pack.json', 'image.png.meta.json']);
  });

  it('reports meta subAsset collisions across independent roots', async () => {
    const firstRoot = await makeRoot('cross-a');
    const secondRoot = await makeRoot('cross-b');
    await writeFile(join(firstRoot, 'hero.png'), Buffer.from('first'));
    await writeFile(join(secondRoot, 'hero.png'), Buffer.from('second'));
    await writeFile(
      join(firstRoot, 'hero.png.meta.json'),
      JSON.stringify(meta(COLLIDING_GUID, 'hero.png')),
    );
    await writeFile(
      join(secondRoot, 'hero.png.meta.json'),
      JSON.stringify(meta(COLLIDING_GUID, 'hero.png')),
    );

    await expectGuidCollision([firstRoot, secondRoot], ['hero.png.meta.json']);
  });

  it('reports a ScriptablePack output colliding with a JSON sidecar', async () => {
    const root = await makeRoot('scriptable-meta');
    const packageId = '018e7a4d-1234-7abc-8def-000000000002';
    await writeFile(
      join(root, 'direct.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: { mesh: { kind: 'mesh', payload: {} } },
      }),
    );
    await writeFile(
      join(root, 'generated.pack.ts'),
      `
export default {
  schemaVersion: '2.0.0',
  packageId: new Uint8Array([1, 142, 122, 77, 18, 52, 122, 188, 141, 239, 0, 0, 0, 0, 0, 2]),
  build: () => ({ ok: true, value: { mesh: { kind: 'mesh' } } }),
};
`,
    );

    const result = await scan([root]);
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'pack-guid-collision') return;
    const detail = result.error.detail;
    if (!('guid' in detail) || !('paths' in detail)) return;
    expect(detail.guid).toBe(packageId);
    expect(detail.paths).toHaveLength(2);
    expect(detail.paths.some((path) => path.endsWith('direct.pack.json'))).toBe(true);
    expect(detail.paths.some((path) => path.endsWith('generated.pack.ts'))).toBe(true);
  });
});
