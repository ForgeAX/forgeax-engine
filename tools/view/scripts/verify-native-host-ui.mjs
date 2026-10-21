import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createDevKitBackend } from '@forgeax/engine/devkit';
import { VIEW_FRONTEND_ROOT_PROGRAM } from '../packages/viewer/src/catalog-shared.ts';

const root = await mkdtemp(join(tmpdir(), 'view-native-ui-'));
const evidence = resolve(process.env.VIEW_NATIVE_UI_EVIDENCE ?? '/tmp/runtime-pack-view-native-ui');
await mkdir(evidence, { recursive: true });
let engine, browser;
try {
  engine = await createDevKitBackend(root, { hostPack: resolve('host.pack.json') });
  const workspace = engine.host.context.engineWorkspace;
  const call = async (operation, args = {}) => {
    const api = engine.host.context.toolApi;
    const owner = api.describe(operation, 'view-launcher').find(record => record.callable)?.owner;
    assert.ok(owner, `${operation} must be installed from the host PluginAsset`);
    const terminal = await api.run(operation, args, owner).terminal;
    assert.equal(terminal.outcome, 'succeeded', JSON.stringify(terminal));
    return terminal.result;
  };
  const started = await call('view.start', { frontendConfig: { layout: { responsiveAutoTuck: true } } });
  browser = await chromium.launch({ executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE ?? '/usr/bin/google-chrome', headless: true, args: ['--disable-gpu'], chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(started.url);
  await page.waitForFunction(() => globalThis.__forgeaxViewReady?.mounted || globalThis.__forgeaxViewReady?.error);
  const snapshot = await page.evaluate(() => {
    const ready = globalThis.__forgeaxViewReady;
    const frontend = ready.mounted?.frontendHost;
    return { error: ready.error ?? null, state: frontend?.status.state,
      schema: frontend?.assembly.current.schemaVersion, root: frontend?.assembly.current.root.program,
      plugins: frontend?.assembly.inspection.map(item => ({ name: item.name, state: item.state })),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => element.textContent),
    };
  });
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.state, 'active');
  assert.equal(snapshot.schema, 2);
  assert.equal(snapshot.root, VIEW_FRONTEND_ROOT_PROGRAM);
  assert.ok(snapshot.plugins.some(plugin => plugin.name === 'forgeax.view.panel.asset-browser.frontend' && plugin.state === 'active'));
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: join(evidence, 'shell.png') });
  // Closing an edge drawer must retire its fixed resize grip rather than
  // leave an invisible hit area over the central viewport.
  await page.setViewportSize({ width: 1280, height: 720 });
  const drawerTab = page.getByText(/^(Content Browser|内容浏览器)$/);
  const reveal = await page.evaluate(() => globalThis.__forgeaxViewReady.mounted.frontendHost.context
    .get('viewOperationClient').call('presentation.panel.reveal', { panelId: 'content-browser' }));
  assert.equal(reveal.panels.find(panel => panel.id === 'content-browser')?.visible, true);
  await page.getByTestId('panel-content-browser').waitFor({ state: 'visible' });
  await page.locator('.fx-edge-drawer-portal-host > .fx-edge-drawer-grip').waitFor();
  // An open drawer must receive input above the central grid resize handles.
  // Place an owned probe at a real sash intersection to make this deterministic.
  await page.evaluate(() => {
    const content = document.querySelector('.fx-edge-drawer-portal-host > .dv-content-container');
    const box = content.getBoundingClientRect();
    const sash = [...document.querySelectorAll('.dv-sash.dv-enabled')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width < rect.height && rect.left > box.left + 40 && rect.right < box.right - 40
        && rect.top < box.bottom && rect.bottom > box.top;
    });
    if (!sash) throw new Error('drawer-sash-intersection-missing');
    const rect = sash.getBoundingClientRect();
    const button = document.createElement('button');
    button.textContent = 'Drawer hit probe';
    Object.assign(button.style, { position: 'fixed', left: `${rect.left + rect.width / 2 - 40}px`,
      top: `${(Math.max(rect.top, box.top) + Math.min(rect.bottom, box.bottom)) / 2 - 15}px`,
      width: '80px', height: '30px', pointerEvents: 'auto' });
    button.onclick = () => button.dataset.clicked = 'true';
    content.append(button);
  });
  const hitProbe = page.getByRole('button', { name: 'Drawer hit probe', exact: true });
  await hitProbe.click({ timeout: 2000 });
  assert.equal(await hitProbe.getAttribute('data-clicked'), 'true');
  await hitProbe.evaluate(button => {
    const box = button.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'fx-menu-position fx-ui';
    Object.assign(menu.style, { left: `${box.left}px`, top: `${box.top}px` });
    const item = document.createElement('button');
    item.textContent = 'Drawer menu probe';
    Object.assign(item.style, { width: '80px', height: '30px' });
    item.onclick = () => item.dataset.clicked = 'true';
    menu.append(item);
    document.body.append(menu);
  });
  const menuProbe = page.getByRole('button', { name: 'Drawer menu probe', exact: true });
  await menuProbe.click({ timeout: 2000 });
  assert.equal(await menuProbe.getAttribute('data-clicked'), 'true');
  await page.screenshot({ path: join(evidence, 'drawer-menu.png') });
  await menuProbe.evaluate(button => button.parentElement.remove());
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button'))
      if (button.textContent === 'Drawer hit probe') button.remove();
  });
  // Selecting a body menu can close the transient drawer. Reopen it for the
  // independent explicit-close lifecycle check.
  if (await page.locator('.fx-edge-drawer-grip').count() === 0) {
    await drawerTab.click();
    await page.locator('.fx-edge-drawer-portal-host > .fx-edge-drawer-grip').waitFor();
  }
  await drawerTab.click();
  assert.equal(await page.locator('.fx-edge-drawer-grip').count(), 0);
  await page.close();
  assert.equal((await call('view.stop')).phase, 'stopped');
  assert.equal(engine.host.context.engineWorkspace, workspace);
  assert.equal(workspace.project, undefined);
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ ...snapshot, errors, boundary: 'actual View Host Pack and browser Shell; no game, Renderer, or GPU validation' }, null, 2));
  console.log(`Native Host v2 browser Shell passed: ${evidence}`);
} finally { await browser?.close(); await engine?.dispose(); await rm(root, { recursive: true, force: true }); }
