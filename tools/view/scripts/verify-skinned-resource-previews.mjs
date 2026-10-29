import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startViewLiveIntegration } from './workspace-fixture.mjs';
import { verifySkinnedResourcePreviews } from './verify-inline-previews.mjs';

const [project, engine, evidence] = process.argv.slice(2).map(value => resolve(value));
assert.ok(project && engine && evidence, 'usage: node scripts/verify-skinned-resource-previews.mjs PROJECT ENGINE EVIDENCE');
const root = await mkdtemp(join(tmpdir(), 'view-skinned-preview-'));
const errors = [];
let browser, live;
try {
  await mkdir(evidence, { recursive: true });
  const selectedSdk = await realpath(join(engine, 'packages/engine'));
  const installedSdk = await realpath(new URL('../node_modules/@forgeax/engine', import.meta.url));
  assert.equal(installedSdk, selectedSdk, 'the View installed SDK must match the tested Engine');
  await cp(join(project, 'assets'), join(root, 'assets'), { recursive: true });
  await cp(join(project, 'forge.json'), join(root, 'forge.json'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'skinned-preview-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(join(engine, 'packages/engine'), join(root, 'node_modules/@forgeax/engine'), 'dir');
  await symlink(resolve(import.meta.dirname, '..'), join(root, 'node_modules/@forgeax/view'), 'dir');
  const { runUnifiedCli } = await import(pathToFileURL(join(engine, 'packages/engine/dist/facades/devkit.mjs')).href);
  const binding = await runUnifiedCli(['project', 'engine', 'use-local', engine, '--root', root, '--json']);
  assert.equal(binding.ok, true, JSON.stringify(binding));
  browser = await chromium.launch({ headless: false, ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}), chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE', message.text()); });
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 120_000 } });
  const sceneAsset = live.pageWorkspace.snapshot().assets.find(asset => asset.kind === 'scene');
  assert.ok(sceneAsset, 'game-3d must publish its Scene');
  await live.pageWorkspace.openAsset({ projectId: live.pageWorkspace.snapshot().project.id, guid: sceneAsset.guid });
  const save = (name, png) => writeFile(join(evidence, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'));
  const onPreview = async ({ asset, preview }) => {
    if (process.env.FORGEAX_PREVIEW_RHI_WINDOW !== '1' || asset.kind !== 'mesh') return;
    const observation = await page.waitForFunction(targetId => {
      const canvas = document.querySelector(`canvas[data-forgeax-asset-preview="${targetId}"]`);
      const encoded = canvas?.dataset.forgeaxPreviewRhiWindow;
      if (!encoded) return false;
      const value = JSON.parse(encoded);
      if (['capture-error', 'upload-error'].includes(value.status)) throw new Error(JSON.stringify(value));
      return value.status === 'uploaded' ? value : false;
    }, preview.target.targetId, { timeout: 60_000 });
    await writeFile(join(evidence, `${asset.sourceKey.replaceAll('/', '-')}-rhi.json`), JSON.stringify(await observation.jsonValue(), null, 2));
    await observation.dispose();
  };
  const observations = await verifySkinnedResourcePreviews({ page, workspace: live.pageWorkspace, save, onPreview });
  const presentationCall = async (operation, args = {}) => {
    const terminal = await live.backendHost.context.get('toolApi').run('view.workspace.call', { operation, args }, { sourceId: 'view-workspace' }).terminal;
    assert.equal(terminal.outcome, 'succeeded', JSON.stringify(terminal));
    return terminal.result;
  };
  const presentation = await presentationCall('presentation.get');
  const scenePage = presentation.pages.find(row => row.typeId === 'scene');
  assert.ok(scenePage, 'the Scene page must exist');
  await presentationCall('presentation.page.select', { pageId: scenePage.id });
  const scene = live.pageWorkspace.snapshot().scenePreview;
  const sceneImage = await live.pageWorkspace.capture({ targetId: scene.target.targetId, targetGeneration: scene.target.generation });
  await save('scene', sceneImage.png);
  await page.screenshot({ path: join(evidence, 'view-scene.png') });
  const started = await live.pageWorkspace.invoke('play.start', { projectId: live.pageWorkspace.snapshot().project.id });
  const playArgs = { targetId: started.play.target.targetId, targetGeneration: started.play.target.generation };
  await live.pageWorkspace.invoke('play.ready', playArgs);
  const game = page.frames().find(frame => frame.url().includes(playArgs.targetId));
  assert.ok(game, 'the Engine Play document must be mounted');
  await game.waitForFunction(() => {
    const renderer = globalThis.__forgeaxGameInspection?.renderer();
    if (renderer?.execution.engine.health === 'faulted' || renderer?.execution.world.health === 'poisoned') throw new Error(JSON.stringify(renderer));
    return (document.querySelector('canvas#app')?.forgeaxFrameProgress?.completed?.frameId ?? 0) >= 60;
  }, undefined, { timeout: 180_000 });
  const completed = await game.evaluate(() => document.querySelector('canvas#app').forgeaxFrameProgress.completed);
  await game.locator('canvas#app').screenshot({ path: join(evidence, 'play.png') });
  observations.push({ label: 'play', completed });
  await live.pageWorkspace.invoke('play.stop', playArgs);
  assert.deepEqual(errors, []);
  const engineCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: engine, encoding: 'utf8' }).trim();
  const engineDiff = execFileSync('git', ['diff', '--stat'], { cwd: engine, encoding: 'utf8' }).trim();
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, sdkMatchesSelectedEngine: true, engineCommit, engineDiff, project: basename(project), observations, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, observations: observations.length, evidence }));
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, errors, root }, null, 2));
  if (browser) for (const page of browser.contexts().flatMap(context => context.pages())) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
    await writeFile(join(evidence, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally {
  try { await live?.dispose(); }
  finally {
    try { await browser?.close(); }
    finally { if (process.env.FORGEAX_KEEP_PROOF_PROJECT !== '1') await rm(root, { recursive: true, force: true }); }
  }
}
