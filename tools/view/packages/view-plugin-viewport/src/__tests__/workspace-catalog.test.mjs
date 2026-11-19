import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ViewWorkspaceShell } from '../workspace-shell.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('presentation-only viewport leaves catalog queries to Content Browser; ordinary shell reads once', async () => {
  for (const presentationOnly of [true, false]) {
    const calls = [];
    const api = {
      subscribe() { return () => {}; }, onDisconnect() { return () => {}; },
      async getState() { calls.push('state'); return { project: { id: 'project', root: '/project' }, projectPhase: 'running', projectDocumentPresentation: 'presenter' }; },
      async listAssets(projectId) { calls.push(['assets', projectId]); return { assets: [] }; },
    };
    const shell = new ViewWorkspaceShell({ api, presentationOnly });
    try {
      await tick(); await tick();
      assert.equal(calls.filter(call => call === 'state').length, 1);
      assert.equal(calls.filter(call => Array.isArray(call)).length, presentationOnly ? 0 : 1,
        'A presentation-only viewport must not race Content Browser catalog refresh during document replacement');
      if (!presentationOnly) assert.deepEqual(calls.at(-1), ['assets', 'project']);
    } finally { await shell.dispose(); }
  }
});
