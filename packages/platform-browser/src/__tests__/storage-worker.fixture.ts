import type { FileRef } from '@forgeax/engine-platform';
import { createBrowserFileStore } from '../file-storage';
import { createBrowserSaveRecords } from '../record-storage';

self.onmessage = async ({ data }: MessageEvent<{ project: string; ref: FileRef }>) => {
  try {
    const signal = new AbortController().signal;
    const store = createBrowserFileStore(data.project, 'contract');
    const records = createBrowserSaveRecords(() => indexedDB, data.project);
    const record = (await records.read('slot', signal)).unwrap();
    const range = new Uint8Array(2);
    const read = (await store.openRead(data.ref, signal)).unwrap();
    try {
      (await read.readAt(1, range, signal)).unwrap();
    } finally {
      (await read.close()).unwrap();
    }
    self.postMessage({ record: record && [...record], range: [...range] });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
