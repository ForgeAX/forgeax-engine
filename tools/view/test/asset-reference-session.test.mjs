import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createToolApi, defineTool, toolJsonSchema } from '@forgeax/engine/tool-runtime';
import { createAssetReferenceSession } from '../packages/view-plugin-asset-references/src/session.ts';
import { ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE } from '../packages/view-workspace-core/src/asset-references.ts';

function fixture(t, { deferPrepare = false, missing = false, abortAdmission = false } = {}) {
  const api = createToolApi();
  let snapshot = { project: { id: 'project' }, projectTarget: { targetId: 'scene', worldId: 'world', generation: 1 }, browserGeneration: 1 };
  let update;
  let finishPrepare;
  const calls = [];
  const packs = new Map();
  const installations = new Map();
  let uid = 0;
  const schema = toolJsonSchema({ type: 'object' });
  const client = {
    subscribe(listener) { update = listener; listener(snapshot); return () => { update = undefined; }; },
    async call(operation, args, options = {}) {
      calls.push({ operation, args });
      if (missing && operation === 'runtime-pack.inspect') throw new Error('capability-unavailable');
      if (operation === 'runtime-pack.inspect') return { imports: {}, packs: [...packs.values()] };
      if (operation === 'runtime-pack.prepare') {
        if (deferPrepare) await new Promise(resolve => { finishPrepare = resolve; });
        return { artifact: {} };
      }
      if (operation === 'runtime-pack.admit') {
        packs.set(args.content.source.packageId, args.content);
        if (abortAdmission) { abortAdmission = false; await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled after commit', 'AbortError')), { once: true })); }
        return {};
      }
      if (operation === 'assets.list') return { assets: [...packs.keys()].map(packageId => ({ packageId, guid: packageId, kind: 'plugin' })) };
      if (operation === 'runtime-pack.plugin-install') {
        const config = packs.get(args.guid).source.assets.query.payload.config;
        const installedUid = ++uid;
        const provider = api.registerProvider({ sourceId: ASSET_REFERENCE_SOURCE, providerId: config.providerId, realm: 'engine',
          tools: [defineTool({ id: ASSET_REFERENCE_QUERY, path: ['view', 'asset-references', 'get'], title: 'References', summary: 'Fixture identity query', realm: 'engine', argsSchema: schema, resultSchema: schema, inputSchema: {}, outputSchema: {}, evidence: [] },
            input => ({ ...input, references: [] }))] });
        installations.set(installedUid, provider);
        return { uid: installedUid };
      }
      if (operation === 'runtime-pack.plugin-inspect') return { plugins: [...installations.keys()].map(uid => ({ uid })) };
      if (operation === 'runtime-pack.plugin-dispose') { await installations.get(args.uid)?.revoke(); installations.delete(args.uid); return {}; }
      if (operation === 'runtime-pack.withdraw') { packs.delete(args.packageId); return {}; }
      throw new Error(operation);
    },
  };
  const session = createAssetReferenceSession({ api, client, program: 'compiled native program' });
  t.after(async () => { finishPrepare?.(); await session.dispose(); await api.dispose(); });
  return { session, calls, installations, api, packs,
    publish(next) { snapshot = { ...snapshot, ...next }; update(snapshot); },
    complete() { deferPrepare = false; finishPrepare?.(); },
    available() { missing = false; },
  };
}

it('installs before selection and stays resident across selection, panels and resource page changes', async t => {
  const f = fixture(t);
  assert.equal(f.session.getState().phase, 'installing');
  await f.session.query('scene:world:1');
  assert.equal(f.session.getState().phase, 'ready');
  assert.equal(f.session.getState().pluginUid, 1);
  f.publish({ sceneSelection: { primary: { entityId: 'scene:world:2' } }, openRequest: { asset: { guid: 'mesh', kind: 'mesh' } } });
  await f.session.query('scene:world:2');
  assert.equal(f.calls.filter(call => call.operation === 'runtime-pack.plugin-install').length, 1);
  assert(!f.calls.some(call => call.operation === 'runtime-pack.plugin-dispose'));
});

it('cleans only its own plugin and Pack and can recover a removed provider', async t => {
  const f = fixture(t);
  await f.session.query('scene:world:1');
  const provider = f.installations.get(1);
  await provider.revoke();
  f.installations.delete(1);
  assert.equal(f.session.getState().phase, 'unavailable');
  await f.session.query('scene:world:1');
  assert.equal(f.session.getState().phase, 'ready');
  await f.session.dispose();
  assert.equal(f.session.getState().scope, undefined);
  await assert.rejects(f.session.query('scene:world:1'), /scene-unavailable/);
  assert(f.calls.some(call => call.operation === 'runtime-pack.plugin-dispose' && call.args.uid === 2));
  assert(!f.calls.some(call => call.operation === 'runtime-pack.release'));
});

it('revokes pending queries synchronously when the target is replaced', async t => {
  const f = fixture(t, { deferPrepare: true });
  const query = f.session.query('scene:world:1');
  const rejected = assert.rejects(query, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
  f.publish({ projectTarget: null });
  await rejected;
  assert.equal(f.session.getState().phase, 'idle');
  f.complete();
});

it('missing runtime capability fails explicitly and recovers on a later user query', async t => {
  const f = fixture(t, { missing: true });
  await assert.rejects(f.session.query('scene:world:1'), /capability-unavailable/);
  assert.equal(f.session.getState().phase, 'failed');
  f.available();
  await f.session.query('scene:world:1');
  assert.equal(f.session.getState().phase, 'ready');
});

it('withdraws its old publication when admission committed before cancellation was acknowledged', async t => {
  const f = fixture(t, { abortAdmission: true });
  const query = f.session.query('scene:world:1');
  const rejected = assert.rejects(query, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
  const oldPackage = f.session.getState().packageId;
  f.publish({ projectTarget: { targetId: 'scene', worldId: 'world', generation: 2 } });
  await rejected;
  await f.session.query('scene:world:2');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.packs.has(oldPackage), false);
  assert(f.calls.some(call => call.operation === 'runtime-pack.withdraw' && call.args.packageId === oldPackage));
});
