import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { DdcEntryStore, ddcOutputDigest } from '../entry-store.js';
import { ddcEntryFixture } from './entry-fixture.js';

const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const key = 'a'.repeat(64);

describe('DDC consumer path', () => {
  const scratch = temporaryDirectories();

  afterEach(scratch.clear);

  it('rebuilds the same output after deleting DDC storage', async () => {
    const firstRoot = await scratch.make('forgeax-ddc-consumer-');
    const secondRoot = await scratch.make('forgeax-ddc-consumer-');
    const cooked = ddcEntryFixture(
      {
        key,
        guid,
        payload: { kind: 'texture', width: 2, height: 1 },
        refs: [],
        artifacts: {
          payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2]) },
        },
      },
      'image-importer@4',
      'source-bytes',
    );

    const firstStore = new DdcEntryStore(firstRoot);
    await firstStore.write(cooked);
    const cold = await firstStore.read(key);
    await rm(firstRoot, { recursive: true, force: true });
    const secondStore = new DdcEntryStore(secondRoot);
    await expect(secondStore.read(key)).resolves.toBeNull();
    await secondStore.write(cooked);
    const rebuilt = await secondStore.read(key);

    expect(rebuilt).toEqual(cold);
    expect(rebuilt?.guid).toBe(guid);
    expect(rebuilt?.receipt.outputDigest).toBe(ddcOutputDigest(cooked));
  });
});
