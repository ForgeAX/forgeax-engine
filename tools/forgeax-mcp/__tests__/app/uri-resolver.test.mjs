import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const sdk = createRequire(require.resolve('@modelcontextprotocol/sdk/package.json'));
const ajv = createRequire(sdk.resolve('ajv/package.json'));
const uri = ajv('fast-uri');

test('Ajv URI dependency keeps suffix path components from becoming schemes', () => {
  for (const scheme of ['javascript', 'data', 'vbscript']) {
    const value = uri.serialize({ path: `${scheme}:marker` }, { reference: 'suffix' });
    assert.equal(uri.parse(value).scheme, undefined);
  }
});

test('Ajv URI dependency rejects encoded schemes instead of activating them', () => {
  for (const value of ['%6Aavascript:marker', '%u006Aavascript:marker']) {
    assert.ok(uri.parse(value).error);
    assert.notEqual(uri.parse(value).scheme, 'javascript');
    assert.throws(() => uri.resolve('https://example.invalid/', value), /malformed/i);
  }
  assert.equal(uri.equal('%68ttp://example.invalid/', 'http://example.invalid/'), false);
});

test('Ajv URI dependency reports malformed hosts without silently changing their identity', () => {
  for (const value of ['http://a@b@other.invalid/', 'http://exa\tmple.invalid/', 'http://exa\nmple.invalid/', 'http://exa\rmple.invalid/']) {
    assert.ok(uri.parse(value).error);
    assert.throws(() => uri.resolve('https://example.invalid/', value), /malformed/i);
  }
});

test('Ajv URI dependency preserves resolution when normalizing relative references', () => {
  const base = 'https://example.invalid/base/dir/';
  for (const value of ['../x', 'a/../b']) {
    assert.equal(uri.resolve(base, uri.normalize(value)), uri.resolve(base, value));
  }
});
