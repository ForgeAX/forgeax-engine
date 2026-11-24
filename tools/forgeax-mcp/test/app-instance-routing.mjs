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
import { stopDevKitBackend } from '@forgeax/engine/devkit';
import { OPEN_TOOL, GLOBAL_OPEN_TOOL } from '../src/contract.ts';
import { assertScenePixels } from './app/acceptance.mjs';

const [pluginArg, firstArg, secondArg, evidenceArg] = process.argv.slice(2);
if (!pluginArg || !firstArg || !secondArg || !evidenceArg || !process.env.CODEX_THREAD_ID)
  throw new Error('Expected plugin, two projects, evidence and a host-provided CODEX_THREAD_ID.');
const plugin = resolve(pluginArg), evidence = resolve(evidenceArg);
const projects = [resolve(firstArg), resolve(secondArg)];
const temp = await mkdtemp(join(tmpdir(), 'forgeax-instance-proof-'));
await mkdir(evidence, { recursive: true });
const binding = JSON.parse(await readFile(join(plugin, 'hosting.json'), 'utf8'));
binding.root = join(temp, 'global');
await writeFile(join(temp, 'hosting.json'), JSON.stringify(binding));
const client = new Client({ name: 'instance-routing-proof', version: '1' });
const business = new Client({ name: 'instance-business-proof', version: '1' });
const meta = { threadId: process.env.CODEX_THREAD_ID };
const errors = [], records = [], roots = new Set();
let primaryFailure;
let server, browser;
const workspaces = [];
const poll = async (read, accept, timeout = 150000) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('Instance routing browser boundary timed out.');
};
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, 'src/codex-app-server.mjs'), join(temp, 'hosting.json')],
    env: { TMPDIR: tmpdir(), FORGEAX_DATA_HOME: join(temp, 'data') }, cwd: temp }));
  await business.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, 'mcp-stdio.mjs'), join(temp, 'hosting.json')],
    env: { TMPDIR: tmpdir(), FORGEAX_DATA_HOME: join(temp, 'data') }, cwd: temp }));
  const tools = (await client.listTools()).tools;
  const entries = {};
  for (const [scope, name] of [['global', GLOBAL_OPEN_TOOL], ['workspace', OPEN_TOOL]]) {
    const opened = await client.callTool({ name, arguments: {}, _meta: meta });
    assert.equal(opened.isError, undefined, JSON.stringify(opened));
    const tool = tools.find(value => value.name === name);
    const carrier = (await client.readResource({ uri: tool._meta.ui.resourceUri })).contents[0].text;
    entries[scope] = { ...opened.structuredContent, carrier };
    roots.add(opened.structuredContent.root);
    console.error(`${scope}: static open ${opened.structuredContent.root}`);
  }
  assert.notEqual(entries.global.root, entries.workspace.root);
  assert.notEqual(entries.global.url, entries.workspace.url);
  const compiled = await build({ entryPoints: [join(import.meta.dirname, 'app/reference-host.ts')],
    write: false, bundle: true, format: 'esm', platform: 'browser' });
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const scope = url.searchParams.get('scope') ?? 'workspace';
      if (url.pathname === '/tool') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const args = JSON.parse(Buffer.concat(chunks));
        if (args.name === OPEN_TOOL && scope === 'global') args.name = GLOBAL_OPEN_TOOL;
        const result = await client.callTool({ ...args, _meta: meta }, undefined, { timeout: 30000 });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (url.pathname === '/carrier.html') {
        response.setHeader('content-security-policy', "frame-src 'none'");
        response.end(entries[scope].carrier);
        return;
      }
      const source = compiled.outputFiles[0].text.replaceAll('"/tool"', `"/tool?scope=${scope}"`)
        .replaceAll('"/carrier.html"', `"/carrier.html?scope=${scope}"`).replaceAll('</script', '<\\/script');
      response.end(`<!doctype html><style>html,body{margin:0;height:100%}iframe{width:100%;height:95vh;border:0}</style><header>${scope}<button id="light">Light</button><button id="dark">Dark</button><button id="reopen">Reopen</button><button id="restart">Restart</button><button id="close">Close</button><output id="closed"></output></header><output id="opened"></output><pre id="draft"></pre><iframe id="app" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script type="module">${source}</script>`);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=UseSkiaRenderer,SharedArrayBuffer'], chromiumSandbox: true });
  const pages = {};
  for (const scope of ['global', 'workspace']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.setDefaultTimeout(150000);
    await page.goto(`http://127.0.0.1:${server.address().port}/?scope=${scope}`);
    pages[scope] = page;
    console.error(`${scope}: reference page opened`);
    const b = await poll(() => fetch(new URL('/__forgeax/view/bootstrap', entries[scope].url)).then(r => r.json()), b => !!b.endpoint && !!b.token);
    const workspace = await connectViewWorkspace({ endpoint: b.endpoint, token: b.token, clientId: `instance-proof-${scope}` });
    workspaces.push(workspace); entries[scope].workspace = workspace;
    console.error(`${scope}: backend connected`);
  }
  const view = scope => pages[scope].frameLocator('#app').frameLocator('#view');
  const select = async (scope, project) => {
    const started = performance.now();
    console.error(`${scope}: selecting ${project}`);
    await pages[scope].bringToFront();
    const state = await entries[scope].workspace.getState();
    if (state.project) await view(scope).getByRole('button', { name: new RegExp(`${state.project.name}.*(?:Running|运行中)`) }).click();
    await view(scope).getByPlaceholder(/项目目录的绝对路径|Absolute project directory/).fill(project);
    await view(scope).getByRole('button', { name: /^(下一步|Next)$/ }).click();
    await poll(() => entries[scope].workspace.getState(), state => {
      if (state.projectFailure) throw new Error(JSON.stringify(state.projectFailure));
      return state.project?.root === project && state.projectPhase === 'running';
    });
    records.push({ stage: 'project-ready', scope, project, ms: Math.round(performance.now() - started) });
    console.error(`${scope}: project ready ${project}`);
  };
  await select('global', projects[0]);
  await select('workspace', projects[1]);
  await select('global', projects[1]);
  await select('global', projects[0]);
  assert.equal((await entries.workspace.workspace.getState()).project.root, projects[1]);
  const status = (await business.callTool({ name: 'forgeax_view_status', arguments: {}, _meta: meta })).structuredContent;
  assert.equal(status.value.root, entries.workspace.root);
  assert.equal(status.value.project.root, projects[1]);
  records.push({ stage: 'global-switch-isolated', globalRoot: entries.global.root, workspaceRoot: entries.workspace.root, business: status });
  for (const scope of ['global', 'workspace']) {
    await pages[scope].bringToFront();
    const workspace = entries[scope].workspace;
    const state = await workspace.getState();
    const scene = (await workspace.listAssets(state.project.id, { targetId: state.projectTarget.targetId })).assets.find(asset => asset.kind === 'scene');
    assert.ok(scene);
    await workspace.openAsset(scene.guid, { projectId: state.project.id, targetId: state.projectTarget.targetId, width: 960, height: 540 });
    const preview = view(scope).locator('iframe[data-forgeax-project-document]');
    await preview.waitFor({ state: 'visible' });
    const frame = await (await preview.elementHandle()).contentFrame();
    await frame.waitForFunction(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60);
    const png = await preview.screenshot();
    records.push({ stage: `${scope}-60-frames`, pixels: await assertScenePixels(pages[scope], `data:image/png;base64,${png.toString('base64')}`, scope) });
    await writeFile(join(evidence, `${scope}.png`), png);
  }
  await pages.global.getByRole('button', { name: 'Close', exact: true }).click();
  await poll(() => entries.global.workspace.listPages(), state => state.pages.length === 0);
  assert.equal((await entries.workspace.workspace.getSummary()).project.root, projects[1]);
  assert.equal((await entries.workspace.workspace.listPages()).pages.length, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, roots: [...roots], boundary: 'Packaged MCP, public Codex metadata lookup and real browser pixels; native clicks remain separate acceptance' }));
} catch (error) {
  primaryFailure = String(error);
  console.error(primaryFailure);
  for (const page of browser?.contexts().flatMap(context => context.pages()) ?? []) {
    for (const frame of page.frames()) records.push({ failedDocument: frame.url().split('?')[0], body: await frame.locator('body').innerText().catch(() => '?') });
    await page.screenshot({ path: join(evidence, `failure-${records.length}.png`) }).catch(() => {});
  }
  throw error;
} finally {
  workspaces.forEach(workspace => workspace.close());
  await browser?.close(); await client.close(); await business.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  // The workspace root was created by this probe before native plugin activation.
  for (const root of roots) await stopDevKitBackend(root).catch(error => records.push({ cleanup: String(error), root }));
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ roots: [...roots], errors, primaryFailure, records }, null, 2));
  await rm(temp, { recursive: true, force: true });
}
