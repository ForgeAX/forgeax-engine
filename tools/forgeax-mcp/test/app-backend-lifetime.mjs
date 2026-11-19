import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectViewWorkspace } from '@forgeax/view';
import { devKitBackendStatus, stopDevKitBackend } from '@forgeax/engine/devkit';
import { BIND_TOOL, OPEN_TOOL } from '../src/contract.ts';
import { assertScenePixels } from './app/acceptance.mjs';

const [pluginArg, projectArg, evidenceArg] = process.argv.slice(2);
if (!evidenceArg) throw new Error('Expected generated plugin, existing game and evidence directory.');
const plugin = resolve(pluginArg), project = await realpath(projectArg), evidence = resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
const temp = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-backend-lifetime-proof-')));
const binding = JSON.parse(await readFile(join(plugin, 'hosting.json'), 'utf8'));
binding.root = join(temp, 'global');
binding.codexContext = { command: join(temp, 'codex'), home: temp };
await writeFile(binding.codexContext.command, `#!${process.execPath}
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
if(m.method==='thread/read')process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId,cwd:${JSON.stringify(project)}}}})+'\\n');});`, { mode: 0o700 });
const hosting = join(temp, 'hosting.json'); await writeFile(hosting, JSON.stringify(binding));
const clients = [], roots = new Set(), records = [], errors = [];
let browser, server, app, workspace, viewUrl, carrier, scene;
const poll = async (read, accept, timeout = 150000) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(done => setTimeout(done, 150)); }
  throw new Error('Backend lifetime boundary timed out.');
};
const meta = { threadId: 'lifetime-chat' };
const connect = async kind => {
  const client = new Client({ name: `lifetime-${kind}`, version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, kind === 'app' ? 'src/codex-app-server.mjs' : 'mcp-stdio.mjs'), hosting],
    env: { TMPDIR: tmpdir(), FORGEAX_DATA_HOME: join(temp, 'data') }, cwd: temp });
  await client.connect(transport); clients.push(client); return { client, transport };
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const businessStatus = client => client.callTool({ name: 'forgeax_view_status', arguments: {}, _meta: meta }).then(r => r.structuredContent);
async function open() {
  const pair = await connect('app'); app = pair.client;
  const entry = (await app.callTool({ name: OPEN_TOOL, arguments: {}, _meta: meta })).structuredContent;
  roots.add(entry.root); viewUrl = entry.url;
  carrier = (await app.readResource({ uri: (await app.listTools()).tools.find(t => t.name === OPEN_TOOL)._meta.ui.resourceUri })).contents[0].text;
  return { ...pair, entry };
}
async function connectWorkspace() {
  const bootstrap = await poll(() => fetch(new URL('/__forgeax/view/bootstrap', viewUrl)).then(r => r.json()), b => !!b.endpoint && !!b.token);
  workspace?.close(); workspace = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'lifetime-proof' });
}
const view = page => page.frameLocator('#app').frameLocator('#view');
async function pageAndScene(stage) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(150000);
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.bringToFront();
  await connectWorkspace();
  const state = await poll(() => workspace.getState(), s => s.projectPhase === 'running');
  assert.equal(state.project.root, project);
  scene = (await workspace.listAssets(state.project.id, { targetId: state.projectTarget.targetId })).assets.find(a => a.kind === 'scene');
  assert.ok(scene);
  const frameElement = view(page).locator('iframe[data-forgeax-project-document]');
  await frameElement.waitFor({ state: 'attached' });
  const projectFrame = await (await frameElement.elementHandle()).contentFrame();
  const shell = projectFrame.parentFrame();
  await shell.evaluate(async guid => {
    const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
    const state = await client.getState(); await client.openAsset(guid, { projectId: state.project.id, targetId: state.projectTarget.targetId, width: 960, height: 540 });
  }, scene.guid);
  await projectFrame.waitForFunction(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60, undefined, { timeout: 150000 });
  await frameElement.waitFor({ state: 'visible' });
  const png = await frameElement.screenshot(); await writeFile(join(evidence, `${stage}.png`), png);
  records.push({ stage, root: state.project.root, target: state.projectTarget, pixels: await assertScenePixels(page, `data:image/png;base64,${png.toString('base64')}`, stage) });
  console.error(`${stage}: 60 completed frames and scene pixels passed`);
  return { page, state };
}
async function stopped(root, pid, urls, stage, since) {
  await poll(async () => ({ status: await devKitBackendStatus(root), alive: alive(pid) }), s => s.status.phase === 'stopped' && !s.alive, 30000);
  for (const url of urls.filter(Boolean)) await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }), `${stage}: project and View HTTP services must close`);
  records.push({ stage, shutdownMs: Math.round(performance.now() - since), pid, root });
  console.error(`${stage}: actual backend PID and HTTP services stopped`);
}
try {
  let first = await open(); const business = await connect('business');
  assert.equal((await businessStatus(business.client)).ok, false, 'read-only status does not start a backend');
  const reference = (await build({ entryPoints: [join(import.meta.dirname, 'app/reference-host.ts')], write: false, bundle: true, format: 'esm', platform: 'browser' })).outputFiles[0].text;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/tool') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const args = JSON.parse(Buffer.concat(chunks));
        const result = await app.callTool({ ...args, _meta: meta }, undefined, { timeout: 120000 });
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/carrier.html') { response.setHeader('content-security-policy', "frame-src 'none'"); response.end(carrier); return; }
      response.end(`<!doctype html><style>html,body{height:100%;margin:0}iframe{width:100%;height:95vh;border:0}</style><button id="light">Light</button><button id="dark">Dark</button><button id="reopen">Reopen</button><button id="restart">Restart</button><button id="close">Close</button><output id="closed"></output><output id="opened"></output><pre id="draft"></pre><iframe id="app" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script type="module">${reference.replaceAll('</script', '<\\/script')}</script>`);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=UseSkiaRenderer,SharedArrayBuffer'], chromiumSandbox: true });
  const initial = await pageAndScene('initial');
  const status = await devKitBackendStatus(first.entry.root); assert.equal(status.phase, 'ready');
  const urls = [viewUrl, initial.state.projectTarget.url];
  // Closing one MCP owner must not stop a shared instance used by business MCP.
  await initial.page.close(); workspace.close(); await first.client.close();
  await new Promise(done => setTimeout(done, 5000));
  assert.ok(alive(status.pid)); assert.equal((await businessStatus(business.client)).ok, true);
  records.push({ stage: 'sibling-retained', pid: status.pid });
  let since = performance.now(); await business.client.close();
  await stopped(first.entry.root, status.pid, urls, 'last-normal-exit', since);
  // Reopening preserves H and the selected game even when its bound working directory is not a game.
  first = await open();
  await app.callTool({ name: BIND_TOOL, arguments: { directory: temp }, _meta: meta });
  const updated = await app.callTool({ name: OPEN_TOOL, arguments: {}, _meta: meta });
  viewUrl = updated.structuredContent.url;
  // Restore the selected game explicitly once, while keeping the non-game cwd.
  const document = '00000000-0000-4000-8000-000000000001';
  await app.callTool({ name: 'forgeax_view_transport', arguments: { action: 'view-document', appDocumentId: document, entryScope: 'workspace' }, _meta: meta });
  await app.callTool({ name: 'forgeax_view_transport', arguments: { action: 'backend-start', appDocumentId: document, entryScope: 'workspace', project }, _meta: meta });
  await connectWorkspace(); await poll(() => workspace.getState(), s => s.project?.root === project);
  const selectedStatus = await devKitBackendStatus(first.entry.root);
  workspace.close(); since = performance.now(); await first.client.close();
  await stopped(first.entry.root, selectedStatus.pid, [], 'selected-game-exit', since);
  const resumed = await open(); assert.equal(resumed.entry.root, first.entry.root);
  const restored = await pageAndScene('reopened-non-game-workspace');
  assert.notEqual(restored.state.projectTarget.targetId, initial.state.projectTarget.targetId);
  // SIGKILL skips all MCP teardown handlers; daemon process liveness owns recovery.
  const current = await devKitBackendStatus(resumed.entry.root);
  await restored.page.close(); workspace.close(); since = performance.now(); process.kill(resumed.transport.pid, 'SIGKILL');
  await stopped(resumed.entry.root, current.pid, [restored.state.projectTarget.url], 'abrupt-owner-exit', since);
  // Killing a starting owner must also recover the daemon before any scene mounts.
  const preparing = await open();
  const startupDocument = '00000000-0000-4000-8000-000000000002';
  await app.callTool({ name: 'forgeax_view_transport', arguments: { action: 'view-document', appDocumentId: startupDocument, entryScope: 'workspace' }, _meta: meta });
  await app.callTool({ name: 'forgeax_view_transport', arguments: { action: 'backend-start', appDocumentId: startupDocument, entryScope: 'workspace' }, _meta: meta });
  const startup = await poll(() => devKitBackendStatus(preparing.entry.root), s => s.phase === 'starting' && !!s.pid && s.pid !== preparing.transport.pid, 10000);
  since = performance.now(); process.kill(preparing.transport.pid, 'SIGKILL');
  await stopped(preparing.entry.root, startup.pid, [], 'startup-owner-exit', since);
  assert.deepEqual(errors, []);
} catch (error) { records.push({ failure: error.stack }); throw error; }
finally {
  workspace?.close(); await browser?.close();
  for (const client of clients) await client.close().catch(() => {});
  if (server) await new Promise(done => server.close(done));
  for (const root of roots) await stopDevKitBackend(root).catch(error => records.push({ cleanupFailure: error.message }));
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ temp, records, errors }, null, 2));
}
