import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkEngineAuthoringPackageSize } from '../engine-authoring-package.mjs';
import {
  buildCacheEntries,
  seedTemplateBuildCache,
  stageSdkBuildCache,
} from '../sdk-template-cache.mjs';

test('the complete Engine npm archive fits the inclusive decimal 64 MB budget', () => {
  assert.doesNotThrow(() => checkEngineAuthoringPackageSize(64_000_000));
  assert.throws(
    () => checkEngineAuthoringPackageSize(64_000_001),
    /engine-authoring-package-budget-exceeded: 64000001 > 64000000/,
  );
});

async function write(path, body = 'x') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

test('templates share one seed, retaining only published Pack products and discovery rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-template-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, 'working-cache');
  const sdk = join(root, 'sdk/build-cache');
  const seed = 'scriptable-pack-products/entries/shared/payload.json';
  for (const id of ['empty', 'game-3d']) {
    const template = join(root, id);
    await write(join(template, 'package.json'), '{}');
    await write(join(template, 'node_modules/.keep'));
    await seedTemplateBuildCache(template, async () => {
      if (id === 'empty') await write(join(cache, seed), '{"p":1}');
      assert.equal(await readFile(join(cache, seed), 'utf8'), '{"p":1}');
      await write(join(cache, `scriptable-pack-products/entries/${id}/payload.json`));
      await write(join(cache, 'scriptable-pack-products/staging/pending/payload.json'));
      await write(join(cache, 'scriptable-pack-product-kinds/entries/discovery/payload.json'));
      await write(join(cache, 'scriptable-pack-transports/entries/transport/payload.json'));
      await write(join(cache, 'native-cook/input'));
      await write(join(template, '.forgeax/ddc/v2/entries/project/payload.json'));
      await write(join(template, 'dist/index.html'));
    });
    assert.deepEqual((await readdir(template)).sort(), ['node_modules', 'package.json']);
  }
  const entries = await stageSdkBuildCache(cache, sdk);
  assert.deepEqual(entries, [
    'scriptable-pack-product-kinds/discovery',
    'scriptable-pack-products/empty',
    'scriptable-pack-products/game-3d',
    'scriptable-pack-products/shared',
  ]);
  assert.deepEqual(await buildCacheEntries(sdk), entries);
  assert.deepEqual((await readdir(sdk)).sort(), [
    'scriptable-pack-product-kinds',
    'scriptable-pack-products',
  ]);
  assert.deepEqual(await readdir(join(sdk, 'scriptable-pack-products')), ['entries']);
  assert.equal(await readFile(join(sdk, seed), 'utf8'), '{"p":1}');
});

test('an SDK with no published Pack products fails staging', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-template-cache-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await buildCacheEntries(root), []);
  await assert.rejects(stageSdkBuildCache(root, join(root, 'sdk')), /sdk-build-cache-empty/);
});

test('the Engine seed excludes one Pack by receipt GUID from both stores', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'engine-template-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, 'working-cache');
  const staged = join(root, 'engine-cache');
  const stores = ['scriptable-pack-product-kinds', 'scriptable-pack-products'];
  for (const store of stores)
    for (const guid of ['convoy', 'shared'])
      await write(
        join(cache, store, 'entries', guid, 'entry.json'),
        JSON.stringify({
          receipt: { guid },
        }),
      );
  const expected = stores.map((store) => `${store}/shared`);
  assert.deepEqual(await stageSdkBuildCache(cache, staged, new Set(['convoy'])), expected);
  assert.deepEqual(await buildCacheEntries(staged), expected);
  assert.equal((await buildCacheEntries(cache)).length, 4);
});
