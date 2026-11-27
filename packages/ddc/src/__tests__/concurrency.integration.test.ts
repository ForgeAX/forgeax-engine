import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { type DdcEntry, DdcEntryStore } from '../entry-store.js';
import { ddcEntryFixture } from './entry-fixture.js';

const KEY = 'a'.repeat(64);
const entry = (payload: string): DdcEntry => {
  return ddcEntryFixture(
    {
      key: KEY,
      guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
      payload: { payload },
      refs: [],
      artifacts: {
        data: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
      },
    },
    'test-producer',
    'input',
  );
};

describe('DDC same-key writer concurrency', () => {
  const scratch = temporaryDirectories();

  afterEach(scratch.clear);

  it('lets one writer publish and makes the loser observe an identical entry', async () => {
    const root = await scratch.make('forgeax-ddc-concurrency-');
    const store = new DdcEntryStore(root);
    const results = await Promise.all([store.write(entry('same')), store.write(entry('same'))]);

    expect(results.map((result) => result.result).sort()).toEqual(['existing', 'published']);
    await expect(store.read(KEY)).resolves.toEqual(entry('same'));
  });

  it('reports a conflict when the same key maps to different bytes', async () => {
    const root = await scratch.make('forgeax-ddc-concurrency-');
    const store = new DdcEntryStore(root);
    await store.write(entry('first'));
    await expect(store.write(entry('second'))).resolves.toEqual({ result: 'conflict', key: KEY });
    await expect(store.read(KEY)).resolves.toEqual(entry('first'));
  });
});
