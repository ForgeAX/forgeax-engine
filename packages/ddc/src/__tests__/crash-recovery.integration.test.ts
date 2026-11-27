import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { DdcEntryStore } from '../entry-store.js';
import { DdcLifecycle } from '../lifecycle.js';
import { ddcEntryFixture } from './entry-fixture.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

async function writeEntry(root: string, key: string): Promise<void> {
  await new DdcEntryStore(root).write(
    ddcEntryFixture(
      {
        key,
        guid: GUID,
        payload: { key },
        refs: [],
        artifacts: {},
      },
      'test',
      key,
    ),
  );
}

describe('DDC lease and crash recovery', () => {
  const scratch = temporaryDirectories();

  afterEach(scratch.clear);

  it('keeps a crashed cooking attempt out of the readable head', async () => {
    const root = await scratch.make('forgeax-ddc-crash-');
    const lifecycle = new DdcLifecycle(root);
    await writeEntry(root, KEY_A);
    const accepted = await lifecycle.begin(GUID, KEY_A);
    await expect(lifecycle.commit(accepted, KEY_A)).resolves.toMatchObject({ result: 'current' });
    const crashed = await lifecycle.begin(GUID, KEY_B);
    await expect(lifecycle.readCurrentEntry(GUID)).resolves.toMatchObject({ entry: null });
    const replacement = await lifecycle.begin(GUID, KEY_B);
    expect(replacement.generation).toBeGreaterThan(crashed.generation);
    await writeEntry(root, KEY_B);
    await expect(lifecycle.commit(crashed, KEY_B)).resolves.toMatchObject({ result: 'lease-lost' });
    await expect(lifecycle.commit(replacement, KEY_B)).resolves.toMatchObject({
      result: 'current',
    });
    await expect(lifecycle.inspect(GUID, KEY_B)).resolves.toMatchObject({
      state: 'current',
      currentKey: KEY_B,
      lastKnownGoodKey: KEY_A,
    });
  });

  it('rejects a commit after the lease is lost', async () => {
    const root = await scratch.make('forgeax-ddc-crash-');
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, KEY_A);
    await lifecycle.fail(lease, {
      code: 'lease-lost',
      detail: 'cook lease was revoked before validation',
    });

    await expect(lifecycle.commit(lease, KEY_A)).resolves.toEqual({
      result: 'lease-lost',
      key: KEY_A,
      revision: 1,
    });
  });

  it('rejects an old writer after a newer desired key starts cooking', async () => {
    const root = await scratch.make('forgeax-ddc-crash-');
    const lifecycle = new DdcLifecycle(root);
    const oldLease = await lifecycle.begin(GUID, KEY_A);
    const newLease = await lifecycle.begin(GUID, KEY_B);
    await writeEntry(root, KEY_B);

    await expect(lifecycle.commit(oldLease, KEY_A)).resolves.toEqual({
      result: 'lease-lost',
      key: KEY_A,
      revision: 0,
    });
    await expect(lifecycle.commit(newLease, KEY_B)).resolves.toMatchObject({
      result: 'current',
      head: { currentKey: KEY_B, revision: 1, generation: newLease.generation },
    });
  });
});
