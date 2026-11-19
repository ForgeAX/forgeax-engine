import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256, sha256Bytes } from '../index';

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

it.each([
  'native',
  'portable',
] as const)('streams original chunks through %s SHA-256', async (backend) => {
  if (backend === 'portable') vi.stubGlobal('process', { ...process, getBuiltinModule: undefined });
  vi.resetModules();
  const owner = backend === 'native' ? { sha256 } : await import('../sha256');
  const chunks = ['prefix', '\ud83d\ude00', new Uint8Array([0, 255]), 'tail'];
  const expected = createHash('sha256');
  for (const chunk of chunks) expected.update(chunk);
  expect(owner.sha256(chunks.values())).toBe(expected.digest('hex'));
  expect(owner.sha256([])).toBe(createHash('sha256').digest('hex'));
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

it.each([
  'native',
  'portable',
] as const)('hashes only the raw byte window through the %s public entry', async (backend) => {
  if (backend === 'portable') vi.stubGlobal('process', { ...process, getBuiltinModule: undefined });
  vi.resetModules();
  const owner = backend === 'native' ? { sha256Bytes } : await import('../index');
  const bytes = Uint8Array.from([0x7f, 0x00, 0xff, 0x80, 0x61, 0xfe]);
  const windows = [new Uint8Array(), bytes, bytes.subarray(1, 5)];
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  for (const window of windows)
    expect(owner.sha256Bytes(window)).toBe(createHash('sha256').update(window).digest('hex'));
  expect(owner.sha256Bytes(bytes.subarray(1, 5))).not.toBe(owner.sha256Bytes(bytes));
  expect(encode).not.toHaveBeenCalled();
});

it('keeps the existing cross-realm byte input identity while accepting streamed text', () => {
  const foreign: Uint8Array = runInNewContext('Uint8Array.from([0, 1, 127, 255])');
  expect(sha256(foreign)).toBe(createHash('sha256').update(foreign).digest('hex'));
});
