import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createPluginI18n } from '../packages/view-workspace-core/src/plugin-i18n.ts';
import { registerViewLocaleSink, setViewLocale } from '../packages/view-workspace-core/src/locale-bridge.ts';

const packages = new URL('../packages/', import.meta.url);
function flatten(value, prefix = '', result = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') result[path] = child;
    else flatten(child, path, result);
  }
  return result;
}
function placeholders(message) {
  return [...new Set([...message.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]))].sort();
}

for (const entry of readdirSync(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = new URL(`${entry.name}/src/i18n/locales/`, packages);
  let en;
  try { en = JSON.parse(readFileSync(new URL('en.json', directory), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const zh = JSON.parse(readFileSync(new URL('zh.json', directory), 'utf8'));
  test(`${entry.name}: locale keys and interpolation parameters match`, () => {
    const english = flatten(en);
    const chinese = flatten(zh);
    assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort(), fileURLToPath(directory));
    for (const key of Object.keys(english)) {
      assert.ok(english[key].trim() && chinese[key].trim(), `${key}: empty translation`);
      assert.deepEqual(placeholders(chinese[key]), placeholders(english[key]), key);
    }
  });
}

test('mounted plugin subscriptions observe locale changes and retain interpolation values', () => {
  const plugin = createPluginI18n({
    en: { source: 'Source {{field}}' }, zh: { source: '源码 {{field}}' },
  });
  const disconnect = registerViewLocaleSink(plugin.setLocale);
  const messages = [];
  const unsubscribe = plugin.subscribe(() => messages.push(plugin.t('source', { field: 'Transform.x' })));
  try {
    setViewLocale('en');
    setViewLocale('zh');
    assert.deepEqual(messages, ['Source Transform.x', '源码 Transform.x']);
  } finally { unsubscribe(); disconnect(); setViewLocale('zh'); }
});
