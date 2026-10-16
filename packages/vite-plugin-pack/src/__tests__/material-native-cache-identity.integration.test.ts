import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { produceScriptablePackProducts } from '@forgeax/engine-import';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { err, type MaterialAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ fingerprint: 'sha256-native-a', valid: true }));
vi.mock('@forgeax/engine-naga', async (original) => ({
  ...(await original<typeof import('@forgeax/engine-naga')>()),
  getCompilerFingerprint: async () =>
    native.valid ? ok(native.fingerprint) : err(new Error('invalid native provenance')),
}));

it('invalidates the existing producer DDC when only native identity changes and rejects unavailable identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-native-identity-cache-'));
  const sourcePath = join(root, 'material.pack.ts');
  const bytes = 'fixed authoring source';
  const material: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'game::identity' } }],
    parameters: [],
  };
  const nativeCooker = createMaterialPackCooker();
  let cooks = 0;
  try {
    await writeFile(sourcePath, bytes);
    const identity = async () => {
      const value = await nativeCooker.cacheIdentity?.();
      if (value === undefined) throw new Error('native identity unavailable');
      return value;
    };
    const run = () =>
      produceScriptablePackProducts({
        sources: [
          {
            sourcePath,
            displaySourcePath: sourcePath,
            definition: definePack({
              schemaVersion: '2.0.0',
              packageId: definePackageId('01900000-0000-7000-8000-0000000000f7'),
              build: () => ok({ material }),
            }),
            sourceClosure: [
              {
                path: sourcePath,
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              },
            ],
            publicationGeneration: 1,
            policy: {
              base: '/',
              packagePath: 'material.pack.json',
              artifactPath: (guid, key) => `${guid}/${key}`,
            },
          },
        ],
        buildCacheRoot: join(root, 'cache'),
        cookers: [
          {
            key: 'material',
            cacheIdentity: identity,
            async cook(input) {
              cooks++;
              const fingerprint = await identity();
              const draft = input as { guid: string; source: unknown };
              return {
                guid: draft.guid,
                payload: draft.source,
                refs: [],
                artifacts: {},
                inputFingerprint: fingerprint,
              };
            },
          },
        ],
      });
    native.valid = true;
    native.fingerprint = 'sha256-native-a';
    const identityA = await identity();
    const first = await run();
    expect(first.ok).toBe(true);
    expect((await run()).unwrap()).toEqual(first.unwrap());
    expect(cooks).toBe(1);
    native.fingerprint = 'sha256-native-b';
    expect(await identity()).not.toBe(identityA);
    const second = await run();
    expect(second.ok).toBe(true);
    expect(cooks).toBe(2);
    expect((await run()).unwrap()).toEqual(second.unwrap());
    expect(cooks).toBe(2);
    native.valid = false;
    await expect(identity()).rejects.toThrow('invalid native provenance');
    const rejected = await run();
    expect(rejected.ok).toBe(false);
    expect(cooks).toBe(3);
  } finally {
    native.valid = true;
    await rm(root, { recursive: true, force: true });
  }
});
