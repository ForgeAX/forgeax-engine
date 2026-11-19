import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectViewWorkspace } from '@forgeax/view';
import { devKitBackendStatus, stopDevKitBackend } from '@forgeax/engine/devkit';
import { BIND_TOOL, GLOBAL_OPEN_TOOL, OPEN_TOOL } from '../src/contract.ts';
import { assertScenePixels } from './app/acceptance.mjs';

const [pluginArg, sourceArg, destinationArg, evidenceArg] = process.argv.slice(2);
if (!evidenceArg) throw new Error('Expected generated plugin, source project, worktree project and evidence directory.');
const plugin = resolve(pluginArg), source = resolve(sourceArg), destination = resolve(destinationArg), evidence = resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'forgeax-chat-binding-'));
const binding = JSON.parse(await readFile(join(plugin, 'hosting.json'), 'utf8'));
binding.root = join(temp, 'global');
binding.codexContext = { command: join(temp, 'codex'), home: temp };
// Only the host metadata provider is simulated. Both projects, backends and pixels are real.
await writeFile(binding.codexContext.command, `#!${process.execPath}
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
if(m.method==='thread/read')process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId,cwd:${JSON.stringify(source)}}}})+'\\n');});`, { mode: 0o700 });
await writeFile(join(temp, 'hosting.json'), JSON.stringify(binding));
const clients = [], workspaces = [], roots = new Set(), errors = [], records = [];
let browser, server, failure;
const connect = async kind => {
  const client = new Client({ name: `binding-${kind}`, version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, kind === 'app' ? 'src/codex-app-server.mjs' : 'mcp-stdio.mjs'), join(temp, 'hosting.json')],
    env: { TMPDIR: tmpdir(), FORGEAX_DATA_HOME: join(temp, 'data') }, cwd: temp }));
  clients.push(client); return client;
};
const poll = async (read, accept, timeout = 150000) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(done => setTimeout(done, 150)); }
  throw new Error('Chat binding browser boundary timed out.');
};
try {
  const app = await connect('app'); let business = await connect('business');
  const meta = threadId => ({ threadId });
  const open = async (scope, thread = 'chat-a') => (await app.callTool({ name: scope === 'global' ? GLOBAL_OPEN_TOOL : OPEN_TOOL, arguments: {}, _meta: meta(thread) })).structuredContent;
  const entries = { workspace: await open('workspace'), global: await open('global'), chatb: await open('workspace', 'chat-b') };
  assert.notEqual(entries.workspace.root, entries.chatb.root);
  for (const entry of Object.values(entries)) roots.add(entry.root);
  const tools = (await app.listTools()).tools;
  const carriers = {};
  for (const scope of ['workspace', 'global']) carriers[scope] = (await app.readResource({ uri: tools.find(t => t.name === (scope === 'global' ? GLOBAL_OPEN_TOOL : OPEN_TOOL))._meta.ui.resourceUri })).contents[0].text;
  carriers.chatb = carriers.workspace;
  const reference = (await build({ entryPoints: [join(import.meta.dirname, 'app/reference-host.ts')], write: false, bundle: true, format: 'esm', platform: 'browser' })).outputFiles[0].text;
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'), scope = url.searchParams.get('scope') ?? 'workspace';
      if (url.pathname === '/tool') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const args = JSON.parse(Buffer.concat(chunks));
        if (scope === 'global' && args.name === OPEN_TOOL) args.name = GLOBAL_OPEN_TOOL;
        const result = await app.callTool({ ...args, _meta: meta(scope === 'global' ? 'global' : scope === 'chatb' ? 'chat-b' : 'chat-a') }, undefined, { timeout: 120000 });
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); return;
      }
      response.setHeader('content-type', 'text/html');
      if (url.pathname === '/carrier.html') { response.setHeader('content-security-policy', "frame-src 'none'"); response.end(carriers[scope]); return; }
      const script = reference.replaceAll('"/tool"', `"/tool?scope=${scope}"`).replaceAll('"/carrier.html"', `"/carrier.html?scope=${scope}"`).replaceAll('</script', '<\\/script');
      response.end(`<!doctype html><style>html,body{height:100%;margin:0}iframe{width:100%;height:95vh;border:0}</style><header>${scope}<button id="light">Light</button><button id="dark">Dark</button><button id="reopen">Reopen</button><button id="restart">Restart</button><button id="close">Close</button><output id="closed"></output></header><output id="opened"></output><pre id="draft"></pre><iframe id="app" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script type="module">${script}</script>`);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=UseSkiaRenderer,SharedArrayBuffer'], chromiumSandbox: true });
  const pages = {};
  const workspace = async entry => {
    const bootstrap = await poll(() => fetch(new URL('/__forgeax/view/bootstrap', entry.url)).then(r => r.json()), b => !!b.endpoint && !!b.token);
    const value = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'binding-proof' }); workspaces.push(value); return value;
  };
  const view = scope => pages[scope].frameLocator('#app').frameLocator('#view');
  for (const scope of ['workspace', 'global', 'chatb']) {
    pages[scope] = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    pages[scope].setDefaultTimeout(150000);
    pages[scope].on('pageerror', error => errors.push(error.message));
    pages[scope].on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await pages[scope].goto(`http://127.0.0.1:${server.address().port}/?scope=${scope}`);
    entries[scope].workspace = await workspace(entries[scope]);
  }
  await pages.global.bringToFront();
  await view('global').getByPlaceholder(/项目目录的绝对路径|Absolute project directory/).fill(source);
  await view('global').getByRole('button', { name: /^(下一步|Next)$/ }).click();
  for (const scope of ['workspace', 'global', 'chatb']) await poll(() => entries[scope].workspace.getSummary(), s => s.project?.root === source && s.projectPhase === 'running');
  const oldState = await entries.workspace.workspace.getSummary();
  const showScene = async (scope, connection, name) => {
    await pages[scope].bringToFront();
    const state = await poll(() => connection.getState(), s => s.projectPhase === 'running');
    const scene = (await connection.listAssets(state.project.id, { targetId: state.projectTarget.targetId })).assets.find(a => a.kind === 'scene');
    assert.ok(scene);
    await connection.openAsset(scene.guid, { projectId: state.project.id, targetId: state.projectTarget.targetId, width: 960, height: 540 });
    const preview = view(scope).locator('iframe[data-forgeax-project-document]'); await preview.waitFor({ state: 'visible' });
    const frame = await (await preview.elementHandle()).contentFrame();
    await frame.waitForFunction(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60);
    const png = await preview.screenshot(); records.push({ stage: name, pixels: await assertScenePixels(pages[scope], `data:image/png;base64,${png.toString('base64')}`, name) });
    await writeFile(join(evidence, `${name}.png`), png);
  };
  await showScene('workspace', entries.workspace.workspace, 'before');
  await showScene('chatb', entries.chatb.workspace, 'other-chat-before');
  const started = performance.now();
  const changed = (await app.callTool({ name: BIND_TOOL, arguments: { directory: destination }, _meta: meta('chat-a') }, undefined, { timeout: 120000 })).structuredContent;
  assert.equal(changed.ok, true, JSON.stringify(changed)); roots.add(changed.value.root);
  assert.equal(changed.value.root, entries.workspace.root);
  records.push({ stage: 'binding-api', ms: Math.round(performance.now() - started), revision: changed.value.revision });
  entries.workspace.workspace.close();
  const migrated = await open('workspace'); assert.equal(migrated.root, changed.value.root);
  const next = await workspace(migrated);
  await poll(() => next.getSummary(), s => s.project?.root === destination && s.projectPhase === 'running');
  await showScene('workspace', next, 'after');
  records.push({ stage: 'migration-visible', ms: Math.round(performance.now() - started), result: changed });
  assert.equal((await entries.global.workspace.getSummary()).project.root, source);
  const status = async thread => (await business.callTool({ name: 'forgeax_view_status', arguments: {}, _meta: meta(thread) })).structuredContent;
  assert.equal((await status('chat-a')).value.root, changed.value.root);
  assert.equal((await status('chat-b')).value.root, entries.chatb.root);
  assert.equal((await entries.chatb.workspace.getSummary()).project.root, source);
  await showScene('chatb', entries.chatb.workspace, 'other-chat-after');
  assert.equal((await devKitBackendStatus(entries.workspace.root)).phase, 'ready');
  const stale = (await business.callTool({ name: 'forgeax_engine_scene_tree_get', arguments: { targetId: oldState.targets[0].targetId, targetGeneration: oldState.targets[0].generation ?? 1 }, _meta: meta('chat-a') })).structuredContent;
  assert.equal(stale.ok, false); records.push({ stage: 'old-target-rejected', code: stale.error.code });
  const foreign = (await business.callTool({ name: 'forgeax_engine_scene_tree_get', arguments: { targetId: (await entries.chatb.workspace.getSummary()).targets[0].targetId, targetGeneration: 1 }, _meta: meta('chat-a') })).structuredContent;
  assert.equal(foreign.ok, false); records.push({ stage: 'other-chat-target-rejected', code: foreign.error.code });
  await business.close(); business = await connect('business');
  assert.equal((await status('chat-a')).value.root, changed.value.root);
  await pages.workspace.reload();
  await pages.workspace.bringToFront();
  await view('workspace').getByRole('button', { name: /Pack authoring.*running/ }).waitFor({ state: 'visible' });
  await poll(() => next.listPages(), value => value.pages.length === 1);
  await showScene('workspace', next, 'reopened');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, boundary: 'Real packaged MCP, live browser per-chat isolation, binding/reopen and 60-frame pixels; simulated host chat cwd' }));
} catch (error) {
  failure = String(error);
  for (const page of browser?.contexts().flatMap(c => c.pages()) ?? []) {
    for (const frame of page.frames()) records.push({ document: frame.url().split('?')[0], body: await frame.locator('body').innerText().catch(() => '?') });
    await page.screenshot({ path: join(evidence, `failure-${records.length}.png`) }).catch(() => {});
  }
  throw error;
} finally {
  workspaces.forEach(w => w.close()); await browser?.close(); await Promise.allSettled(clients.map(c => c.close()));
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  for (const root of roots) await stopDevKitBackend(root).catch(error => records.push({ cleanup: String(error) }));
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ failure, errors, roots: [...roots], records }, null, 2));
  await rm(temp, { recursive: true, force: true });
}
