import { expect, it } from 'vitest';
import { canonicalJson } from '../canonical-json.js';

it('retains nested value order while removing object insertion order', () => {
  expect(canonicalJson({ z: [3, { b: true, a: 'quote"' }], a: null })).toBe(
    canonicalJson({ a: null, z: [3, { a: 'quote"', b: true }] }),
  );
  expect(canonicalJson({ z: 2, a: [1, 3] })).toBe('{"a":[1,3],"z":2}');
  expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
});

it('preserves existing undefined, numeric and indexed-object spelling', () => {
  expect(canonicalJson({ absent: undefined, number: NaN })).toBe('{"absent":null,"number":null}');
  expect(canonicalJson([undefined, null, -0])).toBe('[null,null,0]');
  expect(canonicalJson(new Uint8Array([2, 7]))).toBe('{"0":2,"1":7}');
  expect(() => canonicalJson(1n)).toThrow(TypeError);
});
