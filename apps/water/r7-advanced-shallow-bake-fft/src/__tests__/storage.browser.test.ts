import type { RuntimePackContent } from '@forgeax/engine/import';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadBakeContent, saveBakeContent } from '../storage';

const removeDatabase = () =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('forgeax-water-r7');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

beforeEach(removeDatabase);
afterEach(removeDatabase);

it('round-trips only bake content with native binary data intact', async () => {
  const content = {
    source: {
      schemaVersion: '3.0.0',
      packageId: '019fcf2d-7100-7000-8000-000000000272',
      assets: {},
    },
    blobs: { grid: new Uint8Array([0, 128, 255]) },
    dependencies: { body: 'sha256:body' },
  } satisfies RuntimePackContent;
  expect(await loadBakeContent()).toBeUndefined();
  await saveBakeContent(content);
  expect(await loadBakeContent()).toEqual(content);
});

it('retires legacy whole-runtime snapshots before admitting a new bake', async () => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('forgeax-water-r7', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('publication');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('publication', 'readwrite');
    transaction
      .objectStore('publication')
      .put(new Blob(['{"schemaVersion":"runtime-pack-source/2"}']), 'river');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
  expect(await loadBakeContent()).toBeUndefined();
});
