import type { RuntimePackContent } from '@forgeax/engine/import';

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open('forgeax-water-r7', 2);
    request.onupgradeneeded = () => {
      // Version 1 retained the entire fixed dependency closure, including shaders.
      if (request.result.objectStoreNames.contains('publication'))
        request.result.deleteObjectStore('publication');
      request.result.createObjectStore('publication');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function loadBakeContent(): Promise<RuntimePackContent | undefined> {
  const db = await open();
  try {
    return await new Promise<RuntimePackContent | undefined>((resolve, reject) => {
      const request = db
        .transaction('publication', 'readonly')
        .objectStore('publication')
        .get('river');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveBakeContent(content: RuntimePackContent): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('publication', 'readwrite');
      transaction.objectStore('publication').put(content, 'river');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
