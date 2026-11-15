import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '@forgeax/engine-plugin';
import inspectorFrontend from '../packages/view-plugin-inspector/src/frontend.ts';

// Owner-issued Native T5 targets; no World is derived from an entity ID.
const play = { projectId: 'vc-ue5', targetId: 'target-95d4dfc0-ab15-42fe-af78-7c7abc1e1228', targetGeneration: 1 };
const editor = { projectId: 'vc-ue5', targetId: 'target-852ace0d-17aa-44e0-9743-a9bec87158eb', targetGeneration: 1,
  worldId: 'world-09e757df-8edc-439d-a214-c2d2a36c23d9-2', browserGeneration: 1 };
const guids = ['4c77c4c0-ef1e-515d-9da9-aec256aca42d', 'a4db8106-28a7-585a-b6c5-62e9e993303f', 'a3f8ddd1-6b4e-58f4-93f2-f0e3f533e270'];

async function fixture(t, { scope = editor, reveal, browser = true } = {}) {
  const context = new Context();
  const calls = [];
  let props;
  context.provide('viewOperationClient', {});
  context.provide('viewScenePage', { typeId: 'scene' });
  context.provide('viewAssetReferences', { getState: () => ({ phase: scope ? 'ready' : 'idle', scope }) });
  if (browser) context.provide('viewAssetBrowser', { revealAsset(input) {
    calls.push(input);
    return reveal ? reveal(input) : Promise.resolve(input.projectId === play.projectId
      && input.targetId === play.targetId && input.targetGeneration === play.targetGeneration);
  } });
  const fiber = context.plugin(inspectorFrontend, { panelHost: { async mountPanel(panel) {
    props = panel.props;
    return () => {};
  } } });
  await fiber.await();
  t.after(() => context.fiber.dispose());
  return { props, calls };
}

it('reveals each Native cloud reference with the Inspector Play scope rather than the Editor read session', async t => {
  const f = await fixture(t);
  for (const guid of guids) assert.equal(await f.props.browseAsset(guid, play), true);
  assert.deepEqual(f.calls, guids.map(guid => ({ ...play, guid })));
});

it('does not require an Editor World session to reveal a returned Inspector reference', async t => {
  const f = await fixture(t, { scope: null });
  assert.equal(await f.props.browseAsset(guids[0], play), true);
  assert.deepEqual(f.calls, [{ ...play, guid: guids[0] }]);
});

it('preserves the Content Browser refusal for stale targets and generations', async t => {
  const f = await fixture(t);
  assert.equal(await f.props.browseAsset(guids[0], { ...play, targetGeneration: 0 }), false);
  assert.equal(await f.props.browseAsset(guids[0], { ...play, targetId: editor.targetId }), false);
  assert.deepEqual(f.calls.map(({ targetId, targetGeneration }) => ({ targetId, targetGeneration })), [
    { targetId: play.targetId, targetGeneration: 0 }, { targetId: editor.targetId, targetGeneration: play.targetGeneration },
  ]);
});

it('preserves missing-browser and rejected-reveal results instead of crediting a locate', async t => {
  const missing = await fixture(t, { browser: false });
  assert.equal(await missing.props.browseAsset(guids[0], play), false);
  const failed = await fixture(t, { reveal: async () => { throw new Error('reveal-failed'); } });
  await assert.rejects(failed.props.browseAsset(guids[0], play), /reveal-failed/);
});
