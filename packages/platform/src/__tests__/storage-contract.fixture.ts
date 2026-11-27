import { expect } from 'vitest';
import type { FileStore, RecordStore } from '../storage.js';

export async function verifyFileStore(first: FileStore, reopened: FileStore) {
  const signal = new AbortController().signal;
  const cancelled = AbortSignal.abort();
  const incomplete = (await first.beginWrite(2, signal)).unwrap();
  (await incomplete.append(Uint8Array.of(8), signal)).unwrap();
  expect(await incomplete.commit(signal)).toMatchObject({ error: { code: 'invalid-input' } });
  (await incomplete.abort()).unwrap();
  expect(await incomplete.append(Uint8Array.of(9), signal)).toMatchObject({
    error: { code: 'closed' },
  });

  const writer = (await first.beginWrite(5, signal)).unwrap();
  (await writer.append(Uint8Array.of(99, 1, 2, 99).subarray(1, 3), signal)).unwrap();
  (await writer.append(Uint8Array.of(3, 4, 5), signal)).unwrap();
  const ref = (await writer.commit(signal)).unwrap();
  (await writer.abort()).unwrap();
  expect(await reopened.openRead(ref, cancelled)).toMatchObject({ error: { code: 'cancelled' } });

  const read = (await reopened.openRead(ref, signal)).unwrap();
  try {
    expect(await reopened.remove(ref, signal)).toMatchObject({ error: { code: 'io' } });
    const target = new Uint8Array(5).fill(99);
    expect((await read.readAt(3, target.subarray(1, 4), signal)).unwrap()).toBe(2);
    expect([...target]).toEqual([99, 4, 5, 99, 99]);
    expect((await read.readAt(5, target, signal)).unwrap()).toBe(0);
    expect(await read.readAt(-1, target, signal)).toMatchObject({
      error: { code: 'invalid-input' },
    });
  } finally {
    (await read.close()).unwrap();
  }
  (await reopened.remove(ref, signal)).unwrap();
  expect(await reopened.openRead(ref, signal)).toMatchObject({ error: { code: 'missing' } });
}

export async function verifyRecordStore(first: RecordStore, reopened: RecordStore) {
  const signal = new AbortController().signal;
  const key = 'test-1';
  expect((await first.read(key, signal)).unwrap()).toBeUndefined();
  (await first.replace(key, Uint8Array.of(7, 1, 2, 7).subarray(1, 3), signal)).unwrap();
  expect(await reopened.replace(key, Uint8Array.of(3), AbortSignal.abort())).toMatchObject({
    error: { code: 'cancelled' },
  });
  expect((await reopened.read(key, signal)).unwrap()).toEqual(Uint8Array.of(1, 2));
  const writes = await Promise.all([
    first.replace(key, new Uint8Array(16).fill(8), signal),
    reopened.replace(key, new Uint8Array(16).fill(9), signal),
  ]);
  for (const write of writes) write.unwrap();
  const bytes = (await first.read(key, signal)).unwrap();
  expect(bytes).toHaveLength(16);
  expect([8, 9]).toContain(bytes?.[0]);
  expect(bytes?.every((value) => value === bytes[0])).toBe(true);
  (await reopened.remove(key, signal)).unwrap();
  (await first.remove(key, signal)).unwrap();
  expect((await reopened.read(key, signal)).unwrap()).toBeUndefined();
}
