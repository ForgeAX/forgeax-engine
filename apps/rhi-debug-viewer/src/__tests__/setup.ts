// setup.ts — vitest setup for the jsdom-environment viewer tests.
//
// localStorage availability varies by runtime: jsdom only backs it when an
// origin is set, and Node >= 22.13 ships an experimental global `localStorage`
// that throws without `--localstorage-file`. Install a deterministic in-memory
// Storage when a working one is absent. This is a no-op where jsdom already
// provides a functional localStorage.

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
  return storage;
}

function isWorkingStorage(s: unknown): boolean {
  try {
    if (!s || typeof (s as Storage).setItem !== 'function') return false;
    (s as Storage).setItem('__probe__', '1');
    (s as Storage).removeItem('__probe__');
    return true;
  } catch {
    return false;
  }
}

const win = (globalThis as { window?: Window & typeof globalThis }).window;

if (!isWorkingStorage((globalThis as { localStorage?: Storage }).localStorage)) {
  const storage =
    win && isWorkingStorage(win.localStorage) ? win.localStorage : makeMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  if (win && !isWorkingStorage(win.localStorage)) {
    Object.defineProperty(win, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}
