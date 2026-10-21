import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { collectViewBackendDiagnostics } from '../../../scripts/ci/view-backend-diagnostics.mjs';
import { reduceTestProject } from '../../../scripts/test/reduce-test-project.mjs';
import { assertNoRuntimeFailure, assertScenePixels } from './app/acceptance.mjs';
import { probeRuntimeVase } from '../../../templates/game-3d/scripts/runtime-vase-probe.mjs';
const sourceProject = resolve(process.argv[2]);
const engine = resolve(import.meta.dirname, '../../..');
const evidence = resolve(process.argv[3] ?? '/tmp/forgeax-mcp-app-browser');
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'forgeax-app-consumer-'));
const project = join(temp, 'game-3d');
await cp(sourceProject, project, {
  recursive: true,
  filter: (path) => !['node_modules', '.forgeax', '.git'].includes(path.split('/').at(-1)),
});
if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1') await reduceTestProject(project);
await symlink(join(engine, 'node_modules'), join(project, 'node_modules'), 'dir');
const execute = promisify(execFile);
const records = [],
  errors = [],
  consoleErrors = [];
let browser, server, targetId;
let startupProfile;
const stopStartupProfile = async () => {
  if (!startupProfile) return;
  const session = startupProfile;
  startupProfile = undefined;
  try {
    const { profile } = await session.send('Profiler.stop');
    await writeFile(join(evidence, 'play-startup.cpuprofile'), JSON.stringify(profile));
  } finally {
    await session.detach();
  }
};
let hostAdmissions = 0;
let documentRequests = 0;
let replacingBackend = false;
const backendStarts = [];
async function cli(command, args = {}) {
  const startedAt = Date.now();
  const execution = execute(
    process.execPath,
    [
      join(engine, 'packages/engine/dist/bin/forgeax.mjs'),
      ...command.split(' '),
      '--root',
      project,
      '--json',
      ...(command === 'backend start'
        ? ['--host-pack', args.hostPack]
        : ['--input', JSON.stringify(args)]),
    ],
    {
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, FORGEAX_WORKSPACE_TIMING: '1' },
    },
  );
  if (command === 'backend start') backendStarts.push({ probePid: execution.child.pid, startedAt });
  const { stdout } = await execution;
  records.push({ cli: command, ms: Date.now() - startedAt });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}
const client = new Client({ name: 'portable-view-acceptance', version: '1' });
try {
  await cli('backend start', { hostPack: resolve(import.meta.dirname, '../host.app.pack.json') });
  const marketplace = join(temp, 'marketplace');
  await execute(process.execPath, [
    resolve(import.meta.dirname, '../codex/create-local-plugin.mjs'),
    project,
    marketplace,
  ]);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(marketplace, 'plugins/forgeax-view-codex/src/codex-app-server.mjs'), project],
      cwd: temp,
    }),
  );
  await client.callTool({ name: 'forgeax_view_start', arguments: {} });
  const openingTool = (await client.listTools()).tools.find(tool => tool.name === 'forgeax_view_start');
  const carrier = (await client.readResource({ uri: openingTool._meta.ui.resourceUri })).contents[0].text;
  const result = await build({
    entryPoints: [resolve(import.meta.dirname, 'app/reference-host.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const html = `<!doctype html><html><style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}iframe{flex:1;width:100%;border:0;min-height:0}pre{margin:0;max-height:80px;overflow:auto}</style><body><header>Browser reference host <button id="light">Light</button><button id="dark">Dark</button><button id="reopen">Reopen View</button><button id="restart">Restart backend</button><button id="close">Close App</button><output id="closed"></output></header><output id="opened"></output><pre id="draft"></pre><iframe id="app" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script type="module">${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/restart' && request.method === 'POST') {
        await cli('backend stop');
        await cli('backend start', { hostPack: resolve(import.meta.dirname, '../host.app.pack.json') });
        const opened = await client.callTool({ name: 'forgeax_view_start', arguments: {} });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(opened));
        return;
      }
      if (request.url === '/tool' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks));
        // Admit the real Preview after the View's first catalog observation.
        // Native hosts can schedule these realms at different speeds.
        if (params.arguments.action === 'host-open' && ++hostAdmissions === 2)
          await new Promise(resolve => setTimeout(resolve, 2000));
        if (params.arguments.action === 'document' && ++documentRequests === 4)
          await new Promise(resolve => setTimeout(resolve, 2000));
        const controller = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) controller.abort();
        });
        const started = performance.now();
        const value = await client.callTool(params, undefined, {
          signal: controller.signal,
          timeout: 30000,
        });
        if (params.arguments.action !== 'host-read')
          records.push({
            action: params.arguments.action,
            wireBytes: value.structuredContent?.bytes,
            decodedBytes: value.structuredContent?.decodedBytes,
            requestCount: params.arguments.requests?.length,
            url: params.arguments.url
              ? new URL(params.arguments.url).origin + new URL(params.arguments.url).pathname
              : undefined,
            service: params.arguments.service,
            operation: params.arguments.payload?.operation,
            resultError: value.isError ? value.content : undefined,
            ms: Math.round(performance.now() - started),
          });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(value));
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/carrier.html') response.setHeader('content-security-policy', "frame-src 'none'");
      response.end(request.url === '/carrier.html' ? carrier : html);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({
    executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE,
    headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  const native = await browser.newBrowserCDPSession();
  await native.send('Target.setDiscoverTargets', { discover: true });
  native.on('Target.targetCrashed', failure => {
    errors.push(`Native browser target crashed: ${failure.status} (${failure.errorCode})`);
    records.push({ nativeCrash: failure });
    console.error('MCP App native crash: ' + JSON.stringify(failure));
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('framedetached', frame => records.push({ frameDetached: frame.url().split('?')[0], at: Date.now() }));
  page.on('console', (message) => {
    if (message.type() === 'error' && !(replacingBackend && message.text().startsWith('ForgeaX Host connection failed:')))
      consoleErrors.push(message.text());
    if (message.type() === 'error' || message.text().includes('stage:') || message.text().includes('[forgeax.play]'))
      records.push({ console: message.text().slice(0, 16000) });
  });
  console.error('MCP App stage: browser ready');
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const view = page.frameLocator('#app').frameLocator('#view');
  const initialPreviewDeadline = performance.now() + 180000;
  const hostDeadline = performance.now() + 60000;
  try {
    const iframe = await view.owner().elementHandle({ timeout: 60000 });
    const document = await iframe.contentFrame();
    assert.ok(document);
    await document.waitForFunction(
      () => globalThis.__forgeaxViewReady?.mounted?.transport?.connected === true,
      undefined, { timeout: Math.max(1, hostDeadline - performance.now()) });
    await iframe.dispose();
  } catch (error) {
    for (const frame of page.frames())
      records.push({
        frame: frame.url(),
        body: await frame
          .locator('body')
          .innerText()
          .catch(() => '?'),
        diagnostics: await frame
          .locator('pre')
          .allTextContents()
          .catch(() => []),
      });
    throw error;
  }
  console.error('MCP App stage: View connected');
  // Project restoration replaces the header's connected label. It belongs to
  // the Preview's existing readiness budget, not the native Host connection gate.
  await view.getByRole('status', { name: /ForgeaX Host (\u5df2\u8fde\u63a5|connected)/ })
    .waitFor({ timeout: Math.max(1, initialPreviewDeadline - performance.now()) });
  const playCycle = async (cycle) => {
    const playStarted = performance.now();
    await view.getByRole('button', { name: 'Play', exact: true }).click();
    const play = view.locator('iframe[data-forgeax-scene-play]');
    // Presentation stays transparent until native readiness; observe startup while attached.
    await play.waitFor({ state: 'attached' });
    const playDocument = await (await play.elementHandle()).contentFrame();
    assert.ok(playDocument, 'Play must expose its actual document');
    if (cycle === 0 && process.env.FORGEAX_MCP_PROFILE === '1') {
      let owner = playDocument;
      for (;;) {
        try {
          startupProfile = await browser.contexts()[0].newCDPSession(owner);
          break;
        } catch (error) {
          if (!String(error).includes('part of the parent frame')) throw error;
          const parent = owner.parentFrame();
          if (parent) owner = parent;
          else {
            startupProfile = await browser.contexts()[0].newCDPSession(page);
            break;
          }
        }
      }
      await startupProfile.send('Profiler.enable');
      await startupProfile.send('Profiler.start');
    }
    assert.ok((await play.getAttribute('src')) === null, 'Hosted Play must not navigate loopback');
    // Keep the exact admitted frame. Re-resolving the nested iframe every poll
    // makes Playwright preview its multi-megabyte srcdoc on the browser thread.
    const playFrame = playDocument;
    const playHtml = playFrame.locator('html');
    const deadline = performance.now() + 180000;
    while (Number(await playHtml.getAttribute('data-forgeax-frame-completed')) < 60) {
      await assertNoRuntimeFailure(playFrame, `Play ${cycle}`, errors, consoleErrors);
      assert.ok(performance.now() < deadline, 'The real Play Renderer must complete 60 frames');
      await page.waitForTimeout(50);
    }
    await play.waitFor({ state: 'visible' });
    await stopStartupProfile();
    const readyMs = Math.round(performance.now() - playStarted);
    if (cycle === 0) {
      const read = () => playDocument.evaluate(() => globalThis.__forgeaxGameInspection?.read('game-3d.runtime-vase'));
      records.push({ runtimeVase: await read() });
      records.push({ runtimeVaseProbe: await probeRuntimeVase(playDocument, read,
        join(evidence, 'runtime-vase'), options => page.screenshot(options)) });
    }
    const placement = await play.evaluate(element => ({
      hidden: element.hidden, previewTarget: element.dataset.forgeaxMcpPreview,
      width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
    }));
    assert.equal(placement.hidden, false);
    assert.equal(placement.previewTarget, undefined, 'Preview must not acquire the Play document');
    assert.ok(placement.width > 0 && placement.height > 0);
    await page.screenshot({ path: join(evidence, `play-${cycle}.png`) });
    await assertNoRuntimeFailure(playFrame, `Play ${cycle}`, errors, consoleErrors);
    const completedFrames = Number(await playHtml.getAttribute('data-forgeax-frame-completed'));
    assert.ok(completedFrames >= 60, 'The current Play document must retain 60 completed frames after capture');
    records.push({ playCycle: cycle, frameId: completedFrames,
      readyMs, placement });
    const stopStarted = performance.now();
    await view.getByRole('button', { name: 'Stop', exact: true }).click();
    await play.waitFor({ state: 'detached' });
    await view.getByRole('button', { name: 'Play', exact: true }).waitFor();
    records.push({ stopCycle: cycle, ms: Math.round(performance.now() - stopStarted) });
  };
  // The first retained cycle covers Play before any scene is opened.
  await playCycle(0);
  // Scene readiness has its own budget; the preceding Play journey is independent.
  const sceneDeadline = performance.now() + 180000;
  targetId = await view
    .locator('iframe[data-forgeax-mcp-preview]')
    .getAttribute('data-forgeax-mcp-preview');
  if (!(await view.getByTestId('panel-content-browser').isVisible()))
    await view.getByText(/^(内容浏览器|Content Browser)$/).click();
  await view.getByRole('button', { name: 'assets', exact: true }).first().click();
  const sceneCard = view.getByRole('button', { name: /^scene\/showcase (场景|Scene)$/ });
  await sceneCard.click({ button: 'right' });
  await view.getByRole('menuitem', { name: /^(引用到会话|Reference in conversation)$/ }).click();
  await page.locator('#draft').filter({ hasText: 'scene/showcase' }).waitFor();
  const draft = JSON.parse(await page.locator('#draft').innerText());
  assert.equal(draft._meta['openai/message'].send, false);
  assert.equal(draft._meta['openai/message'].target, 'active');
  assert.ok(draft.content[0]._meta['openai/title']);
  records.push({ draft });
  if (!(await sceneCard.isVisible()))
    await view.getByText(/^(内容浏览器|Content Browser)$/).click();
  await sceneCard.dblclick();
  await view.getByRole('treeitem', { name: /Mirror Sphere (网格|Mesh)/ }).waitFor();
  targetId = await view
    .locator('iframe[data-forgeax-mcp-preview]')
    .getAttribute('data-forgeax-mcp-preview');
  assert.ok(targetId);
  const completeFrames = async (frameDeadline = performance.now() + 180000) => {
    const preview = view.frameLocator('iframe[data-forgeax-mcp-preview]');
    const previewHtml = preview.locator('html');
    // Match the maintained game-3d gate: observe completed frames without adding
    // GPU readbacks and multi-megabyte transport to every progress sample.
    while (Number(await previewHtml.getAttribute('data-forgeax-frame-completed')) < 60) {
      await assertNoRuntimeFailure(preview, 'Preview', errors, consoleErrors);
      assert.ok(performance.now() < frameDeadline, 'The real Renderer must complete at least 60 frames');
      await page.waitForTimeout(50);
    }
    assert.ok(performance.now() < frameDeadline, 'Preview readiness must remain within its 180-second budget');
    await assertNoRuntimeFailure(preview, 'Preview', errors, consoleErrors);
  };
  await completeFrames(sceneDeadline);
  const capture = await cli('view workspace preview capture', { targetId, targetGeneration: 1 });
  assert.ok(capture.frameId >= 60, 'The real Renderer must complete at least 60 frames');
  assert.ok(capture.png?.startsWith('data:image/png;base64,'));
  await writeFile(join(evidence, 'scene.png'), Buffer.from(capture.png.split(',')[1], 'base64'));
  records.push({ scenePixels: await assertScenePixels(page, capture.png, 'Preview scene') });
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await view.locator('html[data-theme="dark"]').waitFor();
  if (!(await view.getByTestId('panel-content-browser').isVisible()))
    await view.getByText(/^(内容浏览器|Content Browser)$/).click();
  await view
    .getByRole('button', { name: /guide/i })
    .first()
    .dblclick();
  const htmlPreview = view.getByTestId('html-ui-preview');
  await htmlPreview.waitFor({ state: 'visible' });
  const htmlFrame = htmlPreview.locator('iframe[title="assets/guide.ui.html"]');
  await htmlFrame.waitFor();
  assert.equal(await htmlFrame.getAttribute('sandbox'), 'allow-scripts');
  // Qualify the authored UI in its actual sandboxed document. Inspector chrome
  // can change without changing preview readiness or the authored content.
  const guideTitle = view.frameLocator('iframe[title="assets/guide.ui.html"]').locator('[data-ui-part="guide-title"]');
  await guideTitle.waitFor({ state: 'visible' });
  assert.equal(await guideTitle.textContent(), '3C starter');
  assert.equal(await guideTitle.locator('..').evaluate(element => getComputedStyle(element).display), 'grid',
    'The isolated HTML preview must render its companion stylesheet');
  assert.equal(await view.getByTestId('html-ui-inspector').locator('[role="alert"]').count(), 0);
  await page.screenshot({ path: join(evidence, 'html.png') });
  await view.locator('[role="tab"][data-page-id="page-scene"]').click();
  await view.getByRole('treeitem', { name: /Mirror Sphere (网格|Mesh)/ }).waitFor();
  await page.screenshot({ path: join(evidence, 'view.png') });
  await playCycle(1);
  await view.getByRole('treeitem', { name: /Mirror Sphere (网格|Mesh)/ }).waitFor();
  await view.getByRole('button', { name: 'Play', exact: true }).click();
  const preparingPlay = view.locator('iframe[data-forgeax-scene-play]');
  await preparingPlay.waitFor();
  assert.equal(await preparingPlay.getAttribute('srcdoc'), null, 'The adopted Stop probe holds document delivery');
  // The published target is adopted: its owner retains presentation through
  // initial readiness before native cleanup, within the existing workspace bound.
  const preparingStopStarted = performance.now();
  await view.getByRole('button', { name: 'Stop', exact: true }).click();
  await view.getByRole('button', { name: 'Game', exact: true }).waitFor();
  assert.equal(await view.locator('iframe[data-forgeax-mcp-preview]').evaluate(element => element.hidden), true,
    'Preview rendering must stay paused while adopted Play startup is draining');
  await preparingPlay.waitFor({ state: 'detached', timeout: 120000 });
  records.push({ adoptedStopMs: Math.round(performance.now() - preparingStopStarted) });
  await view.getByRole('button', { name: 'Play', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reopen View', exact: true }).click();
  await page.locator('#opened').filter({ hasText: 'http' }).waitFor();
  assert.equal(await view.locator('iframe[data-forgeax-mcp-preview]').getAttribute('data-forgeax-mcp-preview'), targetId,
    'reopening the same View must retain the existing document and Engine target');
  const previousTargetId = targetId;
  const previousUrl = await page.locator('#opened').innerText();
  console.error('MCP App stage: initial scene and reopening passed');
  await assertNoRuntimeFailure(view.frameLocator('iframe[data-forgeax-mcp-preview]'), 'Preview before backend replacement', errors, consoleErrors);
  // Backend retirement deliberately produces connection failures. Observe the
  // replacement independently once its native Host has connected.
  replacingBackend = true;
  await page.getByRole('button', { name: 'Restart backend', exact: true }).click();
  await page.waitForFunction(url => document.querySelector('#opened').textContent !== url, previousUrl, { timeout: 60000 });
  await view.locator(`iframe[data-forgeax-mcp-preview]:not([data-forgeax-mcp-preview="${previousTargetId}"])`).waitFor({ state: 'attached', timeout: 60000 });
  await view.getByRole('status', { name: /ForgeaX Host (\u5df2\u8fde\u63a5|connected)/ }).waitFor({ timeout: 60000 });
  targetId = await view.locator('iframe[data-forgeax-mcp-preview]').getAttribute('data-forgeax-mcp-preview');
  assert.notEqual(targetId, previousTargetId, 'a backend replacement must admit a fresh Engine target');
  replacingBackend = false;
  if (!(await view.getByTestId('panel-content-browser').isVisible()))
    await view.getByText(/^(内容浏览器|Content Browser)$/).click();
  await view.getByRole('button', { name: 'assets', exact: true }).first().click();
  await view.getByRole('button', { name: /^scene\/showcase (场景|Scene)$/ }).dblclick();
  await view.getByRole('treeitem', { name: /Mirror Sphere (网格|Mesh)/ }).waitFor();
  console.error('MCP App stage: recovered scene ready');
  await completeFrames();
  const recoveredCapture = await cli('view workspace preview capture', { targetId, targetGeneration: 1 });
  assert.ok(recoveredCapture.frameId >= 60);
  await writeFile(join(evidence, 'scene-after-restart.png'), Buffer.from(recoveredCapture.png.split(',')[1], 'base64'));
  records.push({ scenePixels: await assertScenePixels(page, recoveredCapture.png, 'Recovered Preview scene') });
  await view.locator('html[data-theme="dark"]').waitFor();
  records.push({ backendRestart: { previousTargetId, targetId, frameId: recoveredCapture.frameId } });
  await page.getByRole('button', { name: 'Close App', exact: true }).click();
  await page.getByText('closed', { exact: true }).waitFor();
  assert.equal(await page.locator('#app').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      targetId,
      errors,
      frameId: capture.frameId,
      boundary:
        'portable stdio package + real SDK nested iframes + game-3d; browser reference host, not native Codex',
    }),
  );
} catch (error) {
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  for (const frame of browser?.contexts()[0]?.pages()[0]?.frames() ?? [])
    records.push({ failureDocument: frame.url().split('?')[0], body: await frame.locator('body').innerText().catch(() => '?'),
      startup: await frame.locator('#forgeax-fatal-message, #forgeax-fatal-details').allTextContents().catch(() => []),
      startupState: await frame.evaluate(() => ({
        attributes: Object.fromEntries([...document.documentElement.attributes].filter(a => a.name.startsWith('data-forgeax-')).map(a => [a.name, a.value])),
        fatalVisible: !!document.querySelector('#forgeax-fatal')?.getClientRects().length,
        visibility: document.visibilityState,
        nativeViewConnected: globalThis.__forgeaxViewReady?.mounted?.transport?.connected,
        nativeViewError: globalThis.__forgeaxViewReady?.error,
      })).catch(() => undefined) });
  throw error;
} finally {
  await stopStartupProfile().catch(error => records.push({ profileError: String(error) }));
  for (const owner of backendStarts) {
    try {
      const files = collectViewBackendDiagnostics({ ...owner, outputDirectory: join(evidence, 'backend') });
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        for (const line of text.split('\n'))
          if (['[forgeax.workspace.timing]', '[forgeax.vite-config.timing]', '[forgeax.pack-startup.timing]', '[forgeax.authored-pack.timing]'].some(prefix => line.includes(prefix)))
            console.error(line);
      }
    } catch (error) { console.error('Workspace timing diagnostics:', String(error)); }
  }
  if (targetId)
    await cli('view workspace project close', {
      projectId: 'template-game-3d',
      expectedTargetId: targetId,
      targetId,
    }).catch((error) => records.push({ cleanup: String(error) }));
  await browser?.close();
  await client.close();
  await cli('backend stop').catch((error) => records.push({ backendCleanup: String(error) }));
  // backend start runs in a CLI child, which owns the daemon spawn record.
  for (const owner of backendStarts) {
    try { collectViewBackendDiagnostics({ ...owner, outputDirectory: join(evidence, 'backend') }); }
    catch (cause) { records.push({ backendDiagnostics: String(cause) }); }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify({ targetId, errors, consoleErrors, records }, null, 2),
  );
  await rm(temp, { recursive: true, force: true });
}
