import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { engineProducerVersion } from '../engine-version.js';
import type { ScriptablePackBuildProduct } from '../scriptable-pack-build-core.js';
import { createScriptablePackProductCache } from '../scriptable-pack-product-cache.js';

const engine = vi.hoisted(() => ({ version: undefined as string | undefined }));
vi.mock('../engine-version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine-version.js')>();
  return { engineProducerVersion: () => engine.version ?? actual.engineProducerVersion() };
});

it('names the Engine package release that produces Pack products', () => {
  expect(engineProducerVersion()).toMatch(/^@forgeax\/engine-import@\d+\.\d+\.\d+/);
});

// Pack evaluation runs Engine modules that no source closure records. A
// location-independent entry is shared by every project on one cache root, so
// a project on another Engine release must cook its own product.
it('re-cooks an unchanged Pack source produced by another Engine release', async () => {
  const machine = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-engine-'));
  try {
    const projectAt = async (name: string) => {
      const root = join(machine, name);
      await mkdir(join(root, 'assets'), { recursive: true });
      const sourcePath = join(root, 'assets', 'scene.pack.ts');
      await writeFile(sourcePath, 'source');
      return {
        root,
        subject: {
          sourcePath,
          sourceClosure: [
            {
              path: sourcePath,
              digest: `sha256:${createHash('sha256').update('source').digest('hex')}`,
            },
          ],
          definition: definePack({
            schemaVersion: '2.0.0',
            packageId: definePackageId('01900000-0000-7000-8000-0000000000e9'),
            build: () => ok({}),
          }),
        },
      };
    };
    const product = {
      product: { assets: [{ kind: 'scene', payload: { entities: {} } }] },
      stagedOutputs: [],
      externalEvidence: [],
      inputFingerprint: 'sha256:source',
    } as unknown as ScriptablePackBuildProduct;
    const cacheFor = (identityRoot: string) =>
      createScriptablePackProductCache({
        root: join(machine, 'cache'),
        outputVersions: {},
        cookers: [],
        identityRoot,
      });
    const first = await projectAt('first');
    const copy = await projectAt('copy');
    engine.version = '@forgeax/engine-import@1.0.0';
    await (await cacheFor(first.root)).write(first.subject, product);
    expect(await (await cacheFor(copy.root)).read(copy.subject)).toEqual(product);
    engine.version = '@forgeax/engine-import@1.0.1';
    expect(await (await cacheFor(copy.root)).read(copy.subject)).toBeUndefined();
    expect(await (await cacheFor(first.root)).read(first.subject)).toBeUndefined();
  } finally {
    engine.version = undefined;
    await rm(machine, { recursive: true, force: true });
  }
});
