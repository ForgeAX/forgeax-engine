#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
import {
  collectRhiDebugDraws,
  runRhiDebugBrowserAdmission,
} from '../../../shared/scripts/rhi-debug-browser-admission.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const root = resolve(scriptsDir, '..', '..', '..', '..');
const packageName = '@forgeax/bevy-text2d';

if (process.argv.includes('--m34-recovery')) {
  await runM34RecoveryBrowser();
} else if (process.env.TEXT2D_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy text2d public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareText2dCapture',
    appDir,
    assertTape: ({ tape }) => assertTextTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicExit = await runPublicCaptureFrame();
  if (publicExit !== 0) process.exit(publicExit);
  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy text2d',
    readyHook: '__bevyText2dReady',
    capturePrepareHook: '__prepareText2dCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'text2d-rhi-debug.png'),
    triggerLabel: 'text2d-public-trigger',
    assertTape: ({ events, blobPool }) => assertTextTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) =>
      `${capture.runId ?? 'remote'} glyphDraws=${selected.glyphDraws} drawOrdinal=${selected.drawOrdinal} ` +
      `indexCount=${inspected.drawCall.indexCount} bindings=${inspected.bindings.length} ` +
      `atlas=${selected.fontAtlasTexture} sampler=${selected.fontAtlasSampler}`,
  });
}

async function runM34RecoveryBrowser() {
  const artifactDir = resolve(
    process.env.SMOKE_ARTIFACT_DIR ??
      process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ??
      resolve(appDir, 'artifacts', 'm34-browser'),
  );
  mkdirSync(artifactDir, { recursive: true });
  const vite = spawn('pnpm', ['-F', packageName, 'dev'], {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let url;
  vite.stdout.on('data', (chunk) => {
    const text = String(chunk);
    process.stdout.write(`[vite] ${text}`);
    url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
  });
  vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${String(chunk)}`));
  let browser;
  try {
    const deadline = Date.now() + 30_000;
    while (url === undefined && Date.now() < deadline) await sleep(100);
    if (url === undefined) throw new Error('M34 Vite dev server did not publish a URL in 30s');
    browser = await chromium.launch({
      headless: true,
      channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel,
      args: process.env.CI && process.platform === 'linux'
        ? [...browserLaunch.args, '--use-angle=swiftshader']
        : ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('response', (response) => {
      if (response.status() >= 400) process.stdout.write(`[http-error] ${response.status()} ${response.url()}\n`);
    });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    await page.goto(`${url}/?m34-font-recovery=1`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(
      () => typeof globalThis.__bevyText2dM34?.baseline === 'function',
      undefined,
      { timeout: 30_000 },
    );

    const capture = async (name, method) => {
      const state = await page.evaluate((operation) => globalThis.__bevyText2dM34[operation](), method);
      const path = resolve(artifactDir, `m34-${name}.png`);
      const bytes = await page.locator('#app').screenshot({ path });
      return {
        state,
        path,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    };
    const baseline = await capture('baseline', 'baseline');
    const edited = await capture('edited', 'edit');
    const recovered = await capture('recovered', 'recover');
    const cleanup = await capture('cleanup', 'cleanup');
    const cleanupAgain = await page.evaluate(() => globalThis.__bevyText2dM34.cleanup());
    const evidence = { baseline, edited, recovered, cleanup, cleanupAgain, pageErrors, consoleErrors };
    writeFileSync(resolve(artifactDir, 'm34-browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

    const failures = [];
    for (const [name, capture] of [['baseline', baseline], ['edited', edited], ['recovered', recovered]]) {
      if (capture.state.labels !== 9 || capture.state.generatedComponents !== 0 ||
          capture.state.liveFonts !== 9 || capture.state.errorCount !== 0 ||
          capture.state.targetFontHandle !== baseline.state.targetFontHandle) {
        failures.push(`${name}=${JSON.stringify(capture.state)}`);
      }
    }
    if (baseline.state.targetGlyphs === 0 || edited.state.targetGlyphs !== 0 ||
        recovered.state.targetGlyphs !== baseline.state.targetGlyphs) {
      failures.push('Font edit/restore did not preserve the reference and replace glyph content');
    }
    if (cleanup.state.labels !== 0 || cleanup.state.generatedComponents !== 0 ||
        cleanup.state.liveFonts !== 0 || !cleanup.state.unrelatedPresent ||
        cleanup.state.errorCount !== 0 || JSON.stringify(cleanupAgain) !== JSON.stringify(cleanup.state)) {
      failures.push(`cleanup=${JSON.stringify({ cleanup: cleanup.state, cleanupAgain })}`);
    }
    if (baseline.bytes < 1000 || edited.sha256 === baseline.sha256 || cleanup.sha256 === baseline.sha256) {
      failures.push(`pixel evidence hashes=${JSON.stringify({ baseline, edited, cleanup })}`);
    }
    if (pageErrors.length > 0 || consoleErrors.length > 0) {
      failures.push(`browser errors=${JSON.stringify({ pageErrors, consoleErrors })}`);
    }
    if (failures.length > 0) {
      throw new Error(`[m34] FAIL - ${failures.join('; ')}`);
    }
    console.log(
      `[m34] Browser PASS baseline=${baseline.sha256} edited=${edited.sha256} ` +
        `recovered=${recovered.sha256} cleanup=${cleanup.sha256}`,
    );
  } finally {
    await browser?.close();
    try {
      if (process.platform === 'win32') vite.kill('SIGTERM');
      else process.kill(-vite.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, TEXT2D_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function assertTextTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const textures = new Map(events.filter((event) => event.kind === 'createTexture').map((event) => [event.handleId, event]));
  const textureViews = new Map(events.filter((event) => event.kind === 'createTextureView').map((event) => [event.resultHandleId, event]));
  const samplers = new Map(events.filter((event) => event.kind === 'createSampler').map((event) => [event.handleId, event]));
  const shaderModules = events.filter((event) => event.kind === 'createShaderModule');
  const msdfShaders = shaderModules.filter(
    (event) =>
      typeof event.wgslCode === 'string' &&
      event.wgslCode.includes('screen_px_range') &&
      event.wgslCode.includes('median') &&
      event.wgslCode.includes('baseColorTexture'),
  );
  if (msdfShaders.length !== 1) throw new Error(`expected one captured MSDF text shader, got ${msdfShaders.length}`);
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const glyphDraws = indexed.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string' &&
      draw.vertexBuffer !== undefined &&
      draw.indexBuffer !== undefined &&
      hasGlyphPipeline(draw.pipeline) &&
      hasFontAtlasBinding(draw, groups, layouts, textures, textureViews, initialData, samplers, blobPool),
  );
  if (glyphDraws.length !== 4) {
    throw new Error(`expected four semantically selected GlyphText draws, got ${glyphDraws.length} of ${indexed.length} indexed draws`);
  }
  for (const draw of glyphDraws) {
    if (draw.event.indexCount <= 0 || draw.event.instanceCount <= 0) {
      throw new Error(`selected GlyphText draw is not non-empty: ${JSON.stringify(draw.event)}`);
    }
    assertNonEmptyBuffer(draw.vertexBuffer.bufferHandleId, initialData, blobPool, 'vertex');
    assertNonEmptyBuffer(draw.indexBuffer.bufferHandleId, initialData, blobPool, 'index');
  }
  const selected = glyphDraws[0];
  const materialSet = selected.bindGroups.get(1);
  const materialGroup = materialSet === undefined ? undefined : groups.get(materialSet.bindGroupHandleId);
  if (materialGroup === undefined) throw new Error('selected GlyphText draw has no material bind group');
  const materialLayout = layouts.get(materialGroup.layoutHandleId);
  if (materialLayout?.desc?.label !== 'pbr-material-skylight-bgl') {
    throw new Error(`selected GlyphText draw has unexpected material layout: ${materialLayout?.desc?.label ?? 'missing'}`);
  }
  const atlas = resourceAt(materialGroup, 2);
  const atlasTextureView = atlas?.resourceKind === 'textureView' ? textureViews.get(atlas.resourceHandleId) : undefined;
  const atlasTexture = atlasTextureView === undefined ? undefined : textures.get(atlasTextureView.sourceHandleId);
  const atlasSampler = resourceAt(materialGroup, 1);
  const sampler = atlasSampler?.resourceKind === 'sampler' ? samplers.get(atlasSampler.resourceHandleId) : undefined;
  if (atlasTexture === undefined || atlasTexture.desc?.size?.width !== 512 || atlasTexture.desc?.size?.height !== 512 || atlasTexture.desc?.format !== 'rgba8unorm') {
    throw new Error(`selected GlyphText draw has no 512x512 rgba8unorm font atlas: ${JSON.stringify(atlasTexture?.desc)}`);
  }
  if (sampler === undefined) throw new Error('selected GlyphText draw has no font atlas sampler');
  assertNonEmptyBuffer(atlasTexture.handleId, initialData, blobPool, 'font atlas texture');
  const drawOrdinal = draws.indexOf(selected);
  const fontAtlasTexture = atlasTexture.handleId;
  const fontAtlasSampler = sampler.handleId;
  console.log(
    `[bevy text2d] semantic selector glyphDraws=${glyphDraws.length} indexCounts=${glyphDraws.map(({ event }) => event.indexCount).join(',')} ` +
      `atlas=${fontAtlasTexture} sampler=${fontAtlasSampler} drawOrdinal=${drawOrdinal}`,
  );
  return { drawOrdinal, glyphDraws: glyphDraws.length, fontAtlasTexture, fontAtlasSampler };
}

function hasGlyphPipeline(pipeline) {
  const attributes = pipeline?.desc?.vertex?.buffers?.flatMap((buffer) => buffer.attributes ?? []) ?? [];
  const byLocation = new Map(attributes.map((attribute) => [attribute.shaderLocation, attribute.format]));
  return (
    byLocation.get(0) === 'float32x3' &&
    byLocation.get(1) === 'float32x3' &&
    byLocation.get(2) === 'float32x2' &&
    byLocation.get(3) === 'float32x4' &&
    pipeline?.desc?.primitive?.cullMode === 'none' &&
    pipeline?.desc?.depthStencil?.format === 'depth24plus-stencil8' &&
    pipeline?.desc?.fragment?.targets?.length === 1 &&
    pipeline.desc.fragment.targets[0]?.format === 'rgba16float'
  );
}

function hasFontAtlasBinding(draw, groups, layouts, textures, textureViews, initialData, samplers, blobPool) {
  const materialSet = draw.bindGroups.get(1);
  const materialGroup = materialSet === undefined ? undefined : groups.get(materialSet.bindGroupHandleId);
  if (materialGroup === undefined || layouts.get(materialGroup.layoutHandleId)?.desc?.label !== 'pbr-material-skylight-bgl') return false;
  const sampler = resourceAt(materialGroup, 1);
  const texture = resourceAt(materialGroup, 2);
  if (sampler?.resourceKind !== 'sampler' || texture?.resourceKind !== 'textureView') return false;
  const samplerEvent = samplers.get(sampler.resourceHandleId);
  const textureViewEvent = textureViews.get(texture.resourceHandleId);
  const textureEvent = textureViewEvent === undefined ? undefined : textures.get(textureViewEvent.sourceHandleId);
  if (samplerEvent === undefined || textureEvent === undefined) return false;
  if (textureEvent.desc?.size?.width !== 512 || textureEvent.desc?.size?.height !== 512 || textureEvent.desc?.format !== 'rgba8unorm') return false;
  const seed = initialData.get(textureEvent.handleId);
  const bytes = seed === undefined ? undefined : blobPool.get(seed.dataHash);
  const view = bytes === undefined ? undefined : asBytes(bytes);
  return view !== undefined && view.byteLength > 0 && view.some((value) => value !== 0);
}

function resourceAt(group, binding) {
  const index = group.entries.findIndex((entry) => entry.binding === binding);
  if (index < 0) return undefined;
  const entry = group.entries[index];
  const resourceHandleId = group.resourceHandleIds[index];
  return resourceHandleId === undefined ? undefined : { ...entry, resourceHandleId };
}

function assertNonEmptyBuffer(handleId, initialData, blobPool, label) {
  const seed = initialData.get(handleId);
  const blob = seed === undefined ? undefined : blobPool.get(seed.dataHash);
  const bytes = blob === undefined ? undefined : asBytes(blob);
  if (bytes === undefined || bytes.byteLength === 0 || !bytes.some((value) => value !== 0)) {
    throw new Error(`selected GlyphText ${label} has no non-zero captured data`);
  }
}

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
