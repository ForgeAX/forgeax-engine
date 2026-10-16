import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DdcEntry, DdcEntryStore, ddcOutputDigest } from '../entry-store.js';

const KEY = 'a'.repeat(64);
const entry = (payload: string): DdcEntry => {
  const value = {
    key: KEY,
    guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
    payload: { payload },
    refs: [],
    artifacts: {
      data: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
    },
    receipt: {
      guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
      key: KEY,
      producer: 'test-producer',
      inputFingerprint: 'input',
      outputDigest: '',
    },
  } satisfies DdcEntry;
  return { ...value, receipt: { ...value.receipt, outputDigest: ddcOutputDigest(value) } };
};

describe('DDC same-key writer concurrency', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('lets one writer publish and makes the loser observe an identical entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-concurrency-'));
    roots.push(root);
    const store = new DdcEntryStore(root);
    const results = await Promise.all([store.write(entry('same')), store.write(entry('same'))]);

    expect(results.map((result) => result.result).sort()).toEqual(['existing', 'published']);
    await expect(store.read(KEY)).resolves.toEqual(entry('same'));
  });

  it('reports a conflict when the same key maps to different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-concurrency-'));
    roots.push(root);
    const store = new DdcEntryStore(root);
    await store.write(entry('first'));
    await expect(store.write(entry('second'))).resolves.toEqual({ result: 'conflict', key: KEY });
    await expect(store.read(KEY)).resolves.toEqual(entry('first'));
  });
});
