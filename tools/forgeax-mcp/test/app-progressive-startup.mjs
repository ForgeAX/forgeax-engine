import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stopDevKitBackend } from '@forgeax/engine/devkit';
import { connectViewWorkspace } from '@forgeax/view';
import { assertScenePixels } from './app/acceptance.mjs';

const engine = resolve(import.meta.dirname, '../../..');
const [firstArg, secondArg, evidenceArg] = process.argv.slice(2);
if (!firstArg || !secondArg || !evidenceArg) throw new Error('Expected two existing projects and an evidence directory');
const projects = [resolve(firstArg), resolve(secondArg)];
const evidence = resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'forgeax-codex-progressive-'));
const previousDataHome = process.env.FORGEAX_DATA_HOME;
process.env.FORGEAX_DATA_HOME = join(temp, 'data');
let root = join(temp, 'backend');
const marketplace = join(temp, 'marketplace');
const execute = promisify(execFile);
const app = new Client({ name: 'progressive-app-proof', version: '1' });
const business = new Client({ name: 'progressive-business-proof', version: '1' });
const records = [], errors = [], consoleErrors = [], timings = {};
let browser, page, server, workspace, releaseStartup;
let startupReleased = false, expectedOffline = false;
const holdStartup = new Promise(resolve => { releaseStartup = resolve; });
async function poll(read, accept, timeout = 150000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out awaiting the real progressive App boundary');
}
async function bindWorkspace(url) {
  const bootstrap = await poll(() => fetch(new URL('/__forgeax/view/bootstrap', url)).then(r => r.json()), b => !!b.endpoint && !!b.token);
  workspace?.close();
  workspace = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'codex-progressive-proof' });
}
try {
  const generated = await execute(process.execPath, [join(engine, 'tools/forgeax-mcp/codex/create-local-plugin.mjs'), engine, marketplace, '--root', root]);
  root = JSON.parse(generated.stdout).root;
  const plugin = join(marketplace, 'plugins/forgeax-view-codex');
  const binding = join(plugin, 'hosting.json');
  const initialized = performance.now();
  await app.connect(new StdioClientTransport({ command: process.execPath, args: [join(plugin, 'src/codex-app-server.mjs'), binding], cwd: temp, env: { TMPDIR: tmpdir(), FORGEAX_DATA_HOME: process.env.FORGEAX_DATA_HOME } }));
  await business.connect(new StdioClientTransport({ command: process.execPath, args: [join(plugin, 'mcp-stdio.mjs'), binding], cwd: temp, env: { TMPDIR: tmpdir(), FORGEAX_DATA_HOME: process.env.FORGEAX_DATA_HOME } }));
  timings.mcpInitializationMs = Math.round(performance.now() - initialized);
  const offline = (await business.callTool({ name: 'forgeax_view_status', arguments: {} })).structuredContent;
  assert.equal(offline.error.code, 'backend-not-ready');
  const openedAt = performance.now();
  const opened = await app.callTool({ name: 'forgeax_view_start', arguments: {} });
  timings.openStaticPresentationMs = Math.round(performance.now() - openedAt);
  const viewUrl = opened.structuredContent.url;
  const tool = (await app.listTools()).tools.find(t => t.name === 'forgeax_view_start');
  assert.deepEqual(tool._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  const carrier = (await app.readResource({ uri: tool._meta.ui.resourceUri })).contents[0].text;
  const compiled = await build({ entryPoints: [join(import.meta.dirname, 'app/reference-host.ts')], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const html = `<!doctype html><style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}iframe{flex:1;width:100%;border:0;min-height:0}</style><header>Browser MCP reference host <button id="light">Light</button><button id="dark">Dark</button><button id="reopen">Reopen View</button><button id="restart">Restart backend</button><button id="close">Close App</button><output id="closed"></output></header><output id="opened"></output><pre id="draft"></pre><iframe id="app" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script type="module">${compiled.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/tool' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks));
        if (params.arguments.action === 'backend-start') await holdStartup;
        const started = performance.now();
        const value = await app.callTool(params, undefined, { timeout: 30000 });
        if (params.arguments.action !== 'host-read') records.push({ action: params.arguments.action ?? params.name, ms: Math.round(performance.now() - started), failed: !!value.isError });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(value));
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/carrier.html') response.setHeader('content-security-policy', "frame-src 'none'");
      response.end(request.url === '/carrier.html' ? carrier : html);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=UseSkiaRenderer,SharedArrayBuffer'], chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(150000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') { records.push({ consoleError: message.text(), expectedOffline }); if (!expectedOffline) consoleErrors.push(message.text()); }
  });
  const clickAt = performance.now();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const view = page.frameLocator('#app').frameLocator('#view');
  await view.locator('#root').filter({ hasText: /.+/ }).waitFor({ state: 'visible' });
  timings.staticShellVisibleMs = Math.round(performance.now() - clickAt);
  assert.equal(startupReleased, false);
  assert.equal((await business.callTool({ name: 'forgeax_view_status', arguments: {} })).structuredContent.error.code, 'backend-not-ready');
  assert.equal(await view.owner().getAttribute('src'), null);
  await page.screenshot({ path: join(evidence, 'static-before-backend.png') });
  console.error('Static Shell visible while backend remains stopped', timings.staticShellVisibleMs);
  const backendAt = performance.now();
  startupReleased = true; releaseStartup();
  await bindWorkspace(viewUrl);
  await view.getByRole('button', { name: /^(下一步|Next)$/ }).waitFor();
  timings.backendAndChooserReadyMs = Math.round(performance.now() - backendAt);
  assert.equal((await workspace.getState()).project, null);
  console.error('Backend connected; unbound chooser ready', timings.backendAndChooserReadyMs);
  let initialViewFrame;
  for (let index = 0; index < projects.length; index++) {
    const projectAt = performance.now();
    if (index) await view.getByRole('button', { name: /empty3d.*(?:Running|运行中)/ }).click();
    await view.getByPlaceholder(/项目目录的绝对路径|Absolute project directory/).fill(projects[index]);
    await view.getByRole('button', { name: /^(下一步|Next)$/ }).click();
    const ready = await poll(() => workspace.getState(), state => { if (state.projectFailure) throw new Error(JSON.stringify(state.projectFailure)); return state.projectPhase === 'running' && state.project?.root === projects[index]; });
    const projectId = ready.project.id;
    timings[`project${index + 1}ServerReadyMs`] = Math.round(performance.now() - projectAt);
    console.error(`Project ${index + 1}: project server ready`, timings[`project${index + 1}ServerReadyMs`]);
    const assets = (await workspace.listAssets(projectId, { targetId: ready.projectTarget.targetId })).assets;
    const scene = assets.find(asset => asset.kind === 'scene');
    assert.ok(scene, 'A real authored scene must be published');
    await workspace.openAsset(scene.guid, { projectId, targetId: ready.projectTarget.targetId, width: 960, height: 540 });
    const sceneState = await poll(() => workspace.getState(), state => !!state.scenePreview?.target?.worldId);
    const target = sceneState.scenePreview.target;
    const preview = view.locator(`iframe[data-forgeax-project-document="${target.targetId}"]`);
    const frame = await (await preview.elementHandle()).contentFrame();
    assert.ok(frame);
    await frame.waitForFunction(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60, undefined, { timeout: 150000 });
    assert.equal(await preview.getAttribute('src'), null);
    console.error(`Project ${index + 1}: completed scene frames`);
    const tree = await workspace.getSceneTree({ targetId: target.targetId, targetGeneration: target.generation });
    assert.ok(tree.nodes.some(node => /cube/i.test(node.name)));
    const capture = await workspace.call('preview.capture', { targetId: target.targetId, targetGeneration: target.generation });
    records.push({ projectId, pixels: await assertScenePixels(page, capture.png, `Project ${index + 1} scene`) });
    await writeFile(join(evidence, `project-${index + 1}.png`), Buffer.from(capture.png.split(',')[1], 'base64'));
    timings[`project${index + 1}SceneUsableMs`] = Math.round(performance.now() - projectAt);
    const status = (await business.callTool({ name: 'forgeax_view_status', arguments: {} })).structuredContent;
    assert.equal(status.ok, true, JSON.stringify(status.error));
    assert.equal(status.value.project.id, projectId);
    records.push({ businessProject: projectId, editorWorld: target.worldId });
    if (index === 0) initialViewFrame = frame.parentFrame();
    else assert.equal(frame.parentFrame(), initialViewFrame, 'Project switching must retain the static View document');
    const playAt = performance.now();
    console.error(`Project ${index + 1}: starting Play`);
    await view.locator('[data-action="scene.play"]').click();
    const playing = await poll(() => workspace.getState(), state => { if (state.play?.failure) throw new Error(JSON.stringify(state.play.failure)); return state.play?.phase === 'running'; });
    const play = view.locator('iframe[data-forgeax-scene-play]');
    const game = await (await play.elementHandle()).contentFrame();
    assert.ok(game);
    await game.waitForFunction(() => document.documentElement.dataset.forgeaxInput === 'open' && (globalThis.__forgeaxGameInspection?.renderer()?.frameId ?? 0) >= 60, undefined, { timeout: 150000 });
    assert.equal(await play.getAttribute('src'), null);
    assert.notEqual(playing.play.target.worldId, target.worldId);
    assert.equal(new URL(playing.play.target.url).origin, new URL(ready.projectTarget.url).origin);
    timings[`project${index + 1}PlayReadyMs`] = Math.round(performance.now() - playAt);
    await page.screenshot({ path: join(evidence, `play-${index + 1}.png`) });
    const stopAt = performance.now();
    await view.locator('[data-action="scene.stop"]').click();
    await poll(() => workspace.getState(), state => !state.play);
    await play.waitFor({ state: 'detached' });
    timings[`project${index + 1}StopMs`] = Math.round(performance.now() - stopAt);
    console.error(`Project ${index + 1}: scene, Play, Stop and 60 frames passed`);
  }
  expectedOffline = true;
  await stopDevKitBackend(root);
  await view.getByRole('button', { name: /^(启动后端|Start backend)$/ }).waitFor();
  const retained = await (await view.owner().elementHandle()).contentFrame();
  assert.equal(retained, initialViewFrame);
  await page.screenshot({ path: join(evidence, 'offline-retained.png') });
  const restartAt = performance.now();
  await view.getByPlaceholder(/项目目录的绝对路径|Absolute project directory/).fill('');
  await view.getByRole('button', { name: /^(启动后端|Start backend)$/ }).click();
  await bindWorkspace(viewUrl);
  await view.getByRole('button', { name: /^(下一步|Next)$/ }).waitFor();
  timings.restartToChooserMs = Math.round(performance.now() - restartAt);
  assert.equal(await (await view.owner().elementHandle()).contentFrame(), initialViewFrame);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  await page.getByRole('button', { name: 'Close App', exact: true }).click();
  await page.getByText('closed', { exact: true }).waitFor();
  console.log(JSON.stringify({ passed: true, timings, boundary: 'Packaged stdio MCP and sandboxed reference browser; native Codex click remains unverified' }));
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  for (const frame of page?.frames() ?? []) records.push({ failureDocument: frame.url().split('?')[0], body: await frame.locator('body').innerText().catch(() => '?') });
  throw error;
} finally {
  releaseStartup?.();
  workspace?.close();
  await browser?.close();
  await app.close(); await business.close();
  await stopDevKitBackend(root).catch(error => records.push({ cleanup: String(error) }));
  if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ timings, errors, consoleErrors, records }, null, 2));
  await rm(temp, { recursive: true, force: true });
  if (previousDataHome === undefined) delete process.env.FORGEAX_DATA_HOME;
  else process.env.FORGEAX_DATA_HOME = previousDataHome;
}
