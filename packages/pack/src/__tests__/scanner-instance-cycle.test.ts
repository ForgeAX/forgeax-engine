// Scanner dependency-cycle coverage for keyed SceneAsset instances.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scan } from '../scanner.js';

const GUID_A = 'aa000000-0000-4000-8000-000000000aaa';
const GUID_B = 'bb000000-0000-4000-8000-000000000bbb';
const GUID_C = 'cc000000-0000-4000-8000-000000000ccc';

function sceneAssetPack(guid: string, source?: string): unknown {
  return {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid,
        kind: 'scene',
        refs: source === undefined ? [] : [source],
        payload: {
          kind: 'scene',
          entities:
            source === undefined
              ? { root: { components: {} } }
              : { child: { components: {}, instance: { source: 0 } } },
        },
      },
    ],
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
      JSON.stringify(sceneAssetPack(GUID_A, GUID_B)),
      'utf8',
    );
    await writeFile(
      join(dir, 'b.pack.json'),
      JSON.stringify(sceneAssetPack(GUID_B, GUID_C)),
      'utf8',
    );
    await writeFile(join(dir, 'c.pack.json'), JSON.stringify(sceneAssetPack(GUID_C)), 'utf8');
    expect((await scan([dir])).ok).toBe(true);
  });

  it.each([
    ['two', [GUID_A, GUID_B]],
    ['three', [GUID_A, GUID_B, GUID_C]],
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
    for (const guid of cycle) expect(found).toContain(guid);
  });

  it('rejects a self-instance', async () => {
    await writeFile(
      join(dir, 'a.pack.json'),
      JSON.stringify(sceneAssetPack(GUID_A, GUID_A)),
      'utf8',
    );
    const result = await scan([dir]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('pack-cyclic-reference');
    expect((result.error.detail as { kind?: string }).kind).toBe('mount-asset');
  });
});
