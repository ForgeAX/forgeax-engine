import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  verifyFileStore,
  verifyRecordStore,
} from '../../../../platform/src/__tests__/storage-contract.fixture';
import { createDesktopGameSaves } from '../desktop-platform';
import { createDesktopFileStore, createDesktopRecordStore } from '../desktop-storage';

it('reopens project records, immutable versions, and the existing desktop save file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-desktop-storage-'));
  try {
    const records = () => createDesktopRecordStore(join(root, 'records'));
    const files = () => createDesktopFileStore(join(root, 'files'));
    await verifyRecordStore(records(), records());
    await verifyFileStore(files(), files());
    const path = join(root, 'slot-checkpoint.json');
    await writeFile(path, '{"version":1,"data":{"room":4}}');
    const { saves, flush } = createDesktopGameSaves(root);
    expect((await saves.read('checkpoint')).unwrap()?.data).toEqual({ room: 4 });
    (await saves.write('checkpoint', { version: 2, data: { room: 8 } })).unwrap();
    await flush();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 2, data: { room: 8 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
