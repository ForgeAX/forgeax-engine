#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { parseSmokeFrameBudget } from '../../../../scripts/ci/run-dawn-smoke-roster.mjs';
import { pnpmCommand } from '../../../../scripts/lib/pnpm-command.mjs';
import { createOwnedProcessGroupStopper } from '../../../shared/scripts/rhi-debug-process.mjs';
import { resolveBrowserWebGpuLaunch } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { parseViteServerUrl } from './server-url.mjs';

const APP = '@forgeax/hello-custom-shader';
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const minimumFrames = parseSmokeFrameBudget(process.env.SMOKE_MIN_FRAMES);
const backend = process.env.FORGEAX_BROWSER_BACKEND ?? 'webgpu';
if (backend !== 'webgpu' && backend !== 'webgl2') throw new Error(`unsupported backend: ${backend}`);
const browserHeadless = !['0', 'false'].includes(
  (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
);
const browserChannel = process.env.FORGEAX_CHROME_CHANNEL ?? (process.platform === 'win32' ? undefined : process.env.CI ? browserLaunch.channel : 'chrome');

function waitForServer(process) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const url = parseViteServerUrl(output);
      if (url !== undefined) resolve(url);
    };
    process.stdout.on('data', onData);
    process.stderr.on('data', onData);
    process.once('exit', (code) => reject(new Error(`vite exited before ready: ${code}\n${output}`)));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function falsificationVariant() {
  if (process.env.FORGEAX_FALSIFY_MISSING_PARENT === '1') return 'missing-derived-parent';
  if (process.env.FORGEAX_FALSIFY_UV0_TRANSFORM === '1') return 'uv0-transform-loss';
  if (process.env.FORGEAX_FALSIFY_MISSING_NORMAL_RESOURCE === '1') return 'missing-normal-resource';
  if (process.env.FORGEAX_FALSIFY_SWAPPED_NORMAL_BINDING === '1') return 'swapped-normal-binding';
  if (process.env.FORGEAX_FALSIFY_NORMAL_SLOT_SWAP === '1') return 'normal-slot-swap';
  if (process.env.FORGEAX_FALSIFY_NUMERIC_OVERWRITE === '1') {
    return 'numeric-byte-80-96-overwrite';
  }
  if (process.env.FORGEAX_FALSIFY_PHYSICAL_UV_SCALE === '1') {
    return 'odd-physical-uv-scale-identity';
  }
  if (process.env.FORGEAX_FALSIFY_LIVE_INHERITANCE_REBIND === '1') return 'live-inheritance-rebind';
  return undefined;
}

const liveNormalSlotSwap =
  process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP === '1' ||
  process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP_RESIZE === '1';
const liveNormalSlotResize =
  process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_RESIZE === '1' ||
  process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP_RESIZE === '1';
const liveNormalSlotSwapResize = process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP_RESIZE === '1';
const liveTwoSlotSwap =
  process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP === '1' ||
  process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP_RESIZE === '1';
const liveTwoSlotResize =
  process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE === '1' ||
  process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP_RESIZE === '1';
const liveTwoSlotSwapResize = process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP_RESIZE === '1';
const liveInheritanceRebind = process.env.FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND === '1';
const liveMutationEnabled = liveNormalSlotSwap || liveTwoSlotSwap || liveInheritanceRebind;
const liveResizeRebuild = liveNormalSlotResize || liveTwoSlotResize;
const runtimeBoolMode = process.env.FORGEAX_CUSTOM_SHADER_RUNTIME_BOOL === '1';
const liveMode = liveTwoSlotSwapResize
  ? 'two-slot-swap-resize'
  : liveTwoSlotResize
    ? 'two-slot-resize'
    : liveTwoSlotSwap
      ? 'two-slot-swap'
      : liveNormalSlotSwapResize
        ? 'normal-slot-swap-resize'
        : liveNormalSlotResize
          ? 'normal-slot-resize'
        : liveNormalSlotSwap
            ? 'normal-slot-swap'
            : liveInheritanceRebind
              ? 'inheritance-rebind'
            : undefined;

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJson(entry)]),
    );
  }
  return value;
}

async function readActiveLayoutIdentity(page) {
  const semanticPack = process.env.FORGEAX_CUSTOM_SHADER_SEMANTIC === '1';
  const packUrl = await page.evaluate(() => {
    const resources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) =>
        globalThis.location.search.includes('semantic=1') || globalThis.location.search.includes('materialPack=')
          ? name.includes('pack.json')
          : name.includes('pulse-material.pack'),
      );
    return resources.at(-1) ?? null;
  });
  assert(packUrl !== null, `browser pack transport did not expose ${semanticPack ? 'semantic material pack' : 'pulse-material.pack.json'}`);
  const pack = await page.evaluate(async (url) => {
    const requested = new URLSearchParams(globalThis.location.search).get('materialPack');
    const candidates = [
      url,
      ...performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) =>
          requested === null && !globalThis.location.search.includes('semantic=1')
            ? name.includes('pulse-material.pack')
            : name.includes('pack.json'),
        ),
    ];
    for (const candidate of [...new Set(candidates)].reverse()) {
      const response = await fetch(candidate, { cache: 'no-store' });
      if (!response.ok) continue;
      const text = await response.text();
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.assets)) return parsed;
      } catch {
        // Vite's JSON module transport is JavaScript; skip it and keep the pack URL.
      }
    }
    throw new Error('browser pack transport returned no JSON MaterialAsset pack');
  }, packUrl);
  const identities = pack.assets
    .map((asset) => asset.payload?.cooked?.receipt?.identity)
    .filter((identity) => identity !== null && typeof identity === 'object');
  assert(identities.length >= 2, 'cooked pack has no active layoutIdentity pair');
  const layoutIdentities = identities.map((identity) => identity.layoutIdentity);
  assert(
    layoutIdentities.every((identity) => typeof identity === 'string'),
    'cooked pack identity tuple has no layoutIdentity',
  );
  assert(new Set(layoutIdentities).size === 1, 'cooked pack root and derived layoutIdentity diverged');
  const first = identities[0];
  assert(first !== undefined, 'cooked pack identity tuple is empty');
  for (const field of ['programIdentity', 'pipelineIdentity', 'cookIdentity', 'compilerFingerprint', 'artifactDigest']) {
    assert(typeof first[field] === 'string' && first[field].length > 0, `cooked pack identity tuple lacks ${field}`);
  }
  return { identity: first, layoutIdentity: first.layoutIdentity, packUrl };
}

function assertFalsificationOracle(variant, evidence) {
  if (variant === 'uv0-transform-loss') {
    assert(
      JSON.stringify(evidence.renderedSamplingInput) !== JSON.stringify(evidence.resolvedSamplingInput),
      'UV transform falsification did not alter the rendered sampling input',
    );
    throw new Error(
      `FALSIFY_EXPECTED_FAILURE:${variant}:renderedSamplingInput=${JSON.stringify(evidence.renderedSamplingInput)}`,
    );
  }
  if (variant === 'numeric-byte-80-96-overwrite') {
    const baseColor = evidence.values?.baseColor;
    assert(Array.isArray(baseColor) && baseColor.length >= 4, 'numeric falsification lacks baseColor oracle');
    const shifted = [baseColor[1], baseColor[2], baseColor[3], baseColor[0]];
    assert(JSON.stringify(shifted) !== JSON.stringify(baseColor), 'numeric falsification was not discriminating');
    throw new Error(`FALSIFY_EXPECTED_FAILURE:${variant}:old-byte-region-shift=${JSON.stringify(shifted)}`);
  }
  if (variant === 'odd-physical-uv-scale-identity') {
    const logicalExtent = [2085, 1573];
    const physicalExtent = [2088, 1576];
    const expected = [logicalExtent[0] / physicalExtent[0], logicalExtent[1] / physicalExtent[1]];
    const falsified = [1, 1];
    assert(JSON.stringify(expected) !== JSON.stringify(falsified), 'physicalUvScale falsification was not discriminating');
    throw new Error(`FALSIFY_EXPECTED_FAILURE:${variant}:physicalUvScale=${JSON.stringify(falsified)}`);
  }
}

const [manager, ...managerArgs] = pnpmCommand();
const vite = spawn(manager, [...managerArgs, '-F', APP, 'dev', '--', '--host', '127.0.0.1'], {
  cwd: ROOT,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
let page;
let consoleLedger = [];
let requestFailures = [];

const stopVite = createOwnedProcessGroupStopper(vite);

async function closeBrowserBounded() {
  if (browser === undefined) return;
  const close = browser.close().catch(() => undefined);
  await Promise.race([close, delay(2000)]);
}

try {
  const url = await waitForServer(vite);
  browser = await chromium.launch({
    headless: browserHeadless,
    channel: browserChannel,
    args: process.platform === 'win32' ? resolveBrowserWebGpuLaunch().args : process.env.CI && process.platform === 'linux'
      ? [...browserLaunch.args, '--use-angle=swiftshader']
      : ['--disable-features=MacAppCodeSignClone', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  page = await browser.newPage();
  if (backend === 'webgl2') await page.addInitScript(() => { delete Navigator.prototype.gpu; });
  const consoleErrors = [];
  consoleLedger = [];
  requestFailures = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('pageerror', (error) => consoleLedger.push({ type: 'pageerror', text: error.message }));
  page.on('console', (message) => {
    const entry = { type: message.type(), text: message.text() };
    consoleLedger.push(entry);
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const entry = { type: 'requestfailed', url: request.url(), text: request.failure()?.errorText ?? 'unknown' };
    requestFailures.push(entry);
    consoleErrors.push(`${entry.url}: ${entry.text}`);
  });

  const variant = falsificationVariant();
  const query = new URLSearchParams();
  if (variant !== undefined) query.set('falsify', variant);
  if (liveMode !== undefined) query.set('live', liveMode);
  if (process.env.FORGEAX_CUSTOM_SHADER_PACK_URL !== undefined) {
    query.set('materialPack', process.env.FORGEAX_CUSTOM_SHADER_PACK_URL);
  }
  if (process.env.FORGEAX_CUSTOM_SHADER_SEMANTIC === '1') query.set('semantic', '1');
  if (process.env.FORGEAX_CUSTOM_SHADER_EXPECTED_GUID !== undefined) {
    query.set('materialGuid', process.env.FORGEAX_CUSTOM_SHADER_EXPECTED_GUID);
  }
  if (process.env.FORGEAX_CUSTOM_SHADER_DERIVED_GUID !== undefined) {
    query.set('derivedMaterialGuid', process.env.FORGEAX_CUSTOM_SHADER_DERIVED_GUID);
  }
  const queryString = query.toString();
  const targetUrl = queryString === '' ? url : `${url}?${queryString}`;
  // The Vite listener can be ready before the cooked shader module graph is
  // transformed. Keep admission checks below bounded separately.
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const readinessTimeout =
    variant === 'missing-derived-parent' || variant === 'missing-normal-resource' ? 5000 : 30000;
  await page.waitForFunction(() => globalThis.__forgeaxMaterialEvidence?.ready === true, null, {
    timeout: readinessTimeout,
  });
  await page.waitForFunction(
    () => {
      const diagnostics = globalThis.__forgeaxMaterialEvidence?.renderDiagnostics;
      return diagnostics?.shader?.status === 'ok' &&
        diagnostics?.readback?.status === 'ok' &&
        diagnostics.readback.nonZeroBytes > 0;
    },
    null,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    (frames) => globalThis.__forgeaxMaterialEvidence?.frameCount >= frames,
    minimumFrames,
    { timeout: 30000 },
  );
  const evidence = await page.evaluate(() => globalThis.__forgeaxMaterialEvidence);
  assert(evidence.frameCount >= minimumFrames, 'engine-owned carrier did not complete the smoke frame budget');
  const activeLayout = await readActiveLayoutIdentity(page);
  evidence.layoutIdentity = activeLayout.layoutIdentity;
  evidence.materialIdentity = activeLayout.identity;
  evidence.browserCarrier = {
    url: targetUrl,
    packUrl: activeLayout.packUrl,
    readyFrame: evidence.frameCount,
    consoleLedger,
    requestFailures,
    backend,
    webgpu: evidence.webgpu === true,
  };
  const artifactArg = process.argv.indexOf('--artifact-dir');
  const artifactDir = artifactArg >= 0 ? process.argv[artifactArg + 1] : process.env.FORGEAX_MATERIAL_ARTIFACT_DIR;
  let liveVisual;
  if (liveMutationEnabled || liveResizeRebuild) {
    await page.waitForFunction(
      () => globalThis.__forgeaxMaterialEvidence?.frameCount >= 2,
      null,
      { timeout: 30000 },
    );
    const beforePath =
      artifactDir === undefined
        ? undefined
        : resolve(
            artifactDir,
            liveInheritanceRebind
              ? 'live-inheritance-before.png'
              : liveTwoSlotSwap || liveTwoSlotResize
                ? 'live-two-slot-before.png'
                : 'live-normal-slot-before.png',
          );
    if (beforePath !== undefined) {
      mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({ path: beforePath, fullPage: false });
    }
    const beforeEvidence = await page.evaluate(() => globalThis.__forgeaxMaterialEvidence);
    assert(beforeEvidence.liveMutation?.applied === false, 'live mutation occurred before the before-frame capture');
    await page.waitForFunction(
      () => {
        const evidence = globalThis.__forgeaxMaterialEvidence;
        if (evidence?.resizeRebuild?.enabled === true) {
          return evidence.resizeRebuild.afterCanvas?.[0] === 384 &&
            evidence.resizeRebuild.afterCanvas?.[1] === 192 &&
            (evidence.frameCount ?? 0) > 170;
        }
        const mutation = evidence?.liveMutation;
        return mutation?.applied === true &&
          mutation.appliedFrame !== null &&
          (evidence?.frameCount ?? 0) > mutation.appliedFrame + 20;
      },
      null,
      { timeout: 30000 },
    );
    const afterPath = artifactDir === undefined
      ? undefined
      : resolve(
          artifactDir,
          liveResizeRebuild
            ? liveTwoSlotSwap || liveTwoSlotResize
              ? 'live-two-slot-resize-after.png'
              : 'live-normal-slot-resize-after.png'
            : liveInheritanceRebind
              ? 'live-inheritance-after.png'
              : liveTwoSlotSwap
                ? 'live-two-slot-after.png'
                : 'live-normal-slot-after.png',
        );
    if (afterPath !== undefined) {
      await page.screenshot({ path: afterPath, fullPage: false });
    }
    liveVisual = { beforePath, afterPath };
    Object.assign(evidence, await page.evaluate(() => globalThis.__forgeaxMaterialEvidence));
  }
  const screenshotPath = artifactDir === undefined ? undefined : resolve(artifactDir, 'custom-material.png');
  if (screenshotPath !== undefined) {
    mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    evidence.browserVisual = { status: 'pass', path: screenshotPath, source: 'engine-owned-app-canvas' };
  }
  assertFalsificationOracle(variant, evidence);
  if (liveMutationEnabled || liveResizeRebuild) {
    const mutation = evidence.liveMutation;
    if (liveNormalSlotSwap) {
      assert(mutation?.enabled === true, 'live normal-slot mutation was not enabled');
      assert(mutation?.applied === true, 'live normal-slot mutation was not applied');
      assert(mutation.beforeMaterialHandle !== mutation.afterMaterialHandle, 'live rebind reused the material handle');
      assert(mutation.afterComponentMaterialHandle === mutation.afterMaterialHandle, 'World.set did not expose the replacement material handle');
      assert(
        mutation.beforeTextureHandles[0] === mutation.afterTextureHandles[0] &&
          mutation.beforeTextureHandles[1] !== mutation.afterTextureHandles[1],
        'live rebind changed a resource other than normalTexture',
      );
    }
    if (liveTwoSlotSwap) {
      assert(mutation?.enabled === true, 'live two-slot mutation was not enabled');
      assert(mutation?.applied === true, 'live two-slot mutation was not applied');
      assert(mutation.beforeMaterialHandle !== mutation.afterMaterialHandle, 'live two-slot rebind reused the material handle');
      assert(mutation.afterComponentMaterialHandle === mutation.afterMaterialHandle, 'World.set did not expose the two-slot replacement material handle');
      assert(mutation.baseColorSlotChanged === true, 'live two-slot rebind did not change baseColorTexture');
      assert(mutation.normalSlotChanged === true, 'live two-slot rebind did not change normalTexture');
      assert(
        mutation.beforeTextureHandles[0] !== mutation.afterTextureHandles[0] &&
          mutation.beforeTextureHandles[1] !== mutation.afterTextureHandles[1],
        'live two-slot rebind did not change both authored texture resources',
      );
    }
    if (liveInheritanceRebind) {
      assert(mutation?.enabled === true, 'live inherited-material mutation was not enabled');
      assert(mutation?.inheritanceBacked === true, 'live inherited-material mutation was not marked inheritance-backed');
      assert(mutation?.applied === true, 'live inherited-material mutation was not applied');
      assert(mutation.beforeMaterialHandle !== mutation.afterMaterialHandle, 'live inherited-material rebind reused the material handle');
      assert(mutation.afterComponentMaterialHandle === mutation.afterMaterialHandle, 'World.set did not expose the inherited replacement material handle');
      assert(mutation.sourceDerivedGuid === evidence.derivedGuid, 'live replacement did not originate from the derived material GUID');
      assert(mutation.sourceArtifactDigest === evidence.derivedArtifactDigest, 'live replacement changed the cooked specialization artifact');
      assert(mutation.sourceCookInputDigest === evidence.derivedCookInputDigest, 'live replacement changed the specialization input digest');
      assert(
        mutation.beforeTextureHandles[0] !== mutation.afterTextureHandles[0] &&
          mutation.beforeTextureHandles[1] !== mutation.afterTextureHandles[1],
        'live inherited-material rebind did not change both replacement texture handles',
      );
    }
    if (liveResizeRebuild) {
      const resize = evidence.resizeRebuild;
      assert(resize?.enabled === true, 'live resize/rebuild was not enabled');
      assert(resize.applied === true, 'live resize/rebuild was not applied');
      assert(JSON.stringify(resize.afterCanvas) === JSON.stringify([384, 192]), 'live resize/rebuild did not reach 384x192');
      assert(
        resize.postResizeMaterialHandle === (liveMutationEnabled ? mutation.afterMaterialHandle : mutation.beforeMaterialHandle),
        'material handle did not survive resize/rebuild',
      );
    }
    evidence.liveVisual = liveVisual;
    assert(evidence.rendererErrorCodes.length === 0, `renderer errors: ${evidence.rendererErrorCodes.join('; ')}`);
    assert(evidence.drawErrorCodes.length === 0, `draw errors: ${evidence.drawErrorCodes.join('; ')}`);
  }
  assert(evidence.browserPath === true, 'browser evidence did not use the Vite path');
  assert(evidence.webgpu === (backend === 'webgpu'), `browser evidence did not reach ${backend}`);
  assert(
    evidence.renderDiagnostics?.shader?.status === 'ok',
    `browser render diagnostics did not install the authored shader: ${JSON.stringify(evidence.renderDiagnostics?.shader)}`,
  );
  assert(
    evidence.renderDiagnostics?.readback?.status === 'ok' &&
      evidence.renderDiagnostics.readback.nonZeroBytes > 0,
    `browser render readback was empty: ${JSON.stringify(evidence.renderDiagnostics?.readback)}`,
  );
  assert(typeof evidence.layoutIdentity === 'string', 'browser evidence lacks active layoutIdentity');
  assert(typeof evidence.materialIdentity?.compilerFingerprint === 'string', 'browser evidence lacks compiler fingerprint');
  if (process.env.FORGEAX_CUSTOM_SHADER_EXPECTED_GUID !== undefined) {
    assert(
      evidence.rootGuid?.toLowerCase() ===
        process.env.FORGEAX_CUSTOM_SHADER_EXPECTED_GUID.toLowerCase(),
      `browser material GUID mismatch: expected ${process.env.FORGEAX_CUSTOM_SHADER_EXPECTED_GUID}`,
    );
  }
  assert(evidence.rootGuid !== evidence.derivedGuid, 'root and derived GUIDs must remain distinct');
  assert(evidence.rootArtifactDigest === evidence.derivedArtifactDigest, 'cooked artifacts diverged');
  assert(evidence.rootCookInputDigest === evidence.derivedCookInputDigest, 'specialization inputs diverged');
  assert(evidence.renderedTextureHandles[0] !== evidence.renderedTextureHandles[1], 'base and normal textures must be distinct');
  assert(
    JSON.stringify(evidence.renderedTextureHandles) === JSON.stringify(evidence.resolvedTextureHandles),
    'browser texture bindings do not match the resolved per-slot resources',
  );
  if (!runtimeBoolMode) {
    assert(
      JSON.stringify(stableJson(evidence.values?.time)) ===
        JSON.stringify(stableJson(evidence.resolvedValues?.time)) &&
        JSON.stringify(stableJson(evidence.values?.speed)) ===
          JSON.stringify(stableJson(evidence.resolvedValues?.speed)),
      'browser inherited values lost shared runtime parameters',
    );
    assert(
      JSON.stringify(stableJson(evidence.values?.baseColor)) !==
        JSON.stringify(stableJson(evidence.resolvedValues?.baseColor)),
      'browser inherited values lost the derived baseColor override',
    );
  }
  assert(evidence.rendererErrorCodes.length === 0, `renderer errors: ${evidence.rendererErrorCodes.join('; ')}`);
  assert(evidence.drawErrorCodes.length === 0, `draw errors: ${evidence.drawErrorCodes.join('; ')}`);
  assert(
    consoleLedger.every((entry) => !entry.text.includes('[forgeax] import failed')),
    `browser asset imports failed: ${JSON.stringify(consoleLedger)}`,
  );
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join('; ')}`);
  console.log(
    JSON.stringify({
      status: 'pass',
      backend,
      browserPath: evidence.browserPath,
      rootGuid: evidence.rootGuid,
      derivedGuid: evidence.derivedGuid,
      rootArtifactDigest: evidence.rootArtifactDigest,
      derivedArtifactDigest: evidence.derivedArtifactDigest,
      rootCookInputDigest: evidence.rootCookInputDigest,
      derivedCookInputDigest: evidence.derivedCookInputDigest,
      layoutIdentity: evidence.layoutIdentity,
      materialIdentity: evidence.materialIdentity,
      browserCarrier: evidence.browserCarrier,
      webgpu: evidence.webgpu,
      renderDiagnostics: evidence.renderDiagnostics,
      textureHandlesDistinct: evidence.renderedTextureHandles[0] !== evidence.renderedTextureHandles[1],
      liveMutation: evidence.liveMutation,
      resizeRebuild: evidence.resizeRebuild,
      liveVisual: evidence.liveVisual,
      rendererErrorCodes: evidence.rendererErrorCodes,
      drawErrorCodes: evidence.drawErrorCodes,
      bindGroupCreateCounts: evidence.bindGroupCreateCounts,
      browserVisual: evidence.browserVisual,
    }),
  );
} catch (error) {
  const variant = falsificationVariant();
  if (variant !== undefined) console.error(`FALSIFY_EXPECTED_FAILURE:${variant}`);
  if (page !== undefined) {
    const diagnostic = await page
      .evaluate(() => ({
        url: globalThis.location.href,
        evidence: globalThis.__forgeaxMaterialEvidence,
        bodyText: document.body?.innerText?.slice(0, 2000) ?? '',
      }))
      .catch((cause) => ({ evaluateError: cause instanceof Error ? cause.message : String(cause) }));
    console.error(`custom-shader browser diagnostic: ${JSON.stringify({ diagnostic, consoleLedger, requestFailures })}`);
  }
  console.error(`custom-shader browser smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await stopVite();
  await closeBrowserBounded();
}
