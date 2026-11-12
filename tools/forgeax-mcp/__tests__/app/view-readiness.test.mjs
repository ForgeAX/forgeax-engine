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
  projectId = 'template-game-3d', targetId = 'target-ready', phase = 'running', label = 'Restoring project' } = {}) {
  const page = await browser.newPage();
  await page.setContent(`<iframe id="view" srcdoc='<span role="status" style="display:inline-block;width:12px;height:12px" aria-label="${label}"></span>'></iframe>`);
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  await frame.evaluate(({ connected, busy, restoring, error, projectId, targetId, phase }) => {
    globalThis.__projectState = { busy, restoring, error,
      snapshot: { project: { id: projectId }, projectPhase: phase,
        projectTarget: targetId && { targetId, url: 'http://localhost/?private-token=not-for-records' } } };
    globalThis.__forgeaxViewReady = { mounted: { transport: { connected },
      frontendHost: { context: { get: () => ({ projectSession: { getSnapshot: () => globalThis.__projectState } }) } } } };
  }, { connected, busy, restoring, error, projectId, targetId, phase });
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

test('late target publication retains a separate bounded browser startup budget', async () => {
  const f = await fixture({ targetId: null, phase: 'starting', busy: true, restoring: true });
  const stages = [];
  try {
    await f.frame.evaluate(() => {
      setTimeout(() => { globalThis.__projectState.snapshot.projectTarget = {
        targetId: 'target-ready', url: 'http://localhost/?private-token=not-for-records' }; }, 160);
      setTimeout(() => { const state = globalThis.__projectState;
        state.busy = false; state.restoring = false; state.snapshot.projectPhase = 'running'; }, 400);
    });
    await waitForViewProjectReady(f.view, 'template-game-3d', performance.now() + 300,
      { startupTimeoutMs: 600, onStage: row => stages.push(row) });
    assert.deepEqual(stages.map(row => row.stage), ['project-target', 'project-startup', 'project-ready']);
    assert.equal(JSON.stringify(stages).includes('private-token'), false);
  } finally { await f.page.close(); }
});

for (const [name, change, message] of [
  ['failed target', { projectPhase: 'failed' }, /target failed or was lost/],
  ['lost target', { workspaceTargetLost: true }, /target failed or was lost/],
]) test(`browser startup rejects ${name} without adopting a replacement`, async () => {
  const f = await fixture({ phase: 'starting', busy: true, restoring: true });
  try {
    await f.frame.evaluate(change => setTimeout(() => Object.assign(globalThis.__projectState.snapshot, change), 50), change);
    await assert.rejects(waitForViewProjectReady(f.view, 'template-game-3d', performance.now() + 1000,
      { startupTimeoutMs: 250 }), message);
  } finally { await f.page.close(); }
});

test('browser startup rejects a replaced target without adopting a replacement', async () => {
  const f = await fixture({ phase: 'starting', busy: true, restoring: true });
  try {
    await assert.rejects(waitForViewProjectReady(f.view, 'template-game-3d', performance.now() + 1000,
      { startupTimeoutMs: 1000, onStage: async row => {
        if (row.stage !== 'project-startup') return;
        await f.frame.evaluate(() => { globalThis.__projectState.snapshot.projectTarget = {
          targetId: 'another-target', url: 'http://localhost/' }; });
      } }), /target changed/);
  } finally { await f.page.close(); }
});

test('repeated starting observations do not extend browser startup deadline', async () => {
  const f = await fixture({ phase: 'starting', busy: true, restoring: true });
  try {
    await f.frame.evaluate(() => setInterval(() => { globalThis.__projectState.snapshot.browserGeneration =
      (globalThis.__projectState.snapshot.browserGeneration ?? 0) + 1; }, 20));
    const started = performance.now();
    await assert.rejects(waitForViewProjectReady(f.view, 'template-game-3d', started + 1000,
      { startupTimeoutMs: 150 }), /Timeout/);
    assert.ok(performance.now() - started < 650, 'A starting target must not renew its startup lease');
  } finally { await f.page.close(); }
});
