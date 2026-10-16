import assert from 'node:assert/strict';
import test from 'node:test';

import { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
import {
  createWorkspaceRequest,
  VIEW_WORKSPACE_TAB_ID,
  ViewWorkspaceError,
} from '@forgeax/view-workspace-core/contract';
import {
  adoptRemoteWorkspaceProject,
  isWorkspacePageLostError,
  navigateToWorkspaceProjectTarget,
  resolveWorkspaceFailure,
  resolveWorkspaceFailureCode,
  resolveWorkspaceReopenRoot,
  shouldOfferWorkspaceRecovery,
  VIEW_WORKSPACE_PAGE_LOST_CODE,
} from '@forgeax/view-workspace-core/workspace-recovery';

test('resolveWorkspaceReopenRoot prefers an explicit root over snapshot state', () => {
  assert.equal(
    resolveWorkspaceReopenRoot({ project: { root: '/snapshot' } }, '/explicit'),
    '/explicit',
  );
  assert.equal(resolveWorkspaceReopenRoot({ project: { root: '/snapshot' } }), '/snapshot');
  assert.throws(
    () => resolveWorkspaceReopenRoot({ project: null }),
    (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-reopen-unavailable',
  );
});

test('resolveWorkspaceFailure unwraps executor-threw page loss', () => {
  assert.equal(
    resolveWorkspaceFailureCode({
      code: 'tool-domain-failed',
      expected: 'the contribution executor to return a result',
      hint: 'view-workspace-page-lost: the Engine workspace browser page to remain connected',
      detail: { code: 'executor-threw' },
    }),
    VIEW_WORKSPACE_PAGE_LOST_CODE,
  );
  const unwrapped = resolveWorkspaceFailure({
    code: 'tool-domain-failed',
    expected: 'the contribution executor to return a result',
    hint: 'engine-workspace-browser-failure: workspace asset is required',
    detail: {
      code: 'executor-threw',
      payload: {
        name: 'DevKitWorkspaceError',
        message: 'engine-workspace-browser-failure: workspace asset is required',
        code: 'engine-workspace-browser-failure',
        expected: 'the workspace command to complete',
        hint: 'workspace asset is required',
      },
    },
  });
  assert.equal(unwrapped.code, 'view-workspace-browser-failure');
  assert.equal(unwrapped.expected, undefined);
  assert.equal(unwrapped.hint, 'workspace asset is required');
  assert.equal(unwrapped.detail.failure.expected, 'the contribution executor to return a result');
  assert.equal(unwrapped.detail.cause.hint, 'workspace asset is required');
  assert.equal(
    shouldOfferWorkspaceRecovery({
      code: 'view-workspace-provider-failed',
      message: 'view-workspace-provider-failed: the contribution executor to return a result',
      hint: 'engine-workspace-page-lost: the Engine workspace browser page to remain connected',
    }),
    true,
  );
});

test('bootstrap failure offers explicit project recovery', () => {
  assert.equal(shouldOfferWorkspaceRecovery({ code: 'view-workspace-bootstrap-failed' }), true);
  assert.equal(shouldOfferWorkspaceRecovery({ code: 'view-workspace-provider-failed', hint: 'engine-workspace-bootstrap-failed: graphics unavailable' }), true);
});

test('isWorkspacePageLostError recognizes broker and transport codes', () => {
  assert.equal(
    isWorkspacePageLostError(new ViewWorkspaceError(VIEW_WORKSPACE_PAGE_LOST_CODE, 'x', 'y')),
    true,
  );
  assert.equal(
    isWorkspacePageLostError({ code: 'host-transport-failure', detail: { remoteCode: VIEW_WORKSPACE_PAGE_LOST_CODE } }),
    true,
  );
  assert.equal(isWorkspacePageLostError(new Error('other')), false);
});

test('adoptRemoteWorkspaceProject navigates an empty shell once and leaves a headed document', () => {
  const target = 'http://127.0.0.1:9/?forgeaxWorkspace=1&forgeaxWorkspaceSession=session-1&forgeaxWorkspaceToken=secret';
  const snapshot = {
    project: { id: 'game', root: '/game' },
    projectTarget: { url: target, targetId: 'target-1' },
  };
  const empty = { href: 'http://127.0.0.1:8/', assign(url) { this.href = url; this.assigned = (this.assigned ?? 0) + 1; } };
  adoptRemoteWorkspaceProject(snapshot, { location: empty });
  assert.equal(empty.href.split('#')[0], target);
  // The adoption carries the session record hash for refresh recovery.
  assert.equal(new URL(empty.href).hash.includes('forgeaxViewRestore'), true);
  assert.equal(empty.assigned, 1);
  // The adopted document carries the target session and is not navigated again.
  adoptRemoteWorkspaceProject(snapshot, { location: empty });
  assert.equal(empty.assigned, 1);

  const headed = {
    href: 'http://127.0.0.1:9/?forgeaxWorkspaceToken=other&forgeaxWorkspaceSession=session-1',
    assign() { throw new Error('headed document must not navigate'); },
  };
  adoptRemoteWorkspaceProject(snapshot, { location: headed });
  assert.equal(headed.href.includes('forgeaxWorkspaceSession=session-1'), true);

  // A document carrying a different session is not this headed target; it
  // adopts the current project URL instead of staying on a stale session.
  const stale = { href: 'http://127.0.0.1:9/?forgeaxWorkspaceSession=session-0', assign(url) { this.href = url; } };
  adoptRemoteWorkspaceProject(snapshot, { location: stale });
  assert.equal(stale.href.split('#')[0], target);
});

test('adoptRemoteWorkspaceProject does not navigate when the workspace target is lost', () => {
  const location = {
    href: 'http://127.0.0.1:8/',
    assign() { throw new Error('lost target must not navigate'); },
  };
  const snapshot = adoptRemoteWorkspaceProject({
    workspaceTargetLost: true,
    project: { root: '/game' },
    projectTarget: { url: 'http://127.0.0.1:9/?forgeaxWorkspaceSession=session-1' },
  }, { location });
  assert.equal(snapshot.workspaceTargetLost, true);
  assert.equal(location.href, 'http://127.0.0.1:8/');
});

test('navigateToWorkspaceProjectTarget assigns when the headed URL changes', () => {
  const location = { href: 'http://localhost/old', assign(url) { this.href = url; } };
  navigateToWorkspaceProjectTarget(
    { projectTarget: { url: 'http://localhost/new' } },
    { location },
  );
  assert.equal(location.href, 'http://localhost/new');
});

test('broker project.reopen reuses the known project root', async () => {
  const calls = [];
  const broker = new ViewWorkspaceBroker({
    engine: {
      project: {
        project: { id: 'project:/fixture', root: '/fixture' },
        target: { targetId: 'target-1', url: 'http://localhost/old' },
      },
    },
    toolApi: {
      describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1, sourceId: 'engine-workspace' } }],
      list: () => [],
      run: (id) => {
        calls.push(id);
        return {
          terminal: {
            outcome: 'succeeded',
            result: {
              project: { id: 'project:/fixture', root: '/fixture' },
              target: { targetId: 'target-2', url: 'http://localhost/new', headed: true },
            },
          },
        };
      },
    },
  });
  const state = await broker.call(
    createWorkspaceRequest('project.reopen', { tabId: VIEW_WORKSPACE_TAB_ID }, {
      clientId: 'test',
      token: broker.accessToken,
    }),
  );
  assert.deepEqual(calls, ['engine.project.open']);
  assert.notEqual(state.workspaceTargetLost, true);
});

test('broker marks workspaceTargetLost when page-lost surfaces through invoke', async () => {
  const broker = new ViewWorkspaceBroker({
    engine: {
      project: {
        project: { id: 'project:/fixture', root: '/fixture' },
        target: { targetId: 'target-1' },
      },
    },
    toolApi: {
      describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1, sourceId: 'engine-workspace' } }],
      list: () => [],
      run: () => ({
        terminal: {
          outcome: 'failed',
          failure: {
            code: 'tool-domain-failed',
            expected: 'the Engine workspace browser page to remain connected',
            hint: 'reopen',
            detail: { code: 'engine-workspace-page-lost' },
          },
        },
      }),
    },
  });
  await assert.rejects(
    () => broker.call(
      createWorkspaceRequest('assets.list', { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID }, {
        clientId: 'test',
        token: broker.accessToken,
      }),
    ),
    (error) => error.code === VIEW_WORKSPACE_PAGE_LOST_CODE,
  );
  assert.equal(broker.snapshot().workspaceTargetLost, true);
});

test('broker invoke surfaces the nested owner diagnostic instead of executor-threw wrapping', async () => {
  const broker = new ViewWorkspaceBroker({
    engine: {
      project: {
        project: { id: 'project:/fixture', root: '/fixture' },
        target: { targetId: 'target-1' },
      },
    },
    toolApi: {
      describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1, sourceId: 'engine-workspace' } }],
      list: () => [],
      run: () => ({
        terminal: {
          outcome: 'failed',
          failure: {
            code: 'tool-domain-failed',
            expected: 'the contribution executor to return a result',
            hint: 'engine-workspace-browser-failure: workspace asset is required',
            detail: {
              code: 'executor-threw',
              payload: {
                code: 'engine-workspace-browser-failure',
                hint: 'workspace asset is required',
                message: 'workspace asset is required',
              },
            },
          },
        },
      }),
    },
  });
  await assert.rejects(
    () => broker.call(
      createWorkspaceRequest('asset.open', { guid: 'scene-guid', projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID }, {
        clientId: 'test',
        token: broker.accessToken,
      }),
    ),
    (error) =>
      error instanceof ViewWorkspaceError
      && error.code === 'view-workspace-browser-failure'
      && error.hint === 'workspace asset is required'
      && error.message.includes('workspace asset is required')
      && !error.message.includes('the contribution executor to return a result')
      && error.detail?.failure?.expected === 'the contribution executor to return a result',
  );
});
