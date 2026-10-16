import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/** Real browser acceptance against the connected Host; no synthetic plugin rows. */
export async function verifyPluginFilters(page, output, { backendHost, pagePlugins }) {
  const panel = page.getByTestId('panel-plugins');
  const rows = panel.locator('.fx-plugin-row');
  const tag = name => panel.locator(`[data-plugin-tag="${name}"]`);
  const reset = () => panel.locator('[data-action="plugins.reset"]').click();
  const search = panel.locator('input[data-action="plugins.search"]');
  const assertTags = async (...tags) => {
    const actual = await rows.evaluateAll(elements => elements.map(element => element.dataset.pluginTags.split(' ')));
    assert.ok(actual.length > 0, `No rows for ${tags}`);
    assert.ok(actual.every(row => tags.every(value => row.includes(value))), JSON.stringify(actual));
  };
  await reset();
  for (const role of ['workspace', 'display-carrier', 'plugin-inspection']) {
    await rows.filter({ hasText: `forgeax.view.service.${role}.backend` }).waitFor();
  }
  assert.equal(await panel.getByTestId('plugins-partial').count(), 0);
  assert.equal(await rows.first().getAttribute('data-plugin-kind'), 'backend');
  const total = await rows.count();
  assert.ok(total > 14, 'All entries must include backend services and frontend pages');
  await page.screenshot({ path: resolve(output, 'plugin-hosts-all.png') });

  await panel.locator('[data-plugin-host="view-backend"]').click();
  await assertTags('backend');
  assert.ok((await rows.evaluateAll(elements => elements.map(element => element.dataset.sourceId))).every(id => id === 'view-backend'));
  await tag('api').click();
  await tag('cli').click();
  await assertTags('backend', 'api', 'cli');
  await search.fill('plugins inspect');
  await assertTags('api', 'cli');
  await rows.first().click();
  await panel.locator('.fx-plugin-operations').getByText(/plugins inspect/).waitFor();
  await page.screenshot({ path: resolve(output, 'plugin-hosts-api-cli.png') });
  await search.fill('no-plugin-matches-this-query');
  assert.equal(await rows.count(), 0);
  await panel.getByText('No matching plugins', { exact: true }).waitFor();
  await reset();
  assert.equal(await rows.count(), total);

  await tag('frontend').click();
  await assertTags('frontend');
  await search.fill('forgeax.view.page.');
  assert.deepEqual((await rows.locator('strong').allTextContents()).sort(), [...pagePlugins].sort());
  await page.screenshot({ path: resolve(output, 'plugin-hosts-frontend.png') });
  await reset();
  await tag('game').click();
  if (await rows.count()) await assertTags('game');
  else await panel.getByText(/No game plugin entries have been reported/).waitFor();
  await page.screenshot({ path: resolve(output, 'plugin-hosts-game.png') });

  await reset();
  await tag('backend').click();
  const backendCount = await rows.count();
  await panel.locator('[data-action="plugins.refresh"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="plugins.refresh"]')?.disabled);
  assert.equal(await tag('backend').getAttribute('aria-pressed'), 'true');
  assert.equal(await rows.count(), backendCount);
  const viewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await assertTags('backend');
    assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Plugin panel must fit a narrow viewport');
    await page.screenshot({ path: resolve(output, 'plugin-hosts-narrow.png') });
  } finally { if (viewport) await page.setViewportSize(viewport); }
  await reset();
  // Withdraw only the native inspection Fiber, leaving its page and workspace alive.
  const inspection = [...backendHost.context.registry.values()]
    .flatMap(runtime => [...(runtime.fibers ?? [])])
    .find(fiber => fiber.name === 'forgeax.view.service.plugin-inspection.backend');
  assert.ok(inspection, 'The inspection backend must have an owning Fiber');
  try {
    await inspection.dispose();
    await panel.locator('[data-action="plugins.refresh"]').click();
    await panel.getByTestId('plugins-partial').waitFor();
    await assertTags('frontend');
    assert.equal(await panel.locator('[data-plugin-kind="backend"]').count(), 0);
    await page.screenshot({ path: resolve(output, 'plugin-hosts-unavailable.png') });
  } finally {
    const { default: plugin } = await import('@forgeax/view-plugin-plugins/backend');
    await (await backendHost.context.plugin(plugin)).await();
  }
  // Acknowledge the real workspace error notice before using the covered toolbar.
  const notice = page.getByRole('alert').filter({ hasText: 'Workspace command failed (plugins.sources)' });
  if (await notice.count()) await notice.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await panel.locator('[data-action="plugins.refresh"]').click();
  await rows.filter({ hasText: 'forgeax.view.service.workspace.backend' }).waitFor();
  await panel.getByTestId('plugins-partial').waitFor({ state: 'detached' });
  await page.screenshot({ path: resolve(output, 'plugin-hosts-recovered.png') });
  console.error('real plugin Host/tag filters: backend inventory, API/CLI, frontend, game coverage, combinations, reset and narrow viewport passed');
  console.error('real inspection backend loss preserves local frontend inventory, and restore/refresh recovers backend entries');
}
