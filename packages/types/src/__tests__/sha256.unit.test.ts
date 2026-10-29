import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256 } from '../sha256';

const vectors = [
  '',
  'abc',
  'a'.repeat(55),
  'b'.repeat(64),
  'c'.repeat(129),
  'a\u0000\ud83d\ude00\u03bb\ud800z\udc00',
  'shader source\n'.repeat(1024),
];
const expected = vectors.map((text) => createHash('sha256').update(text).digest('hex'));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('uses synchronous native SHA-256 on Node without allocating an encoded copy', () => {
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  expect(vectors.map(sha256)).toEqual(expected);
  expect(encode).not.toHaveBeenCalled();
});

it('retains exact portable UTF-8 identities without a Node builtin loader', async () => {
  vi.stubGlobal('process', { ...process, getBuiltinModule: undefined });
  vi.resetModules();
  const portable = await import('../sha256');
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  expect(vectors.map(portable.sha256)).toEqual(expected);
  expect(encode).toHaveBeenCalledTimes(vectors.length);
});
