import { once } from 'node:events';
// Browser/RHI-debug MSAA OFF/ON capture gate.
// It keeps the tutorial's user-facing toggle on the public path and checks the
// tape facts that a single default-OFF capture cannot prove.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { decodeTape } from '@forgeax/engine-rhi-debug';
import { compareCapturePair } from './capture-pair-owner.mjs';

const appDir = resolve(import.meta.dirname, '..');
const { PNG } = createRequire(resolve(appDir, 'package.json'))('pngjs');
const artifactDir = process.env.FORGEAX_MSAA_PAIR_ARTIFACT_DIR
  ? resolve(process.env.INIT_CWD ?? process.cwd(), process.env.FORGEAX_MSAA_PAIR_ARTIFACT_DIR)
  : resolve(appDir, '.forgeax-debug');
const PAIR_LINEAGE = 'learn-render-msaa-browser-pair';
const WORKLOAD = 'learn-render-4.10-anti-aliasing-msaa';
const LOGICAL_FRAME = 'frame-1';
const CAPTURE_ENVIRONMENT = 'browser-webgpu';
const MAX_VITE_READINESS_TIMEOUT_MS = 180_000;
const VITE_READINESS_TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.FORGEAX_MSAA_VITE_READINESS_TIMEOUT_MS ?? '90000', 10) || 90_000, 1),
  MAX_VITE_READINESS_TIMEOUT_MS,
);
const browserHeadless = !['0', 'false'].includes(
  (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
);

async function findFreePort() {
  const portServer = createServer();
  await once(portServer.listen(0, '127.0.0.1'), 'listening');
  const address = portServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise((resolveClose, reject) => {
    portServer.close((error) => error ? reject(error) : resolveClose());
  });
  if (port === undefined) throw new Error('could not resolve an ephemeral Vite port');
  return String(port);
}

async function stopViteServer(server) {
  if (server.pid === undefined || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
  const signal = (name) => {
    try {
      if (process.platform === 'win32') server.kill(name);
      else process.kill(-server.pid, name);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  if (await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])) return;
  signal('SIGKILL');
  if (!(await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]))) {
    throw new Error('vite process-group cleanup incomplete after SIGKILL');
  }
}

function tapeFacts(tape, runId) {
  const bootstrapCreates = tape.bootstrap.map((resource) => resource.create);
  const msaaTextures = bootstrapCreates
    .filter((event) => event.kind === 'createTexture' && (event.desc.sampleCount ?? 1) > 1)
    .map((event) => ({
      handleId: event.handleId,
      sampleCount: event.desc.sampleCount,
      format: event.desc.format,
      size: event.desc.size,
    }));
  const msaaPipelines = bootstrapCreates
    .filter((event) => event.kind === 'createRenderPipeline' && (event.desc.multisample?.count ?? 1) > 1)
    .map((event) => ({
      handleId: event.handleId,
      sampleCount: event.desc.multisample.count,
      targetFormats: event.desc.fragment?.targets?.map((target) => target.format) ?? [],
    }));
  const resolvePasses = tape.events
    .filter((event) => event.kind === 'beginRenderPass')
    .map((event) => ({
      passHandleId: event.passHandleId,
      views: event.colorAttachmentViewHandleIds,
      resolveTargets: event.colorAttachmentResolveTargetHandleIds ?? [],
    }))
    .filter((pass) => pass.resolveTargets.some((handleId) => handleId !== undefined && handleId !== null));
  return {
    runId,
    eventCount: tape.events.length,
    blobCount: tape.header?.blobCount ?? tape.blobs?.length ?? null,
    msaaTextures,
    msaaPipelines,
    resolvePasses,
    valid: true,
  };
}

function assertPairManifest(manifest, off, on) {
  if (!manifest || !manifest.baseline || !manifest.comparison) {
    throw new Error('paired manifest is missing explicit baseline and comparison artifacts');
  }
  const { baseline, comparison } = manifest;
  for (const [side, artifact] of [['baseline', baseline], ['comparison', comparison]]) {
    if (typeof artifact.tapePath !== 'string' || !existsSync(artifact.tapePath)) {
      throw new Error(`paired manifest ${side} is missing its materialized capture tape`);
    }
    if (typeof artifact.tapeDigest !== 'string' || artifact.tapeDigest.length === 0) {
      throw new Error(`paired manifest ${side} is missing its capture tape digest`);
    }
  }
  if (baseline.artifactId === comparison.artifactId) {
    throw new Error('paired manifest must use distinct baseline and comparison artifact IDs');
  }
  for (const field of [
    'pairedCaptureLineage',
    'workload',
    'logicalFrame',
    'captureEnvironment',
    'evidenceScope',
    'outputShape',
  ]) {
    if (baseline[field] === undefined || comparison[field] === undefined) {
      throw new Error(`paired manifest is missing ${field}`);
    }
    if (JSON.stringify(baseline[field]) !== JSON.stringify(comparison[field])) {
      throw new Error(`paired manifest does not preserve shared ${field}`);
    }
  }
  if (baseline.controls?.msaa !== false || comparison.controls?.msaa !== true) {
    throw new Error(`paired manifest controls are not explicit OFF/ON: ${JSON.stringify(manifest)}`);
  }
  if (!Array.isArray(baseline.finalColorRgb8) || !Array.isArray(comparison.finalColorRgb8)) {
    throw new Error('paired manifest must retain raw final-color RGB8 evidence');
  }
  const expectedBytes = Buffer.from(off.pixels, 'base64').length;
  if (
    baseline.finalColorRgb8.length !== expectedBytes ||
    comparison.finalColorRgb8.length !== expectedBytes
  ) {
    throw new Error('paired manifest final-color evidence has an invalid shape');
  }
  if (baseline.artifactId !== off.runId || comparison.artifactId !== on.runId) {
    throw new Error('paired manifest artifact IDs do not identify their capture outputs');
  }
  for (const [side, artifact] of [
    ['baseline', baseline],
    ['comparison', comparison],
  ]) {
    if (
      typeof artifact.tapePath !== 'string' ||
      !existsSync(artifact.tapePath) ||
      !Number.isSafeInteger(artifact.tapeFacts?.eventCount) ||
      artifact.tapeFacts.eventCount === 0
    ) {
      throw new Error(`paired manifest ${side} is missing its bounded tape evidence`);
    }
  }
}

function assertAcceptedPair(result) {
  if (!result || result.status !== 'accepted') {
    throw new Error(`MSAA pair was not accepted by the shared owner: ${JSON.stringify(result)}`);
  }
  if (result.pair?.changedControl?.name !== 'msaa') {
    throw new Error('accepted pair does not identify the single changed MSAA control');
  }
  if (result.rawComparison?.domain !== 'final-color-rgb8') {
    throw new Error('accepted pair is missing final-color raw comparison evidence');
  }
  if (result.rawFirstDivergence === null || result.outcome !== 'divergence') {
    throw new Error('accepted MSAA pair must expose a non-zero raw divergence');
  }
  if (
    result.derivedMetrics?.status !== 'available' ||
    result.derivedMetrics.changedPixelCount < 1
  ) {
    throw new Error('accepted MSAA pair must expose non-zero derived changed-pixel evidence');
  }
}

function assertTraceableAccess(access, capture, side, lineageAccess = access) {
  if (!access || !Number.isSafeInteger(access.eventIndex) || access.eventIndex < 0) {
    throw new Error(`MSAA ${side} P2 divergence is missing a source event index`);
  }
  const captureEvents = [
    ...(capture.tape?.bootstrap ?? []).map((resource) => resource.create),
    ...capture.events,
  ];
  const event = captureEvents[access.eventIndex];
  if (!event) {
    throw new Error(`MSAA ${side} P2 event index ${access.eventIndex} is not present in its tape`);
  }
  const eventText = JSON.stringify(event);
  const sourceHandleIds = [access.resourceHandleId, lineageAccess?.viewHandleId].filter(
    (handleId) => typeof handleId === 'string',
  );
  const directTrace = sourceHandleIds.some((handleId) => eventText.includes(handleId));
  const setupKinds = new Set(['vertex', 'index', 'binding']);
  const setupTrace =
    !directTrace &&
    setupKinds.has(access.role) &&
    captureEvents.slice(0, access.eventIndex).some((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const record = candidate;
      if (
        (access.role === 'vertex' && record.kind !== 'setVertexBuffer') ||
        (access.role === 'index' && record.kind !== 'setIndexBuffer') ||
        (access.role === 'binding' && record.kind !== 'createBindGroup')
      ) {
        return false;
      }
      return sourceHandleIds.some((handleId) => JSON.stringify(record).includes(handleId));
    });
  if (!directTrace && !setupTrace) {
    throw new Error(`MSAA ${side} P2 resource identity is not traceable to its source event`);
  }
  if (
    lineageAccess !== undefined &&
    (!lineageAccess.subresource || typeof lineageAccess.subresource !== 'object')
  ) {
    throw new Error(`MSAA ${side} P2 lineage is missing subresource evidence`);
  }
}

function findLineageAccess(edges, side, access) {
  return edges
    .map((edge) => edge[side])
    .find(
      (candidate) =>
        candidate?.eventIndex === access.eventIndex &&
        candidate.accessOrdinal === access.accessOrdinal,
    );
}

function assertRealP2Positive(result, off, on) {
  if (result?.eventResource?.status !== 'divergence') {
    throw new Error(
      `real MSAA pair did not produce a P2 divergence: ${JSON.stringify(result?.eventResource)}`,
    );
  }
  const first = result.eventResource.firstDivergence;
  if (!first || first.field === 'access.presence') {
    throw new Error('real MSAA P2 divergence must identify a concrete event/resource field');
  }
  const edges = result.eventResource.lineage.edges;
  if (result.eventResource.lineage.limit !== 64 || edges.length === 0) {
    throw new Error('real MSAA P2 lineage must be bounded and non-empty');
  }
  const traceableEdges = edges.filter((edge) => edge.baseline && edge.comparison);
  if (traceableEdges.length === 0) {
    throw new Error('real MSAA P2 lineage must retain paired event/resource edges');
  }
  const firstBaseline = findLineageAccess(edges, 'baseline', first.baseline);
  const firstComparison = findLineageAccess(edges, 'comparison', first.comparison);
  assertTraceableAccess(first.baseline, off, 'baseline', firstBaseline);
  assertTraceableAccess(first.comparison, on, 'comparison', firstComparison);
  for (const edge of traceableEdges) {
    assertTraceableAccess(edge.baseline, off, 'baseline lineage', edge.baseline);
    assertTraceableAccess(edge.comparison, on, 'comparison lineage', edge.comparison);
  }
}

function assertRealP2NoDivergence(result) {
  if (
    !['no-divergence', 'truncated'].includes(result?.eventResource?.status) ||
    result.eventResource.firstDivergence !== null ||
    result.eventResource.lineage.edges.length === 0
  ) {
    throw new Error(
      `real MSAA equal-evidence control was not an honest P2 no-divergence result: ${JSON.stringify(result?.eventResource)}`,
    );
  }
}

function assertPositiveAnswerSubstitutionFalsifier(result) {
  if (result?.eventResource?.status === 'divergence') {
    throw new Error('substituting the positive MSAA result into the negative control passed P2');
  }
  if (!['no-divergence', 'truncated'].includes(result?.eventResource?.status)) {
    throw new Error(
      `positive-answer substitution falsifier did not reach the negative P2 state: ${JSON.stringify(result?.eventResource)}`,
    );
  }
}

function assertRejectedLogicalFrame(result) {
  if (result?.status !== 'rejected' || result.failure?.code !== 'paired-identity-mismatch') {
    throw new Error(`mismatched logical frame was not rejected by the shared owner: ${JSON.stringify(result)}`);
  }
  if (result.failure.detail?.field !== 'logicalFrame') {
    throw new Error('mismatched logical frame rejection lacks narrowed field detail');
  }
  for (const field of ['rawComparison', 'rawFirstDivergence', 'derivedMetrics', 'outcome']) {
    if (field in result) throw new Error(`rejected pair incorrectly exposes ${field}`);
  }
}

function assertPairIsolation(repeated, concurrent, manifests) {
  if (!Array.isArray(repeated) || repeated.length !== 2 || !repeated[0] || !repeated[1]) {
    throw new Error('repeat isolation proof is missing two owner results');
  }
  if (JSON.stringify(repeated[0]) !== JSON.stringify(repeated[1])) {
    throw new Error('repeated identical pair inputs produced different owner documents');
  }
  if (!Array.isArray(concurrent) || concurrent.length !== 2 || concurrent.some((item) => !item)) {
    throw new Error('concurrent isolation proof is missing two owner results');
  }
  for (let index = 0; index < concurrent.length; index += 1) {
    const expected = manifests[index];
    const actual = concurrent[index];
    if (
      actual.status !== 'accepted' ||
      actual.pair.baseline.artifactId !== expected.baseline.artifactId ||
      actual.pair.comparison.artifactId !== expected.comparison.artifactId ||
      JSON.stringify(actual.rawComparison.baselineBytes) !==
        JSON.stringify(expected.baseline.finalColorRgb8) ||
      JSON.stringify(actual.rawComparison.comparisonBytes) !==
        JSON.stringify(expected.comparison.finalColorRgb8)
    ) {
      throw new Error(`concurrent pair result mixed evidence for input ${index}`);
    }
  }
}

function assertEqualPixelsFalsification(result) {
  if (
    result?.status !== 'accepted' ||
    result.outcome !== 'no-divergence' ||
    result.rawFirstDivergence !== null ||
    result.derivedMetrics?.status !== 'available' ||
    result.derivedMetrics.changedPixelCount !== 0
  ) {
    throw new Error(`equal-pixel falsification did not produce an honest no-divergence result: ${JSON.stringify(result)}`);
  }
}

function isTransientExternalInstanceError(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.includes('A valid external Instance reference no longer exists');
}

async function capture(page, label) {
  const result = await page.evaluate(async ({ label: captureLabel, snapshotTimeoutMs }) => {
    const capture = globalThis.__captureAntiAliasingMsaaFrame;
    if (typeof capture !== 'function') {
      throw new Error('window.__captureAntiAliasingMsaaFrame missing');
    }
    // A valid diagnostic tape can describe preparation. This paired visual
    // proof needs an actual ready scene submission under the same deadline.
    const deadline = Date.now() + snapshotTimeoutMs;
    let out;
    do {
      out = await capture({ snapshotTimeoutMs: Math.max(1, deadline - Date.now()) });
      if (!out?.ok) return { label: captureLabel, out };
      const submitted = out.value.submittedFrame;
      if (submitted.status === 'complete' && submitted.receipt.presentation === 'ready') break;
      if (submitted.status !== 'complete') {
        throw new Error(`capture ${captureLabel} has no completed submission: ${JSON.stringify(submitted)}`);
      }
      if (Date.now() >= deadline) throw new Error(`capture ${captureLabel} scene did not become ready`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } while (true);
    const bytes = out.value.bytes instanceof Uint8Array
      ? out.value.bytes
      : new Uint8Array(out.value.bytes);
    let binary = '';
    const chunkSize = 0x2000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return {
      label: captureLabel,
      out: {
        ok: true,
        value: { kind: out.value.kind, digest: out.value.digest, bytes: btoa(binary) },
      },
      hud: document.querySelector('#msaa-hud')?.textContent ?? null,
      outputShape: {
        width: document.querySelector('canvas')?.width ?? 0,
        height: document.querySelector('canvas')?.height ?? 0,
        channels: 4,
      },
    };
  }, { label, snapshotTimeoutMs: 30_000 });
  if (!result.out?.ok) {
    throw new Error(`capture ${label} failed before materializing v7 tape: ${JSON.stringify(result.out)}`);
  }
  const screenshot = await page.locator('#app').screenshot();
  const png = PNG.sync.read(screenshot);
  if (png.width !== result.outputShape.width || png.height !== result.outputShape.height) {
    throw new Error(
      `capture ${label} screenshot dimensions ${png.width}x${png.height} do not match canvas ${result.outputShape.width}x${result.outputShape.height}`,
    );
  }
  if (!result.out?.ok || typeof result.out.value?.bytes !== 'string') {
    throw new Error(`capture ${label} returned no v7 tape bytes: ${JSON.stringify(result.out)}`);
  }
  const tapeBytes = Buffer.from(result.out.value.bytes, 'base64');
  const tapeResult = decodeTape(new Uint8Array(tapeBytes));
  if (!tapeResult.ok) {
    throw new Error(`capture ${label} tape could not be decoded: ${tapeResult.error.code}`);
  }
  const targetArtifactPath = resolve(artifactDir, `msaa-${label}.rhitape`);
  const runId = `${label}-${Date.now()}-${randomUUID()}`;
  writeFileSync(targetArtifactPath, tapeBytes);
  return {
    label,
    runId,
    artifactDigest: result.out.value.digest,
    hud: result.hud,
    outputShape: result.outputShape,
    artifactPath: targetArtifactPath,
    events: tapeResult.value.events,
    tape: tapeResult.value,
    pixels: Buffer.from(png.data).toString('base64'),
    facts: tapeFacts(tapeResult.value, runId),
  };
}

function captureArtifact(captureResult, msaa, logicalFrame = LOGICAL_FRAME) {
  return {
    artifactId: captureResult.runId,
    controls: { msaa },
    finalColorRgb8: Array.from(Buffer.from(captureResult.pixels, 'base64')),
    pairedCaptureLineage: PAIR_LINEAGE,
    workload: WORKLOAD,
    logicalFrame,
    captureEnvironment: CAPTURE_ENVIRONMENT,
    evidenceScope: 'final-color-rgb8',
    outputShape: captureResult.outputShape,
    tapePath: captureResult.artifactPath,
    tapeDigest: captureResult.artifactDigest,
    tapeFacts: captureResult.facts,
  };
}

function buildPairManifest(off, on, comparisonLogicalFrame = LOGICAL_FRAME) {
  return {
    baseline: captureArtifact(off, false),
    comparison: captureArtifact(on, true, comparisonLogicalFrame),
  };
}

function runOwner(manifestPath) {
  const document = compareCapturePair(manifestPath);
  const serialized = JSON.stringify(document);
  return { document, serialized };
}

function runOwnerAsync(manifestPath, lifecycle) {
  lifecycle.started.push(manifestPath);
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        lifecycle.ownerCalls.push(manifestPath);
        const result = runOwner(manifestPath).document;
        lifecycle.completed.push(manifestPath);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeManifest(name, manifest) {
  const manifestPath = resolve(artifactDir, name);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return manifestPath;
}

mkdirSync(artifactDir, { recursive: true });
const vitePort = await findFreePort();
const devServerUrl = `http://127.0.0.1:${vitePort}/`;
const server = spawn(process.execPath, [
  resolve(appDir, 'node_modules/vite/bin/vite.js'),
  '--host',
  '127.0.0.1',
  '--port',
  vitePort,
], {
  cwd: appDir,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let url;
let serverOutput = '';
let serverSpawnError;
let serverExit;
const observeServerOutput = (stream, chunk) => {
  const text = chunk.toString();
  serverOutput = `${serverOutput}${text}`.slice(-8192);
  process[stream === 'stdout' ? 'stdout' : 'stderr'].write(`[vite${stream === 'stderr' ? '-err' : ''}] ${text}`);
  const plain = serverOutput.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const match = plain.match(/Local:\s+(http:\/\/[^\s]+)/);
  if (match) url = match[1];
};
server.stdout.on('data', (chunk) => observeServerOutput('stdout', chunk));
server.stderr.on('data', (chunk) => observeServerOutput('stderr', chunk));
server.once('error', (error) => { serverSpawnError = error; });
server.once('exit', (code, signal) => { serverExit = { code, signal }; });

const consoleErrors = [];
const notFound = [];
let browser;
try {
  const readinessStartedAt = Date.now();
  let ready = false;
  let lastStatus;
  while (!ready && serverSpawnError === undefined && serverExit === undefined && Date.now() - readinessStartedAt < VITE_READINESS_TIMEOUT_MS) {
    const candidate = url ?? devServerUrl;
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(500) });
      lastStatus = response.status;
      if (response.status < 500) {
        url = candidate;
        ready = true;
      }
    } catch {
      // The server can be ready before its stdout line is delivered; keep probing.
    }
    if (!ready) await sleep(200);
  }
  if (!ready || !url) {
    throw new Error(`vite did not become ready within ${VITE_READINESS_TIMEOUT_MS}ms: ${JSON.stringify({
      elapsedMs: Date.now() - readinessStartedAt,
      pid: server.pid ?? null,
      lastStatus: lastStatus ?? null,
      spawnError: serverSpawnError === undefined ? null : String(serverSpawnError),
      exit: serverExit ?? null,
      output: serverOutput.trim() || 'none',
    })}`);
  }

  const chromeChannel = process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome';
  const chromeArgs = [
    '--disable-features=MacAppCodeSignClone',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ];
  if (chromeChannel === 'chrome-beta') {
    chromeArgs.push(
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
    );
  }
  let captureRecoveryAttempts = 0;
  let off;
  let on;
  while (true) {
    try {
      consoleErrors.length = 0;
      notFound.length = 0;
      browser = await chromium.launch({
        headless: browserHeadless,
        channel: chromeChannel,
        args: chromeArgs,
        chromiumSandbox: true,
      });
      const page = await (await browser.newContext()).newPage();
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('response', (response) => {
        if (response.status() === 404) notFound.push(response.url());
      });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForFunction(
        () => typeof globalThis.__captureAntiAliasingMsaaFrame === 'function',
        undefined,
        { timeout: 30_000 },
      );
      await page.waitForTimeout(250);

      off = await capture(page, 'off');
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      });
      await page.waitForTimeout(100);
      try {
        on = await capture(page, 'on');
      } finally {
        await page.evaluate(() => {
          window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
        });
      }
      break;
    } catch (error) {
      if (!isTransientExternalInstanceError(error) || captureRecoveryAttempts >= 2) throw error;
      captureRecoveryAttempts += 1;
      console.warn(
        `[msaa] transient WebGPU external Instance loss; restarting browser capture (recovery ${captureRecoveryAttempts}/2)`,
      );
      await browser?.close();
      browser = undefined;
      await sleep(250);
    }
  }
  if (off.hud !== 'MSAA: OFF' || on.hud !== 'MSAA: ON') {
    throw new Error(`HUD lineage failed: off=${off.hud} on=${on.hud}`);
  }
  if (on.facts.msaaTextures.length === 0 || on.facts.msaaPipelines.length === 0 || on.facts.resolvePasses.length === 0) {
    throw new Error('MSAA capture lacks multisample texture, pipeline, or resolve evidence');
  }
  const pairManifest = buildPairManifest(off, on);
  const mismatchManifest = buildPairManifest(off, on, 'frame-2');
  const pairManifestPath = writeManifest('msaa-pair.json', pairManifest);
  const mismatchManifestPath = writeManifest('msaa-pair-mismatch.json', mismatchManifest);
  const pairedRun = runOwner(pairManifestPath);
  const mismatchRun = runOwner(mismatchManifestPath);
  const pairedResult = pairedRun.document;
  const mismatchResult = mismatchRun.document;
  assertPairManifest(pairManifest, off, on);
  assertAcceptedPair(pairedResult);
  assertRealP2Positive(pairedResult, off, on);
  assertRejectedLogicalFrame(mismatchResult);
  writeFileSync(resolve(artifactDir, 'msaa-pair-result.json'), `${pairedRun.serialized}\n`);
  writeFileSync(
    resolve(artifactDir, 'msaa-pair-mismatch-result.json'),
    `${mismatchRun.serialized}\n`,
  );

  const isolatedManifest = {
    ...pairManifest,
    baseline: {
      ...pairManifest.baseline,
      artifactId: `${pairManifest.baseline.artifactId}-isolated`,
      pairedCaptureLineage: `${pairManifest.baseline.pairedCaptureLineage}-isolated`,
      logicalFrame: 'frame-isolated',
    },
    comparison: {
      ...pairManifest.comparison,
      artifactId: `${pairManifest.comparison.artifactId}-isolated`,
      pairedCaptureLineage: `${pairManifest.comparison.pairedCaptureLineage}-isolated`,
      logicalFrame: 'frame-isolated',
    },
  };
  const isolatedManifestPath = writeManifest('msaa-pair-isolated.json', isolatedManifest);
  const equalPixelsManifest = {
    ...pairManifest,
    comparison: {
      ...pairManifest.comparison,
      finalColorRgb8: [...pairManifest.baseline.finalColorRgb8],
      tapePath: pairManifest.baseline.tapePath,
      tapeDigest: pairManifest.baseline.tapeDigest,
      tapeFacts: pairManifest.baseline.tapeFacts,
    },
  };
  const equalPixelsManifestPath = writeManifest(
    'msaa-pair-equal-pixels.json',
    equalPixelsManifest,
  );
  const repeated = [runOwner(pairManifestPath).document, runOwner(pairManifestPath).document];
  const concurrentLifecycle = { started: [], ownerCalls: [], completed: [] };
  const concurrentPromises = [pairManifestPath, isolatedManifestPath].map((manifestPath) =>
    runOwnerAsync(manifestPath, concurrentLifecycle),
  );
  if (concurrentLifecycle.started.length !== 2) {
    throw new Error('concurrent pair proof did not schedule both asynchronous owner calls');
  }
  const concurrentRuns = await Promise.all(concurrentPromises);
  const equalPixelsResult = runOwner(equalPixelsManifestPath).document;
  const equalPixelsResultPath = resolve(artifactDir, 'msaa-pair-equal-pixels-result.json');
  writeFileSync(equalPixelsResultPath, `${JSON.stringify(equalPixelsResult)}\n`);
  assertPairIsolation(repeated, concurrentRuns, [pairManifest, isolatedManifest]);
  assertRealP2NoDivergence(equalPixelsResult);
  const substitutedPositive = {
    ...equalPixelsResult,
    eventResource: pairedResult.eventResource,
  };
  let positiveAnswerSubstitutionRejected = false;
  try {
    assertRealP2NoDivergence(substitutedPositive);
  } catch {
    positiveAnswerSubstitutionRejected = true;
  }
  if (!positiveAnswerSubstitutionRejected) {
    throw new Error('substituting the positive MSAA result into the negative control passed P2');
  }
  assertPositiveAnswerSubstitutionFalsifier(equalPixelsResult);
  assertEqualPixelsFalsification(equalPixelsResult);
  let equalPixelsRejectedByPositiveGate = false;
  try {
    assertAcceptedPair(equalPixelsResult);
  } catch {
    equalPixelsRejectedByPositiveGate = true;
  }
  if (!equalPixelsRejectedByPositiveGate) {
    throw new Error('equal-pixel result incorrectly passed the positive acceptance gate');
  }
  if (
    concurrentLifecycle.ownerCalls.length !== 2 ||
    concurrentLifecycle.completed.length !== 2
  ) {
    throw new Error('concurrent pair proof did not complete both isolated asynchronous owner calls');
  }
  const result = {
    url,
    // Keep the terminal evidence bounded. The full tapes remain in the
    // artifact files and are consumed by the paired owner below; spreading
    // the capture objects here would duplicate every tape event into the CI
    // log and can strand runner cleanup after an otherwise successful smoke.
    off: {
      label: off.label,
      runId: off.runId,
      hud: off.hud,
      outputShape: off.outputShape,
      tapePath: off.tapePath,
      reportPath: off.reportPath,
      facts: off.facts,
    },
    on: {
      label: on.label,
      runId: on.runId,
      hud: on.hud,
      outputShape: on.outputShape,
      tapePath: on.tapePath,
      reportPath: on.reportPath,
      facts: on.facts,
    },
    pairManifestPath,
    pairedResultPath: resolve(artifactDir, 'msaa-pair-result.json'),
    mismatchManifestPath,
    mismatchResultPath: resolve(artifactDir, 'msaa-pair-mismatch-result.json'),
    equalPixelsManifestPath,
    equalPixelsResultPath,
    equalPixelsOutcome: equalPixelsResult.outcome,
    equalPixelsChangedPixelCount: equalPixelsResult.derivedMetrics.changedPixelCount,
    equalPixelsRejectedByPositiveGate,
    positiveAnswerSubstitutionRejected,
    concurrentOwnerCalls: {
      scheduled: concurrentLifecycle.started.length,
      ownerCalls: concurrentLifecycle.ownerCalls.length,
      completed: concurrentLifecycle.completed.length,
    },
    captureRecoveryAttempts,
    producerEvidence: { off: off.facts, on: on.facts },
    consoleErrors,
    notFound,
  };
  writeFileSync(resolve(artifactDir, 'msaa-pair.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await stopViteServer(server);
}
