import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGhPages } from '../parse-gh-pages.mjs';

test('parses one JSON array emitted by a test double', () => {
  assert.deepEqual(parseGhPages('[{"total_count":1}]'), [{ total_count: 1 }]);
});

test('parses newline-delimited paginated objects', () => {
  assert.deepEqual(parseGhPages('{"page":1}\n{"page":2}'), [{ page: 1 }, { page: 2 }]);
});

test('parses concatenated paginated objects emitted by gh api --paginate', () => {
  assert.deepEqual(parseGhPages('{"page":1}{"page":2}'), [{ page: 1 }, { page: 2 }]);
});

test('preserves braces and brackets inside JSON strings', () => {
  assert.deepEqual(parseGhPages('{"key":"{}[]"}{"page":2}'), [{ key: '{}[]' }, { page: 2 }]);
});
