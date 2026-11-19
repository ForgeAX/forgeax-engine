import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

function admit(evidence) {
  const source = readFileSync(new URL('../smoke-dawn.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const evidence = globalThis.__forgeaxShadowStress;');
  const end = source.indexOf('\nlet drivenRafCallbacks', start);
  return runInNewContext(`${source.slice(start, end)}; targetFrames;`, {
    globalThis: { __forgeaxShadowStress: evidence },
    fail: (message) => { throw new Error(message); },
  });
}

const published = {
  completedFrames: 0,
  preparationCompletedFrames: 0,
  warmupFrames: 0,
  profileFrames: 30,
  sampleFrames: 29,
};

test('stale published evidence cannot bypass the completed-frame loop with undefined comparisons', () => {
  const { completedFrames, preparationCompletedFrames, ...stale } = published;
  assert.throws(() => admit(stale), /published app evidence.*completedFrames/);
});

test('invalid published frame counters and measurement windows fail before frame driving', () => {
  for (const field of Object.keys(published)) {
    for (const invalid of [undefined, Number.NaN, -1, 0.5, '60']) {
      assert.throws(() => admit({ ...published, [field]: invalid }), new RegExp(`published app evidence.*${field}`));
    }
  }
});

test('a valid startup remains at zero real completions and retains the original 60-frame window', () => {
  assert.equal(admit(published), 60);
  assert.equal(published.completedFrames, 0);
  assert.equal(published.preparationCompletedFrames, 0);
  assert.equal(admit({ ...published, warmupFrames: 120 }), 180);
});
