import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadViewPanels } from '../packages/viewer/src/host/panel-bridge.ts';
import { setViewLocale } from '../packages/view-workspace-core/src/locale-bridge.ts';

test('separately bundled panels receive the shell locale once and keep observing changes', async () => {
  const previous = globalThis.__forgeaxViewPanelsPromise;
  const received = [];
  const panels = { setViewLocale: locale => received.push(locale) };
  globalThis.__forgeaxViewPanelsPromise = Promise.resolve(panels);
  try {
    setViewLocale('en');
    assert.equal(await loadViewPanels(), panels);
    assert.equal(await loadViewPanels(), panels);
    setViewLocale('zh');
    assert.deepEqual(received, ['en', 'zh']);
  } finally {
    globalThis.__forgeaxViewPanelsPromise = previous;
    setViewLocale('zh');
  }
});
