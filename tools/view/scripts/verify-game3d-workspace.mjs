import assert from 'node:assert/strict';
import { browserProofWorkload } from './browser-proof-workload.mjs';
const workload = browserProofWorkload();
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { connectViewWorkspace } from '@forgeax/view/workspace/resident';

const checkout = resolve(process.env.FORGEAX_ENGINE_CHECKOUT ?? '.ci/forgeax-engine');
const localEngine = process.env.FORGEAX_LOCAL_ENGINE === '1';
const engine = localEngine ? join(checkout, 'packages/engine') : dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const { runUnifiedCli } = await import(localEngine ? pathToFileURL(join(engine, 'dist/facades/devkit.mjs')).href : '@forgeax/engine/devkit');
const view = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'view-game3d-proof-'));
const viewStartInput = JSON.stringify({ root, frontendConfig: { layout: { responsiveAutoTuck: false } } });
let browser;
let page;
let workspace;
let backendPid;
const command = async (...args) => {
  const result = await runUnifiedCli([...args, '--root', root, '--json']);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const errors = [];
let preparationRequestId;
let preparationCancelled = false;
const requests = new Set();
const requestStarts = new WeakMap();
const failuresDuringViewStop = [];
let stoppingView = false;
let phase = 'startup';
async function assertDetached(frame) {
  const deadline = Date.now() + 10_000;
  while (!frame.isDetached() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(frame.isDetached(), true, 'Play stop must remove its game document before View restarts');
}
try {
  await cp(join(checkout, 'templates/game-3d/assets'), join(root, 'assets'), { recursive: true });
  if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1') {
    // Change only the disposable project; keep every authored light and cascade.
    const scenePath = join(root, 'assets/scene.pack.ts');
    const scene = await readFile(scenePath, 'utf8');
    const directional = scene.match(/DirectionalLight:\s*\{([^{}]*)\}/);
    assert.ok(directional, 'view-ci-shadow-fixture-changed');
    const body = directional[1];
    const explicitSize = body.match(/\bmapSize:\s*(\d+)\s*,/);
    assert.ok(!/\bmapSize\s*:/.test(body) || explicitSize, 'view-ci-shadow-fixture-changed');
    const bounded = explicitSize
      ? body.replace(explicitSize[0], `mapSize: ${Math.min(Number(explicitSize[1]), 256)},`)
      : ` mapSize: 256,${body}`;
    await writeFile(scenePath, scene.replace(directional[0], directional[0].replace(body, bounded)));
  }
  const manifest = JSON.parse(await readFile(join(checkout, 'templates/game-3d/forge.json'), 'utf8'));
  await writeFile(join(root, 'forge.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-game3d-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'), 'dir');
  await symlink(view, join(root, 'node_modules/@forgeax/view'), 'dir');
  if (localEngine) {
    const binding = await command('project', 'engine', 'use-local', checkout);
    assert.equal(binding.mode, 'local');
    assert.equal(binding.resolved.root, checkout);
    assert.equal((await command('project', 'engine', 'check')).healthy, true);
    console.error('direct local Engine binding', binding.resolved.entry);
  }
  browser = await chromium.launch({
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    ...(!process.env.FORGEAX_BROWSER_EXECUTABLE && process.env.FORGEAX_CHROME_CHANNEL
      ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
      : {}),
    headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: workload.gameViewport });
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    let message;
    try { message = JSON.parse(payload.toString()); } catch { return; }
    if (message.kind === 'request' && message.payload?.operation === 'play.start' && preparationRequestId === undefined)
      preparationRequestId = message.id;
    if (message.kind === 'cancel' && message.id === preparationRequestId) preparationCancelled = true;
  }));
  await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });
  await page.addInitScript(() => {
    const progress = globalThis.__gpuProof = { stage: 'document', calls: {}, resolved: {}, pending: {} };
    const gpu = navigator.gpu;
    if (!gpu) return;
    const requestAdapter = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...args) => {
      progress.stage = 'adapter-requested';
      const adapter = await requestAdapter(...args);
      progress.stage = 'adapter-ready';
      if (!adapter) return adapter;
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...args) => {
        progress.stage = 'device-requested';
        const device = await requestDevice(...args);
        progress.stage = 'device-ready';
        for (const name of ['createShaderModule', 'createRenderPipeline', 'createComputePipeline', 'createRenderPipelineAsync', 'createComputePipelineAsync', 'popErrorScope']) {
          const original = device[name].bind(device);
          device[name] = (...args) => {
            progress.calls[name] = (progress.calls[name] ?? 0) + 1;
            const result = original(...args);
            if (name === 'createShaderModule') {
              const compilation = result.getCompilationInfo.bind(result);
              result.getCompilationInfo = async () => {
                progress.calls.compilation = (progress.calls.compilation ?? 0) + 1;
                const key = String(progress.calls.compilation);
                progress.pending[key] = { label: args[0].label, bytes: args[0].code.length, started: Date.now() };
                const info = await compilation();
                delete progress.pending[key];
                progress.resolved.compilation = (progress.resolved.compilation ?? 0) + 1;
                return info;
              };
            }
            if (result?.then) return result.then(value => { progress.resolved[name] = (progress.resolved[name] ?? 0) + 1; return value; });
            progress.resolved[name] = (progress.resolved[name] ?? 0) + 1;
            return result;
          };
        }
        return device;
      };
      return adapter;
    };
  });
  page.on('request', request => {
    requests.add(request);
    const url = new URL(request.url());
    let frame;
    try { frame = request.frame(); } catch {}
    const frameUrl = frame?.url();
    requestStarts.set(request, {
      phase, origin: url.origin, path: url.pathname,
      mainFrame: frame === page.mainFrame(),
      targetId: frameUrl?.startsWith('http') ? new URL(frameUrl).searchParams.get('forgeaxWorkspaceTarget') : null,
    });
  });
  page.on('requestfinished', request => requests.delete(request));
  page.on('requestfailed', request => {
    requests.delete(request);
    const path = new URL(request.url()).pathname;
    if (stoppingView) failuresDuringViewStop.push(path);
    console.error('REQUEST', { ...requestStarts.get(request), failedDuring: phase, failure: request.failure() });
  });
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE', error.message); });
  page.on('console', message => { if (message.type() === 'error') {
    if (!(stoppingView && message.text() === 'Failed to load resource: net::ERR_CONNECTION_REFUSED')) errors.push(message.text());
    console.error('CONSOLE', message.text());
  } });
  backendPid = (await command('backend', 'start', '--host-pack', join(view, 'host.pack.json'))).pid;
  const viewState = await command('view', 'start', '--input', viewStartInput);
  const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap', viewState.url)).then(response => response.json());
  workspace = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'game3d-proof' });
  await page.goto(viewState.url);
  assert.equal(new URL(viewState.url).searchParams.get('project'), await realpath(root));
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 60_000 });
  await page.waitForURL(url => url.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 300_000 });
  const originalWorkspaceTarget = new URL(page.url()).searchParams.get('forgeaxWorkspaceTarget');
  await workspace.listAssets(manifest.id, { targetId: originalWorkspaceTarget });
  console.error('default backend -> View URL -> automatic project opening passed');
  const content = page.getByTestId('panel-content-browser');
  await content.waitFor({ state: 'attached' });
  if (!(await content.isVisible())) {
    await page.locator('.fx-view-workspace-row.is-active .dv-groupview-edge .dv-tab')
      .filter({ hasText: /^Content Browser$/ }).click();
  }
  await content.waitFor({ state: 'visible' });
  // The initial folder is assets; explicitly exercise root-to-assets navigation.
  await content.locator('.cb-address-crumb > [data-action="content-browser.navigate"]').click();
  await content.locator('.cb-grid-folder').filter({ hasText: /^assets$/ }).click();
  await content.locator('[data-action="content-browser.activate"]').click();
  const sceneAsset = (await workspace.getState()).assets.find(asset => asset.kind === 'scene');
  assert.ok(sceneAsset);
  const sceneName = (sceneAsset.path ?? sceneAsset.sourcePath ?? '').toLowerCase().endsWith('.pack.ts')
    ? sceneAsset.sourceKey ?? sceneAsset.name ?? sceneAsset.label ?? sceneAsset.guid
    : sceneAsset.name ?? sceneAsset.label ?? sceneAsset.guid;
  assert.equal(await content.locator('.cb-file-card[data-cb-path="assets/scene.pack.ts"]').count(), 0,
    'a single-output Pack presents its resource directly');
  const scene = content.locator('.cb-grid-item').filter({ has: page.getByText(sceneName, { exact: true }) });
  await scene.click();
  await page.screenshot({ path: '/tmp/view-game3d-open-asset.png' });
  await scene.press('Enter');
  await page.getByTestId('panel-hierarchy').getByText('Ground', { exact: true }).waitFor({ timeout: 60_000 });
  const opened = await workspace.getState();
  const target = opened.preview.target;
  const args = { targetId: target.targetId, targetGeneration: target.generation };
  const tree = await workspace.getSceneTree(args);
  const named = name => { const node = tree.nodes.find(row => row.name === name); assert.ok(node, `game-3d must expose ${name}`); return node; };
  const player = named('Player');
  const body = named('Player Body');
  const ground = named('Ground');
  assert.equal(body.parentId, player.entityId);
  assert.ok(ground.componentNames.includes('MeshFilter'));
  await page.getByTestId('panel-hierarchy').getByText('Ground', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('panel-content-browser').getByText('..', { exact: true }).count(), 0, 'external sources must not become parent-navigation folders');
  await workspace.call('scene.select', { ...args, entityId: body.entityId });
  await page.waitForFunction(id => document.querySelector('[data-testid="panel-inspector"]')?.getAttribute('data-entity-id') === id, body.entityId);
  await page.getByText('Player Body', { exact: true }).first().waitFor();
  const inspected = await workspace.call('entity.inspect', { ...args, entityId: body.entityId });
  assert.ok(inspected.components.some(component => component.name === 'Transform'));
  const details = page.getByTestId('insp-entity-body');
  await details.getByTestId('insp-component-list').waitFor();
  assert.equal(await details.getByTestId('insp-component-list').locator('button').count(), inspected.components.length);
  assert.equal(await details.getByTestId('insp-group-common').getAttribute('aria-checked'), 'true');
  const sceneSelection = await workspace.getState().then(state => state.sceneSelection);
  await details.getByTestId('insp-comprow-MeshFilter').click();
  assert.equal(await details.getAttribute('data-group'), 'all');
  assert.equal(await details.getByTestId('insp-field-Transform-pos').count(), 1);
  for (const component of inspected.components) await details.getByTestId(`insp-section-${component.name}`).waitFor();
  assert.deepEqual((await workspace.getState()).sceneSelection, sceneSelection);
  await details.getByTestId('insp-group-common').click();
  await details.getByTestId('insp-field-Transform-pos').waitFor();
  console.error('PR 3281: real game-3d hierarchy, parent relation, components and View inspection passed');
  // Keep the real Play gesture, including outside-click drawer dismissal. Arm
  // Stop in that browser task, after the client's request microtask but before
  // a server reply can adopt the target. An adopted Stop is a different boundary.
  const playButton = page.locator('[data-action="scene.play"]');
  await playButton.evaluate(button => {
    button.addEventListener('click', () => queueMicrotask(() => {
      const status = [...document.querySelectorAll('[role="status"]')]
        .find(node => node.textContent.includes('Preparing Play'))?.textContent;
      const stop = document.querySelector('[data-action="scene.stop"]');
      globalThis.__preparationCancellation = { status, stopEnabled: !!stop && !stop.disabled };
      stop?.click();
    }), { once: true });
  });
  await playButton.click();
  const preparing = await page.evaluate(() => globalThis.__preparationCancellation);
  assert.match(preparing.status, /Preparing Play/);
  assert.equal(preparing.stopEnabled, true, 'Preparing Play must expose an enabled Stop');
  await page.waitForFunction(() => document.querySelector('[data-action="scene.play"]')?.disabled === false);
  assert.equal(typeof preparationRequestId, 'string', 'preparation must send a real Play request');
  assert.equal(preparationCancelled, true, 'Stop must cancel that exact request through the real transport');
  assert.equal((await workspace.getState()).play, null);
  console.error('Play preparation cancellation through the toolbar passed');
  const preparationStarted = performance.now();
  const play = await workspace.call('play.start', { projectId: manifest.id });
  console.error('Play snapshot and target prepared', { waitMs: Math.round(performance.now() - preparationStarted) });
  const playArgs = { targetId: play.play.target.targetId, targetGeneration: play.play.target.generation };
  console.error('workspace target identities', {
    scene: { targetId: target.targetId, origin: new URL(target.url).origin },
    play: { targetId: play.play.target.targetId, origin: new URL(play.play.target.url).origin },
  });
  const waitingSince = performance.now();
  const progress = setInterval(() => {
    const frame = page.frames().find(frame => frame.url().includes(playArgs.targetId));
    void frame?.evaluate(() => globalThis.__gpuProof).then(value => console.error('game GPU progress', JSON.stringify(value))).catch(() => {});
  }, 15_000);
  try { await workspace.call('play.ready', playArgs); }
  catch (error) {
    console.error('pending requests', [...requests].map(request => new URL(request.url()).pathname));
    console.error('game-3d startup documents', JSON.stringify(await Promise.all(page.frames().map(async frame => ({ url: frame.url().replace(/forgeaxWorkspaceToken=[^&]+/, 'forgeaxWorkspaceToken=REDACTED'), state: await frame.evaluate(() => ({ title: document.title, gpu: globalThis.__gpuProof, text: document.body.innerText.slice(0, 2000), bootstrap: globalThis.__forgeaxRendererBootstrap, execution: globalThis.__forgeaxGameInspection?.renderer(), plugins: globalThis.__forgeaxPluginProjection?.current?.inspect()?.live?.map(({ id, fiberState, requiredServices, providedServices, error }) => ({ id, fiberState, requiredServices, providedServices, error })) })).catch(() => null) }))), null, 2));
    throw error;
  } finally { clearInterval(progress); }
  console.error('game tools ready', { waitMs: Math.round(performance.now() - waitingSince) });
  const sceneFrame = await page.evaluate(() => document.documentElement.dataset.forgeaxFrameSubmitted);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.forgeaxFrameSubmitted), sceneFrame, 'hidden scene preview must release continuous rendering');
  const hiddenCapture = await workspace.capture(args);
  assert.match(hiddenCapture.png, /^data:image\/png/);
  assert.equal((await workspace.getSceneTree(args)).worldId, target.worldId);
  console.error('hidden preview capture and stable World passed');
  const game = page.frames().find(frame => frame.url().includes(playArgs.targetId));
  assert.ok(game);
  try {
    await game.waitForFunction(() => Number(document.documentElement.dataset.forgeaxFrameCompleted ?? 0) >= 60, undefined, { timeout: 180_000 });
  } catch (error) {
    console.error('game frame failure', JSON.stringify(await game.evaluate(() => ({
      submitted: document.documentElement.dataset.forgeaxFrameSubmitted,
      visibility: document.visibilityState,
      gpu: globalThis.__gpuProof,
      renderer: globalThis.__forgeaxGameInspection?.renderer(),
      bootstrap: globalThis.__forgeaxRendererBootstrap,
    }))));
    throw error;
  }
  const liveTree = await workspace.getSceneTree(playArgs);
  const livePlayer = liveTree.nodes.find(row => row.name === 'Player');
  assert.ok(livePlayer);
  const position = async () => (await workspace.call('entity.inspect', { ...playArgs, entityId: livePlayer.entityId })).components.find(component => component.name === 'Transform').values.pos;
  const playerInspection = await workspace.call('entity.inspect', { ...playArgs, entityId: livePlayer.entityId });
  assert.ok(playerInspection.components.some(component => component.name === 'Game3dThirdPersonRig'), 'the ordinary player plugin must be active');
  await game.evaluate(() => {
    globalThis.__inputTrace = [];
    for (const type of ['pointerdown', 'keydown', 'keyup']) window.addEventListener(type, event => {
      globalThis.__inputTrace.push({ type, code: event.code, target: event.target.tagName, focused: document.hasFocus() });
    }, { capture: true });
  });
  const canvas = game.locator('canvas');
  const bounds = await canvas.boundingBox();
  assert.ok(bounds?.width && bounds?.height);
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.waitForFunction(({ x, y, targetId }) => document.elementFromPoint(x, y)?.getAttribute('data-forgeax-scene-play') === targetId,
    { ...center, targetId: playArgs.targetId });
  // Game UI can cover its canvas; use the same visible document gesture as a player.
  await page.mouse.click(center.x, center.y);
  const walk = async () => {
    const frame = await game.evaluate(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted));
    await page.keyboard.down('w');
    try { await game.waitForFunction(before => Number(document.documentElement.dataset.forgeaxFrameSubmitted) >= before + 4, frame, { timeout: 30_000 }); }
    finally { await page.keyboard.up('w'); }
    await page.waitForTimeout(100);
  };
  const before = await position();
  await walk();
  const after = await position();
  console.error('game movement', { before, after, events: await game.evaluate(() => globalThis.__inputTrace) });
  assert.ok(Math.hypot(after[0] - before[0], after[2] - before[2]) > 0.01, 'real game input moves the player');
  await workspace.call('target.control', { ...playArgs, mode: 'observer' });
  const ejected = await position();
  await walk();
  const whileObserving = await position();
  assert.ok(Math.hypot(whileObserving[0] - ejected[0], whileObserving[2] - ejected[2]) < 0.01, 'Eject blocks game input');
  await workspace.call('target.control', { ...playArgs, mode: 'player' });
  await walk();
  const resumed = await position();
  assert.ok(Math.hypot(resumed[0] - whileObserving[0], resumed[2] - whileObserving[2]) > 0.01, 'Possess restores game input');
  assert.equal((await workspace.getSceneTree(playArgs)).worldId, liveTree.worldId);
  await page.screenshot({ path: '/tmp/view-game3d-play.png' });
  phase = 'play-stop';
  await workspace.call('play.stop', playArgs);
  await assertDetached(game);
  assert.equal((await workspace.getState()).preview.target.targetId, target.targetId);
  assert.deepEqual(errors, []);
  workspace.close('View restart proof'); workspace = undefined;
  stoppingView = true;
  phase = 'view-stop';
  await command('view', 'stop');
  assert.equal((await command('backend', 'status')).phase, 'ready');
  const restarted = await command('view', 'start', '--input', viewStartInput);
  phase = 'view-restart';
  await page.goto(restarted.url);
  await page.waitForURL(url => url.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 300_000 });
  stoppingView = false;
  phase = 'restarted';
  assert.notEqual(new URL(page.url()).searchParams.get('forgeaxWorkspaceTarget'), originalWorkspaceTarget);
  console.error('View restart preserves backend; the returned URL directly opens a new target');
  assert.ok(failuresDuringViewStop.every(path => path === '/__forgeax/view/health'), 'only the stopped View health probe may refuse a request');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, boundary: 'game-3d-hierarchy-and-control', entities: tree.nodes.length, worldId: liveTree.worldId, workload }));
} catch (error) {
  await page?.screenshot({ path: '/tmp/view-game3d-failure.png' }).catch(() => {});
  console.error('Game 3D failure documents', JSON.stringify(await Promise.all((page?.frames() ?? []).map(async frame => ({
    url: frame.url().replace(/forgeaxWorkspaceToken=[^&]+/, 'forgeaxWorkspaceToken=REDACTED'),
    state: await frame.evaluate(() => JSON.parse(JSON.stringify({
      gpu: globalThis.__gpuProof, submitted: document.documentElement.dataset.forgeaxFrameSubmitted,
      completed: document.documentElement.dataset.forgeaxFrameCompleted,
      bootstrap: globalThis.__forgeaxRendererBootstrap, execution: globalThis.__forgeaxGameInspection?.renderer(),
      canvases: Array.from(document.querySelectorAll('canvas'), canvas => ({ width: canvas.width, height: canvas.height, visible: canvas.checkVisibility() })),
    }, (_key, value) => value instanceof Error ? { ...value, message: value.message } : value))).catch(() => null),
  }))), null, 2));
  console.error('View failure state', await page?.locator('body').innerText().catch(() => 'Page unavailable'));
  // [ci-diag] the detached backend writes to its own log file, not the job log.
  const backendLog = join(tmpdir(), 'forgeax-backend', createHash('sha256').update(resolve(root)).digest('hex'), 'backend.log');
  console.error('BACKEND-LOG-TAIL', await readFile(backendLog, 'utf8')
    .then(text => text.split('\n').slice(-150).join('\n'))
    .catch(() => '<unavailable>'));
  throw error;
} finally {
  workspace?.close('game3d proof complete');
  await browser?.close();
  await command('backend', 'stop');
  if (backendPid) {
    const deadline = Date.now() + 5000;
    const alive = () => {
      try { process.kill(backendPid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(), false, 'the project backend process must exit after its plugins dispose');
  }
  await rm(root, { recursive: true, force: true });
}
