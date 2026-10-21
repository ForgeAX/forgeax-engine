import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPackAuthoringClient, packParameterReference } from '../packages/view-workspace-core/src/pack-authoring.ts';

test('Expose carries the selected source and reflected value without inventing a nested binding', () => {
  const input = {
    project: { id: 'game', root: '/games/current' },
    target: { targetId: 'preview', generation: 7 },
    sourcePath: 'assets/scene.pack.ts',
    field: { component: 'DirectionalLight', key: 'intensity', value: 3.2, schema: { type: 'f32', default: 1 },
      asset: 'scene/showcase', address: ['sun'], path: ['entities', 'sun', 'components', 'DirectionalLight', 'intensity'] },
  };
  const context = JSON.parse(packParameterReference(input).text.split('\n\n')[1]);
  assert.deepEqual(context.project, input.project);
  assert.deepEqual(context.target, input.target);
  assert.deepEqual(context.apply, { asset: 'scene/showcase', path: input.field.path });
  assert.deepEqual(context.field.schema, { type: 'f32', default: 1 });
  assert.equal(context.field.currentPreviewValue, 3.2);
  const nested = JSON.parse(packParameterReference({ ...input,
    field: { ...input.field, address: ['mount', 'sun'], path: undefined },
  }).text.split('\n\n')[1]);
  assert.equal('apply' in nested, false);
  assert.deepEqual(nested.field.address, ['mount', 'sun']);
});

function fixture() {
  let sequence = 0;
  let draft = { id: 'draft', sequence: 0, fields: [], values: { color: 0 }, unsaved: false };
  let listener;
  let finish;
  const calls = [];
  const client = {
    transport: { subscribe(_topic, callback) { listener = callback; return () => { listener = undefined; }; } },
    async call(_operation, { request }, { signal }) {
      calls.push(request);
      if (request.action === 'edit') {
        await new Promise(resolve => { finish = resolve; });
        signal.throwIfAborted();
        draft = { ...draft, values: { color: request.value }, unsaved: true };
      }
      if (request.action === 'save') draft = { ...draft, unsaved: false };
      return { ...draft, sequence: ++sequence };
    },
  };
  const author = createPackAuthoringClient(client, { projectId: 'project', sessionId: 'session', targetId: 'target', sourcePath: 'assets/test.pack.ts' });
  return { author, calls, finish: () => finish(), event: reply => listener?.({ sessionId: 'session', targetId: 'target', reply }) };
}

test('Save drains pending and in-flight edits, coalescing the last input for a field', async () => {
  const { author, calls, finish } = fixture();
  await author.open();
  author.edit('color', 1);
  author.edit('color', 2);
  const saving = author.act('save');
  assert.equal(author.getSnapshot().pending, true);
  assert.deepEqual(calls.map(call => call.action), ['open', 'edit']);
  assert.equal(calls[1].value, 2);
  finish();
  await saving;
  assert.deepEqual(calls.map(call => call.action), ['open', 'edit', 'save']);
  assert.equal(author.getSnapshot().draft.values.color, 2);
  assert.equal(author.getSnapshot().draft.unsaved, false);
  author.dispose();
});

test('stale response cannot overwrite a newer owner event', async () => {
  const { author, event, finish } = fixture();
  await author.open();
  author.edit('color', 1);
  const pending = author.flush();
  event({ ...author.getSnapshot().draft, sequence: 20, values: { color: 7 } });
  finish();
  await pending;
  assert.equal(author.getSnapshot().draft.values.color, 7);
  author.dispose();
});

test('retiring a panel never forwards its queued writes or Save to another source', async () => {
  const { author, calls, finish } = fixture();
  await author.open();
  author.edit('color', 1);
  const pending = author.act('save');
  author.edit('color', 2);
  author.dispose();
  finish();
  await assert.rejects(pending, /abort/i);
  assert.deepEqual(calls.map(call => call.action), ['open', 'edit']);
});

test('100 author edits never publish or traverse the workspace asset inventory', async () => {
  const { createToolApi, defineTool, toolJsonSchema } = await import('@forgeax/engine-tool-runtime');
  const { ViewWorkspaceBroker } = await import('../packages/view-workspace-core/src/broker.ts');
  const api = createToolApi();
  let count = 0;
  api.registerProvider({ providerId: 'author', sourceId: 'engine-workspace', realm: 'host', tools: [defineTool({ id: 'engine.asset.source.draft', realm: 'host', title: 'Edit a draft', evidence: [], summary: 'Edit a draft', argsSchema: toolJsonSchema({ type: 'object' }), resultSchema: toolJsonSchema({}) },
    ({ request }) => ({ id: 'draft', sequence: ++count, changed: { field: request.field, value: request.value } }),
  )] });
  const broker = new ViewWorkspaceBroker({ toolApi: api });
  // Any workspace synchronization or snapshot would read this inventory.
  Object.defineProperty(broker, 'assets', { get() { throw new Error('Draft edit read the Catalog'); } });
  broker.changed = () => { throw new Error('Draft edit published workspace state'); };
  broker.syncBindings = () => { throw new Error('Draft edit synchronized workspace state'); };
  try {
    for (let i = 0; i < 100; i++) {
      const reply = await broker.invoke('asset.source.draft', { projectId: 'project', request: { action: 'edit', draftId: 'draft', field: 'color', value: i } });
      assert.equal(reply.changed.value, i);
    }
    assert.equal(count, 100);
  } finally { await api.dispose(); }
});
