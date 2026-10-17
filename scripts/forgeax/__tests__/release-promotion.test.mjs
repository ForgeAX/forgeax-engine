import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promoteRelease } from '../release-promotion.mjs';

const items = [
  { name: '@forgeax/engine', version: '1.2.3' },
  { name: '@forgeax/view', version: '1.2.3' },
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
test('all products upload before their joint visibility gate; pending bytes preserve channels', async () => {
  const options = operations('visibility');
  await assert.rejects(promoteRelease(options), /pending validation/);
  assert.deepEqual(options.calls, [
    'upload:@forgeax/engine:candidate',
    'upload:@forgeax/view:candidate',
    'upload:@forgeax/engine-sdk:candidate',
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
  assert.deepEqual(tags, [
    'tag:@forgeax/engine:next',
    'tag:@forgeax/view:next',
    'tag:@forgeax/engine-sdk:next',
  ]);
  assert(options.calls.indexOf('consumer') < options.calls.indexOf(tags[0]));
});

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('slow uploads run together and all bytes gate consumer verification and latest', async () => {
  const options = operations();
  const uploads = items.map(deferred);
  const visibility = deferred();
  const started = [];
  options.upload = (item) => {
    const index = items.indexOf(item);
    started.push(item.name);
    return uploads[index].promise;
  };
  options.wait = async (waiting, tag) => {
    assert.deepEqual(waiting, items);
    options.calls.push(`wait:${tag ?? 'bytes'}`);
    if (!tag) await visibility.promise;
  };
  const promotion = promoteRelease(options);
  assert.deepEqual(
    started,
    items.map((item) => item.name),
  );
  uploads[2].resolve('sdk');
  uploads[0].resolve('engine');
  await new Promise(setImmediate);
  assert.deepEqual(options.calls, []);
  uploads[1].resolve('view');
  await new Promise(setImmediate);
  assert.deepEqual(options.calls, ['wait:bytes']);
  visibility.resolve();
  const result = await promotion;
  assert.deepEqual(result.reports, ['engine', 'view', 'sdk']);
  assert.deepEqual(options.calls, [
    'wait:bytes',
    'consumer',
    'tag:@forgeax/engine:latest',
    'tag:@forgeax/view:latest',
    'tag:@forgeax/engine-sdk:latest',
    'wait:latest',
  ]);
});

test('a failed upload drains other active uploads before failing without channel mutation', async () => {
  const options = operations();
  const slow = deferred();
  let settled = false;
  const failure = new Error('registry rejected upload');
  options.upload = (item) => (item === items[0] ? Promise.reject(failure) : slow.promise);
  const promotion = promoteRelease(options);
  const rejection = assert
    .rejects(promotion, (error) => error === failure)
    .then(() => {
      settled = true;
    });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.deepEqual(options.calls, []);
  slow.resolve({});
  await rejection;
  assert.deepEqual(options.calls, []);
});
test('focused-package publication is rejected before any upload', async () => {
  const options = operations();
  options.items = [{ name: '@forgeax/engine-remote' }];
  await assert.rejects(promoteRelease(options), /release-focused-package-forbidden/);
  assert.deepEqual(options.calls, []);
});
