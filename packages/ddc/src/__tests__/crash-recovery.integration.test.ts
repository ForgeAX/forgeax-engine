import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DdcEntryStore, ddcOutputDigest } from '../entry-store.js';
import { DdcLifecycle } from '../lifecycle.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

async function writeEntry(root: string, key: string): Promise<void> {
  const base = {
    key,
    guid: GUID,
    payload: { key },
    refs: [],
    artifacts: {},
    receipt: {
      guid: GUID,
      key,
      producer: 'test',
      inputFingerprint: key,
      outputDigest: '',
    },
  } as const;
  await new DdcEntryStore(root).write({
    ...base,
    receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) },
  });
}

describe('DDC lease and crash recovery', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps a crashed cooking attempt out of the readable head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-crash-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    await lifecycle.begin(GUID, KEY_A);

    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({ state: 'cooking' });
    await expect(lifecycle.recover(GUID, KEY_A)).resolves.toMatchObject({ state: 'failed' });
    await expect(lifecycle.inspect(GUID, KEY_A)).resolves.toMatchObject({
      state: 'failed',
      currentKey: undefined,
    });
  });

  it('rejects a commit after the lease is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-crash-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    await lifecycle.revoke(lease);

    await expect(lifecycle.commit(lease, KEY_A)).resolves.toEqual({
      result: 'lease-lost',
      key: KEY_A,
    });
  });

  it('keeps an old writer stale after a newer desired key starts cooking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-crash-'));
    roots.push(root);
    const lifecycle = new DdcLifecycle(root);
    const oldLease = await lifecycle.begin(GUID, KEY_A);
    const newLease = await lifecycle.begin(GUID, KEY_B);
    await writeEntry(root, KEY_B);

    await expect(lifecycle.commit(oldLease, KEY_A)).resolves.toEqual({
      result: 'stale',
      key: KEY_A,
    });
    await expect(lifecycle.commit(newLease, KEY_B)).resolves.toEqual({
      result: 'current',
      key: KEY_B,
    });
  });
});
