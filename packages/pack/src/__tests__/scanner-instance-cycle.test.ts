// Scanner dependency-cycle coverage for keyed SceneAsset instances.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetGuid, PackageId } from '../guid.js';
import { scan } from '../scanner.js';

const PACKAGE_A = 'aa000000-0000-4000-8000-000000000aaa';
const PACKAGE_B = 'bb000000-0000-4000-8000-000000000bbb';
const PACKAGE_C = 'cc000000-0000-4000-8000-000000000ccc';

function sceneGuid(packageId: string): string {
  const parsed = PackageId.parse(packageId);
  if (!parsed.ok) throw parsed.error;
  return AssetGuid.format(AssetGuid.derive(parsed.value, 'scene'));
}

function sceneAssetPack(packageId: string, source?: string): unknown {
  return {
    schemaVersion: '3.0.0',
    packageId,
    assets: {
      scene: {
        kind: 'scene',
        refs: source === undefined ? [] : [sceneGuid(source)],
        payload: {
          kind: 'scene',
          entities:
            source === undefined
              ? { root: { components: {} } }
              : { child: { components: {}, instance: { source: 0 } } },
        },
      },
    },
  };
}

describe('scanner keyed SceneAsset instance cycle detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pack-instance-cycle-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts an acyclic instance chain A -> B -> C', async () => {
    await writeFile(
      join(dir, 'a.pack.json'),
      JSON.stringify(sceneAssetPack(PACKAGE_A, PACKAGE_B)),
      'utf8',
    );
    await writeFile(
      join(dir, 'b.pack.json'),
      JSON.stringify(sceneAssetPack(PACKAGE_B, PACKAGE_C)),
      'utf8',
    );
    await writeFile(join(dir, 'c.pack.json'), JSON.stringify(sceneAssetPack(PACKAGE_C)), 'utf8');
    expect((await scan([dir])).ok).toBe(true);
  });

  it.each([
    ['two', [PACKAGE_A, PACKAGE_B]],
    ['three', [PACKAGE_A, PACKAGE_B, PACKAGE_C]],
  ])('rejects a %s-asset source instance create cycle', async (_name, cycle) => {
    const [a, b, c] = cycle;
    await writeFile(join(dir, 'a.pack.json'), JSON.stringify(sceneAssetPack(a, b)), 'utf8');
    await writeFile(join(dir, 'b.pack.json'), JSON.stringify(sceneAssetPack(b, c ?? a)), 'utf8');
    if (c !== undefined)
      await writeFile(join(dir, 'c.pack.json'), JSON.stringify(sceneAssetPack(c, a)), 'utf8');
    const result = await scan([dir]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('pack-cyclic-reference');
    const detail = result.error.detail as { kind?: string; cycle?: readonly string[] };
    expect(detail.kind).toBe('mount-asset');
    const found = detail.cycle ?? [];
    expect(found[0]).toBe(found[found.length - 1]);
    for (const guid of cycle) expect(found).toContain(sceneGuid(guid));
  });

  it('rejects a self-instance', async () => {
    await writeFile(
      join(dir, 'a.pack.json'),
      JSON.stringify(sceneAssetPack(PACKAGE_A, PACKAGE_A)),
      'utf8',
    );
    const result = await scan([dir]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('pack-cyclic-reference');
    expect((result.error.detail as { kind?: string }).kind).toBe('mount-asset');
  });
});
