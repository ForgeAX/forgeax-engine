#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { loadLodProducerInputs } from './load-lod-producer-inputs.mjs';
import { selectedLod } from './lod-acceptance-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outputRoot = resolve(
  process.env.FORGEAX_E03_EVIDENCE_DIR ?? resolve(root, 'evidence/e03-lod-o'),
);
const framesPerPhase = Math.max(60, Number.parseInt(process.env.LOD_BROWSER_FRAMES ?? '60', 10));
const producerInputDirectory = process.env.FORGEAX_E03_INPUTS_DIR;
const report = {
  taskId: 'E03',
  backend: 'browser-webgpu',
  requiredCompletedFramesPerPhase: framesPerPhase,
  requiredAcceptedEvidenceFramesPerPhase: framesPerPhase,
  phases: [],
  screenshots: [],
};
const pageErrors = [];
const shaderResponseChecks = [];
let browser;
let server;
let context;
let page;
const cdpEndpoint = process.env.FORGEAX_E03_CDP_ENDPOINT;
const previewUrl = process.env.FORGEAX_E03_URL;
mkdirSync(outputRoot, { recursive: true });

try {
  if (!producerInputDirectory)
    throw new Error(
      'FORGEAX_E03_INPUTS_DIR must point to the selected producer manifest directory',
    );
  if (cdpEndpoint !== undefined && previewUrl === undefined)
    throw new Error('FORGEAX_E03_URL must name the browser-accessible preview when using CDP');
  const {
    verified: verifiedProducer,
    identity: producerIdentity,
    inputRoot: producerRoot,
  } = await loadLodProducerInputs(producerInputDirectory);
  const producerManifest = verifiedProducer.manifest;
  const shaderPublication = producerManifest.shaderClosure.publication;
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const allowedInputPaths = new Set(['manifest.json', shaderPublication.path]);
  for (const asset of producerManifest.assets) {
    allowedInputPaths.add(asset.path);
    for (const artifact of Object.values(asset.artifacts)) allowedInputPaths.add(artifact.path);
  }
  report.producerInputs = {
    producerHead: producerManifest.provenance.producerHead,
    manifestSha256: verifiedProducer.sha256,
    sourceSha256: producerManifest.provenance.source.sha256,
    metaSha256: producerManifest.provenance.meta.sha256,
    shaderPublicationSha256: shaderPublication.sha256,
    gpuReadiness: producerManifest.shaderClosure.gpuReadiness,
    stagedInitial: producerManifest.admission.initial,
    stagedLater: producerManifest.admission.later,
  };

  browser =
    cdpEndpoint === undefined
      ? await chromium.launch({
          headless: true,
          args: ['--enable-unsafe-webgpu'],
          chromiumSandbox: true,
        })
      : await chromium.connectOverCDP(cdpEndpoint);
  context = await browser.newContext({
    viewport: { width: 1000, height: 820 },
    deviceScaleFactor: 1,
  });
  page = await context.newPage();
  const network = await context.newCDPSession(page);
  await network.send('Network.enable', {
    maxResourceBufferSize: shaderPublication.byteLength * 2,
    maxTotalBufferSize: shaderPublication.byteLength * 4,
  });
  const shaderRequests = new Set();
  network.on('Network.responseReceived', ({ requestId, response }) => {
    if (new URL(response.url).pathname.endsWith('/shaders/manifest.json'))
      shaderRequests.add(requestId);
  });
  network.on('Network.loadingFailed', ({ requestId, errorText }) => {
    if (shaderRequests.delete(requestId)) pageErrors.push(`shader-response:${errorText}`);
  });
  network.on('Network.loadingFinished', ({ requestId }) => {
    if (!shaderRequests.delete(requestId)) return;
    shaderResponseChecks.push(
      network
        .send('Network.getResponseBody', { requestId })
        .then(({ body, base64Encoded }) => {
          const bytes = Buffer.from(body, base64Encoded ? 'base64' : 'utf8');
          const digest = hash(bytes);
          assert.equal(
            digest,
            shaderPublication.sha256,
            'the app loaded a different shader manifest',
          );
          assert.equal(bytes.byteLength, shaderPublication.byteLength);
          report.appShaderManifestSha256 = digest;
        })
        .catch((error) => {
          pageErrors.push(`shader-response:${error instanceof Error ? error.message : error}`);
        }),
    );
  });
  page.on('pageerror', (error) => pageErrors.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console:${message.text()}`);
  });
  let url = previewUrl;
  if (url === undefined) {
    server = await createServer({
      root,
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    await server.listen();
    url = `http://127.0.0.1:${server.config.server.port}`;
  }
  report.url = url;
  await page.route('**/__e03-inputs/**', async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const relativePath = pathname.slice('/__e03-inputs/'.length);
    if (!allowedInputPaths.has(relativePath)) {
      await route.fulfill({ status: 404, body: 'E03 input path is not in the fixed manifest' });
      return;
    }
    const bytes = readFileSync(resolve(producerRoot, relativePath));
    await route.fulfill({
      status: 200,
      body: bytes,
      contentType: relativePath.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    });
  });
  await page.addInitScript(
    (inputs) => {
      globalThis.__forgeaxLodIncrementalInputs = inputs;
    },
    { manifestUrl: '/__e03-inputs/manifest.json', ...producerIdentity },
  );
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const api = globalThis.__forgeaxLodAcceptance;
      return typeof api?.snapshot === 'function' && api.snapshot().latestReceipt !== undefined;
    },
    undefined,
    { timeout: 45_000 },
  );

  const snapshot = async () => page.evaluate(() => globalThis.__forgeaxLodAcceptance.snapshot());
  const runPhase = async (name, expected) => {
    const before = await snapshot();
    const previousFrameId = before.latestReceipt?.frameId ?? 0;
    await page.evaluate(
      ({ phaseName, phaseFrames }) =>
        globalThis.__forgeaxLodAcceptance.beginPhase(phaseName, phaseFrames),
      { phaseName: name, phaseFrames: framesPerPhase },
    );
    await page.waitForFunction(
      ({ phaseName, phaseFrames }) => {
        const value = globalThis.__forgeaxLodAcceptance.snapshot();
        return value.phase === phaseName && value.phaseAcceptedFrames === phaseFrames;
      },
      { phaseName: name, phaseFrames: framesPerPhase },
      { timeout: 45_000 },
    );
    const value = await snapshot();
    assert.equal(
      value.phaseAcceptedFrames,
      framesPerPhase,
      `${name} did not finish the requested accepted evidence frames`,
    );
    assert.ok(value.phaseCompletedFrames >= framesPerPhase);
    assert.ok(value.evidenceReceipt?.frameId > previousFrameId);
    const phaseLastFrameId = value.latestReceipt?.frameId;
    assert.equal(
      value.runtimeErrors.length,
      0,
      `${name} recorded runtime errors: ${value.runtimeErrors.join(', ')}`,
    );
    assert.equal(
      value.submit?.frameId,
      value.evidenceReceipt?.frameId,
      `${name} LOD facts must match an exact completed receipt`,
    );
    assert.equal(
      value.submit?.deviceGeneration,
      value.evidenceReceipt?.deviceGeneration,
      `${name} generation identity mismatch`,
    );
    assert.equal(
      value.sameSubmitAttribution?.status,
      'same-submit',
      `${name} World attribution is not same-submit`,
    );
    assert.equal(value.views.length, 2, `${name} must report both CameraViews`);
    assert.equal(value.views[0]?.cameraEntity, value.nearCameraEntity);
    assert.equal(value.views[1]?.cameraEntity, value.farCameraEntity);
    assert.ok(value.views[0]?.viewKey, `${name} near CameraView key is missing`);
    assert.ok(value.views[1]?.viewKey, `${name} far CameraView key is missing`);
    assert.notEqual(value.views[0]?.viewKey, value.views[1]?.viewKey);
    assert.equal(value.views[0]?.attachmentId, value.attachmentId);
    assert.equal(value.views[1]?.attachmentId, value.attachmentId);
    if (expected.visible === 0) {
      assert.equal(value.targetVisible, false);
      assert.deepEqual(value.hiddenDraws, { status: 'complete', draws: [] });
      assert.equal(value.aggregate, undefined, 'hidden draws must not fabricate LOD counts');
    } else if (expected.visible !== undefined)
      assert.equal(value.aggregate?.visible, expected.visible);
    if (expected.nearLevel !== undefined)
      assert.equal(selectedLod(value.views[0]), expected.nearLevel);
    if (expected.farLevel !== undefined)
      assert.equal(selectedLod(value.views[1]), expected.farLevel);
    if (expected.farBelow !== undefined) assert.ok(selectedLod(value.views[1]) < expected.farBelow);
    const screenshotPath = resolve(outputRoot, `browser-${name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const phase = {
      name,
      completedFrames: value.phaseCompletedFrames,
      acceptedEvidenceFrames: value.phaseAcceptedFrames,
      previousFrameId,
      lastFrameId: phaseLastFrameId,
      evidenceReceipt: value.evidenceReceipt,
      submit: value.submit,
      attachmentId: value.attachmentId,
      attribution: value.sameSubmitAttribution,
      cameraViews: value.views,
      aggregate: value.aggregate,
      hiddenDraws: value.hiddenDraws,
      hiddenLodObservation: value.hiddenLodObservation,
      assetRegistry: {
        rootReady: value.lodAssetsReady[0],
        middleReady: value.lodAssetsReady[1],
        lowestReady: value.lodAssetsReady[2],
      },
      targetVisible: value.targetVisible,
      rootMeshSharedRefCount: value.rootMeshSharedRefCount,
      revisionRace: value.revisionRace,
      dynamicReceipt: value.dynamicReceipt,
      screenshot: screenshotPath,
    };
    report.phases.push(phase);
    report.screenshots.push(screenshotPath);
    writeFileSync(
      resolve(outputRoot, `browser-${name}.json`),
      `${JSON.stringify(phase, null, 2)}\n`,
      'utf8',
    );
    return phase;
  };

  const initial = await snapshot();
  assert.deepEqual(initial.producerInput, {
    producerHead: producerManifest.provenance.producerHead,
    manifestSha256: verifiedProducer.sha256,
    shaderPublicationSha256: shaderPublication.sha256,
    gpuReadiness: 'unverified',
    admission: 'incremental-catalog',
  });
  assert.equal(
    initial.lodAssetsReady[2],
    false,
    'lowest LOD must remain unavailable during the fallback phase',
  );
  const fallback = await runPhase('lod2-not-ready-fallback', {
    visible: 2,
    nearLevel: 0,
    farBelow: 2,
  });
  assert.equal(fallback.assetRegistry.lowestReady, false);

  await page.evaluate(() => globalThis.__forgeaxLodAcceptance.loadLowestLod());
  let residentLevel = false;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const before = await snapshot();
    await page.evaluate(
      ({ phaseName }) => globalThis.__forgeaxLodAcceptance.beginPhase(phaseName, 1),
      {
        phaseName: `lod2-residency-warmup-${attempt + 1}`,
      },
    );
    await page.waitForFunction(
      ({ phaseName }) => {
        const value = globalThis.__forgeaxLodAcceptance.snapshot();
        return value.phase === phaseName && value.phaseAcceptedFrames === 1;
      },
      { phaseName: `lod2-residency-warmup-${attempt + 1}` },
      { timeout: 15_000 },
    );
    const warmed = await snapshot();
    report.residencyWarmupFrames ??= [];
    report.residencyWarmupFrames.push(warmed.latestReceipt.frameId);
    if (selectedLod(warmed.views[1]) === 2) {
      residentLevel = true;
      break;
    }
    if (warmed.latestReceipt.frameId <= (before.latestReceipt?.frameId ?? 0)) {
      throw new Error('residency warmup did not advance a completed frame receipt');
    }
  }
  assert.ok(residentLevel, 'loaded lowest LOD never became the selected resident GPU LOD');
  const ready = await runPhase('lod2-ready-resident', { visible: 2, nearLevel: 0, farLevel: 2 });
  assert.equal(ready.assetRegistry.lowestReady, true);

  const visibleRefCount = ready.rootMeshSharedRefCount;
  await page.evaluate(() => globalThis.__forgeaxLodAcceptance.setVisible(false));
  const hidden = await runPhase('visibility-hidden', { visible: 0 });
  assert.equal(hidden.targetVisible, false);
  assert.equal(
    hidden.rootMeshSharedRefCount,
    visibleRefCount,
    'Visibility must not release the mesh shared reference',
  );
  assert.equal(
    hidden.assetRegistry.lowestReady,
    true,
    'Visibility must not evict the AssetRegistry payload',
  );

  await page.evaluate(() => globalThis.__forgeaxLodAcceptance.setVisible(true));
  await runPhase('visibility-restored-resident', { visible: 2, nearLevel: 0, farLevel: 2 });

  const race = await page.evaluate(() => globalThis.__forgeaxLodAcceptance.acceptRevisionRace());
  assert.equal(race.revisionRace.acceptedRevision, 4);
  assert.equal(race.revisionRace.lateRevision, 3);
  assert.equal(race.revisionRace.lateError, 'dynamic-geometry-candidate-not-found');
  assert.equal(race.revisionRace.bindingHandle, race.dynamicRevisionBindingHandle);
  const dynamic = await runPhase('revision-4-keeps-late-3-stale', {
    visible: 2,
    nearLevel: 0,
    farLevel: 2,
  });
  assert.equal(dynamic.dynamicReceipt?.revision, 4);
  assert.equal(dynamic.dynamicReceipt?.recordStageConsumed, true);
  assert.ok(dynamic.dynamicReceipt.frameId > dynamic.previousFrameId);
  assert.ok(dynamic.dynamicReceipt.frameId <= dynamic.lastFrameId);

  assert.equal(pageErrors.length, 0, `browser reported errors: ${pageErrors.join(' | ')}`);
  await Promise.all(shaderResponseChecks);
  assert.equal(report.appShaderManifestSha256, shaderPublication.sha256);
  report.status = 'PASS';
  report.url = url;
  const finalState = await snapshot();
  report.totalCompletedFrames = finalState.totalCompletedFrames;
  report.totalAcceptedEvidenceFrames = finalState.totalAcceptedFrames;
  report.pageErrors = pageErrors;
} catch (error) {
  report.status = 'FAILED';
  report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  report.pageErrors = pageErrors;
  if (page !== undefined) {
    report.lastPageState = await page
      .evaluate(() => {
        const api = globalThis.__forgeaxLodAcceptance;
        return typeof api?.snapshot === 'function'
          ? api.snapshot()
          : { status: document.querySelector('#status')?.textContent };
      })
      .catch(() => undefined);
    const failureShot = resolve(outputRoot, 'browser-failure.png');
    await page.screenshot({ path: failureShot, fullPage: false }).catch(() => undefined);
    report.failureScreenshot = failureShot;
  }
  throw error;
} finally {
  writeFileSync(
    resolve(outputRoot, 'browser-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  if (context !== undefined) await context.close();
  if (browser !== undefined && cdpEndpoint === undefined) await browser.close();
  if (server !== undefined) await server.close();
}

console.log(
  `[hello-lod-occlusion] browser phases=${report.phases.length} completedFrames=${report.totalCompletedFrames} screenshots=${report.screenshots.length}`,
);
if (cdpEndpoint !== undefined) process.exit(0);
