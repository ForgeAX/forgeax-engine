import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import {
  formatWorkspaceCommandError,
  isIgnorableWorkspaceCommandError,
  reportWorkspaceCommandError,
  subscribeWorkspaceCommandErrors,
} from '@forgeax/view-workspace-core/command-error';
import { VIEW_WORKSPACE_TAB_ID, ViewWorkspaceError } from '@forgeax/view-workspace-core/contract';

describe('workspace command error reporting', { concurrency: false }, () => {
  test('reports a synchronous transport failure through the same rejected request', async () => {
    const failure = new Error('synchronous transport failure');
    const reports = [];
    const remove = subscribeWorkspaceCommandErrors(error => reports.push(error));
    try {
      const client = createViewWorkspaceClient({ clientId: 'test', transport: { request() { throw failure; } } });
      await assert.rejects(client.call('scene.pick', { targetId: 'editor', targetGeneration: 1, x: 1, y: 1 }), error => error === failure);
      assert.deepEqual(reports, [failure]);
    } finally { remove(); }
  });

  test('formatWorkspaceCommandError surfaces the real nested diagnostic, not executor-threw wrapping', () => {
    const formatted = formatWorkspaceCommandError(
      new ViewWorkspaceError(
        'view-workspace-browser-failure',
        'the contribution executor to return a result',
        'workspace asset is required',
        {
          failure: {
            code: 'tool-domain-failed',
            expected: 'the contribution executor to return a result',
            hint: 'engine-workspace-browser-failure: workspace asset is required',
            detail: { code: 'executor-threw' },
          },
        },
      ),
    );
    assert.equal(formatted.code, 'view-workspace-browser-failure');
    assert.equal(formatted.description, 'workspace asset is required');
    assert.equal(formatted.hint, undefined);
    assert.match(formatted.detailsText ?? '', /executor-threw/);
    assert.match(formatted.detailsText ?? '', /workspace asset is required/);
    assert.match(formatted.detailsText ?? '', /the contribution executor to return a result/);
  });

  test('formatWorkspaceCommandError keeps contract expected when it is the real diagnostic', () => {
    const formatted = formatWorkspaceCommandError(
      new ViewWorkspaceError(
        'view-workspace-invalid-args',
        'guid to be a non-empty string',
        'Provide a non-empty guid.',
        { field: 'guid' },
      ),
    );
    assert.equal(formatted.description, 'guid to be a non-empty string');
    assert.equal(formatted.hint, 'Provide a non-empty guid.');
    assert.match(formatted.detailsText ?? '', /guid/);
  });

  test('isIgnorableWorkspaceCommandError skips aborts', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    assert.equal(isIgnorableWorkspaceCommandError(abort), true);
    assert.equal(isIgnorableWorkspaceCommandError(new Error('x'), { signal: { aborted: true } }), true);
    assert.equal(
      isIgnorableWorkspaceCommandError(
        new ViewWorkspaceError('view-workspace-browser-failure', 'x', 'y'),
      ),
      false,
    );
  });

  test('ViewWorkspaceClient.call reports non-abort failures to subscribers', async () => {
    const reported = [];
    const unsubscribe = subscribeWorkspaceCommandErrors((error, context) => {
      reported.push({ error, context });
    });
    const client = createViewWorkspaceClient({
      transport: {
        request() {
          return Promise.reject(
            new ViewWorkspaceError(
              'view-workspace-browser-failure',
              'the contribution executor to return a result',
              'workspace asset is required',
            ),
          );
        },
      },
      clientId: 'test-client',
      token: 'test-token',
    });
    try {
      await assert.rejects(
        () => client.openAsset('scene-guid', { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID }),
        (error) =>
          error instanceof ViewWorkspaceError
          && error.code === 'view-workspace-browser-failure'
          && error.message.includes('workspace asset is required')
          && !error.message.includes('the contribution executor to return a result'),
      );
      assert.equal(reported.length, 1);
      assert.equal(reported[0].context.operation, 'asset.open');
      assert.equal(reported[0].error.code, 'view-workspace-browser-failure');
      assert.equal(reported[0].error.hint, 'workspace asset is required');
    } finally {
      unsubscribe();
    }
  });

  test('ViewWorkspaceClient.capture can keep a background failure out of the command notices', async () => {
    const reported = [];
    const unsubscribe = subscribeWorkspaceCommandErrors((error, context) => {
      reported.push({ error, context });
    });
    const client = createViewWorkspaceClient({
      transport: {
        request() {
          return Promise.reject(
            new ViewWorkspaceError(
              'view-workspace-target-busy',
              'Engine workspace preview capture is busy',
              'Engine workspace preview capture is busy',
            ),
          );
        },
      },
      clientId: 'test-client',
      token: 'test-token',
    });
    try {
      await assert.rejects(
        () => client.capture({
          targetId: 'play-target',
          targetGeneration: 3,
          reportError: false,
        }),
        (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-target-busy',
      );
      assert.equal(reported.length, 0);
    } finally {
      unsubscribe();
    }
  });

  test('ViewWorkspaceClient.call does not report aborted requests', async () => {
    const reported = [];
    const unsubscribe = subscribeWorkspaceCommandErrors((error, context) => {
      reported.push({ error, context });
    });
    const controller = new AbortController();
    controller.abort();
    const client = createViewWorkspaceClient({
      transport: {
        request() {
          const error = new Error('aborted');
          error.name = 'AbortError';
          return Promise.reject(error);
        },
      },
      clientId: 'test-client',
      token: 'test-token',
    });
    try {
      await assert.rejects(
        () => client.getState({ signal: controller.signal }),
        (error) => error?.name === 'AbortError',
      );
      assert.equal(reported.length, 0);
    } finally {
      unsubscribe();
    }
  });

  test('decodeWorkspaceTransportError does not invent a retry hint', async () => {
    const client = createViewWorkspaceClient({
      transport: {
        request() {
          return Promise.reject(Object.assign(new Error('catalog enumerate failed: missing DDC'), {
            name: 'HostAssemblyError',
            code: 'view-workspace-browser-failure',
          }));
        },
      },
      clientId: 'test-client',
      token: 'test-token',
    });
    await assert.rejects(
      () => client.openAsset('scene-guid', { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID }),
      (error) =>
        error instanceof ViewWorkspaceError
        && error.hint === 'catalog enumerate failed: missing DDC'
        && error.expected === 'catalog enumerate failed: missing DDC'
        && !String(error.hint).includes('Inspect the resident'),
    );
  });

  test('reportWorkspaceCommandError ignores presenter throws', () => {
    const unsubscribe = subscribeWorkspaceCommandErrors(() => {
      throw new Error('presenter failed');
    });
    try {
      assert.doesNotThrow(() => {
        reportWorkspaceCommandError(new ViewWorkspaceError('view-workspace-invalid-args', 'x', 'y'), {
          operation: 'tabs.get',
        });
      });
    } finally {
      unsubscribe();
    }
  });
});

 test('superseded selection is ignored while genuine cancellation failures remain visible',()=>{
  assert.equal(isIgnorableWorkspaceCommandError({code:'view-workspace-selection-superseded'}),true);
  assert.equal(isIgnorableWorkspaceCommandError({code:'view-workspace-provider-failed',detail:{code:'tool-run-cancelled'}}),false);
 });
