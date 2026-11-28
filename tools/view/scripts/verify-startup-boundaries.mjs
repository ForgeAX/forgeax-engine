import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { connectViewWorkspace } from '../packages/view-workspace-core/src/resident.ts';
import { VIEW_PACK_SOURCES_SERVICE } from '../packages/view-workspace-core/src/contract.ts';

const root = await mkdtemp(join(tmpdir(), 'view-startup-browser-'));
const backendRoot = await mkdtemp(join(tmpdir(), 'view-startup-backend-'));
const viewStartInput = JSON.stringify({ frontendConfig: { layout: { responsiveAutoTuck: false } } });
const brokenRoot = await mkdtemp(join(tmpdir(), 'view-startup-broken-'));
const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const command = async (...args) => {
  const result = await runUnifiedCli([...args, '--root', backendRoot, '--json']);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
let browser;
let page;
let client;
let stage = 'fixture';
const errors = [];
try {
  await mkdir(join(root, 'assets'));
  await mkdir(join(brokenRoot, 'assets'));
  await writeFile(join(brokenRoot, 'assets/broken.pack.ts'), 'export default ;');
  await writeFile(join(brokenRoot, 'assets/broken.pack.json'), '{ broken json');
  await writeFile(join(brokenRoot, 'assets/healthy.pack.json'), JSON.stringify({
    schemaVersion: '3.0.0', packageId: '01900000-0000-7000-8000-000000001110', assets: {},
  }));
  await mkdir(join(brokenRoot, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(brokenRoot, 'node_modules/@forgeax/engine'));
  await symlink(view, join(brokenRoot, 'node_modules/@forgeax/view'));
  await writeFile(join(brokenRoot, 'package.json'), JSON.stringify({
    name: 'startup-broken', type: 'module',
    dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' },
  }));
  await writeFile(join(brokenRoot, 'forge.json'), JSON.stringify({
    id: 'startup-broken', name: 'Broken project', schemaVersion: '3.0.0', roots: {},
  }));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(view, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'startup-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await writeFile(join(root, 'forge.json'), JSON.stringify({
    id: 'startup-proof', name: 'Startup proof', schemaVersion: '3.0.0',
    roots: {},
  }));
  const absent = await runUnifiedCli(['view', 'start', '--root', backendRoot, '--json']);
  assert.equal(absent.ok, false, 'View must not start its backend implicitly');
  assert.equal((await command('backend', 'status')).phase, 'stopped');
  const previousBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const previousExecutable = process.env.FORGEAX_BROWSER_EXECUTABLE;
  const previousCi = process.env.CI;
  try {
    // The detached backend has no stdin. Vite's interactive EOF handler would
    // otherwise exit the process when the first project server is created.
    process.env.CI = 'true';
    console.error('Detached backend mode', JSON.stringify({ inheritedCI: previousCi ?? null, CI: process.env.CI }));
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(root, 'uninstalled-browser-cache');
    process.env.FORGEAX_BROWSER_EXECUTABLE = '/uninstalled/chromium';
    const starts = await Promise.all([
      command('backend', 'start', '--host-pack', join(view, 'host.pack.json')),
      command('backend', 'start', '--host-pack', join(view, 'host.pack.json')),
    ]);
    assert.ok(starts.every(state => state.phase === 'starting' || state.phase === 'ready'));
    assert.equal((await command('backend', 'status')).phase, 'ready');
    assert.equal((await command('view', 'start', '--input', viewStartInput)).phase, 'ready');
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousBrowserPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserPath;
    if (previousExecutable === undefined) delete process.env.FORGEAX_BROWSER_EXECUTABLE;
    else process.env.FORGEAX_BROWSER_EXECUTABLE = previousExecutable;
  }
  const state = await command('view', 'status');
  const bootstrap = await fetch(`${state.url}/__forgeax/view/bootstrap`).then(response => response.json());
  client = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'startup-proof' });
  assert.equal((await client.getState()).project ?? null, null);
  console.error('Backend and View ready without a browser installation or project');
  stage = 'partial-project-open';
  const partialOpenStarted = Date.now();
  const partial = await client.openProject(brokenRoot);
  assert.equal(partial.project.root, await realpath(brokenRoot), 'bad sources must not block project admission');
  assert.ok(Date.now() - partialOpenStarted < 30_000, 'partial admission must not spend another catalog deadline');
  stage = 'partial-project-inventory';
  const inventory = await client.transport.request(VIEW_PACK_SOURCES_SERVICE, { projectId: partial.project.id });
  const bad = inventory.sources.find(source => source.sourcePath === 'assets/broken.pack.json');
  assert.equal(bad?.diagnostic?.code, 'pack-malformed-pack', 'the bad source must retain its own diagnostic');
  assert.ok(inventory.sources.some(source => source.sourcePath === 'assets/broken.pack.ts'));
  const healthy = inventory.sources.find(source => source.sourcePath === 'assets/healthy.pack.json');
  assert.ok(healthy, 'healthy siblings must remain visible');
  assert.equal(healthy.diagnostic, undefined);
  assert.equal((await command('view', 'status')).phase, 'ready');
  stage = 'partial-project-close';
  await client.closeProject(partial.project.id);
  console.error('bad Packs preserve source diagnostics and healthy siblings without blocking project admission');
  assert.equal((await client.getState()).project ?? null, null);
  stage = 'browser-start';
  browser = await chromium.launch({
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome' }),
    headless: true, args: ['--disable-gpu', '--disable-webgpu'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('response', async response => { if(response.status() >= 500) console.error('SERVER',response.url(),await response.text().catch(()=>'')); });
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE', error.message); });
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.error('CONSOLE', message.type(), message.text()); });
  await page.addInitScript(() => {
    try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {}
    // Deliberate renderer fault: the ordinary Shell must still mount and bind observations.
    if (navigator.gpu) navigator.gpu.requestAdapter = async () => { throw new Error('startup-proof: graphics unavailable'); };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (['webgpu', 'webgl', 'webgl2', 'experimental-webgl'].includes(kind)) throw new Error('startup-proof: graphics unavailable');
      return getContext.call(this, kind, ...args);
    };
  });
  const registeredProject = await client.registerProject(root);
  await page.goto(state.url);
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 30_000 });
  await page.locator('[role="tab"][data-page-id="page-scene"]').click();
  await page.getByRole('button', { name: 'Next', exact: true }).waitFor();
  assert.equal(await page.locator('canvas').count(), 0);
  assert.equal(await page.locator('.fx-viewport-navigation-hint').isVisible(), false,
    'an empty workspace must not advertise Scene navigation');
  const openDialog = page.getByRole('dialog', { name: 'Open project', exact: true });
  await openDialog.waitFor();
  assert.equal(await openDialog.evaluate(dialog => dialog.matches(':modal')), false,
    'project admission must leave workspace navigation available');
  await page.locator('[role="tab"][data-page-id="page-scene"]').click();
  await page.keyboard.press('Escape');
  assert.equal(await openDialog.isVisible(), true, 'View requires a project before using its pages');
  await page.screenshot({ path: '/tmp/view-startup-empty.png' });
  assert.deepEqual(errors, [], 'empty Shell must not produce page errors');
  const projectChoice = openDialog.locator('.fx-view-project-chooser__list button').filter({ hasText: registeredProject.root });
  await projectChoice.click();
  assert.equal(await page.getByLabel('Project path', { exact: true }).inputValue(), registeredProject.root);
  assert.equal((await client.getState()).project ?? null, null, 'single click only selects a project');
  stage = 'renderer-failure';
  await projectChoice.dblclick();
  assert.equal(page.url(), new URL(state.url).href, 'Project admission retains the Shell URL');
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 60_000 });
  // The retained Shell stays live while its Engine document reports the fault.
  const documentElement = await page.locator('iframe[data-forgeax-project-document]').elementHandle({ timeout: 60_000 });
  const project = await documentElement.contentFrame();
  await documentElement.dispose();
  assert.ok(project);
  await project.waitForFunction(() =>
    document.querySelector('#forgeax-fatal-details')?.textContent?.includes('startup-proof: graphics unavailable'),
  undefined, { timeout: 60_000 });
  await page.locator('[data-page-id="page-display"]').click();
  await page.getByLabel('Capture source').selectOption('run');
  assert.equal(await page.locator('.fx-view-run-observer input').count(), 0);
  await page.getByRole('button', { name: 'View project run', exact: true }).click();
  await page.getByText('No independent Engine run was found for this project.', { exact: true }).waitFor();
  // Exact binding remains an API contract, separate from the context-derived UI.
  await client.call('display.bind', { root, runId: 'exact-missing-run' });
  const observationDeadline = Date.now() + 30_000;
  let observed;
  do {
    observed = await client.call('display.status');
    if (observed.status === 'unavailable') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < observationDeadline);
  assert.match(observed.error, /no longer active/);
  assert.equal(observed.observation, null);
  assert.equal(await openDialog.count(), 0, 'the project dialog closes after opening a project');
  const snapshot = await client.getState();
  assert.equal(snapshot.project.root, await realpath(root));
  assert.equal(snapshot.projectPhase, 'failed');
  assert.equal(await page.locator('.fx-viewport-navigation-hint').isVisible(), false,
    'a failed renderer cannot advertise Scene navigation');
  assert.equal(snapshot.projectTarget, null, 'a failed renderer cannot advertise a live target');
  const failedTargetId = snapshot.projectStatus.document.targetId;
  assert.equal(new URL(project.url()).searchParams.get('forgeaxWorkspaceTarget'), failedTargetId);
  await assert.rejects(client.listAssets(snapshot.project.id, { targetId: failedTargetId }), error => {
    assert.doesNotMatch(error.message, /timeout/i, 'renderer failures must retain their cause');
    assert.match(error.message, /graphics|renderer|backend|adapter/i);
    return true;
  });
  assert.equal((await command('backend', 'status')).phase, 'ready');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: '/tmp/view-startup-renderer-failure.png' });
  await client.call('display.bind', { root: null });
  assert.equal((await client.call('display.status')).binding, null);
  stage = 'view-restart';
  assert.equal((await command('view', 'stop')).phase, 'stopped');
  assert.equal((await command('backend', 'status')).phase, 'ready');
  const restarted = await command('view', 'start', '--input', viewStartInput);
  assert.equal(restarted.phase, 'ready');
  await page.goto(restarted.url);
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted);
  const retainedDocument = await page.locator('iframe[data-forgeax-project-document]').elementHandle({ timeout: 30_000 });
  const retainedProject = await retainedDocument.contentFrame();
  await retainedDocument.dispose();
  assert.ok(retainedProject);
  await retainedProject.waitForFunction(() =>
    document.querySelector('#forgeax-fatal-details')?.textContent?.includes('startup-proof: graphics unavailable'),
  undefined, { timeout: 30_000, polling: 100 });
  client.close('View transport restarted');
  const restartedBootstrap = await fetch(`${restarted.url}/__forgeax/view/bootstrap`).then(response => response.json());
  client = await connectViewWorkspace({ endpoint: restartedBootstrap.endpoint, token: restartedBootstrap.token, clientId: 'startup-proof-restarted' });
  const retained = await client.getState();
  assert.equal(retained.projectPhase, 'failed');
  assert.equal(retained.projectTarget, null);
  assert.equal(retained.projectStatus.sessionId, snapshot.projectStatus.sessionId);
  assert.equal(retained.projectStatus.generation, snapshot.projectStatus.generation);
  assert.equal(retained.projectStatus.document.targetId, failedTargetId);
  assert.equal(await page.getByRole('button', { name: 'Reconnect', exact: true }).count(), 0,
    'renderer failure must retain its diagnostic rather than offer lost-session recovery');
  console.error('PASS: empty UI, exact observation binding, renderer failure isolation, independent View stop/restart');
} catch (error) {
  console.error('STARTUP-FAILURE', JSON.stringify({ stage,
    backend: await command('backend', 'status').catch(cause => ({ error: cause.message })),
  }));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: '/tmp/view-startup-failure.png' }).catch(() => {});
    console.error('URL', page.url());
    console.error('ENGINE-FATAL', await page.evaluate(() => document.querySelector('#forgeax-fatal-details')?.textContent ?? 'unavailable').catch(() => 'unavailable'));
    console.error('UI', await page.locator('body').innerText().catch(() => 'unavailable'));
    console.error('READY', await page.evaluate(() => ({ error: globalThis.__forgeaxViewReady?.error, mounted: !!globalThis.__forgeaxViewReady?.mounted })).catch(() => ({})));
  }
  throw error;
} finally {
  client?.close('startup proof complete');
  await browser?.close();
  await command('backend', 'stop').catch(error => console.error('CLEANUP', error.message));
  await rm(root, { recursive: true, force: true });
  await rm(backendRoot, { recursive: true, force: true });
  await rm(brokenRoot, { recursive: true, force: true });
}
