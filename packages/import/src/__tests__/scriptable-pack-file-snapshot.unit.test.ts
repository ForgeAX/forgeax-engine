import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetGuid as AssetGuidType } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { createScriptablePackFileAssetSnapshotSource } from '../index.js';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function pack(
  assets: readonly {
    readonly guid: string;
    readonly kind: string;
    readonly payload: Record<string, unknown>;
  }[],
): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: assets.map((asset) => ({ ...asset, refs: [] })),
  });
}

const ROOT_GUID = '019ffa97-2000-7000-8000-000000000011';
const SECOND_GUID = '019ffa97-2000-7000-8000-000000000012';
const MISSING_GUID = guid('019ffa97-2000-7000-8000-000000000099');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-file-source-'));
  temporaryRoots.push(root);
  return root;
}

describe('ScriptablePack file asset snapshot source', () => {
  it('indexes ordinary Pack JSON by GUID and returns deterministic private snapshots', async () => {
    const root = await temporaryRoot();
    const nested = join(root, 'nested');
    await mkdir(nested);
    await writeFile(
      join(root, 'root.pack.json'),
      pack([{ guid: ROOT_GUID, kind: 'video', payload: { url: '/root.webm' } }]),
    );
    await writeFile(
      join(nested, 'second.pack.json'),
      pack([{ guid: SECOND_GUID, kind: 'video', payload: { url: '/second.webm' } }]),
    );

    const source = createScriptablePackFileAssetSnapshotSource({ assetRoots: [root] });
    const first = await source.readByGuid(guid(ROOT_GUID));
    const second = await source.readByGuid(guid(ROOT_GUID));

    expect(first).toMatchObject({
      ok: true,
      value: {
        asset: { kind: 'video', url: '/root.webm' },
        generation: expect.any(Number),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    expect(second).toEqual(first);
    if (!first.ok) return;
    expect(first.value.generation).toBeGreaterThan(0);
    (first.value.asset as { url: string }).url = '/mutated.webm';

    const reread = await source.readByGuid(guid(ROOT_GUID));
    expect(reread).toMatchObject({ ok: true, value: { asset: { url: '/root.webm' } } });
  });

  it('keeps generation and digest stable when roots and JSON key order change', async () => {
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();
    await writeFile(
      join(firstRoot, 'first.pack.json'),
      pack([{ guid: ROOT_GUID, kind: 'video', payload: { url: '/root.webm', loop: true } }]),
    );
    await writeFile(
      join(secondRoot, 'second.pack.json'),
      pack([{ guid: SECOND_GUID, kind: 'video', payload: { loop: false, url: '/second.webm' } }]),
    );

    const first = await createScriptablePackFileAssetSnapshotSource({
      assetRoots: [firstRoot, secondRoot],
    }).readByGuid(guid(ROOT_GUID));
    const second = await createScriptablePackFileAssetSnapshotSource({
      assetRoots: [secondRoot, firstRoot],
    }).readByGuid(guid(ROOT_GUID));

    expect(second).toEqual(first);
  });

  it('returns structured failures for malformed packages, collisions, and missing GUIDs', async () => {
    const malformedRoot = await temporaryRoot();
    await writeFile(join(malformedRoot, 'broken.pack.json'), '{not-json');
    const malformed = await createScriptablePackFileAssetSnapshotSource({
      assetRoots: [malformedRoot],
    }).readByGuid(MISSING_GUID);
    expect(malformed).toMatchObject({
      ok: false,
      error: {
        code: 'scriptable-pack-file-json-invalid',
        detail: { path: join(malformedRoot, 'broken.pack.json') },
      },
    });

    const invalidRoot = await temporaryRoot();
    await writeFile(
      join(invalidRoot, 'invalid.pack.json'),
      JSON.stringify({ schemaVersion: '1.0.0', kind: 'internal-text-package' }),
    );
    const invalid = await createScriptablePackFileAssetSnapshotSource({
      assetRoots: [invalidRoot],
    }).readByGuid(MISSING_GUID);
    expect(invalid).toMatchObject({
      ok: false,
      error: {
        code: 'scriptable-pack-file-invalid',
        detail: { path: join(invalidRoot, 'invalid.pack.json') },
      },
    });

    const collisionRoot = await temporaryRoot();
    await writeFile(
      join(collisionRoot, 'a.pack.json'),
      pack([{ guid: ROOT_GUID, kind: 'video', payload: { url: '/a.webm' } }]),
    );
    await writeFile(
      join(collisionRoot, 'b.pack.json'),
      pack([{ guid: ROOT_GUID, kind: 'video', payload: { url: '/b.webm' } }]),
    );
    const collision = await createScriptablePackFileAssetSnapshotSource({
      assetRoots: [collisionRoot],
    }).readByGuid(guid(ROOT_GUID));
    expect(collision).toMatchObject({
      ok: false,
      error: {
        code: 'scriptable-pack-file-guid-collision',
        detail: {
          guid: ROOT_GUID,
          paths: [join(collisionRoot, 'a.pack.json'), join(collisionRoot, 'b.pack.json')],
        },
      },
    });

    const emptyRoot = await temporaryRoot();
    const missing = await createScriptablePackFileAssetSnapshotSource({
      assetRoots: [emptyRoot],
    }).readByGuid(MISSING_GUID);
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'asset-not-found', detail: { guid: AssetGuid.format(MISSING_GUID) } },
    });
  });

  it('fails closed when an asset root cannot be read', async () => {
    const root = join(await temporaryRoot(), 'missing');
    const result = await createScriptablePackFileAssetSnapshotSource({
      assetRoots: [root],
    }).readByGuid(MISSING_GUID);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'scriptable-pack-file-root-unreadable', detail: { root } },
    });
  });
});
