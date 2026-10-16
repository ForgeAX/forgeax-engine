import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { createHostTransport } from '@forgeax/engine-host/transport';
import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { ViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';
import { createViewPageHost, createViewPageTypeRegistry } from '../packages/viewer/src/host/page-registry.ts';
import { attachPresentationResponder, createPresentationRelay, serializePresentation } from '../packages/view-workspace-core/src/presentation.ts';
import { workspaceCoreCliContributions } from '../packages/view-workspace-core/src/cli.ts';

const disposers = [];
afterEach(async () => { while (disposers.length) await disposers.pop()(); });
function snapshot(title = 'Scene') {
  return { shellState: 'mounted', activePageId: 'page-editor', pages: [{ id: 'page-editor', typeId: 'editor', title, closable: false }],
    pageTypes: [{ typeId: 'editor', title: 'Scene', openable: false }], panels: [],
    hasMorePages: false, hasMorePageTypes: false, hasMorePanels: false,
    appearance: { theme: 'dark', preference: 'system', language: 'en' } };
}
function fixture() {
  const transport = createHostTransport();
  const broker = new ViewWorkspaceBroker({ accessToken: 'presentation-test' });
  const unregister = broker.registerTransport(transport);
  disposers.push(async () => { unregister(); await broker.dispose(); transport.close(); });
  const connect = (kind, sourceId) => {
    const connection = transport.connect({ kind, sourceId });
    const client = new ViewWorkspaceClient({ transport: connection, clientId: 'test', token: broker.accessToken });
    return { connection, capabilities: () => client.capabilities({ reportError: false }), call: (operation, args = {}, options = {}) => client.call(operation, args, { ...options, reportError: false }) };
  };
  return { transport, broker, cli: connect('cli'), frontend: () => connect('frontend', 'view-frontend') };
}

it('queries the native PageHost lease freshly through the real Host workspace service', async () => {
  const { cli, frontend } = fixture();
  await assert.rejects(cli.call('presentation.get'), error => error.code === 'view-page-unavailable');
  const page = frontend();
  const host = createViewPageHost({ registry: createViewPageTypeRegistry() });
  disposers.push(attachPresentationResponder(page.connection, (op, args, signal) => host.callPresentation(op, args, signal)));
  await assert.rejects(cli.call('presentation.get'), error => error.code === 'view-presentation-unavailable');
  let current = 'First';
  const detach = host.attachPresentation(() => snapshot(current));
  assert.equal((await cli.call('presentation.get')).pages[0].title, 'First');
  current = 'Changed by the UI owner';
  assert.equal((await cli.call('presentation.get')).pages[0].title, current);
  detach();
  await assert.rejects(cli.call('presentation.get'), error => error.code === 'view-presentation-unavailable');
  const detachAgain = host.attachPresentation(() => snapshot('Replacement'));
  detach();
  assert.equal((await cli.call('presentation.get')).pages[0].title, 'Replacement');
  detachAgain();
});

it('discovers prefixed CLI paths from the same callable presentation operations', async () => {
  const { cli } = fixture();
  const capabilities = await cli.capabilities();
  for (const id of ['presentation.get', 'presentation.page.open', 'presentation.page.select', 'presentation.page.close', 'presentation.panel.reveal']) {
    const contribution = workspaceCoreCliContributions.find(row => row.id === `view.workspace.${id}`);
    assert.ok(capabilities.operations.includes(id));
    assert.deepEqual(contribution.path, ['view', 'workspace', ...id.split('.')]);
    await assert.rejects(cli.call(id), error => error.code === 'view-page-unavailable');
  }
});

it('targets one document, rejects ambiguity and prevents frontend cross-document commands', async () => {
  const { cli, frontend } = fixture();
  const first = frontend(), second = frontend();
  disposers.push(attachPresentationResponder(first.connection, () => snapshot('First')));
  disposers.push(attachPresentationResponder(second.connection, () => snapshot('Second')));
  await assert.rejects(cli.call('presentation.get'), error => error.code === 'view-page-ambiguous');
  const pages = await cli.call('pages.list');
  assert.equal(pages.pages.length, 2);
  assert.equal((await cli.call('presentation.get', { connectionId: second.connection.caller.connectionId })).pages[0].title, 'Second');
  assert.equal((await first.call('presentation.get')).pages[0].title, 'First');
  await assert.rejects(first.call('presentation.page.close', { connectionId: second.connection.caller.connectionId, pageId: 'page-editor' }), error => error.code === 'view-presentation-page-denied');
  second.connection.close();
  await assert.rejects(cli.call('presentation.get', { connectionId: second.connection.caller.connectionId }), error => error.code === 'view-page-gone');
});

it('executes every presentation command at the frontend owner and returns its accepted result', async () => {
  const { cli, frontend } = fixture();
  const page = frontend();
  const received = [];
  disposers.push(attachPresentationResponder(page.connection, (operation, args) => { received.push([operation, args]); return snapshot(operation); }));
  for (const [operation, args] of [
    ['presentation.page.open', { typeId: 'mesh' }],
    ['presentation.page.select', { pageId: 'page-mesh' }],
    ['presentation.page.close', { pageId: 'page-mesh' }],
    ['presentation.panel.reveal', { panelId: 'content-browser' }],
  ]) {
    const result = await cli.call(operation, args);
    assert.equal(result.pages[0].title, operation);
    assert.deepEqual(received.at(-1), [operation, args]);
  }
});

it('rejects replies from another connection and ignores late replies after timeout', async () => {
  const transport = createHostTransport();
  const page = transport.connect({ kind: 'frontend' }), other = transport.connect({ kind: 'frontend' });
  const relay = createPresentationRelay(transport, () => page.caller.connectionId, 30);
  disposers.push(() => { relay.dispose(); transport.close(); });
  let request;
  page.subscribe('forgeax.view.presentation.request', value => { if (!value.cancelled) request = value; });
  const result = relay.call('presentation.get', {}, undefined);
  const rejected = assert.rejects(result, error => error.code === 'view-presentation-timeout');
  assert.deepEqual(await other.request('forgeax.view.presentation.reply', { requestId: request.requestId, snapshot: snapshot('Wrong') }), { accepted: false });
  await rejected;
  assert.deepEqual(await page.request('forgeax.view.presentation.reply', { requestId: request.requestId, snapshot: snapshot('Late') }), { accepted: false });
});

it('cancels pending frontend work and retires requests on disconnect and provider disposal', async () => {
  const { transport, broker, frontend } = fixture();
  const page = frontend();
  let started, aborted;
  const began = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { aborted = resolve; });
  disposers.push(attachPresentationResponder(page.connection, async (_operation, _args, signal) => {
    started(); await new Promise(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
    return snapshot('Cancelled');
  }));
  const cancel = new AbortController();
  const result = broker.presentation.call('presentation.get', {}, undefined, cancel.signal);
  const rejected = assert.rejects(result, error => error.code === 'view-presentation-cancelled');
  await began; cancel.abort(); await rejected; await stopped;
  const disconnected = broker.presentation.call('presentation.get', {}, undefined);
  const lost = assert.rejects(disconnected, error => error.code === 'view-presentation-disconnected');
  page.connection.close(); await lost;
  const replacement = frontend();
  const pending = broker.presentation.call('presentation.get', { connectionId: replacement.connection.caller.connectionId }, undefined);
  const disposed = assert.rejects(pending, error => error.code === 'view-presentation-unavailable');
  await broker.dispose(); await disposed;
});

it('never dispatches an already cancelled request and bounds unanswered requests', async () => {
  const { broker, frontend } = fixture();
  const page = frontend();
  let calls = 0;
  const unsubscribe = page.connection.subscribe('forgeax.view.presentation.request', request => { if (!request.cancelled) calls++; });
  disposers.push(unsubscribe);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(broker.presentation.call('presentation.get', {}, undefined, cancelled.signal), error => error.code === 'view-presentation-cancelled');
  assert.equal(calls, 0);
  const control = new AbortController();
  const waits = Array.from({ length: 64 }, () => assert.rejects(broker.presentation.call('presentation.get', {}, undefined, control.signal), error => error.code === 'view-presentation-cancelled'));
  assert.throws(() => broker.presentation.call('presentation.get', {}, undefined), error => error.code === 'view-presentation-busy');
  control.abort(); await Promise.all(waits);
  assert.equal(calls, 64);
});

it('bounds the returned projection and never returns borrowed UI objects', () => {
  const value = snapshot();
  value.pages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), typeId: 'mesh', title: 'x'.repeat(1000), closable: true, element: { secret: 'not a wire field' } }));
  const result = serializePresentation(value);
  assert.equal(result.pages.length, 64);
  assert.equal(result.hasMorePages, true);
  assert.equal(result.pages[0].title.length, 512);
  assert.equal('element' in result.pages[0], false);
  assert.throws(() => serializePresentation({ ...snapshot(), activePageId: { element: true } }), error => error.code === 'view-presentation-invalid');
  assert.throws(() => serializePresentation({ ...snapshot(), pages: [{ ...snapshot().pages[0], id: 'x'.repeat(257) }] }), error => error.code === 'view-presentation-invalid');
});

it('retiring a native Shell lease cancels its owner and cannot acknowledge stale UI state', async () => {
  const host = createViewPageHost({ registry: createViewPageTypeRegistry() });
  let accepted;
  const started = new Promise(resolve => { accepted = resolve; });
  const detach = host.attachPresentation(async (_operation, _args, signal) => {
    accepted();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return snapshot('Retired Shell');
  });
  const request = host.callPresentation('presentation.page.select', { pageId: 'page-editor' }, new AbortController().signal);
  const rejected = assert.rejects(request, error => error.code === 'view-presentation-retired');
  await started; detach();
  const dispose = host.attachPresentation(() => snapshot('New Shell'));
  await rejected;
  detach();
  assert.equal((await host.callPresentation('presentation.get', {}, new AbortController().signal)).pages[0].title, 'New Shell');
  dispose();
});
