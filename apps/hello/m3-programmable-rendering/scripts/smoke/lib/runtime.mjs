import { countResolveTargets } from '../../../../../shared/scripts/rhi-debug-topology.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = resolve(packageRoot, '..', '..', '..');
// The composed matrix launches a fresh Chrome + Vite pair for each leg. Keep
// enough budget for a cold WebGPU process under a busy headed CI carrier while
// retaining a finite bound for genuinely hung children.
const defaultChildTimeoutMs = 300_000;

function resolveChildTimeoutMs(rawValue) {
  if (rawValue === undefined) return defaultChildTimeoutMs;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`FORGEAX_M3_CHILD_TIMEOUT_MS must be a positive integer, received ${JSON.stringify(rawValue)}`);
  }
  return value;
}

const childTimeoutMs = resolveChildTimeoutMs(process.env.FORGEAX_M3_CHILD_TIMEOUT_MS);
console.log(`[m3-programmable] selector child timeout: ${childTimeoutMs} ms`);
let childRunSequence = 0;

// Scenario files report through one executor-owned termination primitive so a
// falsifier cannot accidentally continue into a later matrix leg.
export function failSmoke() {
  process.exit(1);
}

const require = createRequire(resolve(repoRoot, 'package.json'));
let PNG;
try {
  ({ PNG } = require('pngjs'));
} catch {
  ({ PNG } = require(
    resolve(repoRoot, 'node_modules/.pnpm/pngjs@7.0.0/node_modules/pngjs/lib/png.js'),
  ));
}

function comparePngs(normalPath, falsifierPath) {
  const normal = PNG.sync.read(readFileSync(normalPath));
  const falsifier = PNG.sync.read(readFileSync(falsifierPath));
  if (normal.width !== falsifier.width || normal.height !== falsifier.height) {
    throw new Error(
      `PNG dimensions differ: normal=${normal.width}x${normal.height} falsifier=${falsifier.width}x${falsifier.height}`,
    );
  }
  let absoluteRgbDelta = 0;
  for (let index = 0; index < normal.data.length; index += 4) {
    absoluteRgbDelta += Math.abs(normal.data[index] - falsifier.data[index]);
    absoluteRgbDelta += Math.abs(normal.data[index + 1] - falsifier.data[index + 1]);
    absoluteRgbDelta += Math.abs(normal.data[index + 2] - falsifier.data[index + 2]);
  }
  const changedPixels = pixelmatch(
    normal.data,
    falsifier.data,
    undefined,
    normal.width,
    normal.height,
    { threshold: 0.1, includeAA: true },
  );
  return {
    changedPixels,
    changedFraction: changedPixels / (normal.width * normal.height),
    meanRgbDelta: absoluteRgbDelta / (normal.width * normal.height * 3 * 255),
    width: normal.width,
    height: normal.height,
  };
}

function compareDawnReadbacks(normalRgbaPath, normalMetaPath, falsifierRgbaPath, falsifierMetaPath) {
  const normalMeta = JSON.parse(readFileSync(normalMetaPath, 'utf8'));
  const falsifierMeta = JSON.parse(readFileSync(falsifierMetaPath, 'utf8'));
  if (normalMeta.width !== falsifierMeta.width || normalMeta.height !== falsifierMeta.height) {
    throw new Error(
      `Dawn readback dimensions differ: normal=${normalMeta.width}x${normalMeta.height} falsifier=${falsifierMeta.width}x${falsifierMeta.height}`,
    );
  }
  const normal = readFileSync(normalRgbaPath);
  const falsifier = readFileSync(falsifierRgbaPath);
  if (normal.length !== falsifier.length || normal.length !== normalMeta.width * normalMeta.height * 4) {
    throw new Error(
      `Dawn readback byte lengths differ or are invalid: normal=${normal.length} falsifier=${falsifier.length}`,
    );
  }
  let changedPixels = 0;
  let absoluteRgbDelta = 0;
  for (let index = 0; index < normal.length; index += 4) {
    const redDelta = Math.abs(normal[index] - falsifier[index]);
    const greenDelta = Math.abs(normal[index + 1] - falsifier[index + 1]);
    const blueDelta = Math.abs(normal[index + 2] - falsifier[index + 2]);
    if (redDelta !== 0 || greenDelta !== 0 || blueDelta !== 0) changedPixels++;
    absoluteRgbDelta += redDelta + greenDelta + blueDelta;
  }
  return {
    width: normalMeta.width,
    height: normalMeta.height,
    changedPixels,
    changedFraction: changedPixels / (normalMeta.width * normalMeta.height),
    meanRgbDelta: absoluteRgbDelta / (normalMeta.width * normalMeta.height * 3 * 255),
    normalSha256: normalMeta.sha256,
    falsifierSha256: falsifierMeta.sha256,
  };
}

function readDawnReadbackMetadata(path) {
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  return {
    width: metadata.width,
    height: metadata.height,
    byteLength: metadata.byteLength,
    nonBlackPixelCount: metadata.nonBlackPixelCount,
    meanRgb: metadata.meanRgb,
    sha256: metadata.sha256,
  };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function countLiveTextures(report, matches) {
  const live = new Set();
  for (const resource of report.bootstrap ?? []) {
    if (resource.kind === 'texture' && matches(resource.create?.desc)) {
      live.add(resource.handleId);
    }
  }
  for (const event of report.events) {
    const handleId = event.handleId ?? event.id;
    if (handleId === undefined || handleId === null) continue;
    if (event.kind === 'createTexture' && matches(event.desc)) {
      live.add(handleId);
    } else if (event.kind === 'destroyTexture') {
      live.delete(handleId);
    }
  }
  return live.size;
}

function countLiveMsaaTextures(report) {
  return countLiveTextures(report, (desc) => desc?.sampleCount === 4);
}

function countDepthOnlyPasses(report) {
  return report.events.filter(
    (event) =>
      event.kind === 'beginRenderPass' &&
      event.depthStencilViewHandleId !== undefined &&
      (event.colorAttachmentViewHandleIds?.length ?? 0) === 0,
  ).length;
}

function semanticPassCount(report) {
  const passCount = report.events.filter(
    (event) => event.kind === 'beginRenderPass' || event.kind === 'beginComputePass',
  ).length;
  // The composed scene always owns one spot-shadow depth pass. Directional
  // cascades are a lazy cache detail: a cold capture has four additional
  // depth-only passes, while a hot capture reuses the atlas. Keep that raw
  // topology in the report/tape, but compare the stable render-pass contract
  // across process launches by removing only the optional rebuilt cascades.
  return passCount - Math.max(0, countDepthOnlyPasses(report) - 1);
}

function readRenderPassTopology(root) {
  const report = JSON.parse(readFileSync(resolve(root, 'frame-0.report.json'), 'utf8'));
  return report.events
    .filter((event) => event.kind === 'beginRenderPass')
    .map((event) => ({
      label: event.desc?.label ?? null,
      colorAttachmentCount: event.colorAttachmentViewHandleIds?.length ?? 0,
      resolveTargetCount:
        event.colorAttachmentResolveTargetHandleIds?.filter(
          (handleId) => handleId !== undefined && handleId !== null,
        ).length ?? 0,
      hasDepthAttachment: event.depthStencilViewHandleId !== undefined,
    }));
}

function readRepeatabilitySnapshot(root) {
  const capture = JSON.parse(readFileSync(resolve(root, 'capture.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(resolve(root, 'rhi-summary.json'), 'utf8'));
  return {
    capture: {
      pipeline: capture.pipeline,
      variant: capture.variant,
      post: capture.post,
      selectedVariant: capture.selectedVariant,
      selectedPost: capture.selectedPost,
      texture: capture.texture,
      antialias: capture.antialias,
      canvas: capture.canvas,
      resizeHistory: capture.resizeHistory,
      pipelineSwitchedAfterResize: capture.pipelineSwitchedAfterResize,
      variantSwitchedAfterPipeline: capture.variantSwitchedAfterPipeline,
      postSwitchedAfterPipeline: capture.postSwitchedAfterPipeline,
      falsifyPipeline: capture.falsifyPipeline,
    },
    rhi: {
      pipeline: summary.pipeline,
      variant: summary.variant,
      post: summary.post,
      texture: summary.texture,
      antialias: summary.antialias,
      textureResourceCount: summary.textureResourceCount,
      msaaTextureResourceCount: summary.msaaTextureResourceCount,
      resolveTargetCount: summary.resolveTargetCount,
      canvas: summary.canvas,
      resizeHistory: summary.resizeHistory,
      pipelineSwitchedAfterResize: summary.pipelineSwitchedAfterResize,
      variantSwitchedAfterPipeline: summary.variantSwitchedAfterPipeline,
      postSwitchedAfterPipeline: summary.postSwitchedAfterPipeline,
      falsifyPipeline: summary.falsifyPipeline,
      drawCount: summary.drawCount,
      workCount: summary.workCount ?? summary.drawCount,
      passCount: summary.passCount,
      inspections: summary.inspections,
    },
    dawn: readDawnReadbackMetadata(resolve(root, 'dawn-readback.json')),
    screenshotSha256: sha256File(resolve(root, 'custom-live.png')),
  };
}

function readComposedRhiSnapshot(root, label) {
  const report = JSON.parse(readFileSync(resolve(root, 'rhi', `${label}.report.json`), 'utf8'));
  return {
    textureResourceCount: countLiveTextures(
      report,
      (desc) => desc?.size?.width === 2 && desc?.size?.height === 2,
    ),
    msaaTextureResourceCount: countLiveMsaaTextures(report),
    resolveTargetCount: countResolveTargets(report),
    drawCount: report.events.filter((event) => event.kind === 'draw' || event.kind === 'drawIndexed').length,
    workCount: report.events.filter((event) => event.kind === 'draw' || event.kind === 'drawIndexed').length,
    passCount: semanticPassCount(report),
    dawn: readDawnReadbackMetadata(resolve(root, 'rhi', `${label}.dawn-readback.json`)),
  };
}

function readComposedSnapshot(root, falsifierLabel = 'falsified-second-texture-inversion') {
  const composed = JSON.parse(readFileSync(resolve(root, 'browser-composed.json'), 'utf8'));
  return {
    live: {
      variantDelta: composed.live.variantDelta,
      postDelta: composed.live.postDelta,
      resized: composed.live.resized.state,
      resizeHistory: composed.live.resizeHistory,
      screenshotSha256: sha256File(composed.live.resized.png),
    },
    falsifier: {
      variantDelta: composed.falsifier.variantDelta,
      secondTextureDelta: composed.falsifier.secondTextureDelta,
      secondTexture: composed.falsifier.secondTexture.state,
      resizeHistory: composed.falsifier.resizeHistory,
      screenshotSha256: sha256File(composed.falsifier.secondTexture.png),
    },
    rhi: {
      normal: readComposedRhiSnapshot(root, 'live-resized-inversion'),
      falsifier: readComposedRhiSnapshot(root, falsifierLabel),
    },
  };
}

function readLiveMaterialSnapshot(root) {
  const composed = JSON.parse(readFileSync(resolve(root, 'live-material-browser.json'), 'utf8'));
  const stableEvidence = (evidence) => ({
    enabled: evidence.enabled,
    applied: evidence.applied,
    beforeMaterialHandle: evidence.beforeMaterialHandle,
    afterMaterialHandle: evidence.afterMaterialHandle,
    beforeTextureHandles: evidence.beforeTextureHandles,
    afterTextureHandles: evidence.afterTextureHandles,
    baseColorSlotChanged: evidence.baseColorSlotChanged,
    detailSlotChanged: evidence.detailSlotChanged,
    baseColorParameterChanged: evidence.baseColorParameterChanged,
    baseColorUvTransformChanged: evidence.baseColorUvTransformChanged,
    beforeBaseColor: evidence.beforeBaseColor,
    afterBaseColor: evidence.afterBaseColor,
    beforeBaseColorUvTransform: evidence.beforeBaseColorUvTransform,
    afterBaseColorUvTransform: evidence.afterBaseColorUvTransform,
    inheritanceBacked: evidence.inheritanceBacked,
    sourceRootGuid: evidence.sourceRootGuid,
    sourceDerivedGuid: evidence.sourceDerivedGuid,
    sourceRootArtifactDigest: evidence.sourceRootArtifactDigest,
    sourceArtifactDigest: evidence.sourceArtifactDigest,
    sourceRootCookInputDigest: evidence.sourceRootCookInputDigest,
    sourceCookInputDigest: evidence.sourceCookInputDigest,
    falsifierMarker: evidence.falsifierMarker,
    afterComponentMaterialMatchesAfter:
      evidence.afterComponentMaterialHandle === evidence.afterMaterialHandle,
    resizeHistory: evidence.resizeHistory,
  });
  const snapshotLeg = (leg) => ({
    before: leg.before.state,
    after: leg.after.state,
    delta: leg.delta,
    beforeEvidence: stableEvidence(leg.beforeEvidence),
    afterEvidence: stableEvidence(leg.afterEvidence),
    dawn: leg.rhi.dawnReadback,
    rhiTopology: (() => {
      const report = JSON.parse(readFileSync(leg.rhi.report, 'utf8'));
      const reportText = JSON.stringify(report);
      return {
        msaaTextureResourceCount: countLiveMsaaTextures(report),
        resolveTargetCount: countResolveTargets(report),
        passCount: semanticPassCount(report),
        hasDepthBinding: reportText.includes('sceneDepth') && reportText.includes('depthSampler') && reportText.includes('"binding":3'),
      };
    })(),
    draws: leg.rhi.draws,
    workCount: leg.rhi.workCount ?? leg.rhi.draws,
    // Event/pass offsets move when the optional directional shadow cascades
    // are rebuilt. The inspected work ordinal is the stable semantic fact;
    // the raw offsets remain available in the per-capture inspect artifact.
    inspectedWork: leg.rhi.inspect?.workIndex === undefined
      ? undefined
      : { workIndex: leg.rhi.inspect.workIndex },
    screenshotSha256: sha256File(leg.after.png),
  });
  return { normal: snapshotLeg(composed.normal), falsifier: snapshotLeg(composed.falsifier) };
}

function readLiveMaterialSnapshotIfAvailable(root) {
  return existsSync(resolve(root, 'live-material-browser.json'))
    ? readLiveMaterialSnapshot(root)
    : undefined;
}

function readDepthSnapshot(root) {
  const depth = JSON.parse(readFileSync(resolve(root, 'depth-browser.json'), 'utf8'));
  return {
    normal: {
      baseline: depth.normal.baseline,
      variant: depth.normal.variant,
      resized: depth.normal.resized,
      resizeHistory: depth.normal.resizeHistory,
      dawn: depth.normal.rhi.dawn,
      hasDepthBinding: depth.normal.rhi.hasDepthBinding,
    },
    falsifier: {
      baseline: depth.falsifier.baseline,
      dawn: depth.falsifier.rhi.dawn,
      hasDepthBinding: depth.falsifier.rhi.hasDepthBinding,
    },
    delta: depth.delta,
  };
}

function readDepthSnapshotIfAvailable(root) {
  return existsSync(resolve(root, 'depth-browser.json')) ? readDepthSnapshot(root) : undefined;
}

function repeatabilityDiff(first, second) {
  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);
  return firstJson === secondJson ? undefined : { first, second };
}

function stableCustomMaterialBrowserEvidence(evidence) {
  const stableEvidence = Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'frameObservationCount'),
  );
  // Startup scheduling and the animated material vary capture time/color.
  // Keep structural readback facts (size and covered pixels), not frame IDs
  // or a count of nonzero color bytes, in the repeatability contract.
  if (evidence.renderDiagnostics?.readback !== undefined) {
    stableEvidence.renderDiagnostics = {
      ...evidence.renderDiagnostics,
      readback: Object.fromEntries(Object.entries(evidence.renderDiagnostics.readback)
        .filter(([key]) => key !== 'frameId' && key !== 'nonZeroBytes')),
    };
  }
  const browserCarrier = evidence.browserCarrier;
  if (browserCarrier === undefined) return stableEvidence;
  const stableBrowserCarrier = Object.fromEntries(
    Object.entries(browserCarrier).filter(([key]) => key !== 'packUrl' && key !== 'readyFrame' && key !== 'url'),
  );
  return { ...stableEvidence, browserCarrier: stableBrowserCarrier };
}

function visualCausalityRepeatabilityDiff(first, second) {
  const stableDiff = repeatabilityDiff(
    {
      rootArtifactDigest: first.rootArtifactDigest,
      normalTextureSlot: first.normalTextureSlot,
      dawn: first.dawn,
    },
    {
      rootArtifactDigest: second.rootArtifactDigest,
      normalTextureSlot: second.normalTextureSlot,
      dawn: second.dawn,
    },
  );
  if (stableDiff !== undefined) return stableDiff;
  const left = first.browser.delta;
  const right = second.browser.delta;
  if (
    left.width !== right.width ||
    left.height !== right.height ||
    Math.abs(left.changedFraction - right.changedFraction) > 0.001 ||
    Math.abs(left.meanRgbDelta - right.meanRgbDelta) > 0.001
  ) {
    return { first, second };
  }
  return undefined;
}

function run(label, args, extraEnv = {}, cwd = repoRoot) {
  const childRunId = childRunSequence++;
  const usesComposedBrowserSmoke =
    args.includes('@forgeax/hello-multi-uv') && args.includes('smoke:browser-composed');
  for (let attempt = 0; ; attempt++) {
    const outputDir = mkdtempSync(resolve(tmpdir(), 'forgeax-m3-run-'));
    const stdoutPath = resolve(outputDir, 'stdout.txt');
    const stderrPath = resolve(outputDir, 'stderr.txt');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');
    let result;
    try {
      const env = { ...process.env, INIT_CWD: repoRoot, ...extraEnv };
      env.TMPDIR = outputDir;
      env.TEMP = outputDir;
      env.TMP = outputDir;
      env.NODE_DISABLE_COMPILE_CACHE = '1';
      if (usesComposedBrowserSmoke && env.FORGEAX_BROWSER_PORT === undefined) {
        env.FORGEAX_BROWSER_PORT = String(
          56000 + ((process.pid + childRunId * 37 + attempt * 101) % 900),
        );
      }
      result = spawnSync('pnpm', args, {
        cwd,
        detached: true,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', stdoutFd, stderrFd],
        timeout: childTimeoutMs,
        env,
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    if (result.error?.code === 'ETIMEDOUT' && result.pid !== undefined) {
      try {
        process.kill(-result.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(result.pid, 'SIGKILL');
        } catch {
          // The child may have already exited with the timeout.
        }
      }
    }
    const output = `${readFileSync(stdoutPath, 'utf8')}${readFileSync(stderrPath, 'utf8')}`;
    rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.stdout.write(output);
    const retryableFailure =
      result.signal === 'SIGSEGV' ||
      (result.status !== 0 &&
        (output.includes('is already in use') || output.includes('vite did not become ready in 30s')));
    const maxTransientRetries = result.signal === 'SIGSEGV' ? 2 : 1;
    if (retryableFailure && attempt < maxTransientRetries) {
      console.error(`[m3-programmable] ${label}: transient child failure; retrying`);
      continue;
    }
    if (result.error?.code === 'ETIMEDOUT') {
      console.error(`[m3-programmable] ${label}: child timeout after ${childTimeoutMs} ms`);
    } else if (result.error) {
      console.error(`[m3-programmable] ${label}: spawn failed: ${result.error.message}`);
    }
    if (result.signal !== null && result.signal !== undefined) {
      console.error(`[m3-programmable] ${label}: child signal=${result.signal}`);
    }
    const validationFailure = args.includes('smoke:browser-rhi') && /^validation:\r?$/m.test(output);
    if (validationFailure) {
      console.error(`[m3-programmable] ${label}: WebGPU validation failed despite child exit ${result.status}`);
    }
    return { status: validationFailure ? 1 : result.status, signal: result.signal, output };
  }
}

function readLastJsonLine(output) {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && value.status === 'pass') return value;
    } catch {
      // Ignore pnpm/Vite progress lines and keep looking for the smoke payload.
    }
  }
  return undefined;
}

export {
  compareDawnReadbacks,
  comparePngs,
  readComposedRhiSnapshot,
  readComposedSnapshot,
  readDepthSnapshot,
  readDepthSnapshotIfAvailable,
  readDawnReadbackMetadata,
  readLastJsonLine,
  readLiveMaterialSnapshot,
  readLiveMaterialSnapshotIfAvailable,
  readRenderPassTopology,
  readRepeatabilitySnapshot,
  repoRoot,
  repeatabilityDiff,
  run,
  sha256File,
  stableCustomMaterialBrowserEvidence,
  visualCausalityRepeatabilityDiff,
};
