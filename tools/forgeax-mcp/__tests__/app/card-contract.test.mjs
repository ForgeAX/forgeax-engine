import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { codexResourceCard } from '../../src/codex-resource-card.mjs';
import { codexFileEntry } from '../../src/codex-file-entry.mjs';
import { createCodexRouting } from '../../src/codex-routing.mjs';
import { createViewService } from '../../src/app/service.mjs';
import { RESOURCE_CARD_TOOL, RESOURCE_ACTION_TOOL, RESOURCE_CARD_URI, RESOURCE_CARD_SLOTS, OPEN_TOOL, GLOBAL_OPEN_TOOL, TRANSPORT_TOOL, UI_URI } from '../../src/contract.ts';
const { createViewAppServer } = await import(process.env.FORGEAX_TEST_CARD_SERVER ?? '../../src/app/mcp-server.mjs');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-card-contract-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'forge.json'), '{}');
  const first = join(root, 'assets/first.pack.json'), second = join(root, 'assets/second.pack.ts');
  await writeFile(first, '{}');
  await writeFile(second, 'throw new Error("Card validation must not evaluate this source");');
  await writeFile(join(root, 'carrier.html'), '<carrier>__FX_VIEW_ENTRY_SCOPE__:__FX_VIEW_ENTRY_KIND__</carrier>');
  await writeFile(join(root, 'full-view.html'), '<full-view>');
  return { root, first, second };
}
async function connect(t, root, routing) {
  const app = createViewAppServer({ root }, { artifactRoot: pathToFileURL(`${root}/`),
    resourceCard: codexResourceCard, fileEntry: codexFileEntry, routing });
  const client = new Client({ name: 'resource-card-contract', version: '1' });
  const [host, child] = InMemoryTransport.createLinkedPair();
  await app.server.connect(host); await client.connect(child);
  t.after(async () => { await client.close(); await app.close(); });
  return client;
}

test('model card registration admits static buttons without routing or acquiring a backend', async t => {
  const { root, first, second } = await fixture(t);
  const calls = [];
  const client = await connect(t, root, { route() { assert.fail('Static card acquired a route'); },
    invoke(args) { calls.push(args); }, close() {} });
  const card = (await client.listTools()).tools.find(tool => tool.name === RESOURCE_CARD_TOOL);
  assert.ok(card, 'The card must be registered in the existing View MCP server');
  assert.deepEqual(card._meta.ui.visibility, ['model', 'app']);
  assert.equal(card._meta.ui.resourceUri, RESOURCE_CARD_URI);
  assert.equal(card._meta['openai/ui'].preferredModelDisplayMode, 'inline');
  assert.equal(card.inputSchema.properties.paths.minItems, 1);
  assert.equal(card.inputSchema.properties.paths.maxItems, 8);
  assert.equal(card.inputSchema.additionalProperties, false);
  const resource = (await client.readResource({ uri: RESOURCE_CARD_URI })).contents[0];
  assert.equal(resource.text, '<carrier>"workspace":"card"</carrier>');
  assert.deepEqual(resource._meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' });
  assert.equal((await client.readResource({ uri: UI_URI })).contents[0].text, '<carrier>"workspace":"view"</carrier>');
  const result = await client.callTool({ name: RESOURCE_CARD_TOOL, arguments: { paths: [first, second] } });
  assert.deepEqual(result.structuredContent.resources, [
    { path: first, label: 'first.pack.json' }, { path: second, label: 'second.pack.ts' },
  ]);
  assert.deepEqual(calls, []);
  for (const paths of [[], Array(9).fill(first)])
    assert.equal((await client.callTool({ name: RESOURCE_CARD_TOOL, arguments: { paths } })).isError, true);
  assert.equal((await client.callTool({ name: RESOURCE_CARD_TOOL, arguments: { paths: [first], root: '/foreign' } })).isError, true);
});

test('only inline card slots publish native compact height metadata without removing first-open fullscreen', async t => {
  const { root } = await fixture(t);
  const client = await connect(t, root, { route() { assert.fail('Resource metadata must not acquire a backend'); }, close() {} });
  const slots = new Set(RESOURCE_CARD_SLOTS.map(slot => slot.uri));
  const listed = (await client.listResources()).resources;
  const carriers = [];
  for (const resource of listed) {
    const content = (await client.readResource({ uri: resource.uri })).contents[0];
    for (const metadata of [resource._meta, content._meta]) {
      if (slots.has(resource.uri)) {
        assert.equal(metadata['openai/widgetMinFrameHeight'], 0, `${resource.uri} must override the native default minimum`);
        assert.equal(metadata['openai/widgetHeightHint'], 48, `${resource.uri} must start with compact content height`);
        assert.deepEqual(metadata['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' });
      } else {
        assert.equal(metadata?.['openai/widgetMinFrameHeight'], undefined, `${resource.uri} must retain its existing height policy`);
        assert.equal(metadata?.['openai/widgetHeightHint'], undefined, `${resource.uri} must retain its existing height hint`);
      }
    }
    if (slots.has(resource.uri)) carriers.push(content.text);
  }
  assert.equal(carriers.length, 3);
  assert.equal(new Set(carriers).size, 1, 'Static slot height hints do not create another renderer');
});

test('card selection routes exact trusted chat and normal View revalidates its optional source', async t => {
  const { root, first, second } = await fixture(t);
  const routes = [];
  const dispatches = [];
  const client = await connect(t, root, { async route(scope, meta) {
    routes.push({ scope, meta });
    return { service: { async open() { return { url: 'http://127.0.0.1:1/' }; } } };
  }, async invoke(input, meta, options) {
    dispatches.push({ input, meta });
    const result = await options.sourceContext();
    return result.ok ? { ...result, disposition: 'reused' } : result;
  }, close() {} });
  const tools = (await client.listTools()).tools;
  const select = tools.find(tool => tool.name === RESOURCE_ACTION_TOOL);
  assert.ok(select, 'The click must use a separate data tool');
  assert.deepEqual(select._meta.ui, { visibility: ['app'] });
  assert.equal(select._meta['openai/ui'], undefined);
  assert.equal(select.inputSchema.additionalProperties, false);
  assert.deepEqual(select.inputSchema.required, ['path', 'appDocumentId', 'entryScope', 'displayMode']);
  const meta = { threadId: 'independent-card-chat', 'openai/resource': { path: second } };
  const call = (name, arguments_) => client.callTool({ name, arguments: arguments_, _meta: meta });
  const input = { path: first, appDocumentId: randomUUID(), entryScope: 'workspace', displayMode: 'inline' };
  const selected = await call(RESOURCE_ACTION_TOOL, input);
  assert.deepEqual(selected.structuredContent, { ok: true, value: { projectRoot: root, sourcePath: 'assets/first.pack.json' }, disposition: 'reused' });
  assert.deepEqual(dispatches, [{ input: { appDocumentId: input.appDocumentId, entryScope: 'workspace', displayMode: 'inline', reuse: true,
    action: 'source-select', sourcePath: first }, meta }]);
  assert.deepEqual(routes, [], 'The source action uses admitted routing.invoke, without ordinary View opening');
  for (const args of [{}, { path: first, root }, { path: '' }])
    assert.equal((await call(RESOURCE_ACTION_TOOL, args)).isError, true);
  const open = tools.find(tool => tool.name === OPEN_TOOL);
  assert.equal(open.inputSchema.additionalProperties, false);
  assert.equal(open.inputSchema.required?.includes('assetSource') ?? false, false);
  assert.equal(open.inputSchema.properties.assetSource.additionalProperties, false);
  assert.deepEqual(open.inputSchema.properties.assetSource.required, ['path']);
  assert.deepEqual(tools.find(tool => tool.name === GLOBAL_OPEN_TOOL).inputSchema.properties, {});
  for (const args of [{ assetSource: { path: first, root } }, { assetSource: {} }, { assetSource: { path: 'relative.pack.json' } }])
    assert.equal((await call(OPEN_TOOL, args)).isError, true);
  assert.deepEqual(routes, [], 'Invalid input must fail before routing');
  assert.notEqual((await call(OPEN_TOOL, { assetSource: { path: first } })).isError, true);
  assert.deepEqual(routes, [{ scope: 'workspace', meta }]);
  await rm(first);
  assert.equal((await call(RESOURCE_ACTION_TOOL, input)).structuredContent.error.code, 'view-file-unavailable');
  assert.equal((await call(OPEN_TOOL, { assetSource: { path: first } })).structuredContent.error.code, 'view-file-unavailable');
  assert.equal(routes.length, 1, 'The opening tool must revalidate a source removed after selection');
});

test('card canonicalizes, deduplicates and rejects invalid sources without source execution', async t => {
  const { root, first, second } = await fixture(t);
  const alias = join(root, 'alias.pack.json'); await symlink(first, alias);
  assert.deepEqual((await codexResourceCard.prepare({ paths: [alias, first, second] })).structuredContent.resources,
    [{ path: first, label: 'first.pack.json' }, { path: second, label: 'second.pack.ts' }]);
  const directory = join(root, 'directory.pack.json'); await mkdir(directory);
  for (const [path, code] of [['relative.pack.ts', 'view-file-context-missing'],
    [join(root, 'notes.txt'), 'view-file-unsupported'], [join(root, 'missing.pack.ts'), 'view-file-unavailable'],
    [directory, 'view-file-unavailable']]) {
    const result = await codexResourceCard.prepare({ paths: [first, path] });
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, code);
    assert.equal(result.structuredContent.resources, undefined, 'No partial card survives an invalid source');
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(codexResourceCard.prepare({ paths: [first] }, abort.signal), { name: 'AbortError' });
});

test('source activation revalidates explicit path, ignores spoofed file metadata and fences foreign documents', async t => {
  const { root, first, second } = await fixture(t);
  const acquired = [];
  const routing = createCodexRouting({ root: join(root, 'global'), enginePackage: '/test-engine', hostPack: '/test-pack',
    codexContext: { home: root } }, {
    directoryReader: { async read() { return root; }, close() {} },
    retainInstance: async selected => { acquired.push(selected); return { close() {} }; },
    async createClient(binding) { return { root: binding.root }; },
    createPresentation(selected) { return createViewService(selected, { artifactRoot: pathToFileURL(`${root}/`),
      hosting: { async open() { return { url: 'http://127.0.0.1:1/', presentationId: selected.root }; }, close() {} } }); },
  });
  const client = await connect(t, root, routing);
  await client.callTool({ name: RESOURCE_CARD_TOOL, arguments: { paths: [first] } });
  assert.deepEqual(acquired, []);
  const appDocumentId = randomUUID();
  const args = { appDocumentId, entryScope: 'workspace' };
  const meta = { threadId: 'card-chat', 'openai/resource': { path: second } };
  const invoke = (action, extra = {}, hostMeta = meta) => client.callTool({ name: TRANSPORT_TOOL,
    arguments: { ...args, action, ...extra }, _meta: hostMeta });
  assert.equal((await invoke('source-context', { sourcePath: first })).isError, true, 'Source resolution requires an admitted document');
  await invoke('view-document');
  assert.equal(acquired.length, 1);
  const resolved = await invoke('source-context', { sourcePath: first });
  assert.deepEqual(resolved.structuredContent, { ok: true, value: { projectRoot: root, sourcePath: 'assets/first.pack.json' } });
  assert.equal((await invoke('source-context', { sourcePath: first }, { threadId: 'other-chat' })).isError, true);
  assert.equal((await client.callTool({ name: TRANSPORT_TOOL, arguments: { ...args, action: 'source-context',
    sourcePath: first, entryScope: 'global' }, _meta: meta })).isError, true);
  await rm(first);
  const removed = await invoke('source-context', { sourcePath: first });
  assert.equal(removed.structuredContent.error.code, 'view-file-unavailable', 'Click-time resolution must not reuse card admission');
  assert.equal((await invoke('source-context')).structuredContent.error.code, 'view-file-context-missing', 'Host file metadata cannot supply a card source');
  await invoke('app-close');
  assert.equal(acquired.length, 1, 'The card must not acquire global or another chat');
});
