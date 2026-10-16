import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebSocket as NodeWebSocket } from 'ws';
import { Context } from '@forgeax/engine-plugin';

import { createHostWebSocketClient } from '@forgeax/engine-host/transport';

import {
  VIEW_INSPECTOR_TOPIC,
  ViewInspectorClient,
  ViewWorkspaceError,
  createBrowserPagePlatform,
  startView,
} from '../src/index.ts';
import { runWorkspaceToolApi, viewInspectorFrontendPlugin } from '@forgeax/view-plugin-plugins/runtime';

function decorateBrowserPage(page) {
  const frame = {
    goto: async () => undefined,
    evaluate: async () => undefined,
    locator: () => ({ first: () => ({ screenshot: async () => Buffer.from('frame') }) }),
    waitForFunction: async () => undefined,
    waitForTimeout: async () => undefined,
    page: () => page,
    url: () => 'about:blank',
  };
  page.frame = () => frame;
  page.locator ??= () => ({
    count: async () => 1,
    elementHandle: async () => ({
      evaluate: async () => 'IFRAME',
      contentFrame: async () => frame,
      dispose: async () => undefined,
    }),
  });
  page.waitForFunction ??= async () => undefined;
  page.waitForTimeout ??= async () => undefined;
  return page;
}

function waitForEvent(events, predicate) {
  const current = events.find(predicate);
  if (current !== undefined) return Promise.resolve(current);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const next = events.find(predicate);
      if (next !== undefined) {
        clearInterval(timer);
        resolve(next);
      }
    }, 1);
  });
}

describe('View plugin inspector', () => {
  it('reports frontend plugin facts without mounting a second inspection UI', async () => {
    const page = decorateBrowserPage({ goto: async () => {}, evaluate: async () => {}, on() {}, off() {}, isClosed: () => false });
    const view = await startView({ platform: createBrowserPagePlatform({ page }), workspaceServer: false, frontend: false });
    const transport = view.backendHost.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    const context = new Context();
    const document = { createElement() { assert.fail('The inspection reporter must not create DOM nodes'); } };
    const fiber = context.plugin(viewInspectorFrontendPlugin, {
      document, transport, workspace: { clientId: 'reporter-test', token: view.workspaceAccessToken },
    });
    try {
      await fiber.await();
      const client = context.get('viewInspectorClient');
      const sourceId = `view-frontend:${transport.caller.connectionId}`;
      const listed = await client.sources();
      const source = listed.sources.find(entry => entry.sourceId === sourceId);
      assert.ok(source, JSON.stringify(listed));
      const inspected = await client.inspect({ sourceId, generation: source.generation });
      assert.ok(inspected.plugins.some(entry => entry.module === viewInspectorFrontendPlugin.name));
    } finally {
      await fiber.dispose();
      transport.close();
      await view.dispose();
    }
    assert.equal(context.get('viewInspectorClient', false), undefined);
  });
  it('preserves a ToolApi provider failure diagnostic for workspace startup', async () => {
    await assert.rejects(
      runWorkspaceToolApi(
        {
          run() {
            return {
              terminal: Promise.resolve({
                outcome: 'failed',
                failure: {
                  code: 'tool-domain-failed',
                  expected: 'fetch(http://127.0.0.1:5181/.forgeax/ddc/board.pack.json) to return ok',
                  hint: 'Inspect the provider snapshot and retry.',
                  detail: { code: 'engine-workspace-result-timeout' },
                },
              }),
            };
          },
        },
        { operation: 'assets.list', args: {}, clientId: 'client', token: 'token', requestId: 'request' },
      ),
      (error) => {
        assert.equal(error.code, 'view-tool-provider-failed');
        assert.equal(
          error.expected,
          'fetch(http://127.0.0.1:5181/.forgeax/ddc/board.pack.json) to return ok',
        );
        assert.match(error.hint, /tool-domain-failed -> engine-workspace-result-timeout/);
        return true;
      },
    );
  });

  it('observes real backend/frontend owners with explicit generation and recovery', async () => {
    const page = decorateBrowserPage({
      goto: async () => undefined,
      evaluate: async () => undefined,
      on() {},
      off() {},
      isClosed: () => false,
    });
    const view = await startView({
      frontend: true,
      platform: createBrowserPagePlatform({ page }),
      workspaceServer: false,
    });
    const transport = view.backendHost.transport.connect({ kind: 'cli' });
    const client = new ViewInspectorClient({
      transport,
      clientId: 'inspector-test',
      token: view.workspaceAccessToken,
    });
    const events = [];
    const removeEvents = client.subscribe((event) => {
      if (event?.apiVersion === 'forgeax.view.inspector/1') events.push(event);
    });
    try {
      const listed = await client.sources();
      const backend = listed.sources.find((source) => source.sourceId === 'view-backend');
      const frontend = listed.sources.find((source) => source.kind === 'frontend');
      assert.ok(backend);
      assert.equal(backend.kind, 'backend');
      if (frontend) assert.equal(frontend.kind, 'frontend');
      assert.ok(backend.operationCount >= 4);

      const inspected = await client.inspect({
        sourceId: backend.sourceId,
        generation: backend.generation,
      });
      const statusOperation = inspected.api.operations.find(
        (operation) => operation.descriptor.id === 'view.display.status',
      );
      assert.equal(statusOperation.providerState, 'active');
      assert.equal(statusOperation.callable, true);
      assert.equal(statusOperation.owner.sourceId, 'view-backend');
      const backendEntry = inspected.plugins.find(
        (entry) => entry.module === 'forgeax.view.service.display-carrier.backend',
      );
      assert.ok(backendEntry);
      assert.equal(backendEntry.fiberState, 'active');
      assert.match(backendEntry.entryId, /^fiber:/);
      if (frontend) {
        const frontendInspected = await client.inspect({
          sourceId: frontend.sourceId,
          generation: frontend.generation,
        });
        assert.equal(frontendInspected.state, 'active');
        assert.equal(frontendInspected.coverage.activation, 'actual');
        assert.equal(
          frontendInspected.plugins.some(
            (entry) =>
              entry.module === 'forgeax.view.service.plugin-inspection-reporter.frontend' && entry.fiberState === 'active',
          ),
          true,
        );
        assert.equal(
          new Set(frontendInspected.plugins.map((entry) => entry.entryId)).size,
          frontendInspected.plugins.length,
        );
      }
      assert.equal(JSON.stringify(inspected).includes('execute'), false);
      assert.equal(JSON.stringify(inspected).includes('"config":'), false);

      await assert.rejects(
        client.inspect({ sourceId: backend.sourceId }),
        (error) => error.code === 'view-inspector-generation-required',
      );
      await assert.rejects(
        client.inspect({ sourceId: backend.sourceId, generation: backend.generation + 1 }),
        (error) => error.code === 'view-inspector-stale-generation',
      );

      const backendWatch = await client.watch({
        sourceId: backend.sourceId,
        generation: backend.generation,
      });
      view.backendHost.context.get('viewInspector').publish('view-backend');
      const backendEvent = await waitForEvent(
        events,
        (event) => event.watchId === backendWatch.watchId && event.source?.sourceId === 'view-backend',
      );
      assert.equal(backendEvent.source.generation, backend.generation);

      if (frontend) {
        const frontendWatch = await client.watch({
          sourceId: frontend.sourceId,
          generation: frontend.generation,
        });
        view.frontendHost.transport.close('frontend disconnected');
        const stale = await waitForEvent(
          events,
          (event) => event.watchId === frontendWatch.watchId && event.state === 'stale',
        );
        assert.equal(stale.reason, 'source-disconnected');
        const recovered = await client.sources();
        assert.equal(
          recovered.sources.some((source) => source.sourceId === frontend.sourceId),
          false,
        );
      }
    } finally {
      removeEvents();
      transport.close();
      await view.dispose();
    }
  });

  it('does not promote an ordinary resident token connection through a role query', async () => {
    const page = decorateBrowserPage({
      goto: async () => undefined,
      evaluate: async () => undefined,
      on() {},
      off() {},
      isClosed: () => false,
    });
    const view = await startView({
      platform: createBrowserPagePlatform({ page }),
      frontend: false,
    });
    const socket = new NodeWebSocket(
      `${view.workspaceServer.endpoint}?token=${encodeURIComponent(view.workspaceAccessToken)}&role=frontend`,
    );
    const transport = await createHostWebSocketClient(socket);
    const client = new ViewInspectorClient({
      transport,
      clientId: 'ordinary-token-client',
      token: view.workspaceAccessToken,
    });
    try {
      await assert.rejects(
        client.report({ plugins: [] }),
        (error) => error instanceof ViewWorkspaceError && error.code === 'view-inspector-unauthorized',
      );
    } finally {
      transport.close();
      await view.dispose();
    }
  });

  it('redacts credential-bearing activation errors from the inspector DTO', async () => {
    const page = decorateBrowserPage({
      goto: async () => undefined,
      evaluate: async () => undefined,
      on() {},
      off() {},
      isClosed: () => false,
    });
    const view = await startView({
      platform: createBrowserPagePlatform({ page }),
      workspaceServer: false,
      frontend: false,
    });
    const transport = view.backendHost.transport.connect({
      kind: 'frontend',
      sourceId: 'view-frontend',
    });
    const client = new ViewInspectorClient({
      transport,
      clientId: 'trusted-frontend-test',
      token: view.workspaceAccessToken,
    });
    try {
      await client.report({
        actual: {
          state: 'failed',
          error: {
            code: 'frontend-failed',
            expected: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.ABC.DEF https://user:SECRET_938@example.test',
            hint: 'Basic dXNlcjpwYXNz token=SECRET_938 password=SECRET_938',
            detail: { reason: 'SECRET_938' },
          },
        },
        plugins: [
          {
            entryId: 'frontend-plugin',
            module: 'view/frontend',
            realm: 'engine',
            fiberState: 'failed',
            failure: {
              code: 'frontend-failed',
              expected: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.ABC.DEF secret=SECRET_938',
              hint: 'Basic dXNlcjpwYXNz https://user:SECRET_938@example.test',
              detail: { reason: 'SECRET_938' },
            },
          },
        ],
      });
      const sourceId = `view-frontend:${transport.caller.connectionId}`;
      const listed = await client.sources();
      const source = listed.sources.find((entry) => entry.sourceId === sourceId);
      assert.ok(source);
      const inspected = await client.inspect({ sourceId, generation: source.generation });
      const serialized = JSON.stringify(inspected);
      assert.equal(serialized.includes('SECRET_938'), false);
      assert.equal(serialized.includes('eyJhbGciOiJIUzI1NiJ9.ABC.DEF'), false);
      assert.equal(serialized.includes('dXNlcjpwYXNz'), false);
      assert.equal(serialized.includes('[redacted]'), true);
    } finally {
      transport.close();
      await view.dispose();
    }
  });
});
