import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildCacheEntries,
  seedTemplateBuildCache,
  TEMPLATE_BUILD_CACHE,
} from '../sdk-template-cache.mjs';

async function write(path, body = 'x') {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}

/** What `forgeax project build` leaves in a project: products plus outputs that must not ship. */
async function fakeBuild(template) {
  const cache = join(template, TEMPLATE_BUILD_CACHE);
  await write(join(cache, 'scriptable-pack-products/entries/k1/payload.json'), '{"p":1}');
  await write(join(cache, 'scriptable-pack-products/staging/k2-tmp/payload.json'));
  await write(join(cache, 'scriptable-pack-product-kinds/entries/d1/payload.json'), '{"d":1}');
  await write(join(template, '.forgeax/ddc/v2/entries/a/payload.json'));
  await write(join(template, '.forgeax/generated/main.ts'));
  await write(join(template, 'dist/index.html'));
}

test('a seeded SDK template ships only its published Pack products', async () => {
  const template = await mkdtemp(join(tmpdir(), 'sdk-template-cache-'));
  try {
    await write(join(template, 'package.json'), '{}');
    await write(join(template, 'node_modules/.keep'));
    const entries = await seedTemplateBuildCache(template, () => fakeBuild(template));
    assert.deepEqual(entries, ['scriptable-pack-product-kinds/d1', 'scriptable-pack-products/k1']);
    assert.deepEqual(await buildCacheEntries(template), entries);
    assert.deepEqual((await readdir(template)).sort(), [
      '.forgeax',
      'node_modules',
      'package.json',
    ]);
    assert.deepEqual(await readdir(join(template, '.forgeax')), ['ddc']);
    assert.deepEqual(await readdir(join(template, '.forgeax/ddc')), ['build-cache']);
    assert.deepEqual(
      await readdir(join(template, TEMPLATE_BUILD_CACHE, 'scriptable-pack-products')),
      ['entries'],
    );
    assert.equal(
      await readFile(
        join(template, TEMPLATE_BUILD_CACHE, 'scriptable-pack-products/entries/k1/payload.json'),
        'utf8',
      ),
      '{"p":1}',
    );
  } finally {
    await rm(template, { recursive: true, force: true });
  }
});

test('a template build that publishes no Pack product fails the SDK build', async () => {
  const template = await mkdtemp(join(tmpdir(), 'sdk-template-cache-'));
  try {
    await assert.rejects(
      seedTemplateBuildCache(template, () => write(join(template, 'dist/index.html'))),
      /sdk-template-build-cache-empty/,
    );
  } finally {
    await rm(template, { recursive: true, force: true });
  }
});

test('a project without a build cache lists no entries', async () => {
  const project = await mkdtemp(join(tmpdir(), 'sdk-template-cache-'));
  try {
    assert.deepEqual(await buildCacheEntries(project), []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
