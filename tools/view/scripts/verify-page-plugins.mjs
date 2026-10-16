const additionalPages = JSON.parse(process.env.FORGEAX_VIEW_ADDITIONAL_PAGES ?? '[]');
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyPluginFilters } from './verify-plugin-filters.mjs';

export const pages = [
  ['scene', 'editor', 'Scene'],
  ['ai-display', 'display', 'Runtime observation'],
  ['history', 'history', 'Operation history'],
  ['plugin-browser', 'plugins', 'Plugins'],
  ['material', 'material', 'Material'],
  ['mesh', 'mesh', 'Mesh'],
  ['texture', 'texture', 'Texture'],
  ['asset', 'asset', 'Asset'],
];

/** Canvas attributes acknowledge layout before WebGPU presents the resized frame. */
export async function waitForRenderedViewport(page) {
  const sample = await page.evaluateHandle(() => ({ width: 0, height: 0, submitted: 0 }));
  try {
    const handle = await page.waitForFunction(sample => {
      const canvas = document.querySelector('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas');
      if (!canvas) return false;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, devicePixelRatio);
      const frame = globalThis.__forgeaxGameInspection?.renderer()?.execution?.frame;
      if (!frame || !(rect.width > 0 && rect.height > 0)) return false;
      if (sample.width !== canvas.width || sample.height !== canvas.height ||
          canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        Object.assign(sample, { width: canvas.width, height: canvas.height, submitted: frame.submitted });
        return false;
      }
      return frame.completed > sample.submitted && { width: sample.width, height: sample.height };
    }, sample);
    try { return await handle.jsonValue(); }
    finally { await handle.dispose(); }
  } finally { await sample.dispose(); }
}

/** Run inside the real Engine browser probe; no mocked browser or workspace. */
export async function verifyPagePlugins({ page, backendHost }) {
  const output = resolve(process.env.VIEW_PAGE_EVIDENCE ?? 'artifacts/page-plugins');
  await mkdir(output, { recursive: true });
  const assertSingleInspectorUI = async () => {
    assert.equal(await page.locator('[data-forgeax-view="inspector-entry"], [data-forgeax-view="inspector"]').count(), 0,
      'Plugin inspection belongs to the registered Plugins page, without a standalone body button or panel');
  };
  await assertSingleInspectorUI();
  const tab = type => page.locator(`[role="tab"][data-page-id="page-${type}"]`);
  const open = async (type, title) => {
    if (!await tab(type).count()) {
      await page.locator('.fx-page-tab-btn--new').click();
      await page.getByRole('menuitem', { name: title, exact: true }).click();
    }
    await tab(type).click();
    await tab(type).and(page.locator('[aria-selected="true"]')).waitFor();
  };
  for (const [, type, title] of pages) await open(type, title);
  assert.equal(await page.locator('[role="tab"][data-page-id]').count(), pages.length + additionalPages.length);
  for (const type of additionalPages) assert.equal(await tab(type).count(), 1, type);
  const callWorkspace = async (operation = 'presentation.get', args = {}) => {
    const terminal = await backendHost.context.get('toolApi').run('view.workspace.call', { operation, args }, { sourceId: 'view-workspace' }).terminal;
    assert.equal(terminal.outcome, 'succeeded', JSON.stringify(terminal));
    return terminal.result;
  };
  const before = await callWorkspace();
  assert.ok(before.connectionId);
  assert.ok(before.workspace.project?.id);
  assert.equal(before.pages.find(row => row.typeId === 'editor')?.resource?.asset?.kind, 'scene');
  assert.equal('assets' in before.workspace, false);
  assert.deepEqual(before.pages.map(row => row.id), await page.locator('[role="tab"][data-page-id]').evaluateAll(nodes => nodes.map(node => node.dataset.pageId)));
  const selected = await callWorkspace('presentation.page.select', { pageId: 'page-display' });
  assert.equal(selected.activePageId, 'page-display');
  await tab('display').and(page.locator('[aria-selected="true"]')).waitFor();
  const closed = await callWorkspace('presentation.page.close', { pageId: 'page-plugins' });
  assert.equal(closed.pages.some(row => row.id === 'page-plugins'), false);
  await tab('plugins').waitFor({ state: 'detached' });
  const reopened = await callWorkspace('presentation.page.open', { typeId: 'plugins' });
  assert.equal(reopened.activePageId, 'page-plugins');
  await tab('plugins').and(page.locator('[aria-selected="true"]')).waitFor();
  const required = await backendHost.context.get('toolApi').run('view.workspace.call', { operation: 'presentation.page.close', args: { pageId: 'page-editor' } }, { sourceId: 'view-workspace' }).terminal;
  assert.equal(required.outcome, 'failed');
  assert.match(JSON.stringify(required.failure), /view-presentation-page-required/);
  // A tab is presentation, not plugin removal.
  await open('plugins', 'Plugins');
  await tab('plugins').hover();
  await tab('plugins').locator('[data-page-close]').click();
  await tab('plugins').waitFor({ state: 'detached' });
  await open('plugins', 'Plugins');
  await page.getByText('forgeax.view.page.scene.frontend', { exact: true }).waitFor();
  await assertSingleInspectorUI();
  await page.locator('[data-action="plugins.refresh"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="plugins.refresh"]')?.disabled);
  await page.locator('input[data-action="plugins.search"]').fill('forgeax.view.page.');
  const pagePlugins = [...pages.map(([id]) => `forgeax.view.page.${id}.frontend`), 'forgeax.view.page.html.frontend'];
  await page.locator('.fx-plugin-row').nth(pagePlugins.length - 1).waitFor();
  assert.deepEqual((await page.locator('.fx-plugin-row strong').allTextContents()).sort(), pagePlugins.sort());
  await page.screenshot({ path: resolve(output, 'plugin-browser.png') });
  await page.locator('input[data-action="plugins.search"]').fill('');
  await page.screenshot({ path: resolve(output, 'plugin-browser-all.png') });
  await verifyPluginFilters(page, output, { backendHost, pagePlugins });
  // The preceding backend fault/recovery intentionally replaced the inspector.
  const services = ['viewWorkspaceCore', 'viewInspector', 'viewBroker']
    .map(name => [name, backendHost.context.get(name, false)]);

  await open('editor', 'Scene');
  await page.screenshot({ path: resolve(output, 'scene.png') });
  await open('display', 'Runtime observation');
  await page.screenshot({ path: resolve(output, 'ai-display.png') });

  for (const [name, service] of services) assert.equal(backendHost.context.get(name, false), service, name);
  for (const [, type] of pages) assert.equal(await tab(type).count(), 1, type);
  await open('editor', 'Scene');
  const editor = await callWorkspace();
  assert.equal(editor.activePageId, 'page-editor', 'the public query must observe pointer-driven page changes');
  const content = editor.panels.find(panel => panel.id === 'content-browser');
  assert.ok(content?.mounted, 'panel facts must come from the actual Dock owner');
  const revealed = await callWorkspace('presentation.panel.reveal', { panelId: content.id });
  assert.equal(revealed.panels.find(panel => panel.id === content.id).visible, true);
  await page.locator('[data-forgeax-view="content-browser-root"]').waitFor({ state: 'visible' });
  if (!content.visible) {
    await callWorkspace('presentation.page.select', { pageId: 'page-display' });
    await callWorkspace('presentation.page.select', { pageId: 'page-editor' });
  }
  console.error('independent page plugins: tab close, search and service isolation passed', output);
}
