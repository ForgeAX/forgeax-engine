import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const engine = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const view = resolve(import.meta.dirname, '..');
const source = join(engine, 'tools/forgeax-mcp');
const require = createRequire(join(source, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
assert.equal(await realpath(require.resolve('@forgeax/view/plugin')), join(view, 'dist/modules/plugin.mjs'));
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'view-embedded-selection-'));
const mcp = join(temp, 'mcp');
const project = join(temp, 'game-3d');
await mkdir(mcp);
// Build the unchanged adapter in a disposable consumer, leaving Engine read-only.
for (const name of ['src', 'codex', 'package.json', 'host.app.pack.json'])
  await cp(join(source, name), join(mcp, name), { recursive: true });
await symlink(join(source, 'node_modules'), join(mcp, 'node_modules'));
await cp(join(engine, 'templates/game-3d'), project, { recursive: true,
  filter: path => !['node_modules', '.forgeax', '.git'].includes(basename(path)) });
await symlink(join(engine, 'node_modules'), join(project, 'node_modules'));
const execute = promisify(execFile);
const cli = async (command, input) => {
  const { stdout } = await execute(process.execPath, [join(engine, 'packages/devkit/dist/cli.mjs'), ...command.split(' '),
    '--root', project, '--json', ...(input ? ['--input', JSON.stringify(input)] : [])], { maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
};
let browser, server, started = false;
const client = new Client({ name: 'view-embedded-selection', version: '1' });
const errors = [];
try {
  console.error('Building isolated MCP consumer');
  await execute(process.execPath, [join(mcp, 'codex/build-app.mjs')], { maxBuffer: 8 * 1024 * 1024 });
  const { stdout } = await execute(process.execPath, [join(engine, 'packages/devkit/dist/cli.mjs'), 'backend', 'start',
    '--root', project, '--host-pack', join(mcp, 'host.app.pack.json'), '--json'], { timeout: 180000 });
  assert.equal(JSON.parse(stdout).ok, true, stdout);
  started = true;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(mcp, 'src/codex-app-server.mjs'), project] }));
  const tools = (await client.listTools()).tools;
  const opening = tools.find(tool => tool.name === 'forgeax_view_start');
  const carrier = (await client.readResource({ uri: opening._meta.ui.resourceUri })).contents[0].text;
  const reference = await build({ entryPoints: [join(source, 'test/app/reference-host.ts')], bundle: true,
    write: false, format: 'esm', platform: 'browser' });
  const html = `<!doctype html><html><style>html,body{margin:0;height:100%}#app{width:100%;height:100%;border:0}button,output,pre{display:none}</style><body>
    <button id="reopen"></button><button id="restart"></button><button id="close"></button><button id="light"></button><button id="dark"></button>
    <output id="opened"></output><output id="closed"></output><pre id="draft"></pre>
    <iframe id="app" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script type="module">${reference.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/tool') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const controller = new AbortController();
        response.once('close', () => { if (!response.writableEnded) controller.abort(); });
        const result = await client.callTool(JSON.parse(Buffer.concat(chunks)), undefined, { signal: controller.signal, timeout: 60000 });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
      } else {
        response.setHeader('content-type', 'text/html');
        if (request.url === '/carrier.html') response.setHeader('content-security-policy', "frame-src 'none'");
        response.end(request.url === '/carrier.html' ? carrier : html);
      }
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE, headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const shell = page.frameLocator('#app').frameLocator('#view');
  const deadline = Date.now() + 240000;
  let state;
  while (Date.now() < deadline) {
    try { state = await cli('view workspace tabs get', {}); } catch { /* The first Host admission may still be pending. */ }
    if (state?.projectPhase === 'running') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(state?.projectPhase, 'running', JSON.stringify(state));
  console.error('Opening real Game 3D Scene');
  const assets = await cli('view workspace assets list', { projectId: state.project.id, targetId: state.projectTarget.targetId });
  const scene = assets.assets.find(asset => asset.kind === 'scene' && /scene\.pack/.test(asset.sourcePath ?? asset.path ?? ''))
    ?? assets.assets.find(asset => asset.kind === 'scene');
  assert.ok(scene);
  await cli('view workspace asset open', { projectId: state.project.id, targetId: state.projectTarget.targetId, guid: scene.guid });
  const frame = shell.frameLocator('iframe[data-forgeax-mcp-preview]');
  const canvas = frame.locator('canvas#app');
  await canvas.waitFor({ state: 'visible', timeout: 120000 });
  const frameDeadline = Date.now() + 120000;
  const readCompletedFrame = () => canvas.evaluate(canvas => canvas.forgeaxFrameProgress?.completed?.frameId ?? 0);
  while (Number(await readCompletedFrame()) < 60 && Date.now() < frameDeadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(Number(await readCompletedFrame()) >= 60);
  state = await cli('view workspace tabs get', {});
  await cli('view workspace scene clear', { targetId: state.preview.target.targetId, targetGeneration: state.preview.target.generation });
  const box = await canvas.boundingBox();
  const selections = [];
  console.error('Clicking isolated canvas and checking Shell Inspector');
  for (const [x, y] of [[.5, .5], [.3, .5], [.7, .5], [.5, .7], [.3, .7], [.7, .7]]) {
    await canvas.click({ position: { x: box.width * x, y: box.height * y } });
    await new Promise(resolve => setTimeout(resolve, 300));
    const selected = (await cli('view workspace tabs get', {})).sceneSelection?.primary.entityId;
    if (!selected) continue;
    const inspector = shell.getByTestId('panel-inspector');
    await inspector.locator(`[data-testid="insp-entity-body"]`).waitFor({ state: 'attached', timeout: 10000 });
    assert.equal(await inspector.getAttribute('data-entity-id'), selected);
    const name = await inspector.locator('.insp-header-name').textContent();
    assert.ok(name);
    assert.ok(await inspector.locator('[data-testid="insp-components-card"]').count());
    selections.push({ selected, name });
    if (new Set(selections.map(row => row.selected)).size >= 2) break;
  }
  assert.ok(new Set(selections.map(row => row.selected)).size >= 2, 'Different canvas picks must update the Shell selection and Inspector');
  assert.deepEqual(errors, [], 'The embedded browser must report no runtime errors');
  await page.screenshot({ path: join(evidence, 'selection-inspector.png') });
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ engine, view, project, selections, errors,
    boundary: 'Real Engine + MCP SDK browser reference host; native Codex session requires refreshed installed artifacts' }, null, 2));
  console.log(JSON.stringify({ selections, evidence }));
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error.stack ?? error), errors, project, mcp }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await client.close();
  if (started) await cli('backend stop').catch(error => console.error(String(error)));
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
}
