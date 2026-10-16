import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadPluginSnapshot, filterPluginEntries } from '../packages/view-plugin-plugins/src/ui/plugin-entries.ts';
import { createViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';
import { startView } from '../src/index.ts';

const local = {
  current: { schemaVersion: 2, root: { program: 'ui-module', codeRevision: '1' } },
  status: { state: 'active' },
  inspection: [{ uid: 1, name: 'ui-module', state: 'active' }],
};

it('keeps source generations in inspection/watch arguments, separate from transport generations', async () => {
  const calls = [];
  const client = createViewWorkspaceClient({ clientId: 'generation-proof', transport: {
    request: async (service, request, options) => { calls.push({ service, request, options }); return {}; },
  } });
  await client.inspectPlugins({ sourceId: 'backend', generation: 9 });
  await client.watchPlugins({ sourceId: 'backend', generation: 11 });
  assert.deepEqual(calls.map(call => call.request.args), [
    { sourceId: 'backend', generation: 9 }, { sourceId: 'backend', generation: 11 },
  ]);
  assert.ok(calls.every(call => call.options.generation === undefined));
});

it('loads actual backend installations through the public workspace client inspectPlugins method', async () => {
  const view = await startView({ frontend: false, workspaceServer: false });
  const transport = view.backendHost.transport.connect({ kind: 'cli' });
  try {
    const client = createViewWorkspaceClient({ transport, clientId: 'filter-test', token: view.workspaceAccessToken });
    assert.equal(client.inspect, undefined);
    const snapshot = await loadPluginSnapshot({ client, hostAssembly: local });
    assert.deepEqual(snapshot.issues, []);
    for (const role of ['workspace', 'display-carrier', 'plugin-inspection']) {
      assert.ok(snapshot.entries.some(entry => entry.module === `forgeax.view.service.${role}.backend` && entry.tags.includes('backend')));
    }
    assert.ok(filterPluginEntries(snapshot.entries, { tags: ['backend', 'api', 'cli'] }).length > 0);
    assert.equal(filterPluginEntries(snapshot.entries, { tags: ['game'] }).length, 0);
    assert.equal(snapshot.sources[0].kind, 'backend');
    const listed = await client.sources();
    const source = listed.sources.find(source => source.sourceId === 'view-backend');
    await assert.rejects(
      client.inspectPlugins({ sourceId: source.sourceId, generation: source.generation + 1 }),
      error => error.code === 'view-inspector-stale-generation',
    );
    const watch = await client.watchPlugins({ sourceId: source.sourceId, generation: source.generation });
    assert.ok(watch.watchId);
    assert.equal(watch.source.sourceId, source.sourceId);
  } finally { transport.close(); await view.dispose(); }
});

it('deduplicates only this connection and preserves other frontend and game sources', async () => {
  const calls = [];
  const client = {
    marker: true,
    async sources() {
      assert.equal(this.marker, true);
      return { caller: { connectionId: 'ours' }, sources: [
        { sourceId: 'view-frontend:ours', kind: 'frontend', generation: 1, connection: { connectionId: 'ours' } },
        { sourceId: 'view-frontend:peer', kind: 'frontend', generation: 2 },
        { sourceId: 'game:one', kind: 'game', generation: 3 },
      ] };
    },
    async inspectPlugins(request) {
      assert.equal(this.marker, true);
      calls.push(request);
      return { plugins: [{ entryId: 'shared-entry', module: 'game-module', realm: 'engine', fiberState: 'active' }] };
    },
  };
  const snapshot = await loadPluginSnapshot({ client, hostAssembly: local, connectionId: 'client-local-id' });
  assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(calls, [{ sourceId: 'view-frontend:peer', generation: 2 }, { sourceId: 'game:one', generation: 3 }]);
  assert.equal(snapshot.entries.length, 3);
  assert.equal(filterPluginEntries(snapshot.entries, { sourceId: 'game:one', tags: ['game'] }).length, 1);
  assert.equal(filterPluginEntries(snapshot.entries, { sourceId: 'view-frontend:ours', tags: ['game'] }).length, 0);
  assert.equal(filterPluginEntries(snapshot.entries, { sourceId: 'view-frontend:peer' }).length, 1);
});

it('preserves available hosts and explicitly reports missing or failed inspection', async () => {
  const unavailable = await loadPluginSnapshot({ hostAssembly: local });
  assert.equal(unavailable.entries.length, 1);
  assert.match(unavailable.issues[0].message, /unavailable/);
  const failed = await loadPluginSnapshot({ hostAssembly: local, client: {
    sources: async () => ({ sources: [
      { sourceId: 'backend', kind: 'backend', generation: 1 },
      { sourceId: 'peer', kind: 'frontend', generation: 2 },
    ] }),
    inspect: async ({ sourceId }) => {
      if (sourceId === 'backend') throw new Error('stale generation');
      return { plugins: [{ entryId: 'peer-plugin', module: 'peer-module' }] };
    },
  } });
  assert.equal(failed.entries.length, 2);
  assert.deepEqual(failed.issues, [{ sourceId: 'backend', message: 'stale generation' }]);
  assert.equal(failed.sources.find(source => source.sourceId === 'backend').unavailable, true);
});

it('derives tags from source and contribution facts, not names, and intersects all filters', async () => {
  const snapshot = await loadPluginSnapshot({ client: {
    sources: async () => ({ sources: [{ sourceId: 'host', kind: 'backend', generation: 1 }] }),
    inspect: async () => ({
      // A backend assembly describes the frontend projection and must not leak into backend rows.
      assembly: local.current,
      plugins: [
        { entryId: 'provider:tools:one', module: 'tools', fiberState: 'active' },
        { entryId: 'api-cli-game-in-name-only', module: 'misleading-name' },
        { entryId: 'simulation', module: 'game', realm: 'engine', requiredServices: ['world'] },
      ],
      api: { operations: [{ owner: { sourceId: 'tools', providerId: 'one' }, descriptor: { id: 'assets.list', path: ['assets', 'list'] } }] },
    }),
  } });
  assert.equal(snapshot.entries.length, 3);
  assert.deepEqual(snapshot.entries[1].tags, ['backend']);
  assert.deepEqual(filterPluginEntries(snapshot.entries, { query: ' assets list ', sourceId: 'host', tags: ['backend', 'api', 'cli'] }).map(entry => entry.entryId), ['provider:tools:one']);
  assert.equal(filterPluginEntries(snapshot.entries, { tags: ['frontend', 'api'] }).length, 0);
  assert.equal(filterPluginEntries(snapshot.entries, { tags: ['game'] })[0].entryId, 'simulation');
  assert.equal(snapshot.entries[1].label, 'misleading-name');
  assert.equal(snapshot.entries[1].state, 'unknown');
});

it('shows a Pack plugin GUID and program in the asset filter', async () => {
  const snapshot = await loadPluginSnapshot({ client: {
    sources: async () => ({ sources: [{ sourceId: 'host', kind: 'backend', generation: 1 }] }),
    inspect: async () => ({ plugins: [{
      entryId: 'fiber:17', module: 'game.combat', fiberState: 'active',
      assetGuid: '0467d2d6-ae37-51a5-9450-d9dce432473b', program: 'game/combat',
    }] }),
  } });
  const [entry] = filterPluginEntries(snapshot.entries, { tags: ['backend', 'asset'], query: '0467d2d6' });
  assert.equal(entry?.program, 'game/combat');
  assert.equal(entry?.entryId, 'fiber:17');
  assert.equal(entry?.label, 'game.combat');
  assert.equal(entry?.state, 'active');
});

it('uses plugin identity for display while keeping separate runtime Fiber identities', async () => {
  const snapshot = await loadPluginSnapshot({ client: {
    sources: async () => ({ sources: [{ sourceId: 'host', kind: 'backend', generation: 1 }] }),
    inspect: async () => ({ plugins: [
      { entryId: 'fiber:2', module: 'game.combat' },
      { entryId: 'fiber:3', module: 'game.combat' },
      { entryId: 'fiber:4', module: 'unknown', program: 'game/loader' },
    ] }),
  } });
  assert.deepEqual(snapshot.entries.map(({ entryId, label }) => [entryId, label]), [
    ['fiber:2', 'game.combat'],
    ['fiber:3', 'game.combat'],
    ['fiber:4', 'game/loader'],
  ]);
});

for (const kind of ['workspace', 'inspector']) {
  for (const outcome of ['recovered', 'stale', 'gone', 'unauthorized']) {
    it(`${kind} snapshot handles ${outcome} peers with bounded recovery and visible terminal issues`, async () => {
      const { ViewInspectorClient } = await import('../packages/view-plugin-plugins/src/runtime.ts');
      const { ViewWorkspaceError } = await import('../packages/view-workspace-core/src/contract.ts');
      const { subscribeWorkspaceCommandErrors } = await import('../packages/view-workspace-core/src/command-error.ts');
      let lists = 0, inspections = 0;
      const reported = [];
      const stop = subscribeWorkspaceCommandErrors(error => reported.push(error));
      const transport = { async request(_service, request) {
        if (request.operation === 'plugins.sources') {
          lists++;
          return { sources: outcome === 'gone' && lists > 1 ? [] : [{ sourceId: 'peer', kind: 'frontend', generation: lists }] };
        }
        inspections++;
        if (outcome === 'unauthorized') throw new ViewWorkspaceError('view-inspector-unauthorized', 'authorized caller', 'repair credentials');
        if (inspections === 1 || outcome === 'stale') throw new ViewWorkspaceError('view-inspector-stale-generation', 'current generation', 'refresh');
        return { plugins: [{ entryId: 'peer-plugin', module: 'peer-module', fiberState: 'active' }] };
      } };
      const options = { transport, clientId: 'snapshot-test', token: 'token' };
      const client = kind === 'workspace' ? createViewWorkspaceClient(options) : new ViewInspectorClient(options);
      try {
        const snapshot = await loadPluginSnapshot({ client, hostAssembly: local });
        assert.ok(snapshot.entries.some(entry => entry.module === 'ui-module'));
        if (outcome === 'recovered') {
          assert.deepEqual(snapshot.issues, []);
          assert.ok(snapshot.entries.some(entry => entry.module === 'peer-module'));
          assert.deepEqual([lists, inspections], [2, 2]);
        } else {
          assert.equal(snapshot.issues.length, 1);
          assert.deepEqual([lists, inspections], outcome === 'unauthorized' ? [1, 1] : outcome === 'gone' ? [2, 1] : [2, 2]);
        }
        assert.equal(reported.length, outcome === 'unauthorized' ? 1 : 0);
      } finally { stop(); }
    });
  }
}
