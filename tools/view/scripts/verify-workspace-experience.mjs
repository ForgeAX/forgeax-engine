import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { connectViewWorkspace } from '../packages/view-workspace-core/src/resident.ts';
import { waitForRenderedViewport } from './verify-page-plugins.mjs';
import { writeProofGameAssets } from './fixtures/plugin-assets.mjs';

assert.ok(process.argv.slice(2).every(arg => arg === '--inject-legacy-history'), 'Unknown experience probe option');
const injectLegacyHistory = process.argv.includes('--inject-legacy-history');
const scenario = injectLegacyHistory ? 'legacy-history' : 'normal';
const root = await mkdtemp(join(tmpdir(), 'view-experience-'));
const canonicalRoot = await realpath(root);
const candidate = await mkdtemp(join(tmpdir(), 'view-experience-package-'));
const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const output = resolve('artifacts/workspace-experience', scenario);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, phase: 'running', scenario }));
let browser, page, client, independent;
const errors = [];
const consoleErrors = [];
const command = async (...args) => {
  const result = await runUnifiedCli([...args, '--root', root, '--json']);
  if (!result.ok && args[0] === 'engine' && args[1] === 'run') {
    const status = await runUnifiedCli(['engine', 'run', 'status', '--root', root, '--json']);
    console.error('Engine run failure status', JSON.stringify(status));
    const observed = await runUnifiedCli(['engine', 'run', 'observe', '--root', root, '--json']);
    console.error('Engine run failure observation', JSON.stringify(observed, (key, value) => key === 'png' ? '<image>' : value));
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const until = async predicate => {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Workspace experience condition timed out');
};
try {
  await mkdir(join(root, 'assets'));
  await cp(join(view, 'scripts/fixtures/workspace-proof.pack.ts'), join(root, 'assets/proof.pack.ts'));
  await cp(join(view, 'scripts/fixtures/workspace-proof.plugin.ts'), join(root, 'assets/game.plugin.ts'));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  for (const file of ['dist', 'package.json', 'README.md', 'host.pack.json'])
    await cp(join(view, file), join(candidate, file), { recursive: true });
  await symlink(join(view, 'node_modules'), join(candidate, 'node_modules'));
  await symlink(candidate, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-experience', type: 'module',
    dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  const roots = await writeProofGameAssets(root);
  await writeFile(join(root, 'forge.json'), JSON.stringify({ id: 'view-experience', name: 'Workspace experience',
    schemaVersion: '3.0.0', roots }));
  independent = await command('engine', 'run', 'start', '--headless', 'true', '--backend', 'software');
  console.error('PASS independent AI run started before View');
  await command('backend', 'start', '--host-pack', join(candidate, 'host.pack.json'));
  const start = await command('view', 'start', '--input', JSON.stringify({
    root, frontendConfig: { layout: { responsiveAutoTuck: false } },
  }));
  assert.equal(new URL(start.url).searchParams.get('project'), canonicalRoot);
  const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap', start.url)).then(value => value.json());
  client = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'experience-proof' });
  await client.call('display.bind', { root, runId: independent.runId });
  assert.equal((await client.getState()).project, null, 'CLI must not open a project');
  browser = await chromium.launch({
    executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE ?? '/opt/google/chrome-beta/chrome',
    headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader',
      '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE', error.message); });
  page.on('console', message => {
    if (message.type() === 'error') { consoleErrors.push(message.text()); console.error('CONSOLE', message.text()); }
  });
  page.on('requestfailed', request => console.error('REQUEST', new URL(request.url()).pathname, request.failure()));
  if (process.env.VIEW_STARTUP_DIAGNOSTICS === '1') await page.addInitScript(() => {
    let startup;
    Object.defineProperty(globalThis, '__forgeaxStartup', {
      configurable: true,
      get: () => startup,
      set(value) {
        startup = { ...value, fail(reason) {
          console.error('STARTUP FAILURE', String(reason), new Error().stack);
          return value.fail(reason);
        } };
      },
    });
  });
  await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });
  await page.goto(start.url);
  await page.waitForURL(url => url.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 60_000 });
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 90_000 });
  const opened = await client.getState();
  assert.equal(opened.project.root, canonicalRoot);
  const assets = await client.listAssets(opened.project.id, { targetId: opened.projectTarget.targetId });
  const scene = assets.assets.find(asset => asset.kind === 'scene');
  const mesh = assets.assets.find(asset => asset.kind === 'mesh' && asset.path === 'assets/proof.pack.ts');
  assert.ok(scene && mesh);
  await client.openAsset(scene.guid, { projectId: opened.project.id });
  await waitForRenderedViewport(page);
  const canvas = page.locator('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas').first();
  assert.equal(await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element;
  }), true, 'The View Shell must not obscure the Engine owner canvas or intercept its clicks');
  await canvas.screenshot({ path: join(output, 'scene-before.png') });
  let bounds = await canvas.boundingBox();
  const positionPointer = async () => {
    await page.waitForFunction(() => !document.pointerLockElement);
    bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  };
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const selected = await until(async () => (await client.getState()).sceneSelection);
  assert.ok(selected.primary?.entityId, 'First click must select an actual entity');
  console.error('PASS first left-click without prior camera input', selected.primary.entityId);
  const target = (await client.getState()).preview.target;
  const identity = { targetId: target.targetId, targetGeneration: target.generation };
  assert.equal(await canvas.evaluate(element => Boolean(element.closest('[data-forgeax-view-workspace="targets"]'))), true,
    'The exact Engine Editor canvas is borrowed into the viewport DOM');
  await client.clearSceneSelection(identity);
  assert.equal((await client.getState()).sceneSelection, null);
  const outputCenter = await canvas.evaluate(element => ({ x: element.width / 2, y: element.height / 2 }));
  await client.call('target.pick', { ...identity, ...outputCenter });
  assert.equal((await client.getState()).sceneSelection, null, 'A domain pick query cannot change View selection');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await until(async () => (await client.getState()).sceneSelection?.primary?.entityId === selected.primary.entityId);
  console.error('PASS explicit query is read-only and View click owns selection');
  const camera = () => client.getCamera(identity);
  const beforeFocus = await camera();
  await page.keyboard.press('f');
  await until(async () => (await camera()).version > beforeFocus.version);
  assert.equal(await page.evaluate(() => Boolean(document.pointerLockElement)), false,
    'Selection and focus must not activate the default gameplay pointer lock');
  console.error('PASS F focuses the actual scene selection');
  const beforeAbort = await camera();
  const interaction = { ...identity, interactionId: 'rollback-proof' };
  await client.beginCamera({ ...interaction, baseVersion: beforeAbort.version });
  await client.updateCamera({ ...interaction, camera: {
    pivot: [1, 2, 3],
    lens: { projection: 'orthographic', left: -2, right: 2, top: 2, bottom: -2 },
  } });
  await client.updateCamera({ ...interaction, input: { type: 'pan', x: 0.02, y: 0.01 } });
  await client.updateCamera({ ...interaction, input: { type: 'dolly', amount: -0.1 } });
  await client.abortCamera(interaction);
  assert.deepEqual((await camera()).camera, beforeAbort.camera,
    'Cancellation restores the actual target pose, lens, exposure and pivot');
  console.error('PASS complete camera rollback through the real browser target');
  const beforeOrbit = await camera();
  await positionPointer();
  await page.keyboard.down('Alt');
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2 + 10);
  await page.mouse.up({ button: 'left' });
  await page.keyboard.up('Alt');
  await until(async () => {
    const state = await camera();
    return state.committed && state.version > beforeOrbit.version;
  });
  assert.equal((await client.getState()).sceneSelection?.primary?.entityId, selected.primary.entityId,
    'View consumes Alt navigation without triggering Engine selection');
  assert.notDeepEqual((await camera()).camera.transform.quat, beforeOrbit.camera.transform.quat);
  console.error('PASS Alt orbit is consumed by View and preserves selection');
  await positionPointer();
  const original = await camera();
  await page.keyboard.down('w');
  await until(async () => (await camera()).camera.transform.pos.some((value, index) =>
    value !== original.camera.transform.pos[index]));
  await page.keyboard.up('w');
  await until(async () => {
    const state = await camera();
    return state.committed && state.version > original.version;
  });
  console.error('PASS bare WASD moves and commits the actual camera');
  // Immediately follow a short bare-key gesture with RMB navigation. The
  // previous commit must never consume the new gesture's held-key samples.
  await page.keyboard.press('w');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.keyboard.down('w');
  await page.keyboard.down('d');
  await new Promise(done => setTimeout(done, 250));
  const partial = await camera();
  await page.keyboard.up('d');
  assert.ok(partial.interaction, 'releasing D keeps W navigation active');
  await until(async () => {
    const continued = await camera();
    return continued.camera.transform.pos.some((value, index) => value !== partial.camera.transform.pos[index]);
  });
  await page.keyboard.up('w');
  await page.mouse.up({ button: 'right' });
  await until(async () => (await camera()).committed);
  console.error('PASS RMB navigation and combination release');
  await positionPointer();
  await page.mouse.down({ button: 'right' });
  await page.keyboard.down('w');
  await until(async () => (await camera()).interaction);
  await page.keyboard.press('Escape');
  await until(async () => (await camera()).committed);
  const escaped = (await camera()).camera.transform;
  await new Promise(done => setTimeout(done, 200));
  assert.deepEqual((await camera()).camera.transform, escaped, 'Escape clears held motion');
  await page.keyboard.up('w');
  await page.mouse.up({ button: 'right' });
  console.error('PASS Escape finishes navigation without held-key drift');
  await positionPointer();
  const poseBeforeLook = (await camera()).camera.transform;
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(bounds.x + bounds.width / 2 + 45, bounds.y + bounds.height / 2 + 15);
  await page.mouse.up({ button: 'right' });
  await until(async () => (await camera()).committed &&
    JSON.stringify((await camera()).camera.transform.quat) !== JSON.stringify(poseBeforeLook.quat));
  const confirmed = (await camera()).camera.transform;
  assert.ok(Math.hypot(...confirmed.quat) > 0.99);
  await client.openAsset(mesh.guid, { projectId: opened.project.id });
  await page.locator('[role="tab"][data-page-id="page-mesh"][aria-selected="true"]').waitFor();
  const beforeRefresh = await client.getState();
  const oldTarget = beforeRefresh.projectTarget.targetId;
  const saved = await page.evaluate(() => ({
    record: JSON.parse(sessionStorage.getItem('forgeax.view.project-session/1') ?? 'null'),
    navigation: performance.getEntriesByType('navigation')[0]?.type,
  }));
  assert.equal(new URL(saved.record.entry).origin, new URL(start.url).origin);
  // Older records must not replay removed resources or temporary editor state.
  if (injectLegacyHistory) await page.addInitScript(() => {
    if (performance.getEntriesByType('navigation')[0]?.type !== 'reload') return;
    const key = 'forgeax.view.project-session/1';
    const value = JSON.parse(sessionStorage.getItem(key));
    if (!value) return;
    value.resources = ['00000000-0000-4000-8000-000000000001'];
    value.presentation = { activeType: 'mesh', pageOrder: ['mesh', 'editor'] };
    sessionStorage.setItem(key, JSON.stringify(value));
  });
  assert.equal(saved.record.resources, undefined);
  assert.equal(saved.record.camera, undefined);
  console.error('PASS project identity persists without editor history');
  await page.screenshot({ path: join(output, 'before-refresh.png') });
  const projectUrlBeforeRefresh = page.url();
  const reloadVisits = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloadVisits.push(frame.url()); });
  const refreshStartedAt = performance.now();
  await page.reload();
  await page.waitForURL(url => url.searchParams.get('forgeaxWorkspaceTarget') === oldTarget, { timeout: 30_000 });
  const entryAt = performance.now();
  const replacement = await until(async () => {
    const value = await client.getState();
    return value.projectPhase === 'running' && value.browserGeneration === beforeRefresh.browserGeneration + 1 && value;
  });
  const newTargetAt = performance.now();
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 90_000 });
  console.error('REFRESH TIMING', JSON.stringify({
    entryMs: Math.round(entryAt - refreshStartedAt),
    newTargetMs: Math.round(newTargetAt - refreshStartedAt),
    mountedMs: Math.round(performance.now() - refreshStartedAt),
  }));
  const restored = await until(async () => {
    const value = await client.getState();
    return value.projectTarget?.targetId === oldTarget && value.project?.root === canonicalRoot &&
      value.browserGeneration === replacement.browserGeneration && value;
  });
  assert.equal(restored.projectTarget.targetId, oldTarget);
  assert.equal(restored.projectTarget.sessionId, beforeRefresh.projectTarget.sessionId);
  assert.equal(restored.project.id, beforeRefresh.project.id);
  assert.equal(restored.browserGeneration, beforeRefresh.browserGeneration + 1);
  assert.equal(restored.play, null);
  assert.equal(restored.project.root, canonicalRoot);
  assert.equal(restored.previews.length, 0, 'Refresh starts with no replayed resource previews');
  assert.equal(restored.sceneSelection, null);
  assert.equal(page.url(), projectUrlBeforeRefresh,
    'Refresh must retain the exact project URL and its server');
  assert.deepEqual([...new Set(reloadVisits)], [projectUrlBeforeRefresh],
    'Healthy refresh must not navigate through the resident View entry');
  assert.equal(await page.locator('[role="tab"][data-page-id="page-mesh"]').count(), 0);
  const reopenedScene = await client.openAsset(scene.guid, { projectId: restored.project.id });
  await waitForRenderedViewport(page);
  const restoredScene = reopenedScene.preview.target;
  const recoveredCamera = await client.getCamera({ targetId: restoredScene.targetId, targetGeneration: restoredScene.generation });
  assert.deepEqual(recoveredCamera.camera.transform, beforeFocus.camera.transform, 'Refresh uses authored initial camera state');
  assert.equal(await page.locator('.fx-error-notice').count(), 0, 'Fresh project entry must show no command error');
  assert.equal(await page.locator('.fx-view-project-open').count(), 0, 'Resource failure must not gate a live project');
  await page.screenshot({ path: join(output, 'after-refresh.png') });
  assert.equal(await page.locator('.fx-engine-fatal-banner:not([hidden])').count(), 0,
    'A fresh rendered project must not retain an Engine startup error');
  bounds = await canvas.boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await until(async () => (await client.getState()).sceneSelection?.primary?.entityId);
  await page.locator('.fx-page-tab-btn--new').click();
  const menu = page.getByRole('menu').last();
  assert.equal(await menu.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  }), true, 'Portaled menus must remain above the Engine owner canvas');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.error('PASS refresh reattached the exact project server without history replay');
  await page.locator('[role="tab"][data-page-id="page-editor"]').click();
  const play = await client.call('play.start', { projectId: restored.project.id });
  const playTarget = play.play.target;
  console.error('Play target created; waiting for browser readiness');
  await client.call('play.ready', { targetId: playTarget.targetId, targetGeneration: playTarget.generation },
    { signal: AbortSignal.timeout(600_000) });
  const frame = page.frames().find(value => value.url().includes(playTarget.targetId));
  assert.ok(frame, 'Play has a separate game document');
  await frame.waitForFunction(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted) >= 60,
    undefined, { timeout: 180_000 });
  assert.equal(await page.locator('.fx-error-notice').count(), 0);
  await page.screenshot({ path: join(output, 'play-before-refresh.png') });
  const beforePlayRefresh = await client.getState();
  await page.reload();
  await page.waitForURL(url => url.searchParams.get('forgeaxWorkspaceTarget') === restored.projectTarget.targetId, { timeout: 90_000 });
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 90_000 });
  await until(async () => {
    const value = await client.getState();
    return value.projectPhase === 'running' && value.browserGeneration === beforePlayRefresh.browserGeneration + 1;
  });
  assert.equal((await client.getState()).previews.length, 0);
  assert.equal((await client.getState()).play, null, 'Refresh must not replay Play');
  for (let cycle = 0; cycle < 2; cycle++) {
    const previous = await client.getState();
    await page.reload();
    await page.waitForURL(url => url.searchParams.get('forgeaxWorkspaceTarget') === previous.projectTarget.targetId, { timeout: 90_000 });
    await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 90_000 });
    const state = await until(async () => {
      const value = await client.getState();
      return value.projectPhase === 'running' && value.browserGeneration === previous.browserGeneration + 1 && value;
    });
    assert.equal(state.projectTarget.targetId, previous.projectTarget.targetId);
    assert.equal(state.projectTarget.sessionId, previous.projectTarget.sessionId);
    assert.equal(state.project.root, canonicalRoot);
    assert.equal(state.play, null);
    assert.equal(state.sceneSelection, null);
    assert.equal(await page.locator('.fx-view-project-open').count(), 0);
    assert.equal(await page.locator('.fx-engine-fatal-banner:not([hidden])').count(), 0);
  }
  assert.deepEqual([...new Set(reloadVisits)], [projectUrlBeforeRefresh],
    'The refreshed Editor must remain on its exact project URL through subsequent operations');
  console.error('PASS repeated refresh returns to the project without manual reconnect');
  const observed = await client.call('display.status');
  assert.equal(observed.observation.status.runId, independent.runId);
  const after = await command('engine', 'run', 'status');
  for (const key of ['runId', 'revision', 'inputVersion', 'worldIdentity']) assert.equal(after[key], independent[key]);
  assert.equal(after.phase, 'ready');
  console.error('PASS refresh ended Editor Play and preserved exact independent AI run');
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, [], 'Refresh must not bootstrap a doomed renderer or leave connection errors');
  assert.equal(await page.locator('.fx-error-notice').count(), 0);
  const contentBrowser = page.getByTestId('panel-content-browser');
  await contentBrowser.waitFor({ state: 'attached' });
  if (!(await contentBrowser.isVisible())) {
    await page.locator('.fx-view-workspace-row.is-active .dv-groupview-edge .dv-tab')
      .filter({ hasText: /^Content Browser$/ }).click();
  }
  await contentBrowser.waitFor({ state: 'visible' });
  await contentBrowser.locator('.cb-crumb-current').filter({ hasText: /^assets$/ }).waitFor();
  for (const [name, kind] of [['proof-plugins.pack.json', 'Plugin'], ['proof.pack.ts', 'Asset Package']]) {
    const card = contentBrowser.locator('.cb-grid-item').filter({ has: page.getByText(name, { exact: true }) });
    await card.waitFor();
    assert.equal(await card.locator('.cb-card-meta').textContent(), kind);
  }
  assert.equal(await contentBrowser.locator('.cb-file-card[data-cb-path="assets/proof-plugins.pack.json"]').count(), 0,
    'a single-output Pack presents its resource directly');
  const pluginOutput = contentBrowser.locator('.cb-grid-item').filter({ has: page.getByText('proof-plugins.pack.json', { exact: true }) });
  await pluginOutput.waitFor();
  assert.equal(await pluginOutput.locator('.cb-fe-name').textContent(), 'proof-plugins.pack.json');
  assert.equal(await pluginOutput.locator('.cb-card-meta').textContent(), 'Plugin');
  await page.screenshot({ path: join(output, 'after-play-refresh.png') });
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, scenario, oldTarget,
    newTarget: restored.projectTarget.targetId, finalTarget: (await client.getState()).projectTarget.targetId,
    independentRun: independent.runId, playFrames: 60, refreshes: 4, project: root, errors, consoleErrors }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  const contentBrowserHtml = await page?.getByTestId('panel-content-browser').evaluate(element => element.outerHTML).catch(() => 'unavailable');
  await writeFile(join(output, 'content-browser-failure.html'), contentBrowserHtml ?? 'unavailable');
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, phase: 'failed', scenario,
    error: error.message, errors }, null, 2));
  console.error('RECOVERY', await page?.evaluate(() => ({
    origin: location.origin,
    target: new URL(location.href).searchParams.get('forgeaxWorkspaceTarget'),
    record: JSON.parse(sessionStorage.getItem('forgeax.view.project-session/1') ?? 'null'),
    navigation: performance.getEntriesByType('navigation')[0]?.type,
    ready: { mounted: !!globalThis.__forgeaxViewReady?.mounted, error: globalThis.__forgeaxViewReady?.error },
    startup: { phase: globalThis.__forgeaxStartup?.phase, error: String(globalThis.__forgeaxStartup?.error ?? '') },
    body: document.body?.innerHTML.slice(0, 1500),
  })).catch(() => null));
  // [ci-diag] the detached backend writes to its own log file, not the job log.
  const backendLog = join(tmpdir(), 'forgeax-backend', createHash('sha256').update(resolve(root)).digest('hex'), 'backend.log');
  console.error('BACKEND-LOG-TAIL', await readFile(backendLog, 'utf8')
    .then(text => text.split('\n').slice(-150).join('\n'))
    .catch(() => '<unavailable>'));
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  const viewportDiagnostic = await page?.evaluate(() => {
    const canvas = document.querySelector('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas');
    const describe = element => {
      const style = getComputedStyle(element);
      return { tag: element.tagName, id: element.id, classes: element.className,
        rect: element.getBoundingClientRect().toJSON(), inlineStyle: element.getAttribute('style'),
        display: style.display, visibility: style.visibility, opacity: style.opacity, zIndex: style.zIndex };
    };
    const rect = canvas?.getBoundingClientRect();
    return { canvas: canvas && { width: canvas.width, height: canvas.height, ...describe(canvas) },
      parent: canvas?.parentElement && describe(canvas.parentElement),
      atCenter: rect && document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).map(describe),
      renderer: globalThis.__forgeaxGameInspection?.renderer(),
    };
  }).catch(error => ({ error: error.message }));
  await writeFile(join(output, 'viewport-diagnostic.json'), JSON.stringify(viewportDiagnostic ?? null, null, 2));
  const tape = await page?.evaluate(async () => {
    const result = await Promise.race([
      globalThis.__forgeax?.captureFrame?.(),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, error: { code: 'capture-timeout', timeoutMs: 10000 } }), 10000)),
    ]);
    return result?.ok ? { digest: result.value.digest, bytes: Array.from(result.value.bytes) }
      : { error: result?.error ?? { code: 'capture-unavailable' } };
  }).catch(error => ({ error: error.message }));
  if (tape?.bytes) await writeFile(join(output, 'failure.rhitape'), Buffer.from(tape.bytes));
  await writeFile(join(output, 'capture-diagnostic.json'), JSON.stringify({ digest: tape?.digest, error: tape?.error }, null, 2));
  console.error('UI', await page?.locator('body').innerText().catch(() => 'unavailable'));
  console.error('FRAMES', await Promise.all((page?.frames() ?? []).map(async frame => ({
    target: new URL(frame.url()).searchParams.get('forgeaxWorkspaceTarget'),
    summary: await frame.evaluate(() => ({
      title: document.title, text: document.body?.innerText?.slice(0, 1200),
      frames: document.documentElement.dataset.forgeaxFrameSubmitted,
    })).catch(error => ({ error: error.message })),
  }))));
  const state = await client?.getState().catch(() => null);
  console.error('STATE', JSON.stringify(state, (key, value) => key === 'url' || /token/i.test(key) ? '[redacted]' : value));
  throw error;
} finally {
  client?.close('Experience proof complete');
  await browser?.close();
  await command('backend', 'stop').catch(error => console.error('CLEANUP', error.message));
  await command('engine', 'run', 'stop').catch(error => console.error('CLEANUP', error.message));
  await rm(root, { recursive: true, force: true });
  await rm(candidate, { recursive: true, force: true });
}
