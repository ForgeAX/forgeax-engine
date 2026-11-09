import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { waitForViewProjectReady } from '../../test/app/acceptance.mjs';

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE || chromium.executablePath(),
    chromiumSandbox: true,
  });
});
after(async () => { await browser?.close(); });

async function fixture({ connected = true, busy = false, restoring = false, error = null,
  projectId = 'template-game-3d', targetId = 'target-ready', label = 'Restoring project' } = {}) {
  const page = await browser.newPage();
  await page.setContent(`<iframe id="view" srcdoc='<span role="status" style="display:inline-block;width:12px;height:12px" aria-label="${label}"></span>'></iframe>`);
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  await frame.evaluate(({ connected, busy, restoring, error, projectId, targetId }) => {
    globalThis.__projectState = { busy, restoring, error,
      snapshot: { project: { id: projectId }, projectTarget: targetId && { targetId, url: 'http://localhost/' } } };
    globalThis.__forgeaxViewReady = { mounted: { transport: { connected },
      frontendHost: { context: { get: () => ({ projectSession: { getSnapshot: () => globalThis.__projectState } }) } } } };
  }, { connected, busy, restoring, error, projectId, targetId });
  return { page, frame, view: page.frameLocator('#view') };
}

test('accepts the ready native project while the presentation still shows restoration', async () => {
  const f = await fixture();
  try { await waitForViewProjectReady(f.view, 'template-game-3d', performance.now() + 250); }
  finally { await f.page.close(); }
});

for (const [name, options] of [
  ['closed Host', { connected: false }],
  ['busy project', { busy: true }],
  ['restoring project', { restoring: true }],
  ['wrong project', { projectId: 'unrelated-project' }],
  ['missing target', { targetId: null }],
  ['failed restoration', { error: 'restore failed' }],
]) test(`rejects ${name} despite a connected-looking header`, async () => {
  const f = await fixture({ ...options, label: 'ForgeaX Host connected' });
  try { await assert.rejects(waitForViewProjectReady(f.view, 'template-game-3d', performance.now() + 120)); }
  finally { await f.page.close(); }
});

test('observes the existing project owner settling without replacing the View', async () => {
  const f = await fixture({ restoring: true });
  try {
    await f.frame.evaluate(() => setTimeout(() => { globalThis.__projectState.restoring = false; }, 50));
    await waitForViewProjectReady(f.view, 'template-game-3d', performance.now() + 500);
  } finally { await f.page.close(); }
});
