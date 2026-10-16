import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DdcEntry, DdcEntryStore, ddcOutputDigest } from '../entry-store.js';

const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const key = 'a'.repeat(64);

describe('DDC consumer path', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('rebuilds the same output after deleting DDC storage', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'forgeax-ddc-consumer-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'forgeax-ddc-consumer-'));
    roots.push(firstRoot, secondRoot);
    const cookedBase = {
      key,
      guid,
      payload: { kind: 'texture', width: 2, height: 1 },
      refs: [],
      artifacts: {
        payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2]) },
      },
      receipt: {
        guid,
        key,
        producer: 'image-importer@4',
        inputFingerprint: 'source-bytes',
        outputDigest: '',
      },
    } satisfies DdcEntry;
    const cooked: DdcEntry = {
      ...cookedBase,
      receipt: { ...cookedBase.receipt, outputDigest: ddcOutputDigest(cookedBase) },
    };

    const firstStore = new DdcEntryStore(firstRoot);
    await firstStore.write(cooked);
    const cold = await firstStore.read(key);
    await rm(firstRoot, { recursive: true, force: true });
    const secondStore = new DdcEntryStore(secondRoot);
    await secondStore.write(cooked);
    const rebuilt = await secondStore.read(key);

    expect(rebuilt).toEqual(cold);
    expect(rebuilt?.guid).toBe(guid);
    expect(rebuilt?.receipt.outputDigest).toBe(ddcOutputDigest(cooked));
  });

  it('keeps a direct product path independent from DDC presence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-direct-'));
    roots.push(root);
    const store = new DdcEntryStore(root);
    await expect(store.read(key)).resolves.toBeNull();
  });
});
