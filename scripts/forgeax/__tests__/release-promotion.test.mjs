import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promoteRelease } from '../release-promotion.mjs';

const items = [
  { name: '@forgeax/engine', version: '1.2.3' },
  { name: '@forgeax/engine-sdk', version: '1.2.3' },
];
function operations(fail) {
  const calls = [];
  return {
    calls,
    items,
    version: '1.2.3',
    upload: async (item, tag) => {
      calls.push(`upload:${item.name}:${tag}`);
      return {};
    },
    wait: async (items, tag) => {
      calls.push(`wait:${items[0].name}:${tag ?? 'bytes'}`);
      if (fail === 'visibility') throw new Error('pending validation');
    },
    verifyConsumer: async () => {
      calls.push('consumer');
      if (fail === 'consumer') throw new Error('install failed');
    },
    setTag: async (item, tag) => {
      calls.push(`tag:${item.name}:${tag}`);
    },
  };
}
test('a validating Engine blocks SDK upload and every public channel update', async () => {
  const options = operations('visibility');
  await assert.rejects(promoteRelease(options), /pending validation/);
  assert.deepEqual(options.calls, [
    'upload:@forgeax/engine:candidate',
    'wait:@forgeax/engine:bytes',
  ]);
});
test('a failing clean consumer preserves latest', async () => {
  const options = operations('consumer');
  await assert.rejects(promoteRelease(options), /install failed/);
  assert(!options.calls.some((call) => call.startsWith('tag:')));
});
test('development promotion updates next only after consumer proof', async () => {
  const options = operations();
  options.version = '1.3.0-dev.8.abcdef123456';
  const result = await promoteRelease(options);
  assert.equal(result.tag, 'next');
  const tags = options.calls.filter((call) => call.startsWith('tag:'));
  assert.deepEqual(tags, ['tag:@forgeax/engine:next', 'tag:@forgeax/engine-sdk:next']);
  assert(options.calls.indexOf('consumer') < options.calls.indexOf(tags[0]));
});
test('focused-package publication is rejected before any upload', async () => {
  const options = operations();
  options.items = [{ name: '@forgeax/engine-remote' }];
  await assert.rejects(promoteRelease(options), /release-focused-package-forbidden/);
  assert.deepEqual(options.calls, []);
});
