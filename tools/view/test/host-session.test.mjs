import assert from 'node:assert/strict';
import test from 'node:test';
import { openViewWorkspaceSession } from '../src/host-session.ts';

test('opens one owner page and closes resources in reverse order', async () => {
  const calls = [];
  const session = await openViewWorkspaceSession({
    async startShell() { calls.push('shell'); return { close: async () => calls.push('shell.close') }; },
    async launchBrowser() { return { newPage: async () => (calls.push('page'), {}), close: async () => calls.push('browser.close') }; },
    async startView({ page }) { assert.ok(page); calls.push('view'); return { workspaceEndpoint: 'ws://view', workspaceAccessToken: 'token', dispose: async () => calls.push('view.close') }; },
    async mountShell() { calls.push('mount'); return { api: { openProject: async () => (calls.push('project'), { project: { id: 'gomoku' } }) }, dispose: async () => calls.push('mount.close') }; },
  }, { projectRoot: 'E:/gomoku' });
  assert.equal(session.state.project.id, 'gomoku');
  await session.close();
  await session.close();
  assert.deepEqual(calls, ['shell', 'page', 'view', 'mount', 'project', 'mount.close', 'view.close', 'browser.close', 'shell.close']);
});

test('opens the project through the mounted shell for owner-driven sessions', async () => {
  const calls = [];
  const session = await openViewWorkspaceSession({
    async startShell() { return { close: async () => {} }; },
    async launchBrowser() { return { newPage: async () => ({}), close: async () => {} }; },
    async startView() { return { workspaceEndpoint: 'ws://view', workspaceAccessToken: 'token', dispose: async () => {} }; },
    async mountShell() {
      return {
        shell: {
          async openProject(root) {
            calls.push(root);
            return { project: { id: 'gomoku', root } };
          },
        },
        api: {
          async openProject() {
            calls.push('api');
            return { project: { id: 'wrong' } };
          },
        },
        dispose: async () => {},
      };
    },
  }, { projectRoot: 'E:/gomoku' });
  assert.equal(session.state.project.id, 'gomoku');
  assert.deepEqual(calls, ['E:/gomoku']);
  await session.close();
});

test('uses browser-owned project state without reopening through a second client', async () => {
  const calls = [];
  const session = await openViewWorkspaceSession({
    async startShell() { calls.push('shell'); return { close: async () => calls.push('shell.close') }; },
    async launchBrowser() { return { newPage: async () => (calls.push('page'), {}), close: async () => calls.push('browser.close') }; },
    async startView() { calls.push('view'); return { workspaceEndpoint: 'ws://view', workspaceAccessToken: 'token', dispose: async () => calls.push('view.close') }; },
    async mountShell() {
      calls.push('mount');
      return { state: { project: { id: 'gomoku' } }, dispose: async () => calls.push('mount.close') };
    },
  }, { projectRoot: 'E:/gomoku' });
  assert.equal(session.state.project.id, 'gomoku');
  await session.close();
  assert.deepEqual(calls, ['shell', 'page', 'view', 'mount', 'mount.close', 'view.close', 'browser.close', 'shell.close']);
});

test('cleans up a partially started session', async () => {
  const calls = [];
  await assert.rejects(openViewWorkspaceSession({
    async startShell() { return { close: async () => calls.push('shell.close') }; },
    async launchBrowser() { return { newPage: async () => ({}), close: async () => calls.push('browser.close') }; },
    async startView() { throw new Error('backend failed'); },
  }, { projectRoot: 'E:/gomoku' }), /backend failed/);
  assert.deepEqual(calls, ['browser.close', 'shell.close']);
});


test('a session without project options fails before acquiring host resources', async () => {
  await assert.rejects(openViewWorkspaceSession({}), {
    name: 'TypeError', message: 'View workspace session requires projectRoot',
  });
});
