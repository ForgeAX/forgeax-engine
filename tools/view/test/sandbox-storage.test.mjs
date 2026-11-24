import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Execute the actual TS/TSX entrypoints, including the throwing Window getter
// used by browsers for sandbox="allow-scripts" documents.
const output = await build({
  stdin: {
    contents: `export { getStoredTheme, initializeTheme } from './packages/view-components/src/theme.tsx';
export { DEFAULT_LOCALE, initI18n, getLocale, setLocale } from './packages/viewer/src/i18n/index.ts';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const entry = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('View defaults to English before preference initialization', () => {
  assert.equal(entry.DEFAULT_LOCALE, 'en');
  assert.equal(entry.getLocale(), 'en');
});

for (const { name, saved, languages, language, deniedStorage, deniedNavigator, expected } of [
  { name: 'saved Chinese overrides English system preference', saved: 'zh', languages: ['en-US'], expected: 'zh' },
  { name: 'saved English overrides Chinese system preference', saved: 'en', languages: ['zh-CN'], expected: 'en' },
  { name: 'first launch follows Chinese system preference', languages: ['zh-CN'], expected: 'zh' },
  { name: 'first launch follows English system preference', languages: ['en-GB'], expected: 'en' },
  { name: 'unsupported system languages fall back to English', languages: ['fr-FR', 'ja-JP'], expected: 'en' },
  { name: 'invalid saved locale still uses the system', saved: 'fr', languages: ['zh-TW'], expected: 'zh' },
  { name: 'system preferences retain their declared priority', languages: ['en-US', 'zh-CN'], expected: 'en' },
  { name: 'unsupported primary system preference falls back only to English', languages: ['fr-FR', 'zh-CN', 'en-US'], expected: 'en' },
  { name: 'language is used when languages is unavailable', language: 'zh-Hant-HK', expected: 'zh' },
  { name: 'language is used when languages is empty', languages: [], language: 'zh-CN', expected: 'zh' },
  { name: 'missing browser preferences fall back to English', expected: 'en' },
  { name: 'blocked browser preferences fall back to English', deniedNavigator: true, expected: 'en' },
  { name: 'blocked storage still permits system language discovery', deniedStorage: true, languages: ['zh-CN'], expected: 'zh' },
]) {
  test(`View locale: ${name}`, () => {
    const descriptors = Object.fromEntries(['document', 'localStorage', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const writes = [];
    try {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: 'old' } } });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, get() {
        if (deniedNavigator) throw new Error('Host language access denied');
        return { languages, language };
      } });
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() {
        if (deniedStorage) throw new DOMException('Storage denied', 'SecurityError');
        return { getItem: () => saved ?? null, setItem: (...args) => writes.push(args) };
      } });
      entry.initI18n();
      assert.equal(entry.getLocale(), expected);
      assert.equal(document.documentElement.lang, expected);
      assert.deepEqual(writes, [], 'detected system preferences are not saved as an explicit user choice');
    } finally {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}

test('View initializes and changes preferences when browser storage access is denied', () => {
  const saved = Object.fromEntries(['window', 'document', 'localStorage', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const denied = () => { throw new DOMException('Sandbox storage denied', 'SecurityError'); };
  const sandboxWindow = Object.defineProperty({}, 'localStorage', { get: denied });
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: sandboxWindow });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: denied });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {} } } });
    assert.equal(entry.getStoredTheme('dark'), 'dark');
    assert.equal(entry.initializeTheme('light'), 'light');
    assert.equal(globalThis.document.documentElement.dataset.theme, 'light');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    entry.initI18n();
    assert.equal(entry.getLocale(), 'en');
    entry.setLocale('zh');
    assert.equal(entry.getLocale(), 'zh');
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
