import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navigateBrowserDocument } from '../packages/view-workspace-core/src/document-navigation.ts';

for (const replace of [false, true]) {
  test(`workspace document navigation retains replace=${replace} and departure readiness`, async () => {
    const visits = [];
    const window = Object.assign(new EventTarget(), {
      location: {
        assign: (url) => visits.push(['assign', url]),
        replace: (url) => visits.push(['replace', url]),
      },
    });
    const pending = navigateBrowserDocument(window, 'https://example.test/project', { replace });
    assert.deepEqual(visits, [[replace ? 'replace' : 'assign', 'https://example.test/project']]);
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    window.dispatchEvent(new Event('pagehide'));
    await pending;
  });
}

test('retired workspace navigation never changes the document', async () => {
  const visits = [];
  const window = Object.assign(new EventTarget(), {
    location: { assign: (url) => visits.push(url), replace: (url) => visits.push(url) },
  });
  const reason = new Error('workspace retired');
  await assert.rejects(navigateBrowserDocument(window, 'https://example.test/project', {
    signal: AbortSignal.abort(reason),
  }), error => error === reason);
  assert.deepEqual(visits, []);
});
