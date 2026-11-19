import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectViewWorkspace } from '@forgeax/view';
import { stopDevKitBackend } from '@forgeax/engine/devkit';
import { assertScenePixels } from './app/acceptance.mjs';

const engine = resolve(import.meta.dirname, '../../..');
const [projectArg, evidenceArg] = process.argv.slice(2);
const resumeOnly = process.argv.includes('--resume-only');
if (!projectArg || !evidenceArg) throw new Error('Expected an existing game and an evidence directory');
const project = resolve(projectArg), evidence = resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
const temp = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-app-reopen-')));
const previousDataHome = process.env.FORGEAX_DATA_HOME;
process.env.FORGEAX_DATA_HOME = join(temp, 'data');
const root = join(temp, 'backend'), marketplace = join(temp, 'marketplace');
const execute = promisify(execFile);
const records = [], errors = [], timings = {};
let app, browser, server, workspace, page, plugin, viewUrl, carrier, sceneAsset;
const poll = async (read, accept, timeout = 150000) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out awaiting the actual App lifecycle boundary');
};
async function connectApp() {
  app = new Client({ name: 'app-reopen-proof', version: '1' });
  await app.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, 'src/codex-app-server.mjs'), join(plugin, 'hosting.json')], cwd: temp, env: { TMPDIR: tmpdir(), FORGEAX_DATA_HOME: process.env.FORGEAX_DATA_HOME } }));
  const opened = await app.callTool({ name: 'forgeax_view_start', arguments: {} });
  viewUrl = opened.structuredContent.url;
  const tool = (await app.listTools()).tools.find(tool => tool.name === 'forgeax_view_start');
  carrier = (await app.readResource({ uri: tool._meta.ui.resourceUri })).contents[0].text;
}
async function connectWorkspace() {
  const bootstrap = await poll(() => fetch(new URL('/__forgeax/view/bootstrap', viewUrl)).then(r => r.json()), b => !!b.endpoint && !!b.token);
  workspace?.close();
  workspace = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'app-reopen-proof' });
}
const viewOf = page => page.frameLocator('#app').frameLocator('#view');
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') { records.push({ consoleError: message.text() }); console.error(message.text()); } });
  page.setDefaultTimeout(150000);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.bringToFront();
  return page;
}
async function assertRendered(page, stage) {
  const started = performance.now();
  const preview = viewOf(page).locator('iframe[data-forgeax-project-document]');
  console.error(`${stage}: waiting for project frame`);
  try { await preview.waitFor({ state: 'attached', timeout: 45000 }); }
  catch (error) {
    console.error(JSON.stringify({ stage, frames: await preview.count(), summary: await workspace.getSummary(), body: await viewOf(page).locator('body').innerText() }));
    await page.screenshot({ path: join(evidence, `${stage}-failed.png`) });
    for (const frame of page.frames()) console.error(JSON.stringify({ document: frame.url().split('?')[0], body: await frame.locator('body').innerText().catch(() => '?') }));
    throw error;
  }
  const frame = await (await preview.elementHandle()).contentFrame();
  assert.ok(frame);
  if (stage === 'mcp-restart') {
    await viewOf(page).getByText(/^(内容浏览器|Content Browser)$/).click();
    const search = viewOf(page).getByPlaceholder(/搜索资产|Search assets/);
    await search.waitFor({ timeout: 15000 });
    const path = sceneAsset.sourcePath ?? sceneAsset.path;
    const directory = path.slice(0, path.lastIndexOf('/')).split('/').at(-1);
    await viewOf(page).locator('.cb-source-row').filter({ hasText: new RegExp(`^${directory}$`) }).click({ timeout: 15000 });
    await search.fill(sceneAsset.name ?? sceneAsset.sourceKey);
    await viewOf(page).locator(`[data-cb-guid="${sceneAsset.guid}"]`).dblclick({ timeout: 15000 });
    console.error(`${stage}: opened scene through Content Browser`);
  } else if (stage !== 'first') {
    await poll(() => workspace.getSummary(), state => state.projectPhase === 'running');
    const shell = frame.parentFrame();
    const result = await shell.evaluate(async guid => {
      const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
      const state = await client.getState();
      await client.openAsset(guid, { projectId: state.project.id, targetId: state.projectTarget.targetId, width: 960, height: 540 });
      return { role: state.projectDocumentPresentation, browserGeneration: state.browserGeneration };
    }, sceneAsset.guid);
    console.error(`${stage}: scene open ${JSON.stringify(result)}`);
  }
  await preview.waitFor({ state: 'visible' });
  await frame.waitForFunction(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60, undefined, { timeout: 150000 });
  assert.equal(await preview.getAttribute('src'), null, 'the App keeps isolated srcdoc delivery');
  const summary = await workspace.getSummary();
  assert.equal(summary.project.root, project);
  assert.equal(summary.projectPhase, 'running');
  const png = await preview.screenshot();
  const pixels = await assertScenePixels(page, `data:image/png;base64,${png.toString('base64')}`, stage);
  await writeFile(join(evidence, `${stage}.png`), png);
  timings[`${stage}RenderMs`] = Math.round(performance.now() - started);
  records.push({ stage, summary, pixels, pages: await workspace.listPages() });
  console.error(`${stage}: 60 completed frames and visible pixels passed`);
  return summary;
}
try {
  await execute(process.execPath, [join(engine, 'tools/forgeax-mcp/codex/create-local-plugin.mjs'), engine, marketplace, '--root', root]);
  plugin = join(marketplace, 'plugins/forgeax-view-codex');
  await connectApp();
  const compiled = await build({ entryPoints: [join(import.meta.dirname, 'app/reference-host.ts')], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const html = `<!doctype html><style>html,body{height:100%;margin:0}iframe{width:100%;height:95vh;border:0}</style><header><button id="light">Light</button><button id="dark">Dark</button><button id="reopen">Reopen View</button><button id="restart">Restart</button><button id="close">Close App</button><output id="closed"></output></header><output id="opened"></output><pre id="draft"></pre><iframe id="app" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script type="module">${compiled.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/tool' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks));
        const result = await app.callTool(params, undefined, { timeout: 30000 });
        if (result.isError) records.push({ failedAction: params.arguments?.action, result });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/carrier.html') response.setHeader('content-security-policy', "frame-src 'none'");
      response.end(request.url === '/carrier.html' ? carrier : html);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=UseSkiaRenderer,SharedArrayBuffer'], chromiumSandbox: true });
  page = await openPage();
  const view = viewOf(page);
  await view.getByRole('button', { name: /^(下一步|Next)$/ }).waitFor();
  await connectWorkspace();
  await view.getByPlaceholder(/项目目录的绝对路径|Absolute project directory/).fill(project);
  await view.getByRole('button', { name: /^(下一步|Next)$/ }).click();
  const ready = await poll(() => workspace.getState(), state => {
    if (state.projectFailure) throw new Error(JSON.stringify(state.projectFailure));
    return state.projectPhase === 'running';
  });
  const assets = (await workspace.listAssets(ready.project.id, { targetId: ready.projectTarget.targetId })).assets;
  const scene = assets.find(asset => asset.kind === 'scene');
  assert.ok(scene);
  sceneAsset = scene;
  await workspace.openAsset(scene.guid, { projectId: ready.project.id, targetId: ready.projectTarget.targetId, width: 960, height: 540 });
  const initial = await assertRendered(page, 'first');

  if (!resumeOnly) {
  const second = await openPage();
  await assertRendered(second, 'second-while-first-live');
  await view.locator('iframe[data-forgeax-project-document]').waitFor({ state: 'detached' });
  await page.close();
  page = second;
  await poll(() => workspace.listPages(), result => result.pages.length === 1, 45000);

  await page.reload();
  await assertRendered(page, 'document-reload');
  await poll(() => workspace.listPages(), result => result.pages.length === 1, 45000);

  // Destruction without an App teardown handshake exercises Node reader expiry.
  await page.close();
  page = await openPage();
  await assertRendered(page, 'abrupt-close-reopen');
  await poll(() => workspace.listPages(), result => result.pages.length === 1, 45000);
  }

  await page.getByRole('button', { name: 'Close App', exact: true }).click();
  await page.getByText('closed', { exact: true }).waitFor();
  await poll(() => workspace.listPages(), result => result.pages.length === 0, 5000);
  await page.close();

  // Codex restart replaces MCP while deliberately retaining the project backend.
  await app.close();
  await connectApp();
  page = await openPage();
  await connectWorkspace();
  const resumed = await assertRendered(page, 'mcp-restart');
  assert.equal(resumed.targets.find(t => t.role === 'project').targetId, initial.targets.find(t => t.role === 'project').targetId);
  assert.ok(resumed.browserGeneration > initial.browserGeneration);
  const shell = await (await viewOf(page).owner().elementHandle()).contentFrame();
  const state = await workspace.getState();
  const resumedAssets = (await workspace.listAssets(state.project.id, { targetId: state.projectTarget.targetId })).assets;
  for (const kind of ['mesh', 'material']) {
    const asset = resumedAssets.find(asset => asset.kind === kind && asset.sourceKey === `${kind}/${kind === 'mesh' ? 'cube' : 'default'}`);
    assert.ok(asset, `${kind} fixture is published`);
    await shell.evaluate(async guid => {
      const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
      const state = await client.getState();
      await client.openAsset(guid, { projectId: state.project.id, width: 960, height: 540 });
    }, asset.guid);
    const preview = viewOf(page).locator('iframe[data-forgeax-project-document]');
    await preview.waitFor({ state: 'visible' });
    await poll(() => shell.evaluate(() => document.documentElement.dataset.forgeaxViewActivePage), value => value === kind);
    const document = await (await preview.elementHandle()).contentFrame();
    await document.locator('[data-forgeax-document-preview] canvas').waitFor();
    await document.waitForFunction(() => (document.querySelector('[data-forgeax-document-preview] canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60, undefined, { timeout: 150000 });
    const png = await preview.screenshot();
    records.push({ stage: `${kind}-after-restart`, pixels: await assertScenePixels(page, `data:image/png;base64,${png.toString('base64')}`, kind) });
    await writeFile(join(evidence, `${kind}-after-restart.png`), png);
  }
  await shell.evaluate(async guid => {
    const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
    const state = await client.getState();
    await client.openAsset(guid, { projectId: state.project.id });
  }, sceneAsset.guid);
  const playStarted = performance.now();
  await viewOf(page).getByRole('button', { name: 'Play', exact: true }).click();
  const play = viewOf(page).locator('iframe[data-forgeax-scene-play]');
  await play.waitFor({ state: 'attached' });
  const playFrame = await (await play.elementHandle()).contentFrame();
  await playFrame.waitForFunction(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60, undefined, { timeout: 150000 });
  await play.waitFor({ state: 'visible' });
  timings.playAfterRestartMs = Math.round(performance.now() - playStarted);
  const playPng = await play.screenshot();
  records.push({ stage: 'play-after-restart', pixels: await assertScenePixels(page, `data:image/png;base64,${playPng.toString('base64')}`, 'Play') });
  await writeFile(join(evidence, 'play-after-restart.png'), playPng);
  await viewOf(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await play.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  assert.deepEqual(records.filter(record => record.consoleError), []);
  console.log(JSON.stringify({ passed: true, timings, root, boundary: 'Packaged stdio MCP, restrictive App bridges and actual Chrome GPU; native Codex restart remains a separate acceptance' }));
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  for (const frame of page?.frames() ?? []) records.push({ failureDocument: frame.url().split('?')[0], body: await frame.locator('body').innerText().catch(() => '?') });
  throw error;
} finally {
  workspace?.close();
  await browser?.close();
  await app?.close();
  await stopDevKitBackend(root).catch(error => records.push({ cleanup: String(error) }));
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ root, timings, errors, records }, null, 2));
  await rm(temp, { recursive: true, force: true });
  if (previousDataHome === undefined) delete process.env.FORGEAX_DATA_HOME;
  else process.env.FORGEAX_DATA_HOME = previousDataHome;
}
