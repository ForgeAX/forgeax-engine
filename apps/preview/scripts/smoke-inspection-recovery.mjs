#!/usr/bin/env node
// P7 Preview contract smoke: the host transports only game-owned projections,
// renderer health/recovery, and the existing RHI capture path. The browser
// global is intentionally cleared by the normal Preview dispose message.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { decodeTape } from '@forgeax/engine-rhi-debug';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_INSPECTION_DIR ?? resolve(ROOT, '.forgeax-debug/inspection-recovery'));
const PORT = Number.parseInt(process.env.FORGEAX_INSPECTION_PORT ?? '5199', 10);
const RUNTIME_SCOPE_ID = process.env.FORGEAX_RUNTIME_SCOPE_ID ?? 'preview';
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
  channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--use-vulkan=swiftshader',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-gpu-driver-bug-workarounds',
    '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
    '--autoplay-policy=no-user-gesture-required',
  ],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`);
});

const readInspection = () => page.evaluate(() => {
  const inspection = globalThis.__forgeaxPreviewInspection;
  if (!inspection) throw new Error('Preview inspection global is unavailable');
  return inspection;
});
const readCatalogRows = () => page.evaluate(async (scopeId) => {
  const urls = [`/__pack/scopes/${encodeURIComponent(scopeId)}/1/catalog.json`];
  for (const url of urls) {
    const response = await fetch(url);
    if (!response.ok) continue;
    const payload = await response.json();
    if (Array.isArray(payload)) return payload;
    if (payload !== null && typeof payload === 'object' && Array.isArray(payload.entries)) return payload.entries;
  }
  throw new Error(`no catalog endpoint available for scope ${scopeId}`);
}, RUNTIME_SCOPE_ID);

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?game=game-default&asset-evidence=1`, { waitUntil: 'networkidle', timeout: 2_000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForFunction(
    () => {
      const listed = globalThis.__forgeaxPreviewInspection?.list();
      return (listed?.actions.length ?? 0) >= 4 && (listed?.reads.length ?? 0) >= 2;
    },
    undefined,
    { timeout: 30_000, polling: 100 },
  );

  const listed = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.list());
  if (!listed || listed.actions.length < 4 || listed.reads.length < 2) throw new Error(`projection list incomplete: ${JSON.stringify(listed)}`);
  const before = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!before.ok || before.value.state.phase !== 'Play') throw new Error(`baseline projection failed: ${JSON.stringify(before)}`);
  const hudTargetStatus = await page.evaluate(() => {
    const host = document.querySelector('[data-ui-asset="9e976cdd-1923-57d9-b08c-4ab0bd18a16b"]');
    return host?.shadowRoot?.querySelector('[data-ui-slot="target-status"]')?.textContent ?? null;
  });
  if (hudTargetStatus !== 'TARGET · RedBox · 100/100 HP · +10') {
    throw new Error(`primary target HUD cue failed: ${JSON.stringify({ hudTargetStatus })}`);
  }
  const profileCatalog = (await readCatalogRows()).find((row) => row.guid === '019e2cc6-0c86-79da-aa76-b0984c86d461');
  if (
    profileCatalog?.kind !== 'game-default-target-profile' ||
    profileCatalog?.name !== 'target-profile.json' ||
    typeof profileCatalog?.packageUrl !== 'string'
  ) {
    throw new Error(`target profile catalog row failed: ${JSON.stringify(profileCatalog)}`);
  }
  const profileBefore = before.value.targetProfile;
  if (
    profileBefore?.available !== true ||
    profileBefore.title !== 'Precision target' ||
    profileBefore.scoreMultiplier !== 2 ||
    profileBefore.active !== 'original'
  ) {
    throw new Error(`target profile load witness failed: ${JSON.stringify(profileBefore)}`);
  }
  // Inspection recovery is allowed to use the existing score projection, but it must
  // still cross the same ECS-owned threshold before the Target profile button enables.
  const scoreTriggers = [];
  for (let index = 0; index < 5; index++) {
    scoreTriggers.push(await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-score')));
    await page.waitForTimeout(220);
  }
  const unlockedForGuidedLab = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!unlockedForGuidedLab.ok || unlockedForGuidedLab.value.state.phase !== 'Play' || unlockedForGuidedLab.value.targetHealth.damageEvents < 2) {
    throw new Error(`inspection score gate setup failed: ${JSON.stringify({ scoreTriggers, unlockedForGuidedLab })}`);
  }
  const assetLabSummary = page.locator('summary');
  if (await assetLabSummary.count() !== 1) throw new Error('guided Asset Lab summary missing');
  await assetLabSummary.click();
  const scoreGateHud = await page.locator('[data-ui-slot="score"]').allTextContents();
  const targetProfileGate = await page.getByRole('button', { name: 'Target profile', exact: true }).evaluate((button) => ({ disabled: button.disabled, title: button.title, ariaDisabled: button.getAttribute('aria-disabled') }));
  if (targetProfileGate.disabled) throw new Error(`inspection score gate did not reach HUD: ${JSON.stringify({ scoreTriggers, unlockedForGuidedLab, scoreGateHud, targetProfileGate })}`);
  const assetLabStatus = page.locator('[data-ui-slot="asset-lab-status"]');
  const assetLabControls = [
    ['Target profile', (snapshot) => snapshot.targetProfile?.active === 'profile'],
    ['JPEG target', (snapshot) => snapshot.jpegTexture?.active === 'jpeg'],
    ['WebM panel', (snapshot) => snapshot.videoTexture?.active === 'video'],
    ['PNG projectile', (snapshot) => snapshot.spriteAtlas?.active === true],
    ['TTF score text', (snapshot) => snapshot.worldScoreText?.fontSource === 'ttf-plugin'],
  ];
  const assetLabGuided = [];
  for (const [name, active] of assetLabControls) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.count() !== 1) throw new Error(`guided Asset Lab button missing: ${name}`);
    await button.click();
    await page.waitForTimeout(120);
    const snapshot = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
    const status = await assetLabStatus.innerText();
    if (!snapshot.ok || !active(snapshot.value) || !status.toLowerCase().includes('active')) {
      throw new Error(`guided Asset Lab action failed: ${JSON.stringify({ name, status, snapshot })}`);
    }
    assetLabGuided.push({ name, status, snapshot: snapshot.value });
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'asset-lab-active.png') });
  await page.locator('canvas').click();
  await page.keyboard.down('r');
  await page.waitForTimeout(120);
  await page.keyboard.up('r');
  await page.waitForTimeout(700);
  const assetLabAfterReset = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  const assetLabResetStatus = await assetLabStatus.innerText();
  if (
    !assetLabAfterReset.ok ||
    assetLabAfterReset.value.targetProfile?.active !== 'original' ||
    assetLabAfterReset.value.jpegTexture?.active !== 'original' ||
    assetLabAfterReset.value.videoTexture?.active !== 'original' ||
    assetLabAfterReset.value.videoTexture?.hitReactions !== 0 ||
    assetLabAfterReset.value.videoTexture?.lastHitPlayhead !== null ||
    assetLabAfterReset.value.spriteAtlas?.active !== false ||
    assetLabAfterReset.value.worldScoreText?.fontSource !== 'legacy-pack' ||
    !assetLabResetStatus.startsWith('Asset Lab reset · authored RedBox baseline')
  ) {
    throw new Error(`guided Asset Lab reset failed: ${JSON.stringify({ assetLabResetStatus, assetLabAfterReset })}`);
  }
  const assetLabReset = { guided: assetLabGuided, afterReset: assetLabAfterReset.value, status: assetLabResetStatus };
  const assetBaseline = assetLabAfterReset.value;
  const fbxBefore = before.value.fbxSkinnedTarget;
  if (
    fbxBefore?.available !== true ||
    fbxBefore.jointCount < 50 ||
    fbxBefore.clipGuid !== '019ecd87-179b-71f7-b9f8-4c8518326b65' ||
    Math.abs(fbxBefore.scale[0] - 0.03) > 0.001
  ) {
    throw new Error(`FBX skin target contract failed: ${JSON.stringify(fbxBefore)}`);
  }
  const vfxBefore = before.value.vfxHit;
  if (
    vfxBefore?.available !== true ||
    vfxBefore.mode !== 'hit' ||
    vfxBefore.guid !== 'cbc4f40d-d148-53ee-89e7-310ef3abcfe9' ||
    vfxBefore.emitterCount !== 2 ||
    vfxBefore.emitterStatuses.some((status) => status !== 'ready') ||
    vfxBefore.errorCode !== null
  ) {
    throw new Error(`VFX asset baseline failed: ${JSON.stringify(vfxBefore)}`);
  }
  const vfxTrigger = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-vfx-hit'));
  await page.waitForTimeout(300);
  const afterVfx = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  const vfxKinds = afterVfx.value?.vfxHit?.batchKinds ?? [];
  if (
    !vfxTrigger.ok ||
    !afterVfx.ok ||
    afterVfx.value.vfxHit?.playing !== true ||
    afterVfx.value.vfxHit?.seed !== 1 ||
    afterVfx.value.vfxHit?.triggers !== 1 ||
    afterVfx.value.vfxHit?.emitterStatuses.some((status) => status !== 'ready') ||
    !vfxKinds.includes('billboard') ||
    !vfxKinds.includes('mesh') ||
    afterVfx.value.vfxHit?.bucketCount !== 2 ||
    afterVfx.value.vfxHit?.readiness !== 'ready' ||
    afterVfx.value.vfxHit?.errorCode !== null
  ) {
    throw new Error(`VFX trigger/render loop failed: ${JSON.stringify({ vfxTrigger, afterVfx })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'vfx-hit-active.png') });
  const vfxChargeTrigger = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-vfx-charge'));
  await page.waitForTimeout(350);
  const afterVfxCharge = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  const vfxChargeKinds = afterVfxCharge.value?.vfxHit?.batchKinds ?? [];
  if (
    !vfxChargeTrigger.ok ||
    !afterVfxCharge.ok ||
    afterVfxCharge.value.vfxHit?.mode !== 'charge' ||
    afterVfxCharge.value.vfxHit?.guid !== 'e696463c-b254-5efb-95df-5a44ebe3b508' ||
    afterVfxCharge.value.vfxHit?.playing !== true ||
    afterVfxCharge.value.vfxHit?.seed !== 2 ||
    afterVfxCharge.value.vfxHit?.triggers !== 2 ||
    afterVfxCharge.value.vfxHit?.emitterCount !== 2 ||
    afterVfxCharge.value.vfxHit?.emitterStatuses.some((status) => status !== 'ready') ||
    !vfxChargeKinds.includes('billboard') ||
    !vfxChargeKinds.includes('mesh') ||
    afterVfxCharge.value.vfxHit?.alive <= 0 ||
    afterVfxCharge.value.vfxHit?.bucketCount !== 2 ||
    afterVfxCharge.value.vfxHit?.readiness !== 'ready' ||
    afterVfxCharge.value.vfxHit?.errorCode !== null
  ) {
    throw new Error(`VFX charge composition failed: ${JSON.stringify({ vfxChargeTrigger, afterVfxCharge })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'vfx-charge-active.png') });
  const vfxHitAfterCharge = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-vfx-hit'));
  await page.waitForTimeout(250);
  const afterVfxHitAfterCharge = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !vfxHitAfterCharge.ok ||
    !afterVfxHitAfterCharge.ok ||
    afterVfxHitAfterCharge.value.vfxHit?.mode !== 'hit' ||
    afterVfxHitAfterCharge.value.vfxHit?.guid !== 'cbc4f40d-d148-53ee-89e7-310ef3abcfe9' ||
    afterVfxHitAfterCharge.value.vfxHit?.seed !== 3 ||
    afterVfxHitAfterCharge.value.vfxHit?.triggers !== 3 ||
    afterVfxHitAfterCharge.value.vfxHit?.emitterStatuses.some((status) => status !== 'ready') ||
    afterVfxHitAfterCharge.value.vfxHit?.errorCode !== null
  ) {
    throw new Error(`VFX charge-to-hit switch failed: ${JSON.stringify({ vfxHitAfterCharge, afterVfxHitAfterCharge })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'before.png') });

  const videoBefore = before.value.videoTexture;
  if (
    videoBefore?.available !== true ||
    videoBefore.active !== 'original' ||
    videoBefore.kind !== 'video' ||
    videoBefore.url !== '/cutscene.webm' ||
    videoBefore.hitReactions !== 0 ||
    videoBefore.lastHitPlayhead !== null
  ) {
    throw new Error(`WebM asset witness failed: ${JSON.stringify(videoBefore)}`);
  }
  const videoToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-video-texture'));
  await page.waitForTimeout(500);
  const afterVideo = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !videoToggle.ok ||
    !afterVideo.ok ||
    afterVideo.value.videoTexture?.active !== 'video' ||
    afterVideo.value.videoTexture?.hitReactions !== 0 ||
    afterVideo.value.videoTexture?.lastHitPlayhead !== null ||
    afterVideo.value.videoTexture?.swaps !== (assetBaseline.videoTexture?.swaps ?? 0) + 1
  ) {
    throw new Error(`WebM toggle failed: ${JSON.stringify({ videoToggle, afterVideo })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'video-active.png') });
  const videoOrbit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.set-view', { mode: 'orbit' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'video-active-orbit.png') });
  const videoRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-video-texture'));
  const afterVideoRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !videoRestore.ok ||
    !afterVideoRestore.ok ||
    afterVideoRestore.value.videoTexture?.active !== 'original' ||
    afterVideoRestore.value.videoTexture?.swaps !== (assetBaseline.videoTexture?.swaps ?? 0) + 2
  ) {
    throw new Error(`WebM restore failed: ${JSON.stringify({ videoRestore, afterVideoRestore })}`);
  }
  await page.keyboard.down('m');
  await page.waitForTimeout(100);
  await page.keyboard.up('m');
  await page.waitForTimeout(100);
  const afterVideoKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!afterVideoKey.ok || afterVideoKey.value.videoTexture?.active !== 'video' || afterVideoKey.value.videoTexture?.swaps !== (assetBaseline.videoTexture?.swaps ?? 0) + 3) {
    throw new Error(`WebM keyboard toggle failed: ${JSON.stringify(afterVideoKey)}`);
  }
  await page.keyboard.down('m');
  await page.waitForTimeout(100);
  await page.keyboard.up('m');
  await page.waitForTimeout(100);
  const afterVideoKeyRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!afterVideoKeyRestore.ok || afterVideoKeyRestore.value.videoTexture?.active !== 'original' || afterVideoKeyRestore.value.videoTexture?.swaps !== (assetBaseline.videoTexture?.swaps ?? 0) + 4) {
    throw new Error(`WebM keyboard restore failed: ${JSON.stringify(afterVideoKeyRestore)}`);
  }

  const jpegBefore = before.value.jpegTexture;
  if (
    jpegBefore?.available !== true ||
    jpegBefore.kind !== 'texture' ||
    jpegBefore.name !== 'wood-container.jpg' ||
    jpegBefore.format !== 'bc7-rgba-unorm-srgb' ||
    jpegBefore.colorSpace !== 'srgb'
  ) {
    throw new Error(`JPEG asset witness failed: ${JSON.stringify(jpegBefore)}`);
  }
  const atlasBefore = before.value.spriteAtlas;
  if (
    atlasBefore?.available !== true ||
    atlasBefore.guid !== '0e8657b1-c0ab-4940-a4f6-27fcd976823c' ||
    atlasBefore.name !== 'walk.atlas.png' ||
    atlasBefore.kind !== 'texture' ||
    atlasBefore.width !== 64 ||
    atlasBefore.height !== 64 ||
    atlasBefore.frameCount !== 4 ||
    atlasBefore.animatedShots !== 0 ||
    atlasBefore.animatedHits !== 0 ||
    atlasBefore.active !== false
  ) {
    throw new Error(`PNG sprite atlas witness failed: ${JSON.stringify(atlasBefore)}`);
  }
  const catalogRows = await readCatalogRows();
  const fontCatalog = {
    font: catalogRows.find((row) => row.guid === '57db8d79-bb62-4b2a-8400-67c9601870cd'),
    atlas: catalogRows.find((row) => row.guid === 'd7b931cf-5835-4341-94e7-281939db018e'),
  };
  if (
    fontCatalog.font?.kind !== 'font' ||
    fontCatalog.font?.execution !== 'cooked' ||
    !fontCatalog.font?.sourcePath?.endsWith('DejaVuSansMono.ttf') ||
    fontCatalog.atlas?.kind !== 'texture' ||
    fontCatalog.atlas?.execution !== 'cooked'
  ) {
    throw new Error(`TTF font catalog rows failed: ${JSON.stringify(fontCatalog)}`);
  }
  const fontBefore = before.value.worldScoreText;
  if (fontBefore?.available !== true || fontBefore.fontSource !== 'legacy-pack' || Math.abs(fontBefore.fontSize - 0.024) > 1e-5 || Math.abs((fontBefore.color?.[0] ?? 0) - 1) > 1e-5 || Math.abs((fontBefore.color?.[1] ?? 0) - 0.8) > 1e-5 || Math.abs((fontBefore.color?.[2] ?? 0) - 0.2) > 1e-5 || fontBefore.toggles !== 0) {
    throw new Error(`legacy font baseline failed: ${JSON.stringify(fontBefore)}`);
  }
  const fontToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-font-source'));
  const afterFontToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !fontToggle.ok ||
    !afterFontToggle.ok ||
    afterFontToggle.value.worldScoreText?.fontSource !== 'ttf-plugin' ||
    afterFontToggle.value.worldScoreText?.fontGuid !== '57db8d79-bb62-4b2a-8400-67c9601870cd' ||
    afterFontToggle.value.worldScoreText?.fontSize <= 0.024 ||
    afterFontToggle.value.worldScoreText?.color?.[2] <= afterFontToggle.value.worldScoreText?.color?.[0] ||
    afterFontToggle.value.worldScoreText?.toggles !== (assetBaseline.worldScoreText?.toggles ?? 0) + 1
  ) {
    throw new Error(`TTF font plugin toggle failed: ${JSON.stringify({ fontCatalog, fontBefore, fontToggle, afterFontToggle })}`);
  }
  const fontScore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-score'));
  await page.waitForTimeout(100);
  const afterFontScore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!fontScore.ok || fontScore.value?.points === null || !afterFontScore.ok || afterFontScore.value.worldScoreText?.active !== true || afterFontScore.value.worldScoreText?.fontSource !== 'ttf-plugin' || afterFontScore.value.worldScoreText?.fontSize <= 0.024 || afterFontScore.value.worldScoreText?.color?.[2] <= afterFontScore.value.worldScoreText?.color?.[0]) {
    throw new Error(`TTF font score outcome failed: ${JSON.stringify({ fontScore, afterFontScore })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'ttf-font-active.png') });
  await page.keyboard.down('y');
  await page.waitForTimeout(100);
  await page.keyboard.up('y');
  await page.waitForTimeout(120);
  const fontRestoreKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!fontRestoreKey.ok || fontRestoreKey.value.worldScoreText?.fontSource !== 'legacy-pack' || Math.abs(fontRestoreKey.value.worldScoreText?.fontSize - 0.024) > 1e-5 || Math.abs((fontRestoreKey.value.worldScoreText?.color?.[0] ?? 0) - 1) > 1e-5 || Math.abs((fontRestoreKey.value.worldScoreText?.color?.[1] ?? 0) - 0.8) > 1e-5 || Math.abs((fontRestoreKey.value.worldScoreText?.color?.[2] ?? 0) - 0.2) > 1e-5) {
    throw new Error(`TTF font keyboard restore failed: ${JSON.stringify(fontRestoreKey)}`);
  }
  const atlasToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-sprite-atlas'));
  if (!atlasToggle.ok || atlasToggle.value?.active !== true || atlasToggle.value?.swaps !== (assetBaseline.spriteAtlas?.swaps ?? 0) + 1) {
    throw new Error(`PNG sprite atlas toggle failed: ${JSON.stringify(atlasToggle)}`);
  }
  await page.keyboard.down('f');
  await page.waitForTimeout(90);
  await page.keyboard.up('f');
  await page.waitForTimeout(90);
  const atlasFrame1 = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  await page.waitForTimeout(180);
  const atlasFrame2 = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !atlasFrame1.ok ||
    !atlasFrame2.ok ||
    atlasFrame1.value.spriteAtlas?.active !== true ||
    atlasFrame1.value.spriteAtlas?.animatedShots < 1 ||
    atlasFrame1.value.spriteAtlas?.trackedEntities < 1 ||
    atlasFrame2.value.spriteAtlas?.frame === atlasFrame1.value.spriteAtlas?.frame
  ) {
    throw new Error(`PNG sprite atlas animation did not advance: ${JSON.stringify({ atlasFrame1, atlasFrame2 })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'sprite-atlas-active.png') });
  await page.keyboard.down('n');
  await page.waitForTimeout(100);
  await page.keyboard.up('n');
  await page.waitForTimeout(120);
  const atlasRestoreKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!atlasRestoreKey.ok || atlasRestoreKey.value.spriteAtlas?.active !== false) {
    throw new Error(`PNG sprite atlas keyboard restore failed: ${JSON.stringify(atlasRestoreKey)}`);
  }
  const jpegToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-jpeg-texture'));
  const afterJpeg = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!jpegToggle.ok || !afterJpeg.ok || afterJpeg.value.jpegTexture?.active !== 'jpeg' || afterJpeg.value.jpegTexture?.swaps !== (assetBaseline.jpegTexture?.swaps ?? 0) + 1) {
    throw new Error(`JPEG toggle failed: ${JSON.stringify({ jpegToggle, afterJpeg })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'jpeg-active.png') });
  const jpegRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-jpeg-texture'));
  const afterJpegRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!jpegRestore.ok || !afterJpegRestore.ok || afterJpegRestore.value.jpegTexture?.active !== 'original') {
    throw new Error(`JPEG restore failed: ${JSON.stringify({ jpegRestore, afterJpegRestore })}`);
  }

  // The reset above intentionally restores score to zero. Re-cross the same
  // Score 50 contract before exercising the profile action again.
  for (let index = 0; index < 5; index++) {
    await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-score'));
    await page.waitForTimeout(120);
  }
  const profileToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-target-profile'));
  const afterProfile = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !profileToggle.ok ||
    !afterProfile.ok ||
    afterProfile.value.targetProfile?.active !== 'profile' ||
    afterProfile.value.targetProfile?.swaps !== (assetBaseline.targetProfile?.swaps ?? 0) + 1 ||
    afterProfile.value.targetProfile?.baseColor?.[2] !== 1
  ) {
    throw new Error(`target profile action failed: ${JSON.stringify({ profileToggle, afterProfile })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'target-profile-active.png') });
  await page.keyboard.down('p');
  await page.waitForTimeout(100);
  await page.keyboard.up('p');
  await page.waitForTimeout(150);
  const afterProfileKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!afterProfileKey.ok || afterProfileKey.value.targetProfile?.active !== 'original') {
    throw new Error(`target profile keyboard restore failed: ${JSON.stringify(afterProfileKey)}`);
  }

  const visibilityToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-visibility'));
  const afterVisibilityAction = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !visibilityToggle.ok ||
    !afterVisibilityAction.ok ||
    afterVisibilityAction.value.visibility?.intent !== 'hidden' ||
    afterVisibilityAction.value.visibility?.effective !== 'hidden'
  ) {
    throw new Error(`visibility inspection action failed: ${JSON.stringify({ visibilityToggle, afterVisibilityAction })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'visibility-hidden.png') });
  const visibilityRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-visibility'));
  const afterVisibilityRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !visibilityRestore.ok ||
    !afterVisibilityRestore.ok ||
    afterVisibilityRestore.value.visibility?.intent !== 'visible' ||
    afterVisibilityRestore.value.visibility?.effective !== 'visible'
  ) {
    throw new Error(`visibility inspection restore failed: ${JSON.stringify({ visibilityRestore, afterVisibilityRestore })}`);
  }

  const orbit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.set-view', { mode: 'orbit' }));
  const afterOrbit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!orbit.ok || !afterOrbit.ok || afterOrbit.value.viewMode !== 'orbit') throw new Error(`view projection failed: ${JSON.stringify({ orbit, afterOrbit })}`);
  if (afterOrbit.value.fbxSkinnedTarget.animationTime === fbxBefore.animationTime) throw new Error('FBX animation time did not advance');

  const hit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-hit'));
  await page.waitForTimeout(150);
  const afterHit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!hit.ok || !afterHit.ok || afterHit.value.fbxSkinnedTarget.hitPulses !== 1) {
    throw new Error(`FBX hit loop failed: ${JSON.stringify({ hit, afterHit })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'after-hit.png') });

  const invalidState = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.invalid-state'));
  if (!invalidState.ok || invalidState.value.errorCode !== 'invalid-variant') throw new Error(`invalid state witness failed: ${JSON.stringify(invalidState)}`);
  const missingRead = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('missing.read'));
  if (missingRead.ok || missingRead.error.code !== 'projection-read-not-found') throw new Error(`missing read did not fail structurally: ${JSON.stringify(missingRead)}`);

  const resetRequest = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.reset'));
  await page.waitForTimeout(250);
  const afterReset = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !resetRequest.ok ||
    !afterReset.ok ||
    afterReset.value.state.phase !== 'Play' ||
    afterReset.value.state.resetTransitions < 1 ||
    afterReset.value.videoTexture?.active !== 'original' ||
    afterReset.value.videoTexture?.hitReactions !== 0 ||
    afterReset.value.videoTexture?.lastHitPlayhead !== null ||
    afterReset.value.visibility?.intent !== 'inherited' ||
    afterReset.value.visibility?.effective !== 'visible' ||
    afterReset.value.spriteAtlas?.active !== false ||
    afterReset.value.spriteAtlas?.frame !== 0 ||
    afterReset.value.spriteAtlas?.trackedEntities !== 0 ||
    afterReset.value.spriteAtlas?.animatedShots !== 0 ||
    afterReset.value.spriteAtlas?.animatedHits !== 0
    || afterReset.value.worldScoreText?.fontSource !== 'legacy-pack'
    || afterReset.value.worldScoreText?.toggles !== 0
    || afterReset.value.vfxHit?.mode !== 'hit'
    || afterReset.value.vfxHit?.guid !== 'cbc4f40d-d148-53ee-89e7-310ef3abcfe9'
    || afterReset.value.vfxHit?.playing !== false
    || afterReset.value.vfxHit?.seed !== 0
    || afterReset.value.vfxHit?.triggers !== 0
    || afterReset.value.vfxHit?.alive !== 0
  ) {
    throw new Error(`reset projection failed: ${JSON.stringify({ resetRequest, afterReset })}`);
  }

  const health = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.renderer.health());
  if (health.reason !== 'alive') throw new Error(`unexpected renderer health: ${JSON.stringify(health)}`);
  const recoverHealthy = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.renderer.recover());
  if (recoverHealthy.ok || recoverHealthy.error.code !== 'recover-not-needed') throw new Error(`healthy recover did not refuse structurally: ${JSON.stringify(recoverHealthy)}`);

  const capture = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.captureFrame(1));
  if (
    !capture.ok ||
    capture.value?.kind !== 'rhi-tape' ||
    typeof capture.value.path !== 'string' ||
    typeof capture.value.digest !== 'string'
  ) throw new Error(`RHI capture failed: ${JSON.stringify(capture)}`);
  const tapeSource = [capture.value.path, resolve(ROOT, capture.value.path)].find((path) => existsSync(path));
  if (tapeSource === undefined) throw new Error(`single Preview tape artifact is missing: ${capture.value.path}`);
  const artifactPath = resolve(ARTIFACT_DIR, 'frame.rhitape');
  copyFileSync(tapeSource, artifactPath);
  const decodedTape = decodeTape(new Uint8Array(readFileSync(artifactPath)));
  if (!decodedTape.ok) throw new Error(`captured tape decode failed: ${decodedTape.error.code} (${decodedTape.error.hint})`);
  const capturedEvents = decodedTape.value.events;
  const skinPipelines = new Set(
    capturedEvents
      .filter((event) => event.kind === 'createRenderPipeline')
      .filter((event) => {
        const buffer = event.desc?.vertex?.buffers?.[0];
        const attributes = buffer?.attributes ?? [];
        return (
          buffer?.arrayStride === 72 &&
          attributes.some((attribute) => attribute.shaderLocation === 4 && attribute.format === 'uint16x4') &&
          attributes.some((attribute) => attribute.shaderLocation === 5 && attribute.format === 'float32x4')
        );
      })
      .map((event) => event.handleId),
  );
  let activePipeline;
  const hasVisibleFbxDraw = capturedEvents.some((event) => {
    if (event.kind === 'setPipeline') activePipeline = event.pipelineHandleId;
    return event.kind === 'drawIndexed' && event.indexCount >= 9000 && skinPipelines.has(activePipeline);
  });
  if (!hasVisibleFbxDraw) throw new Error(`captured frame did not contain a skinned FBX draw: pipelines=${JSON.stringify([...skinPipelines])}`);
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'after-recovery.png') });

  await page.evaluate(() => window.postMessage({ type: 'VAG_PREVIEW_DISPOSE' }, '*'));
  await page.waitForTimeout(50);
  const cleared = await page.evaluate(() => globalThis.__forgeaxPreviewInspection === undefined);
  if (!cleared) throw new Error('Preview inspection global survived Stop');

  const report = { listed, before, hudTargetStatus, assetLabReset, vfxBefore, vfxTrigger, afterVfx, videoBefore, videoToggle, afterVideo, videoOrbit, videoRestore, afterVideoRestore, afterVideoKey, afterVideoKeyRestore, profileCatalog, profileBefore, profileToggle, afterProfile, afterProfileKey, atlasBefore, atlasToggle, atlasFrame1, atlasFrame2, atlasRestoreKey, fontCatalog, fontBefore, fontToggle, afterFontToggle, fontScore, afterFontScore, fontRestoreKey, jpegBefore, jpegToggle, afterJpeg, jpegRestore, afterJpegRestore, visibilityToggle, afterVisibilityAction, visibilityRestore, afterVisibilityRestore, orbit, afterOrbit, hit, afterHit, invalidState, missingRead, resetRequest, afterReset, health, recoverHealthy, capture, artifactPath, cleared, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter((line) => !line.includes('favicon') && !line.includes('Failed to load resource'));
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  console.log(`[inspection-recovery] PASS actions=${listed.actions.length} reads=${listed.reads.length} phase=${afterReset.value.state.phase} resetTransitions=${afterReset.value.state.resetTransitions} artifact=${artifactPath} cleared=${cleared}`);
  console.log(`[inspection-recovery] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(300);
}
