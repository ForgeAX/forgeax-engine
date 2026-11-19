import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { codexThreadId, createCodexDirectoryReader } from '../../src/codex-context.mjs';
import { createCodexRouting } from '../../src/codex-routing.mjs';
import { createViewAppServer } from '../../src/app/mcp-server.mjs';
import { GLOBAL_OPEN_TOOL, GLOBAL_UI_URI, OPEN_TOOL, UI_URI } from '../../src/contract.ts';

test('chat identity rejects conflicting metadata instead of selecting a different chat', () => {
  assert.equal(codexThreadId({ thread_id: 'chat', threadId: 'chat' }), 'chat');
  assert.throws(() => codexThreadId({ threadId: 'a', thread_id: 'b' }), /unambiguous/);
  assert.throws(() => codexThreadId({}), /unambiguous/);
});

test('public directory lookup reads exact thread metadata without resuming or reading history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-codex-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'codex');
  const log = join(root, 'requests.jsonl');
  await writeFile(script, `#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); appendFileSync(${JSON.stringify(log)},line+'\\n');
 if(m.method==='initialize') process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
 if(m.method==='thread/read') process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId,cwd:${JSON.stringify(root)},turns:[]}}})+'\\n');
});`, { mode: 0o700 });
  const reader = createCodexDirectoryReader({ command: script });
  t.after(() => reader.close());
  assert.equal(await reader.read('chat-a'), await realpath(root));
  const messages = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages.map(value => value.method), ['initialize', 'initialized', 'thread/read']);
  assert.deepEqual(messages.at(-1).params, { threadId: 'chat-a', includeTurns: false });
});

test('global, same-directory chats and separate worktrees route requests and cleanup to exact owners', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'forgeax-codex-routes-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const first = join(temp, 'worktree-a'), second = join(temp, 'worktree-b'), alias = join(temp, 'alias');
  await mkdir(first); await mkdir(second); await symlink(first, alias);
  const events = [];
  const directories = { a: first, b: alias, c: second };
  const binding = { root: join(temp, 'global'), enginePackage: '/engine', hostPack: '/host.pack.json', codexContext: { home: temp } };
  const routing = createCodexRouting(binding, {
    retainInstance: async () => ({ close() {} }),
    directoryReader: { async read(id) { return directories[id]; }, close() {} },
    async createClient(selected) { return { root: selected.root, async request(operation) { events.push({ root: selected.root, operation }); return { ok: true, value: selected.root }; } }; },
    createPresentation(client) { return {
      async open() { return { root: client.root, url: 'http://127.0.0.1:1/', presentationId: client.root }; },
      async invoke(input) { events.push({ root: client.root, action: input.action }); return { root: client.root }; },
      close() { events.push({ root: client.root, action: 'close-service' }); },
    }; },
  });
  t.after(() => routing.close());
  const a = await routing.route('workspace', { threadId: 'a' });
  const b = await routing.route('workspace', { threadId: 'b' });
  const c = await routing.route('workspace', { threadId: 'c' });
  const global = await routing.route('global', { threadId: 'a' });
  assert.notEqual(a.root, b.root);
  assert.notEqual(a.root, c.root);
  assert.notEqual(a.root, global.root);
  assert.notEqual(a.root, first);
  const id = randomUUID();
  const invoke = (action, meta = { threadId: 'a' }, entryScope = 'workspace') => routing.invoke({ action, appDocumentId: id, entryScope }, meta);
  assert.deepEqual(await invoke('view-document'), { root: a.root });
  assert.deepEqual(await invoke('source-select'), { root: a.root });
  await assert.rejects(invoke('source-select', { threadId: 'c' }), /another or retiring View entry/);
  await assert.rejects(invoke('source-select', { threadId: 'a' }, 'global'), /another or retiring View entry/);
  const otherId = randomUUID();
  assert.deepEqual(await routing.invoke({ action: 'source-select', appDocumentId: otherId, entryScope: 'workspace' },
    { threadId: 'c' }), { root: c.root }, 'A source card in another chat reaches only its own service');
  await assert.rejects(invoke('http', { threadId: 'c' }), /another View entry/);
  await assert.rejects(invoke('http', { threadId: 'a' }, 'global'), /another View entry/);
  // Host cwd changes do not silently move an established chat binding.
  directories.a = second;
  assert.deepEqual(await invoke('http'), { root: a.root });
  assert.equal((await routing.request('view.status', {}, { threadId: 'a' })).value, a.root);
  assert.deepEqual(await invoke('app-close'), { root: a.root });
  assert.equal(events.filter(value => value.action === 'app-close').length, 1);
  assert.equal(events.some(value => value.root === c.root && value.action === 'app-close'), false);
});

test('global and chat user entries deliver different static carriers and route their opens', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-entry-proof-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'carrier.html'), '<script>__FX_VIEW_ENTRY_SCOPE__</script>');
  const calls = [];
  const app = createViewAppServer({ root: directory }, {
    artifactRoot: new URL(`file://${directory}/`),
    routing: {
      async route(scope) { calls.push(scope); return { service: { async open() { return { root: scope, url: 'http://127.0.0.1:1/' }; } } }; },
      close() {},
    },
    entryMetadata: scope => ({ 'openai/ui': { entrypoints: [{ type: scope === 'global' ? 'global' : 'thread' }] } }),
  });
  const client = new Client({ name: 'entry-proof', version: '1' });
  const [host, child] = InMemoryTransport.createLinkedPair();
  await app.server.connect(host); await client.connect(child);
  t.after(async () => { await client.close(); await app.close(); });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.find(tool => tool.name === OPEN_TOOL)._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  assert.deepEqual(tools.find(tool => tool.name === GLOBAL_OPEN_TOOL)._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
  assert.equal((await client.readResource({ uri: UI_URI })).contents[0].text, '<script>"workspace"</script>');
  assert.equal((await client.readResource({ uri: GLOBAL_UI_URI })).contents[0].text, '<script>"global"</script>');
  await client.callTool({ name: OPEN_TOOL, arguments: {} });
  await client.callTool({ name: GLOBAL_OPEN_TOOL, arguments: {} });
  assert.deepEqual(calls, ['workspace', 'global']);
});
