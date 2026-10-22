import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Execute the actual TS/TSX entrypoints, including the throwing Window getter
// used by browsers for sandbox="allow-scripts" documents.
const output = await build({
  stdin: {
    contents: `export { getStoredTheme, initializeTheme } from './packages/view-components/src/theme.tsx';
export { initI18n, getLocale, setLocale } from './packages/viewer/src/i18n/index.ts';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const entry = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('View initializes and changes preferences when browser storage access is denied', () => {
  const saved = Object.fromEntries(['window', 'document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const denied = () => { throw new DOMException('Sandbox storage denied', 'SecurityError'); };
  const sandboxWindow = Object.defineProperty({}, 'localStorage', { get: denied });
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: sandboxWindow });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: denied });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {} } } });
    assert.equal(entry.getStoredTheme('dark'), 'dark');
    assert.equal(entry.initializeTheme('light'), 'light');
    assert.equal(globalThis.document.documentElement.dataset.theme, 'light');
    entry.initI18n();
    assert.equal(entry.getLocale(), 'zh');
    entry.setLocale('en');
    assert.equal(entry.getLocale(), 'en');
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
