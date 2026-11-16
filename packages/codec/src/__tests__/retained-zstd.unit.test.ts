import { setImmediate } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import * as zlib from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import {
  _setZstdImporter,
  copyRetainedZstdBytes,
  decompressRetainedZstd,
  retainedZstdBytes,
} from '../zstd.js';

// The supported test runtime has native zstd; repository Node type declarations predate it.
const { zstdCompressSync, zstdDecompressSync } = zlib as typeof zlib & {
  zstdCompressSync(bytes: Uint8Array): Uint8Array;
  zstdDecompressSync(bytes: Uint8Array): Uint8Array;
};
afterEach(() => _setZstdImporter());
setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;

async function windows() {
  const stats = { calls: 0 };
  const decoder = (bytes: Uint8Array) => {
    stats.calls++;
    return new Uint8Array(zstdDecompressSync(bytes));
  };
  _setZstdImporter(async () => decoder);
  const raw = new Uint8Array(100000).map((_, i) => (i * 17) & 255);
  const encoded = zstdCompressSync(raw),
    transport = new Uint8Array(encoded.length + 12);
  transport.set(encoded, 7);
  const loading = decompressRetainedZstd(transport.subarray(7, 7 + encoded.length));
  transport.fill(0);
  const decoded = await loading;
  if (!decoded.ok) throw Error(decoded.error.code);
  const first = decoded.value.slice(19, 4201),
    second = decoded.value.slice(903, 10009);
  copyRetainedZstdBytes(decoded.value, first, 19);
  copyRetainedZstdBytes(decoded.value, second, 903);
  const firstStorage = retainedZstdBytes(first),
    secondStorage = retainedZstdBytes(second);
  if (firstStorage === undefined || secondStorage === undefined)
    throw Error('Missing retained window');
  return {
    first: firstStorage,
    second: secondStorage,
    weak: [new WeakRef(decoded.value), new WeakRef(first), new WeakRef(second)],
    stats,
    expectedFirst: raw.slice(19, 4201),
    expectedSecond: raw.slice(903, 10009),
  };
}

it('keeps only an independent compressed frame across GC and shares one cold group decode', async () => {
  const held = await windows();
  expect(held.first.storageIdentity).toBe(held.second.storageIdentity);
  expect(held.first.storedByteLength).toBeLessThan(held.first.byteLength);
  for (let i = 0; i < 8; i++) {
    await setImmediate();
    collect();
  }
  expect(held.weak.every((weak) => weak.deref() === undefined)).toBe(true);
  expect(held.stats.calls).toBe(1);
  const a = held.first.read(),
    b = held.second.read();
  expect(a).toEqual(held.expectedFirst);
  expect(b).toEqual(held.expectedSecond);
  expect(held.first.read()).toBe(a);
  expect(a.byteLength).toBe(a.buffer.byteLength);
  expect(a.buffer).not.toBe(b.buffer);
  expect(held.stats.calls).toBe(2);
  expect(retainedZstdBytes(a)).toBe(held.first);
});

it('does not associate corrupt, uncompressed, mismatching or out-of-range copies', async () => {
  const held = await windows(),
    source = held.first.read();
  const wrong = new Uint8Array(source).fill(3),
    tooLong = new Uint8Array(source.length + 1);
  copyRetainedZstdBytes(source, wrong);
  copyRetainedZstdBytes(source, tooLong);
  copyRetainedZstdBytes(source, new Uint8Array(1), -1);
  expect(retainedZstdBytes(wrong)).toBeUndefined();
  expect(retainedZstdBytes(tooLong)).toBeUndefined();
  expect(retainedZstdBytes(new Uint8Array(source))).toBeUndefined();
  expect((await decompressRetainedZstd(new Uint8Array([1, 2, 3]))).ok).toBe(false);
});
