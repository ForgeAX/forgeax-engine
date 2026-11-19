import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridgeClient } from '../../src/client.mjs';
import { createCodexRouting, workspaceBackendRoot } from '../../src/codex-routing.mjs';
import { codexFileEntry } from '../../src/codex-file-entry.mjs';
import { createViewAppServer } from '../../src/app/mcp-server.mjs';
import { createViewService } from '../../src/app/service.mjs';
import { createAppHosting } from '../../src/app/hosting.mjs';
import { FILE_UI_URI, UI_URI } from '../../src/contract.ts';
import { assertNoRuntimeFailure, assertScenePixels } from '../../test/app/acceptance.mjs';

// Supply a populated consumer project containing assets/world/world.scene.pack.json.
const [sourceProjectArg, evidenceArg, secondScenePath, multiPackPath] = process.argv.slice(2);
const multiOnly = process.env.FORGEAX_FILE_BROWSER_MULTI_ONLY === '1';
const startupFailure = process.env.FORGEAX_FILE_BROWSER_STARTUP_FAILURE === '1';
const priorOfflineEvidence = process.env.FORGEAX_FILE_BROWSER_PRIOR_OFFLINE_EVIDENCE;
const coldReopen = process.env.FORGEAX_FILE_BROWSER_COLD_REOPEN === '1';
const rapidFiles = process.env.FORGEAX_FILE_BROWSER_RAPID_FILES === '1';
const overlapFiles = process.env.FORGEAX_FILE_BROWSER_OVERLAP_FILES === '1';
const measureSwitches = process.env.FORGEAX_FILE_BROWSER_MEASURE_SWITCHES === '1';
if (!process.env.FORGEAX_PLUGIN_SOURCE || !sourceProjectArg)
  throw new Error('Usage: FORGEAX_PLUGIN_SOURCE=<built-engine-directory> node file-browser.mjs <source-project-directory> [evidence-directory] [second-scene-relative-path] [multi-pack-relative-path]');
const engine = await realpath(resolve(process.env.FORGEAX_PLUGIN_SOURCE));
const sourceProject = await realpath(resolve(sourceProjectArg));
await readFile(join(sourceProject, 'forge.json'), 'utf8');
await readFile(join(sourceProject, 'assets/world/world.scene.pack.json'), 'utf8');
for (const path of [secondScenePath, multiPackPath].filter(Boolean)) {
  const ownedPath = relative(sourceProject, resolve(sourceProject, path));
  assert.ok(!isAbsolute(path) && ownedPath !== '..' && !ownedPath.startsWith('../'), 'Additional sources must be inside the supplied consumer project');
  await readFile(join(sourceProject, path), 'utf8');
}
const evidence = evidenceArg ? resolve(evidenceArg) : await mkdtemp(join(tmpdir(), 'forgeax-file-browser-evidence-'));
const temp = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-file-browser-')));
await mkdir(evidence, { recursive: true });
const project = join(temp, 'consumer');
await cp(sourceProject, project, { recursive: true,
  filter: path => !['node_modules', '.forgeax', '.git'].includes(path.split('/').at(-1)) });
await symlink(join(engine, 'node_modules'), join(project, 'node_modules'), 'dir');
const execute = promisify(execFile);
const suppliedPlugin = process.env.FORGEAX_FILE_BROWSER_PLUGIN;
let generated;
if (suppliedPlugin) {
  await cp(resolve(suppliedPlugin), join(temp, 'marketplace/plugins/forgeax-view-codex'), { recursive: true });
  generated = { source: resolve(suppliedPlugin), frozen: true };
} else generated = JSON.parse((await execute(process.execPath, [resolve(import.meta.dirname, '../../codex/create-local-plugin.mjs'),
  engine, join(temp, 'marketplace'), '--root', join(temp, 'global')], { timeout: 60000 })).stdout);
const plugin = join(temp, 'marketplace/plugins/forgeax-view-codex');
const binding = JSON.parse(await readFile(join(plugin, 'hosting.json'), 'utf8'));
if (suppliedPlugin) binding.root = join(temp, 'global');
if (measureSwitches && process.env.FORGEAX_FILE_BROWSER_VIEW_ROOT) binding.viewRoot = resolve(process.env.FORGEAX_FILE_BROWSER_VIEW_ROOT);
// A test-only home gives deterministic isolated chat roots without touching user preferences.
binding.codexContext = { home: temp, command: process.execPath };
const roots = new Set([binding.root]), records = [], errors = [], consoleErrors = [];
const timeline = [], measurements = [];
const mark = (event, detail = {}) => { const item = { at: performance.now(), event, ...detail }; timeline.push(item); return item; };
if (startupFailure || measureSwitches) {
  binding.codexContext.command = join(temp, 'codex');
  await writeFile(binding.codexContext.command, `#!${process.execPath}
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
if(m.method==='thread/read')process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId,cwd:${JSON.stringify(temp)}}}})+'\\n');});`, { mode: 0o700 });
  await writeFile(join(temp, 'test-hosting.json'), JSON.stringify(binding));
}
const createSession = async () => {
if (startupFailure || measureSwitches) {
  const client = new Client({ name: 'file-browser-stdio-verifier', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, 'src/codex-app-server.mjs'), join(temp, 'test-hosting.json')], cwd: temp, stderr: 'pipe',
    env: { TMPDIR: tmpdir() } });
  await client.connect(transport);
  transport.stderr?.on('data', bytes => { void import('node:fs').then(({ appendFileSync }) => appendFileSync(join(evidence, 'stdio.log'), bytes)); });
  records.push({ mcpProcessStarted: transport.pid });
  return { client, app: { async close() {} }, routing: undefined };
}
const routing = createCodexRouting(binding, {
  directoryReader: { async read() { return temp; }, close() {} },
  createPresentation(client, selected) {
    roots.add(selected.root);
    return createViewService(client, { artifactRoot: pathToFileURL(join(plugin, 'dist/')), viewDocument: 'codex-view.html',
      hosting: createAppHosting(selected) });
  },
});
const app = createViewAppServer(await createBridgeClient(binding), { routing, fileEntry: codexFileEntry,
  artifactRoot: pathToFileURL(join(plugin, 'dist/')), viewDocument: 'codex-view.html' });
const client = new Client({ name: 'file-browser-verifier', version: '1' });
const [host, child] = InMemoryTransport.createLinkedPair();
await app.server.connect(host); await client.connect(child);
return { routing, app, client };
};
let { routing, app, client } = await createSession();
const carriers = {
  ordinary: (await client.readResource({ uri: UI_URI })).contents[0].text,
  file: (await client.readResource({ uri: FILE_UI_URI })).contents[0].text,
};
const compiled = (await build({ entryPoints: [join(import.meta.dirname, 'support/file-reference-host.ts')],
  bundle: true, write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text;
let selectedPath = join(project, 'assets/world/world.scene.pack.json');
const entryPaths = new Map();
if (rapidFiles) entryPaths.set('file', selectedPath);
let server, browser, failure;
const liveTimer = measureSwitches ? setInterval(() => {
  void writeFile(join(evidence, 'timing-live.json'), JSON.stringify({ measurements, timeline }, null, 2));
}, 2000) : undefined;
const pages = [];
const chatMeta = { threadId: randomUUID() };
const poll = async (read, accepts, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `Readiness deadline exceeded: ${JSON.stringify(value)}`);
    await new Promise(done => setTimeout(done, 100)); }
};
try {
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const entry = url.searchParams.get('entry') ?? 'file';
      if (url.pathname === '/tool') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks));
        const action = params.arguments?.action;
        const operation = params.arguments?.payload?.operation;
        if (measureSwitches && action === 'host-open') roots.add(workspaceBackendRoot(binding, chatMeta.threadId));
        const timing = measureSwitches ? mark('tool-start', { entry, action, operation, document: params.arguments?.url ? new URL(params.arguments.url).pathname : undefined }) : undefined;
        const result = await client.callTool({ ...params, _meta: { ...chatMeta, 'openai/resource': { path: entryPaths.get(entry) ?? selectedPath } } }, undefined, { timeout: 120000 });
        if (timing) mark('tool-end', { entry, action, operation, durationMs: performance.now() - timing.at,
          phase: result.structuredContent?.phase, responseBytes: Buffer.byteLength(JSON.stringify(result)), failed: !!result.isError });
        const payload = params.arguments?.payload;
        if (action !== 'host-read') records.push({ entry, action, service: params.arguments?.service,
          operation: payload?.operation, payload: payload && { operation: payload.operation, args: payload.args },
          result: payload?.operation === 'pack.reveal' ? result.structuredContent : undefined,
          resultError: result.isError ? result.content : undefined });
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); return;
      }
      response.setHeader('content-type', 'text/html');
      if (url.pathname === '/carrier') {
        if (measureSwitches) mark('carrier-bytes', { entry, bytes: Buffer.byteLength(carriers[entry === 'ordinary' ? 'ordinary' : 'file']) });
        response.setHeader('content-security-policy', "frame-src 'none'"); response.end(carriers[entry === 'ordinary' ? 'ordinary' : 'file']); return;
      }
      response.end(`<!doctype html><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe id="app" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script id="test-config" type="application/json">${JSON.stringify({ entry, file: entry !== 'ordinary' })}</script><script type="module">${compiled.replaceAll('</script', '<\\/script')}</script>`);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=SharedArrayBuffer'], chromiumSandbox: true });
  const newPage = async entry => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); pages.push(page);
    page.setDefaultTimeout(60000); page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    if (measureSwitches) {
      await page.exposeBinding('__recordSwitchTiming', (_source, item) => timeline.push({ ...item, entry, at: item.at - performance.timeOrigin }));
      await page.addInitScript(() => {
        const emit = (event, detail = {}) => globalThis.__recordSwitchTiming({ at: performance.timeOrigin + performance.now(), event, ...detail });
        addEventListener('DOMContentLoaded', () => emit('document-dom-ready'));
        addEventListener('message', event => {
          const data = event.data;
          if (data?.method === 'ui/resource-teardown') emit('bridge-teardown-received', { id: data.id });
          else if (data?.jsonrpc === '2.0' && data.id !== undefined && ('result' in data || 'error' in data))
            emit('bridge-response-received', { id: data.id, error: !!data.error });
        });
        let client, owner;
        const timer = setInterval(() => {
          const ctx = globalThis.__forgeaxViewReady?.mounted?.frontendHost?.context;
          if (!ctx) return;
          const current = ctx.get('viewOperationClient', false);
          if (current && current !== client) {
            client = current; emit('workspace-connected');
            const present = current.presentProject.bind(current);
            current.presentProject = async (...args) => { emit('project-present-start'); try { return await present(...args); }
              finally { emit('project-present-end'); } };
            current.subscribe(state => emit('workspace-state', { phase: state.projectStatus?.phase ?? state.projectPhase,
              presentation: state.projectDocumentPresentation, sessionId: state.projectDocument?.sessionId,
              targetId: state.projectDocument?.targetId, generation: state.projectDocument?.browserGeneration,
              assetGuid: state.scenePreview?.asset?.guid ?? state.preview?.asset?.guid }));
          }
          const next = ctx.get('viewProjectDocumentFrameOwner', false);
          if (next && next !== owner) {
            owner = next;
            next.subscribe(state => emit('frame-owner', { phase: state?.phase, sessionId: state?.document?.sessionId,
              targetId: state?.document?.targetId, generation: state?.document?.browserGeneration }));
            const release = next.release.bind(next);
            next.release = async (...args) => { emit('presentation-release-start'); try { return await release(...args); }
              finally { emit('presentation-release-end'); } };
          }
        }, 25);
        addEventListener('pagehide', () => clearInterval(timer), { once: true });
      });
    }
    await page.addInitScript(() => {
      globalThis.__fileLifecycleEvidence = [];
      addEventListener('error', event => {
        globalThis.__fileLifecycleEvidence.push({ at: performance.now(), type: 'error', message: event.message,
          error: JSON.parse(JSON.stringify(event.error, (_key, value) => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value) ?? 'null') });
      });
      addEventListener('pagehide', () => globalThis.__fileLifecycleEvidence.push({ at: performance.now(), type: 'pagehide' }));
      addEventListener('DOMContentLoaded', () => {
        const seen = new WeakSet();
        new MutationObserver(() => {
          for (const element of document.querySelectorAll('.fx-toast--error, #view-file-error')) {
            if (seen.has(element)) continue;
            seen.add(element);
            globalThis.__fileLifecycleEvidence.push({ at: performance.now(), type: 'error-ui', text: element.textContent });
          }
        }).observe(document.body, { childList: true, subtree: true });
        const root = document.querySelector('#root');
        if (root) new MutationObserver(() => {
          if (!root.childElementCount) globalThis.__fileLifecycleEvidence.push({ at: performance.now(), type: 'root-empty' });
        }).observe(root, { childList: true });
      });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?entry=${entry}`);
    const view = page.frameLocator('#app').frameLocator('#view');
    const frame = await (await view.owner().elementHandle()).contentFrame();
    if (!startupFailure) await frame.waitForFunction(() => globalThis.__forgeaxViewReady?.mounted?.transport?.connected === true, undefined, { timeout: 60000 });
    console.error(`${entry}: ${startupFailure ? 'full View frame loaded; connection unverified' : 'full View connected'}`);
    return { page, view, frame };
  };
  if (startupFailure) {
    const requestedRoot = workspaceBackendRoot(binding, chatMeta.threadId);
    await mkdir(requestedRoot, { recursive: true });
    const root = await realpath(requestedRoot); roots.add(root);
    const { startDevKitBackend, stopDevKitBackend, devKitBackendStatus } = await import(pathToFileURL(join(binding.enginePackage, 'dist/facades/devkit.mjs')));
    let file;
    if (!coldReopen) {
    const started = await startDevKitBackend(root, { hostPack: binding.hostPack, viewShell: true });
    records.push({ ordinaryBackend: { root, id: started.id, lifetime: started.lifetime } });
    console.error('Test-only ordinary backend started without clients lifetime');
    file = await newPage('file');
    const begin = Date.now();
    for (;;) {
      const snapshot = await file.frame.evaluate(() => ({ rootChildren: document.querySelector('#root')?.childElementCount,
        rootConnected: document.querySelector('#root')?.isConnected, body: document.body.innerText.slice(-12000),
        ready: globalThis.__forgeaxViewReady && { unconfigured: globalThis.__forgeaxViewReady.unconfigured, error: globalThis.__forgeaxViewReady.error },
        events: globalThis.__fileLifecycleEvidence }));
      records.push({ elapsedMs: Date.now() - begin, attached: !file.frame.isDetached(), snapshot,
        heartbeatCount: records.filter(record => record.action === 'binding-read').length });
      await writeFile(join(evidence, 'startup-failure-progress.json'), JSON.stringify({ errors, consoleErrors, records }, null, 2));
      console.error(`Startup failure ${Math.round((Date.now() - begin) / 1000)}s: rootChildren=${snapshot.rootChildren}; events=${JSON.stringify(snapshot.events)}`);
      if (snapshot.events.some(event => event.type === 'root-empty') || Date.now() - begin >= (priorOfflineEvidence ? 5000 : 125000)) break;
      await new Promise(done => setTimeout(done, 5000));
    }
    await file.page.screenshot({ path: join(evidence, 'startup-failure-125s.png') });
    const final = records.filter(record => record.snapshot).at(-1);
    if (priorOfflineEvidence) {
      const prior = JSON.parse(await readFile(join(resolve(priorOfflineEvidence), 'startup-failure-progress.json'), 'utf8'));
      const retained = prior.records.filter(record => record.snapshot).at(-1);
      assert.ok(retained.elapsedMs >= 125000 && retained.snapshot.rootChildren > 0 && retained.attached);
      records.push({ prior125sEvidence: resolve(priorOfflineEvidence), elapsedMs: retained.elapsedMs });
    } else assert.ok(final.elapsedMs >= 125000, 'Offline Shell must survive the full file intent deadline');
    assert.ok(final.snapshot.rootChildren > 0 && final.attached, 'Offline Shell and document must remain mounted');
    assert.match(final.snapshot.body, /Backend lifetime differs from this caller/, 'The ordinary backend and file page must address the same H');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await stopDevKitBackend(root);
    const currentView = file.view;
    const startupButton = currentView.locator('.fx-view-project-chooser__actions button').last();
    await startupButton.click();
    // The original intent has reached its deadline. A fresh host notification
    // reactivates the same exact source while the retained Shell reconnects.
    await file.page.evaluate(() => window.fileTestHost.activate());
    } else file = await newPage('file');
    const captureRecovered = async (label, current) => {
      const frame = await (await current.view.owner().elementHandle()).contentFrame();
      let connectionObservations = 0;
      await poll(() => frame.evaluate(() => ({ connected: globalThis.__forgeaxViewReady?.mounted?.transport?.connected === true,
        body: document.body.innerText.slice(-1800) })), value => {
        if (++connectionObservations % 100 === 0) console.error(`${label}: connecting barrier ${JSON.stringify(value)}; backend-start calls=${records.filter(record => record.action === 'backend-start').length}`);
        return value.connected;
      }, 60000);
      let stateObservations = 0;
      await poll(() => frame.evaluate(async () => {
        const state = await globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient').getState();
        return { root: state.project?.root, phase: state.projectStatus?.phase, presentation: state.projectDocumentPresentation,
          target: state.projectTarget, document: state.projectDocument, error: document.querySelector('#view-file-error')?.textContent };
      }), value => {
        records.push({ label, runningBarrier: value });
        if (++stateObservations % 100 === 0) console.error(`${label}: running/presenter barrier ${JSON.stringify(value)}`);
        if (value.error) throw new Error(value.error);
        return value.root === project && value.phase === 'running' && value.presentation === 'presenter' && !!value.target?.targetId && !!value.document;
      }, 60000);
      const opened = await poll(() => frame.evaluate(async source => {
        const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
        const state = await client.getState();
        const assets = state.project ? (await client.listAssets(state.project.id)).assets : [];
        const outputs = assets.filter(asset => (asset.sourcePath ?? asset.path) === source || (asset.sourcePath ?? asset.path) === `${state.project.root}/${source}`);
        return { projectRoot: state.project?.root, phase: state.projectStatus?.phase, guid: state.scenePreview?.asset?.guid ?? state.preview?.asset?.guid,
          exactOutputs: outputs.map(asset => ({ guid: asset.guid, kind: asset.kind, sourcePath: asset.sourcePath ?? asset.path })) };
      }, 'assets/world/world.scene.pack.json'), state => state.projectRoot === project && state.phase === 'running' && state.exactOutputs.length === 1 && state.guid === state.exactOutputs[0].guid, 120000);
      const preview = current.view.locator('iframe[data-forgeax-project-document]');
      await preview.waitFor({ state: 'visible', timeout: 120000 });
      const sceneFrame = await (await preview.elementHandle()).contentFrame();
      await sceneFrame.waitForFunction(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60, undefined, { timeout: 120000 });
      const png = await preview.screenshot(); await writeFile(join(evidence, `${label}.png`), png);
      const pixels = await assertScenePixels(current.page, `data:image/png;base64,${png.toString('base64')}`, label);
      const session = JSON.parse(await readFile(join(tmpdir(), 'forgeax-backend', createHash('sha256').update(root).digest('hex'), 'session.json'), 'utf8'));
      assert.equal(session.lifetime, 'clients');
      records.push({ label, pixels, opened, backend: { root, id: session.id, pid: session.pid, lifetime: session.lifetime }, project });
      console.error(`${label}: same H, clients lifetime, original file Scene pixels passed`);
      return session;
    };
    const first = await captureRecovered('same-page-recovered', file);
    await file.page.evaluate(() => window.fileTestHost.close()); await file.page.close();
    await client.close(); await app.close();
    await poll(() => devKitBackendStatus(root), state => state.phase === 'stopped', 30000);
    console.error('All test MCP users closed; clients backend stopped automatically');
    ({ routing, app, client } = await createSession());
    file = await newPage('file');
    const second = await captureRecovered('mcp-reopened', file);
    assert.notEqual(second.pid, first.pid); assert.notEqual(second.id, first.id);
    records.push({ lifecycle: 'normal clients MCP close/reopen retains exact H and source project; fresh PID' });
    console.log(JSON.stringify({ passed: true, evidence, native: 'unverified' }));
  } else if (measureSwitches) {
    assert.ok(secondScenePath, 'Switch measurements require the authored second scene');
    const originalPath = 'assets/world/world.scene.pack.json';
    entryPaths.set('file-A', join(project, originalPath));
    entryPaths.set('file-B', join(project, secondScenePath));
    const stateOf = current => current.frame.evaluate(async () => {
      const state = await globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient').getState();
      return { phase: state.projectStatus?.phase, presentation: state.projectDocumentPresentation,
        document: state.projectDocument && { sessionId: state.projectDocument.sessionId, targetId: state.projectDocument.targetId, generation: state.projectDocument.browserGeneration },
        asset: state.scenePreview?.asset ?? state.preview?.asset, error: document.querySelector('#view-file-error')?.textContent };
    });
    const finish = async (current, label, source, since, frameFloor = 60) => {
      let lastReport = 0;
      await poll(() => stateOf(current), state => {
        if (performance.now() - lastReport > 5000) { lastReport = performance.now(); console.error(`${label}: waiting ${JSON.stringify(state)}`); }
        if (state.error) throw new Error(state.error);
        return state.phase === 'running' && state.presentation === 'presenter' && state.asset?.path === source;
      }, 180000);
      mark('exact-asset-state', { label });
      const preview = current.view.locator('iframe[data-forgeax-project-document]');
      await preview.waitFor({ state: 'visible', timeout: 180000 });
      const frame = await (await preview.elementHandle()).contentFrame();
      const baselineFrame = await frame.evaluate(() => document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0);
      await frame.waitForFunction(floor => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= floor, Math.max(frameFloor, baselineFrame + 60), { timeout: 180000 });
      const end = mark('60-frames-visible', { label });
      const state = await stateOf(current);
      measurements.push({ label, source, start: since.at, end: end.at, elapsedMs: end.at - since.at, state });
      await writeFile(join(evidence, 'timing-progress.json'), JSON.stringify({ measurements, timeline }, null, 2));
      console.error(`${label}: ${(end.at - since.at).toFixed(1)}ms; document=${JSON.stringify(state.document)}`);
    };
    let start = mark('activation', { label: 'cold-file-A' });
    const first = await newPage('file-A');
    await finish(first, 'cold-file-A', originalPath, start);
    start = mark('activation', { label: 'file-A-to-B' });
    const second = await newPage('file-B');
    await finish(second, 'file-A-to-B', secondScenePath, start);
    start = mark('activation', { label: 'file-B-to-A-existing-tab' });
    await first.page.bringToFront();
    await first.page.evaluate(() => window.fileTestHost.activate());
    await finish(first, 'file-B-to-A-existing-tab', originalPath, start);
    const catalog = await first.frame.evaluate(async () => {
      const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
      await client.call('presentation.panel.reveal', { panelId: 'content-browser' });
      const state = await client.getState(); return (await client.listAssets(state.project.id)).assets;
    });
    for (const [label, source] of [['CB-A-to-B', secondScenePath], ['CB-B-to-A', originalPath]]) {
      const asset = catalog.find(asset => (asset.sourcePath ?? asset.path) === source); assert.ok(asset);
      const preview = first.view.locator('iframe[data-forgeax-project-document]');
      const scene = await (await preview.elementHandle()).contentFrame();
      const floor = await scene.evaluate(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) + 60);
      const panel = first.view.locator('[data-testid="panel-content-browser"]');
      await panel.waitFor({ state: 'visible' });
      await panel.locator('.cb-address').click();
      await panel.locator('.cb-address-input').fill(source.slice(0, source.lastIndexOf('/')));
      await panel.locator('.cb-address-input').press('Enter');
      const pack = panel.locator(`[data-cb-path="${source}"]`);
      const card = panel.locator(`[data-cb-guid="${asset.guid}"]`);
      await poll(async () => await card.isVisible() || await pack.isVisible(), visible => visible);
      if (!await card.isVisible() && await pack.isVisible()) await pack.click();
      assert.ok(await card.isVisible(), `CB scene card is unavailable for ${source}`);
      start = mark('activation', { label });
      await first.view.locator(`[data-testid="panel-content-browser"] [data-cb-guid="${asset.guid}"]`).dblclick();
      await finish(first, label, source, start, floor);
    }
    console.log(JSON.stringify({ passed: true, evidence, measurements }));
  } else {
  const ordinary = await newPage('ordinary');
  const global = await routing.route('global', chatMeta);
  const globalBefore = await global.service.open();
  const ordinaryState = await ordinary.frame.evaluate(async () => {
    const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
    const state = await client.presentProject(); return { clientId: client.clientId, project: state.project };
  });
  assert.equal(ordinaryState.project, null);
  let filePage = await newPage('file');
  const probe = () => filePage.frame.evaluate(async () => {
    const mounted = globalThis.__forgeaxViewReady?.mounted;
    const client = mounted?.frontendHost.context.get('viewOperationClient');
    const state = client ? await client.getState() : undefined;
    const owner = mounted?.frontendHost.context.get('viewProjectDocumentFrameOwner', false)?.getSnapshot();
    return { connected: !!mounted?.transport?.connected, hasClient: !!client, clientId: client?.clientId,
      project: state?.project, phase: state?.projectStatus?.phase, presentation: state?.projectDocumentPresentation,
      previewAsset: state?.scenePreview?.asset ?? state?.preview?.asset,
      projectDocument: state?.projectDocument ? { sessionId: state.projectDocument.sessionId, targetId: state.projectDocument.targetId, browserGeneration: state.projectDocument.browserGeneration } : null,
      frameOwner: owner && { phase: owner.phase, document: owner.document && { sessionId: owner.document.sessionId, targetId: owner.document.targetId, browserGeneration: owner.document.browserGeneration }, frameConnected: owner.frame?.isConnected },
      error: document.querySelector('#view-file-error')?.textContent };
  });
  let observations = 0;
  const ready = await poll(probe, state => {
    if (++observations % 100 === 0) console.error(`file activation state: ${JSON.stringify(state)}; file-context calls=${records.filter(record => record.action === 'file-context').length}`);
    if (state.error) { records.push({ fileFailureState: state }); throw new Error(state.error); }
    return state.project?.root === project && state.phase === 'running';
  }, 180000);
  assert.equal(ready.presentation, 'presenter');
  assert.ok(records.some(record => record.entry === 'file' && record.action === 'file-context'), 'ctx.inject must attach the real client and resolve pending activation');
  const capture = async label => {
    const preview = filePage.view.locator('iframe[data-forgeax-project-document]');
    await preview.waitFor({ state: 'visible', timeout: 180000 });
    const frame = await (await preview.elementHandle()).contentFrame();
    await frame.waitForFunction(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60, undefined, { timeout: 180000 });
    await assertNoRuntimeFailure(frame, label, errors, consoleErrors);
    const png = await preview.screenshot(); await writeFile(join(evidence, `${label}.png`), png);
    const pixels = await assertScenePixels(filePage.page, `data:image/png;base64,${png.toString('base64')}`, label);
    records.push({ label, pixels, ready: await probe() }); console.error(`${label}: populated Scene pixels passed`);
    return png;
  };
  if (rapidFiles || !multiOnly) await capture('cold-file');
  assert.equal((await ordinary.frame.evaluate(async () => (await globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient').getState()).projectDocumentPresentation)), 'observer');
  assert.deepEqual(await global.service.open(), globalBefore);
  const selected = await routing.route('workspace', chatMeta);
  assert.equal(selected.directory, temp, 'file activation must not rebind the chat working directory');
  if (!multiOnly && !rapidFiles) {
  await ordinary.frame.evaluate(async () => { await globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient').presentProject(); });
  await filePage.page.evaluate(() => window.fileTestHost.activate());
  await poll(probe, state => state.presentation === 'presenter');
  await capture('repeat-file');
  selectedPath = join(project, 'assets/missing.pack.json');
  await filePage.page.evaluate(() => window.fileTestHost.activate('missing.pack.json'));
  await poll(probe, state => !!state.error);
  await filePage.page.evaluate(() => window.fileTestHost.cancel());
  await poll(probe, state => !state.error);
  selectedPath = join(project, 'assets/world/world.scene.pack.json');
  await filePage.page.evaluate(() => window.fileTestHost.activate());
  await capture('recovered-file');
  await filePage.page.evaluate(() => window.fileTestHost.reopen());
  await capture('reopened-file');
  }
  if (rapidFiles) {
    assert.ok(secondScenePath && multiPackPath, 'Rapid file verification requires a second scene and multi-output Pack');
    entryPaths.set('file-archway', join(project, secondScenePath));
    const original = filePage;
    const originalState = await probe();
    filePage = await newPage('file-archway');
    if (!overlapFiles) await poll(probe, state => {
      records.push({ rapidStage: 'archway-phase-history', state });
      if (state.error) throw new Error(state.error);
      return state.phase === 'running' && state.presentation === 'presenter' && !!state.previewAsset?.guid && state.previewAsset.guid !== originalState.previewAsset?.guid;
    }, 60000);
    records.push({ rapidStage: 'archway-current-file-document', state: await probe() });
    if (!overlapFiles) await capture('archway-file');
    entryPaths.set('file-pack', join(project, multiPackPath));
    const archway = filePage;
    filePage = await newPage('file-pack');
    await poll(probe, state => {
      records.push({ rapidStage: 'pack-phase-history', state });
      if (state.error) throw new Error(state.error);
      return state.phase === 'running' && state.presentation === 'presenter' && !!state.projectDocument;
    }, 60000);
    for (const previous of [original, archway]) assert.equal(await previous.frame.evaluate(async () => (await globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient').getState()).projectDocumentPresentation), 'observer');
    records.push({ rapidStage: 'pack-current-file-document', state: await probe() });
  }
  if (secondScenePath && !multiOnly && !rapidFiles) {
    const before = await probe();
    const firstPng = await filePage.view.locator('iframe[data-forgeax-project-document]').screenshot();
    selectedPath = join(project, secondScenePath);
    const start = records.length;
    await filePage.page.evaluate(name => window.fileTestHost.activate(name), secondScenePath.split('/').at(-1));
    await poll(async () => ({ state: await probe(), opened: records.slice(start).some(record => record.entry === 'file' && record.operation === 'asset.open') }), value => {
      if (value.state.error) throw new Error(value.state.error);
      return value.opened && value.state.previewAsset?.guid && value.state.previewAsset.guid !== before.previewAsset?.guid;
    });
    const secondPng = await capture('second-scene');
    assert.notDeepEqual(secondPng, firstPng, 'Second source must render a different authored scene');
    await filePage.page.screenshot({ path: join(evidence, 'second-scene-full-view.png') });
  }
  if (multiPackPath) {
    const catalog = await filePage.frame.evaluate(async source => {
      const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
      const state = await client.getState();
      const assets = (await client.listAssets(state.project.id)).assets;
      return assets.filter(asset => (asset.sourcePath ?? asset.path) === source || (asset.sourcePath ?? asset.path) === `${state.project.root}/${source}`);
    }, multiPackPath);
    assert.equal(catalog.length, 4, `Running project must publish four outputs for ${multiPackPath}: ${JSON.stringify(catalog)}`);
    assert.deepEqual(catalog.map(asset => asset.kind).sort(), ['material', 'mesh', 'mesh', 'scene']);
    const scene = catalog.find(asset => asset.kind === 'scene');
    const before = await probe(), start = records.length;
    selectedPath = join(project, multiPackPath);
    await filePage.page.evaluate(name => window.fileTestHost.activate(name), multiPackPath.split('/').at(-1));
    const panel = filePage.view.locator('[data-testid="panel-content-browser"]');
    const sourceCard = panel.locator(`[data-cb-path="${multiPackPath}"]`);
    await poll(async () => ({ visible: await sourceCard.isVisible(), state: await probe() }), value => {
      records.push({ rapidStage: rapidFiles ? 'pack-reveal-awaiting-source' : undefined, state: value.state });
      if (value.state.error) throw new Error(value.state.error);
      return value.visible;
    }, 30000);
    await poll(async () => ({ error: (await probe()).error, selected: await sourceCard.getAttribute('aria-selected'), className: await sourceCard.getAttribute('class'),
      children: await panel.locator(`[data-cb-group="${multiPackPath}"][data-cb-guid]`).count() }), value => {
      if (value.error) throw new Error(value.error);
      return value.selected === 'true' && value.className?.includes('cb-pack-expanded') && value.children === 4;
    });
    const children = panel.locator(`[data-cb-group="${multiPackPath}"][data-cb-guid]`);
    const choices = await children.evaluateAll(elements => elements.map(element => ({ guid: element.getAttribute('data-cb-guid'), text: element.textContent })));
    assert.deepEqual(choices.map(choice => choice.guid).sort(), catalog.map(asset => asset.guid).sort());
    assert.equal(records.slice(start).some(record => record.operation === 'asset.open'), false, 'Multiple outputs must await the user child choice');
    assert.equal((await probe()).previewAsset?.guid, before.previewAsset?.guid);
    const detailRail = panel.locator('.cb-preview-rail');
    const detailDockExpanded = await detailRail.count() ? await detailRail.getAttribute('aria-expanded') === 'true' : false;
    records.push({ multiPackPath, choices, catalog, detailDockExpanded });
    console.error(`multi-pack: exact source selected/expanded with four children; detail dock expanded=${detailDockExpanded}`);
    await filePage.page.screenshot({ path: join(evidence, 'multi-pack-choices.png') });
    // Select the exact scene child via the real Content Browser card.
    const sceneCard = panel.locator(`[data-cb-group="${multiPackPath}"][data-cb-guid="${scene.guid}"]`);
    await sceneCard.dblclick();
    await poll(probe, state => { if (state.error) throw new Error(state.error); return state.previewAsset?.guid === scene.guid; });
    await capture('multi-pack-scene-child');
    await filePage.page.screenshot({ path: join(evidence, 'multi-pack-scene-full-view.png') });
    assert.ok(records.slice(start).some(record => record.operation === 'asset.open'), 'Chosen child must open through the existing owner');
  }
  await filePage.page.evaluate(() => window.fileTestHost.close());
  assert.equal(await filePage.page.locator('#app').count(), 0);
  assert.equal((await ordinary.frame.evaluate(async () => (await globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient').getState()).project.root)), project);
  records.push({ lifecycle: 'file teardown preserves ordinary chat View', generated });
  if (rapidFiles) for (const page of pages.filter(page => !page.isClosed())) for (const frame of page.frames()) {
    const uiErrors = await frame.evaluate(() => (globalThis.__fileLifecycleEvidence ?? []).filter(event => event.type === 'error-ui'));
    records.push({ rapidUiErrors: uiErrors });
    assert.deepEqual(uiErrors, [], 'Rapid file switching must not report workspace or file-open errors');
  }
  console.log(JSON.stringify({ passed: true, evidence, boundary: 'Real full View browser simulation; native Codex clicking remains unverified' }));
  }
} catch (error) {
  failure = String(error); console.error(failure);
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]; await page.screenshot({ path: join(evidence, `failure-${index}.png`) }).catch(() => {});
    for (const frame of page.frames()) records.push({ failureFrame: index, body: (await frame.locator('body').innerText().catch(() => '?')).slice(-20000) });
  }
  process.exitCode = 1;
} finally {
  clearInterval(liveTimer);
  await browser?.close(); await client.close(); await app.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  const { stopDevKitBackend } = await import(pathToFileURL(join(binding.enginePackage, 'dist/facades/devkit.mjs')));
  for (const root of roots) await stopDevKitBackend(root).catch(error => records.push({ cleanup: String(error) }));
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ sourceProject, engine, failure, errors, consoleErrors, records, roots: [...roots] }, null, 2));
  if (measureSwitches) await writeFile(join(evidence, 'timing.json'), JSON.stringify({ measurements, timeline, failure }, null, 2));
  await rm(temp, { recursive: true, force: true });
}
