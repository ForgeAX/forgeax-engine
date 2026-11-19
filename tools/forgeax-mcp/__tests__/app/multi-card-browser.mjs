import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_VERSION, RESOURCE_CARD_TOOL, RESOURCE_VIEW_TOOL, RESOURCE_ACTION_TOOL } from '../../src/contract.ts';
import { workspaceBackendRoot } from '../../src/codex-routing.mjs';
import { assertScenePixels } from '../../test/app/acceptance.mjs';

const [pluginArg, projectArg, evidenceArg] = process.argv.slice(2);
const remainderOnly = process.env.FORGEAX_MULTI_CARD_REMAINDER_ONLY === '1';
const singleOnly = process.env.FORGEAX_MULTI_CARD_SINGLE_ONLY === '1';
if (!pluginArg || !projectArg) throw new Error('Usage: multi-card-browser.mjs <plugin-directory> <populated-source-project> [evidence-directory]');
const plugin = await realpath(resolve(pluginArg));
const sourceProject = await realpath(resolve(projectArg));
const evidence = evidenceArg ? resolve(evidenceArg) : await mkdtemp(join(tmpdir(), 'forgeax-multi-card-evidence-'));
await mkdir(evidence, { recursive: true });
const temp = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-multi-card-browser-')));
const project = join(temp, 'consumer');
const binding = JSON.parse(await readFile(join(plugin, 'hosting.json'), 'utf8'));
const engine = resolve(binding.enginePackage, '../..');
await cp(sourceProject, project, { recursive: true, filter: path => !['node_modules', '.forgeax', '.git'].includes(path.split('/').at(-1)) });
await symlink(join(engine, 'node_modules'), join(project, 'node_modules'), 'dir');
binding.root = join(temp, 'global');
binding.codexContext = { home: temp, command: join(temp, 'codex') };
const codex = `#!${process.execPath}\nimport readline from 'node:readline';\nreadline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);\nif(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');\nif(m.method==='thread/read')process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId,cwd:${JSON.stringify(temp)}}}})+'\\n');});\n`;
await writeFile(binding.codexContext.command, codex, { mode: 0o700 });
await writeFile(join(temp, 'hosting.json'), JSON.stringify(binding));
const meta = { threadId: randomUUID(), 'openai/resource': { path: join(project, 'never-use-host-meta.pack.json') } };
const root = workspaceBackendRoot(binding, meta.threadId);
const sources = ['assets/world/world.scene.pack.json', 'assets/world/archway.scene.pack.json', 'assets/link-demo.pack.ts'];
for (const source of sources) await readFile(join(project, source));
const entries = new Map(), actions = [], milestones = [], errors = [], consoleErrors = [], cleanup = [];
const diagnostics = [];
let client, browser, server, page, failure;
const snapshot = async label => {
  if (!page || page.isClosed()) return;
  const host = await page.evaluate(() => ({ requests: window.multiCardHost?.requests(), owners: window.multiCardHost?.snapshot(),
    events: globalThis.__cardEvents, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } })).catch(error => ({ error: String(error) }));
  const carriers = [];
  for (const frame of page.frames().filter(value => value.url().includes('/carrier?id='))) {
    carriers.push(await frame.evaluate(() => {
      const card = document.querySelector('#resource-card');
      return { url: location.href, events: globalThis.__cardEvents, body: document.body.innerText,
        cardHtml: card?.outerHTML, error: document.querySelector('#carrier-error')?.textContent,
        buttons: [...document.querySelectorAll('#resource-card button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { text: button.textContent, disabled: button.disabled, selected: button.getAttribute('aria-pressed'), source: button.dataset.sourcePath,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        }), view: { hidden: document.querySelector('#view')?.hidden, mounted: !!document.querySelector('#view')?.srcdoc } };
    }).catch(error => ({ error: String(error), url: frame.url() })));
  }
  diagnostics.push({ label, at: performance.now(), host, carriers, actions: [...actions], errors: [...errors], consoleErrors: [...consoleErrors] });
  await writeFile(join(evidence, 'click-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
};
const record = async (label, detail = {}) => {
  milestones.push({ label, at: performance.now(), ...detail });
  await writeFile(join(evidence, 'progress.json'), JSON.stringify({ version: APP_VERSION, milestones, actions, errors, consoleErrors }, null, 2));
  console.error(`${label}: ${JSON.stringify(detail)}`);
};
const poll = async (read, accepts, timeout = 75000) => {
  const deadline = Date.now() + timeout; let lastReport = 0;
  for (;;) {
    const state = await read(); if (accepts(state)) return state;
    if (Date.now() - lastReport > 5000) { lastReport = Date.now(); console.error(`barrier: ${JSON.stringify(state)}`); }
    assert.ok(Date.now() < deadline, `Readiness deadline exceeded: ${JSON.stringify(state)}`);
    await new Promise(done => setTimeout(done, 100));
  }
};
try {
  client = new Client({ name: 'multi-card-stdio-verifier', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(plugin, 'src/codex-app-server.mjs'), join(temp, 'hosting.json')],
    cwd: temp, env: { TMPDIR: tmpdir() }, stderr: 'pipe' });
  await client.connect(transport);
  transport.stderr?.on('data', bytes => { void import('node:fs').then(({ appendFileSync }) => appendFileSync(join(evidence, 'stdio.log'), bytes)); });
  assert.equal(client.getServerVersion().version, APP_VERSION);
  const tools = (await client.listTools()).tools;
  const entry = async (id, selected, { warm = false, direct = false } = {}) => {
    const tool = tools.find(value => value.name === (direct ? RESOURCE_VIEW_TOOL : RESOURCE_CARD_TOOL));
    assert.ok(tool);
    const arguments_ = direct ? { path: join(project, selected[0]) } : { paths: selected.map(source => join(project, source)), ...(warm ? { prepareBackend: true } : {}) };
    const result = await client.callTool({ name: tool.name, arguments: arguments_, _meta: meta }, undefined, { timeout: 120000 });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const resource = (await client.readResource({ uri: tool._meta.ui.resourceUri })).contents[0];
    assert.equal(resource._meta['openai/ui'].preferredDisplayMode, direct ? 'fullscreen' : 'inline');
    entries.set(id, { id, initialMode: direct ? 'fullscreen' : 'inline', result, carrier: resource.text });
    return { id, initialMode: direct ? 'fullscreen' : 'inline', result };
  };
  const initial = remainderOnly ? [] : [await entry('single-a', [sources[0]]), await entry('single-b', [sources[1]])];
  const host = (await build({ entryPoints: [join(import.meta.dirname, 'support/multi-card-host.ts')], bundle: true,
    write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text;
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/tool') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const { owner, params } = JSON.parse(Buffer.concat(chunks));
        const row = { owner, tool: params.name, action: params.arguments?.action, sourcePath: params.arguments?.sourcePath,
          documentId: params.arguments?.appDocumentId, operation: params.arguments?.payload?.operation,
          path: params.arguments?.path, operationArgs: params.arguments?.payload?.args, entryScope: params.arguments?.entryScope };
        if (row.action !== 'host-read') actions.push(row);
        const result = await client.callTool({ ...params, _meta: meta }, undefined, { timeout: 120000 });
        row.completed = true;
        if (result.isError) row.error = result.content;
        row.disposition = result.structuredContent?.disposition;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); return;
      }
      response.setHeader('content-type', 'text/html');
      if (url.pathname === '/carrier') {
        response.setHeader('content-security-policy', "frame-src 'none'"); response.end(entries.get(url.searchParams.get('id')).carrier); return;
      }
      response.end(`<!doctype html><style>html,body{margin:0;height:100%}body{padding-right:1050px;box-sizing:border-box}iframe[data-card]{width:370px;height:210px;border:0}iframe.fullscreen{position:fixed;top:0;right:0;width:1050px;height:100vh;z-index:2}</style>${initial.map(value => `<iframe id="${value.id}" data-card="${value.id}" sandbox="allow-scripts" allow="clipboard-write *"></iframe>`).join('')}<script id="test-config" type="application/json">${JSON.stringify({ entries: initial }).replaceAll('<', '\\u003c')}</script><script type="module">${host.replaceAll('</script', '<\\/script')}</script>`);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=SharedArrayBuffer'], chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => {
    globalThis.__cardEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      for (const capture of [true, false]) document.addEventListener(type, event => {
        const target = event.target;
        globalThis.__cardEvents.push({ type, capture, at: performance.now(), trusted: event.isTrusted,
          x: event.clientX, y: event.clientY, target: target?.tagName, id: target?.id,
          source: target?.dataset?.sourcePath, text: target?.textContent?.slice(0, 120), disabled: target?.disabled,
          status: document.querySelector('#resource-card [role="status"]')?.textContent });
        if (globalThis.__cardEvents.length > 200) globalThis.__cardEvents.shift();
      }, capture);
    }
  });
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const card = id => page.frameLocator(`#${id}`);
  const inline = id => page.evaluate(id => window.multiCardHost.inline(id), id);
  const click = async (id, source) => {
    await card(id).locator(`button[data-source-path="${join(project, source)}"]`).click();
    await snapshot(`${id}-after-click`);
    await poll(async () => ({ hidden: !await card(id).locator('#resource-card').isVisible(), error: await card(id).locator('body').evaluate(body => body.querySelector('#carrier-error')?.textContent) }), value => {
      if (value.error) throw new Error(value.error); return value.hidden;
    }, 15000);
  };
  const mounted = async id => {
    const view = card(id).frameLocator('#view');
    await view.locator('#root').waitFor({ state: 'attached', timeout: 30000 });
    const frame = await (await view.owner().elementHandle()).contentFrame();
    return { view, frame };
  };
  const stateOf = current => current.frame.evaluate(async () => {
    const ctx = globalThis.__forgeaxViewReady?.mounted?.frontendHost?.context;
    const client = ctx?.get('viewOperationClient', false);
    const state = client ? await client.getState() : undefined;
    return { project: state?.project, phase: state?.projectStatus?.phase, presentation: state?.projectDocumentPresentation,
      asset: state?.scenePreview?.asset ?? state?.preview?.asset,
      document: state?.projectDocument && { sessionId: state.projectDocument.sessionId, targetId: state.projectDocument.targetId, generation: state.projectDocument.browserGeneration },
      error: document.querySelector('#view-file-error')?.textContent };
  });
  const capture = async (id, label, source, guid) => {
    const current = await mounted(id);
    const state = await poll(() => stateOf(current), value => {
      if (value.error) throw new Error(value.error);
      return value.phase === 'running' && value.presentation === 'presenter' && (guid ? value.asset?.guid === guid : value.asset?.path === source);
    });
    const preview = current.view.locator('iframe[data-forgeax-project-document]');
    await preview.waitFor({ state: 'visible' });
    const sceneFrame = await (await preview.elementHandle()).contentFrame();
    const floor = await sceneFrame.evaluate(() => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) + 60);
    await sceneFrame.waitForFunction(floor => (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= floor, floor, { timeout: 30000 });
    const png = await preview.screenshot(); await writeFile(join(evidence, `${label}.png`), png);
    const pixels = await assertScenePixels(page, `data:image/png;base64,${png.toString('base64')}`, label);
    await record(label, { owner: id, state, pixels, completedFrames: 60 }); return { ...current, state };
  };
  for (const id of ['single-a', 'single-b']) {
    await card(id).locator('#resource-card button').waitFor({ state: 'visible' });
    assert.equal(await card(id).locator('#resource-card button').count(), 1);
    assert.equal(await card(id).locator('#view').getAttribute('srcdoc'), null);
  }
  assert.equal(actions.some(value => ['view-document', 'backend-start', 'host-open'].includes(value.action)), false);
  await record('two-independent-inline-cards', { buttons: [1, 1], backendAcquired: false });
  await click('single-a', sources[0]);
  const first = await capture('single-a', 'single-original-scene', sources[0]);
  const token = await first.frame.evaluate(() => globalThis.__multiCardToken = crypto.randomUUID());
  const reusedClick = async (id, source) => {
    const start = actions.length;
    await card(id).locator(`button[data-source-path="${join(project, source)}"]`).click();
    await poll(async () => ({ rows: actions.slice(start).filter(value => value.tool === RESOURCE_ACTION_TOOL),
      error: await card(id).locator('body').evaluate(body => body.querySelector('#carrier-error')?.textContent) }), value => {
      if (value.error) throw new Error(value.error);
      return value.rows.some(row => row.completed && row.disposition === 'reused');
    }, 30000);
    assert.equal(await card(id).locator('#resource-card').isVisible(), true);
    assert.equal(await card(id).locator('#view').getAttribute('srcdoc'), null);
    await snapshot(`${id}-reused-complete`);
  };
  await reusedClick('single-b', sources[1]);
  const second = await capture('single-a', 'reused-archway-scene', sources[1]);
  assert.equal(await second.frame.evaluate(() => globalThis.__multiCardToken), token);
  assert.deepEqual(second.state.document, first.state.document);
  const grouped = await entry('grouped', sources);
  await page.evaluate(value => window.multiCardHost.add(value), grouped);
  assert.equal(await card('grouped').locator('#resource-card button').count(), 3);
  const before = await stateOf(second), start = actions.length;
  await reusedClick('grouped', sources[2]);
  const panel = second.view.locator('[data-testid="panel-content-browser"]');
  const pack = panel.locator(`[data-cb-path="${sources[2]}"]`);
  await poll(async () => ({ visible: await pack.isVisible(), selected: await pack.getAttribute('aria-selected'),
    expanded: (await pack.getAttribute('class'))?.includes('cb-pack-expanded'), children: await panel.locator(`[data-cb-group="${sources[2]}"][data-cb-guid]`).count(), state: await stateOf(second) }), value => {
      if (value.state.error) throw new Error(value.state.error); return value.visible && value.selected === 'true' && value.expanded && value.children === 4;
    }, 30000);
  const catalog = await second.frame.evaluate(async source => {
    const client = globalThis.__forgeaxViewReady.mounted.frontendHost.context.get('viewOperationClient');
    const state = await client.getState(); return (await client.listAssets(state.project.id)).assets.filter(asset =>
      (asset.sourcePath ?? asset.path) === source || (asset.sourcePath ?? asset.path) === `${state.project.root}/${source}`);
  }, sources[2]);
  assert.equal(catalog.length, 4); assert.deepEqual(catalog.map(value => value.kind).sort(), ['material', 'mesh', 'mesh', 'scene']);
  const choices = await panel.locator(`[data-cb-group="${sources[2]}"][data-cb-guid]`).evaluateAll(elements => elements.map(value => value.getAttribute('data-cb-guid')));
  assert.deepEqual(choices.sort(), catalog.map(value => value.guid).sort());
  assert.equal(actions.slice(start).some(value => value.operation === 'asset.open'), false);
  assert.equal((await stateOf(second)).asset?.guid, before.asset?.guid);
  await page.screenshot({ path: join(evidence, 'pack-four-choices.png') });
  await record('pack-four-exact-children-no-autoopen', { owner: 'single-a', choices });
  const scene = catalog.find(value => value.kind === 'scene');
  await panel.locator(`[data-cb-group="${sources[2]}"][data-cb-guid="${scene.guid}"]`).dblclick();
  await capture('single-a', 'pack-chosen-scene', undefined, scene.guid);
  assert.equal(await second.frame.evaluate(() => globalThis.__multiCardToken), token);
  await inline('single-a');
  const reexpandStart = actions.length;
  await page.evaluate(() => window.multiCardHost.fullscreen('single-a'));
  await poll(() => stateOf(second), value => value.phase === 'running' && value.asset?.guid === scene.guid);
  assert.equal(await second.frame.evaluate(() => globalThis.__multiCardToken), token);
  assert.equal(actions.slice(reexpandStart).some(value => value.operation === 'asset.open'), false, 'Reexpand must not replay the first source over the remote selection');
  await record('host-reexpand-retains-remotely-selected-source', { source: scene.guid, token });
  await reusedClick('grouped', sources[0]);
  const returned = await capture('single-a', 'reused-return-original', sources[0]);
  assert.deepEqual(returned.state.document, first.state.document);
  const requests = await page.evaluate(() => window.multiCardHost.requests());
  assert.deepEqual(requests, [{ owner: 'single-a', mode: 'fullscreen' }]);
  assert.equal(actions.filter(value => value.owner !== 'single-a' && ['view-document', 'host-open'].includes(value.action)).length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  await record('same-presenter-reuse-complete', { requests, errors, consoleErrors, native: 'unverified' });
  console.log(JSON.stringify({ passed: true, evidence, version: APP_VERSION, native: 'unverified' }));
} catch (error) { failure = String(error); process.exitCode = 1; console.error(failure); await snapshot('failure').catch(() => {}); await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {}); }
finally {
  await browser?.close(); await client?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  const { stopDevKitBackend, devKitBackendStatus } = await import(pathToFileURL(join(binding.enginePackage, 'dist/facades/devkit.mjs')));
  for (const ownedRoot of [binding.root, root]) {
    await stopDevKitBackend(ownedRoot).catch(error => cleanup.push({ root: ownedRoot, error: String(error) }));
    cleanup.push({ root: ownedRoot, phase: (await devKitBackendStatus(ownedRoot)).phase });
  }
  await rm(temp, { recursive: true, force: true });
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: !failure, version: APP_VERSION, failure, milestones, actions, errors, consoleErrors, cleanup,
    temporaryProjectRemoved: true, native: 'unverified' }, null, 2));
}
