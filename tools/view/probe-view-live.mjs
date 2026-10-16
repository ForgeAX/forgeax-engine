// Live proof: npm @forgeax/engine 0.2.1 backend + local forgeax-view build on game-3d.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connectViewWorkspace } from './packages/view-workspace-core/src/resident.ts';

const viewUrl = process.env.VIEW_URL ?? 'http://127.0.0.1:8281/?project=E%3A%5Cforgeax-testgame%5Cgame-02-view-test';
const shot = process.env.PROOF_SHOT ?? 'E:/forgeax-testgame/view-live-proof.png';
const errors = [];
let browser;
let workspace;
try {
  const origin = new URL(viewUrl).origin;
  const bootstrap = await fetch(`${origin}/__forgeax/view/bootstrap`).then((r) => r.json());
  workspace = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'live-proof' });

  const gpuArgs = process.env.PROBE_GPU_ARGS
    ? process.env.PROBE_GPU_ARGS.split(' ')
    : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=SharedArrayBuffer'];
  const sandboxDisablingArgs = new Set(['no-sandbox', 'disable-setuid-sandbox', 'single-process']);
  if (gpuArgs.some((argument) => sandboxDisablingArgs.has(argument.replace(/^--/, '').split('=')[0]))) {
    throw new Error('PROBE_GPU_ARGS cannot disable Chromium sandboxing');
  }
  browser = await chromium.launch({ headless: false, args: gpuArgs, chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });
  page.on('pageerror', (error) => { errors.push(error.message); console.error('PAGE', error.message); });
  page.on('console', (message) => { if (message.type() === 'error') { errors.push(message.text()); console.error('CONSOLE', message.text()); } });

  await page.goto(viewUrl);
  assert.equal(new URL(viewUrl).searchParams.get('project') !== null, true, 'view URL carries project intent');
  try {
    await page.waitForURL((url) => url.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 240_000 });
    await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 240_000 });
  } catch (error) {
    await page.screenshot({ path: 'E:/forgeax-testgame/view-live-failure.png' }).catch(() => {});
    console.error('FAILURE URL:', page.url());
    console.error('FAILURE BODY:', (await page.locator('body').innerText().catch(() => '<unavailable>')).slice(0, 1500));
    throw error;
  }
  console.error('shell connected and project target opened');

  const state = await workspace.getState();
  assert.ok(state.project?.root, 'workspace has an open project');
  const { assets } = await workspace.listAssets(state.project.id);
  const scene = assets.find((asset) => asset.kind === 'scene');
  assert.ok(scene, 'game-3d scene asset discovered');
  console.error('project open:', state.project.root, '| assets:', assets.length, '| scene:', scene.name ?? scene.guid);

  await workspace.openAsset(scene.guid, { projectId: state.project.id, tabId: 'forgeax-user-workspace' });
  await page.getByTestId('panel-hierarchy').getByText('Ground', { exact: true }).waitFor({ timeout: 120_000 });
  const opened = await workspace.getState();
  const target = opened.preview.target;
  const tree = await workspace.getSceneTree({ targetId: target.targetId, targetGeneration: target.generation });
  for (const name of ['Player', 'Player Body', 'Ground']) assert.ok(tree.nodes.some((row) => row.name === name), `scene tree exposes ${name}`);
  console.error('scene tree live:', tree.nodes.length, 'nodes');

  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot });
  console.log(JSON.stringify({ passed: true, boundary: 'npm-0.2.1-backend-view-project-scene', project: state.project.root, entities: tree.nodes.length, screenshot: shot, errors }));
} catch (error) {
  console.error('PROBE FAILED:', error);
  process.exitCode = 1;
} finally {
  workspace?.close('live proof complete');
  await browser?.close();
}
