import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { codexResourceCard } from '../../src/codex-resource-card.mjs';
import { createViewAppServer } from '../../src/app/mcp-server.mjs';
import { RESOURCE_CARD_TOOL, RESOURCE_ACTION_TOOL } from '../../src/contract.ts';

const directTool = 'forgeax_view_resource_open';

async function connect(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-multi-card-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'forge.json'), '{}');
  const paths = ['first.pack.json', 'second.pack.ts'].map(name => join(root, 'assets', name));
  await writeFile(paths[0], '{}');
  await writeFile(paths[1], 'throw new Error("Card admission must not execute Pack source");');
  await writeFile(join(root, 'carrier.html'), '<carrier>__FX_VIEW_ENTRY_SCOPE__:__FX_VIEW_ENTRY_KIND__</carrier>');
  const calls = [];
  const app = createViewAppServer({ root }, { artifactRoot: pathToFileURL(`${root}/`), resourceCard: codexResourceCard,
    routing: {
      async route(scope, meta) {
        calls.push({ action: 'route', scope, meta });
        return { service: {
          async prepare(signal) { assert.equal(typeof signal?.aborted, 'boolean'); calls.push({ action: 'prepare' }); },
          async open() { calls.push({ action: 'open' }); throw new Error('Static resource tools must not open another App'); },
        } };
      },
      close() {},
    } });
  const client = new Client({ name: 'multi-card-contract', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await app.close(); });
  return { client, paths, calls, root };
}

test('inline single, grouped and warm cards share the public render tool with strict optional backend preparation', async t => {
  const { client, paths, calls } = await connect(t);
  const tools = (await client.listTools()).tools;
  const card = tools.find(tool => tool.name === RESOURCE_CARD_TOOL);
  assert.ok(card);
  assert.equal(card.inputSchema.properties.prepareBackend?.type, 'boolean', 'Warm variant must be declared in the strict public card schema');
  assert.deepEqual(card.inputSchema.required, ['paths']);
  assert.equal(card.inputSchema.additionalProperties, false);
  assert.deepEqual(card._meta.ui.visibility, ['model', 'app']);
  assert.equal(card._meta['openai/ui'].preferredModelDisplayMode, 'inline');
  const resource = (await client.readResource({ uri: card._meta.ui.resourceUri })).contents[0];
  assert.deepEqual(resource._meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' });
  assert.equal(resource.text, '<carrier>"workspace":"card"</carrier>');
  const invoke = (arguments_, meta = { threadId: 'same-chat' }) => client.callTool({ name: RESOURCE_CARD_TOOL, arguments: arguments_, _meta: meta });
  const first = await invoke({ paths: [paths[0]] });
  const second = await invoke({ paths: [paths[1]] });
  assert.deepEqual(first.structuredContent.resources, [{ path: paths[0], label: 'first.pack.json' }]);
  assert.deepEqual(second.structuredContent.resources, [{ path: paths[1], label: 'second.pack.ts' }]);
  const grouped = await invoke({ paths });
  assert.equal(grouped.structuredContent.resources.length, 2);
  await invoke({ paths, prepareBackend: false });
  assert.deepEqual(calls, [], 'Default and explicit lazy variants admit only static resources');
  const meta = { threadId: 'warm-chat', 'openai/resource': { path: paths[1] } };
  const warm = await invoke({ paths: [paths[0]], prepareBackend: true }, meta);
  assert.notEqual(warm.isError, true);
  assert.deepEqual(warm.structuredContent.resources, first.structuredContent.resources);
  assert.deepEqual(calls, [{ action: 'route', scope: 'workspace', meta }, { action: 'prepare' }]);
  const count = calls.length;
  for (const args of [{ paths, prepareBackend: 'true' }, { paths, root: '/foreign' }, { paths: [join(paths[0], 'missing')], prepareBackend: true }])
    assert.equal((await invoke(args)).isError, true);
  assert.equal(calls.length, count, 'Invalid source/schema must fail before warm preparation');
  assert.equal(tools.some(tool => tool.name === 'forgeax_view_prepare'), false, 'No second prepared App is registered');
});

test('direct resource View has a separate fullscreen-default tool and one validated source', async t => {
  const { client, paths, calls } = await connect(t);
  const tools = (await client.listTools()).tools;
  const direct = tools.find(tool => tool.name === directTool);
  assert.ok(direct, 'Direct resource View needs its own documented UI-linked tool');
  assert.deepEqual(direct.inputSchema.required, ['path']);
  assert.equal(direct.inputSchema.properties.path.type, 'string');
  assert.equal(direct.inputSchema.additionalProperties, false);
  assert.deepEqual(direct._meta.ui.visibility, ['model', 'app']);
  assert.equal(direct._meta['openai/ui'].preferredModelDisplayMode, 'fullscreen');
  const card = tools.find(tool => tool.name === RESOURCE_CARD_TOOL);
  assert.notEqual(direct._meta.ui.resourceUri, card._meta.ui.resourceUri);
  assert.match(direct._meta.ui.resourceUri, /^ui:\/\/forgeax\/resource-view\.html\?version=/);
  const resource = (await client.readResource({ uri: direct._meta.ui.resourceUri })).contents[0];
  assert.deepEqual(resource._meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' });
  assert.equal(resource.text, '<carrier>"workspace":"resource-view"</carrier>');
  const result = await client.callTool({ name: directTool, arguments: { path: paths[0] } });
  assert.deepEqual(result.structuredContent.resources, [{ path: paths[0], label: 'first.pack.json' }]);
  assert.deepEqual(calls, [], 'Direct metadata renders this App; it must not call an independent opening tool');
  for (const args of [{}, { paths }, { path: paths[0], prepareBackend: true }, { path: 'relative.pack.json' }])
    assert.equal((await client.callTool({ name: directTool, arguments: args })).isError, true);
  const select = tools.find(tool => tool.name === RESOURCE_ACTION_TOOL);
  assert.deepEqual(select._meta.ui, { visibility: ['app'] }, 'Click-time validation remains a non-rendering same-server data tool');
});

test('three static card slots have distinct descriptor URIs and share the carrier without backend acquisition', async t => {
  const { client, paths, calls, root } = await connect(t);
  const third = join(root, 'assets', 'third.pack.json');
  await writeFile(third, '{}');
  const sources = [...paths, third];
  const names = [RESOURCE_CARD_TOOL, `${RESOURCE_CARD_TOOL}_2`, `${RESOURCE_CARD_TOOL}_3`];
  const tools = (await client.listTools()).tools;
  const slots = names.map(name => {
    const tool = tools.find(value => value.name === name);
    assert.ok(tool, `Missing static card slot: ${name}`);
    return tool;
  });
  const uris = slots.map(tool => tool._meta.ui.resourceUri);
  assert.equal(new Set(uris).size, 3, 'Native host merges cards with the same originResourceUri');
  for (const [index, tool] of slots.entries()) {
    assert.deepEqual(tool._meta.ui.visibility, ['model', 'app']);
    assert.equal(tool._meta['openai/ui'].preferredModelDisplayMode, 'inline');
    assert.deepEqual(tool.inputSchema, slots[0].inputSchema, 'All slots use the same strict public schema');
    const resource = (await client.readResource({ uri: uris[index] })).contents[0];
    assert.equal(resource.uri, uris[index]);
    assert.equal(resource.text, '<carrier>"workspace":"card"</carrier>');
    assert.deepEqual(resource._meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' });
    const result = await client.callTool({ name: tool.name, arguments: { paths: [sources[index]] }, _meta: { threadId: 'same-chat' } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent.resources, [{ path: sources[index], label: sources[index].split('/').at(-1) }]);
    assert.equal(result._meta?.ui?.resourceUri, undefined, 'Slot identity comes from the descriptor, not an unqualified result override');
    for (const args of [{ paths: [], prepareBackend: true }, { paths: [sources[index]], root: '/foreign' },
      { paths: [join(root, 'assets', 'missing.pack.json')], prepareBackend: true }]) {
      assert.equal((await client.callTool({ name: tool.name, arguments: args, _meta: { threadId: 'same-chat' } })).isError, true);
    }
  }
  assert.deepEqual(calls, [], 'Static slots and rejected inputs must not route, prepare, or open a backend');
});
