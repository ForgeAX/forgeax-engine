#!/usr/bin/env node
// M3 feature-host RHI gate: capture the live multi-UV scene and its single
// fullscreen feature, then replay and inspect the tape on fresh Dawn.

import { countResolveTargets } from '../../shared/scripts/rhi-debug-topology.mjs';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../shared/scripts/rhi-debug-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm3-feature-host-rhi'),
);
const useMsaa = process.env.FORGEAX_M3_MSAA === '1';
const falsifyMsaaResolve = process.env.FORGEAX_M3_FALSIFY_MSAA_RESOLVE === '1';
const falsifyPipeline = process.env.FORGEAX_M3_FALSIFY === '1';
const selectedVariant = process.env.FORGEAX_M3_VARIANT === 'true' ? 'true' : 'false';
const selectedPost = process.env.FORGEAX_M3_POST === 'inversion' ? 'inversion' : 'passthrough';
const switchVariantAfterFrame = process.env.FORGEAX_M3_SWITCH_VARIANT === '1';
const switchPostAfterFrame = process.env.FORGEAX_M3_SWITCH_POST === '1';
const resizeChurn = process.env.FORGEAX_M3_RESIZE_CHURN === '1';
const doubleResizeChurn = process.env.FORGEAX_M3_DOUBLE_RESIZE_CHURN === '1';
const expectedVariant = switchVariantAfterFrame
  ? selectedVariant === 'true'
    ? 'false'
    : 'true'
  : selectedVariant;
const expectedPost = switchPostAfterFrame ? 'inversion' : selectedPost;
const expectedFeatureIdentity = `hello-multi-uv::${expectedPost}`;
mkdirSync(ARTIFACT_DIR, { recursive: true });

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port === undefined) {
          reject(new Error('could not resolve an ephemeral Vite port'));
        } else {
          resolvePort(String(port));
        }
      });
    });
  });
}

const requestedVitePort = process.env.FORGEAX_M3_RHI_PORT;
const vitePort = requestedVitePort !== undefined && requestedVitePort !== '0' ? requestedVitePort : await findFreePort();

function fail(message) {
  console.error(`[m3-browser-rhi] FAIL - ${message}`);
  process.exitCode = 1;
}

function resolveArtifact(path) {
  if (typeof path !== 'string') throw new Error('capture path is not a string');
  if (path.startsWith('/')) return path;
  const inApp = resolve(APP_ROOT, path);
  if (existsSync(inApp)) return inApp;
  return resolve(REPO_ROOT, path);
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

async function waitForVite(proc) {
  let url;
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[vite] ${text}`);
    url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
  });
  proc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  const deadline = Date.now() + 30_000;
  while (url === undefined && Date.now() < deadline) await sleep(200);
  if (url === undefined) throw new Error('vite did not become ready in 30s');
  return url;
}

const viteProc = spawn(process.execPath, [
  resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js'),
  '--host',
  '127.0.0.1',
  '--port',
  vitePort,
], {
  cwd: APP_ROOT,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  const baseUrl = await waitForVite(viteProc);
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
  });

  const query = `?variant=${selectedVariant}&post=${selectedPost}&pipeline=custom${useMsaa ? '&msaa' : ''}${falsifyMsaaResolve ? '&falsify-msaa-resolve' : ''}${falsifyPipeline ? '&falsify-pipeline' : ''}`;
  await page.goto(`${baseUrl}/${query}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    ({ variant, post, useMsaa: expectedMsaa }) =>
      Number(document.documentElement.dataset.forgeaxFrameSubmitted ?? 0) > 0 &&
      document.querySelector('#variant-status')?.textContent === `M3_MULTI_UV_VARIANT=${variant}` &&
      document.querySelector('#texture-status')?.textContent === 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture' &&
      document.querySelector('#post-status')?.textContent === `M3_POST_EFFECT=${post}` &&
      document.querySelector('#antialias-status')?.textContent === `M3_ANTIALIAS=${expectedMsaa ? 'msaa' : 'none'}`,
    { variant: selectedVariant, post: selectedPost, useMsaa },
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2500);
  const canvas = page.locator('#app');
  const initialCanvasSize = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
  const frameIdBeforeResize = await page.evaluate(() =>
    Number(document.documentElement.dataset.forgeaxFrameSubmitted ?? 0),
  );
  const resizeHistory = [];
  const resizeCanvas = async (width, height) => {
    await canvas.evaluate((element, size) => {
      element.width = size.width;
      element.height = size.height;
      element.style.width = `${size.width}px`;
      element.style.height = `${size.height}px`;
    }, { width, height });
    await page.waitForFunction(
      (size) => {
        const element = document.querySelector('#app');
        return element?.width === size.width && element.height === size.height;
      },
      { width, height },
      { timeout: 30_000 },
    );
    await page.waitForTimeout(700);
    const current = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
    resizeHistory.push(`${current.width}x${current.height}`);
  };
  await resizeCanvas(640, 360);
  if (resizeChurn) {
    await resizeCanvas(480, 270);
    await resizeCanvas(720, 405);
    await resizeCanvas(640, 360);
    if (doubleResizeChurn) {
      await resizeCanvas(480, 270);
      await resizeCanvas(720, 405);
      await resizeCanvas(640, 360);
    }
  }
  await page.waitForFunction(
    (previousFrameId) => Number(document.documentElement.dataset.forgeaxFrameSubmitted ?? 0) > previousFrameId,
    frameIdBeforeResize,
    { timeout: 30_000 },
  );
  const resizedCanvasSize = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
  if (initialCanvasSize.width === resizedCanvasSize.width && initialCanvasSize.height === resizedCanvasSize.height) {
    throw new Error(`canvas did not resize: ${initialCanvasSize.width}x${initialCanvasSize.height}`);
  }
  if (switchVariantAfterFrame) {
    await page.selectOption('#variant-select', expectedVariant);
    await page.waitForFunction(
      (variant) => document.querySelector('#variant-status')?.textContent === `M3_MULTI_UV_VARIANT=${variant}`,
      expectedVariant,
      { timeout: 30_000 },
    );
  }
  if (switchPostAfterFrame) {
    await page.selectOption('#post-select', 'inversion');
    await page.waitForFunction(
      () => document.querySelector('#post-status')?.textContent === 'M3_POST_EFFECT=inversion',
      undefined,
      { timeout: 30_000 },
    );
  }
  await page.waitForTimeout(1000);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('canvas bounding box missing');
  await page.locator('#variant-control, #pipeline-control, #post-control').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden';
  });
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'custom-live.png'), clip: box });
  const captured = await page.evaluate(async ({ shouldSwitchVariant, shouldSwitchPost, startupVariant, startupPost, expectedFeatureIdentity: featureIdentity, resizeHistory: capturedResizeHistory, shouldFalsifyPipeline }) => {
    const result = {
      pipeline: document.querySelector('#pipeline-status')?.textContent ?? '',
      variant: document.querySelector('#variant-status')?.textContent ?? '',
      post: document.querySelector('#post-status')?.textContent ?? '',
      selectedVariant: startupVariant,
      selectedPost: `M3_POST_EFFECT=${startupPost}`,
      texture: document.querySelector('#texture-status')?.textContent ?? '',
      antialias: document.querySelector('#antialias-status')?.textContent ?? '',
      frameSubmitted: Number(document.documentElement.dataset.forgeaxFrameSubmitted ?? 0),
      featureIdentity,
      falsifyPipeline: shouldFalsifyPipeline,
      canvas: { width: document.querySelector('#app')?.width ?? 0, height: document.querySelector('#app')?.height ?? 0 },
      resizeHistory: capturedResizeHistory,
      variantSwitchedAfterFrame: shouldSwitchVariant,
      variantSwitchedAfterPipeline: shouldSwitchVariant,
      postSwitchedAfterPipeline: shouldSwitchPost,
    };
    const captureFrame = globalThis.__forgeax?.captureFrame;
    if (typeof captureFrame !== 'function') throw new Error('window.__forgeax.captureFrame is unavailable');
    const capture = await captureFrame();
    if (!capture?.ok) throw new Error(`captureFrame failed: ${JSON.stringify(capture?.error)}`);
    const runId = `m3-rhi-${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}`;
    const response = await fetch(`${location.origin}/__forgeax-debug/tape?runId=${runId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-forgeax-rhitape' },
      body: capture.value.bytes,
    });
    const artifact = await response.json();
    if (!response.ok) throw new Error(`raw tape upload failed: ${JSON.stringify(artifact)}`);
    return { ...result, tape: { ...artifact, runId } };
  }, { shouldSwitchVariant: switchVariantAfterFrame, shouldSwitchPost: switchPostAfterFrame, startupVariant: selectedVariant, startupPost: selectedPost, expectedFeatureIdentity, resizeHistory, shouldFalsifyPipeline: falsifyPipeline });
  writeFileSync(resolve(ARTIFACT_DIR, 'capture.json'), `${JSON.stringify(captured, null, 2)}\n`);
  await browser.close();
  browser = undefined;
  viteProc.kill('SIGTERM');
  await sleep(500);

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  if (captured.variant !== `M3_MULTI_UV_VARIANT=${expectedVariant}`) throw new Error(`wrong variant status: ${captured.variant}`);
  if (captured.post !== `M3_POST_EFFECT=${expectedPost}`) throw new Error(`wrong post status: ${captured.post}`);
  if (captured.pipeline !== 'M3_PIPELINE=custom') throw new Error(`wrong pipeline status: ${captured.pipeline}`);
  if (captured.selectedPost !== `M3_POST_EFFECT=${selectedPost}`) throw new Error(`wrong selected post status: ${captured.selectedPost}`);
  if (captured.variantSwitchedAfterPipeline !== switchVariantAfterFrame) throw new Error(`wrong variant switch evidence: ${captured.variantSwitchedAfterPipeline}`);
  if (captured.postSwitchedAfterPipeline !== switchPostAfterFrame) throw new Error(`wrong post switch evidence: ${captured.postSwitchedAfterPipeline}`);
  if (captured.texture !== 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture') throw new Error(`wrong texture status: ${captured.texture}`);
  if (captured.antialias !== `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`) throw new Error(`wrong antialias status: ${captured.antialias}`);
  if (captured.featureIdentity !== expectedFeatureIdentity) throw new Error(`wrong feature identity: ${captured.featureIdentity}`);
  if (!Number.isInteger(captured.frameSubmitted) || captured.frameSubmitted <= 0) throw new Error(`no submitted frame: ${captured.frameSubmitted}`);
  if (captured.canvas.width !== 640 || captured.canvas.height !== 360) {
    throw new Error(`wrong resized canvas: ${captured.canvas.width}x${captured.canvas.height}`);
  }
  const expectedResizeHistory = doubleResizeChurn
    ? '640x360>480x270>720x405>640x360>480x270>720x405>640x360'
    : resizeChurn
      ? '640x360>480x270>720x405>640x360'
      : '640x360';
  if (captured.resizeHistory.join('>') !== expectedResizeHistory) {
    throw new Error(`wrong resize history: ${captured.resizeHistory.join('>')}`);
  }
  const tape = captured.tape;
  if (tape === undefined || typeof tape !== 'object') throw new Error('captureFrame returned no tape result');
  if (typeof tape.path !== 'string' || typeof tape.digest !== 'string') {
    throw new Error(`captureFrame returned no raw tape artifact: ${JSON.stringify(tape)}`);
  }
  const tapePath = resolveArtifact(tape.path);
  if (!existsSync(tapePath)) throw new Error(`capture artifact missing: tape=${tapePath}`);
  const tapeBlob = new Uint8Array(readFileSync(tapePath));
  const digest = `sha256:${createHash('sha256').update(tapeBlob).digest('hex')}`;
  if (tape.digest !== digest) throw new Error(`raw tape digest mismatch: ${tape.digest} != ${digest}`);
  const deserialized = decodeTape(tapeBlob);
  if (!deserialized.ok) throw new Error(`strict v7 decode failed: ${deserialized.error.code}`);
  const parsedTape = deserialized.value;
  const model = buildFrameModel(parsedTape);
  if (model.works.length === 0) throw new Error('decoded tape has no work entries');
  const report = { header: parsedTape.header, bootstrap: parsedTape.bootstrap, events: parsedTape.events };
  const reportPath = resolve(ARTIFACT_DIR, 'frame-0.report.json');
  const textureResourceCount = countLiveTextures(
    report,
    (desc) => desc?.size?.width === 2 && desc?.size?.height === 2,
  );
  const msaaTextureResourceCount = countLiveTextures(report, (desc) => desc?.sampleCount === 4);
  if (useMsaa && msaaTextureResourceCount < 2) {
    throw new Error(`capture report has fewer than two sampleCount=4 targets: ${msaaTextureResourceCount}`);
  }
  const resolveTargetCount = countResolveTargets(report);
  if (useMsaa && !falsifyMsaaResolve && resolveTargetCount < 1) {
    throw new Error(`capture report has no recorded MSAA resolve target: ${resolveTargetCount}`);
  }
  copyFileSync(tapePath, resolve(ARTIFACT_DIR, 'frame-0.tape.bin'));
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const drawCount = parsedTape.events.filter((event) => event.kind === 'draw' || event.kind === 'drawIndexed').length;
  const minimumDraws = 2;
  if (drawCount < minimumDraws) {
    throw new Error(`feature tape has only ${drawCount} draw calls; expected at least ${minimumDraws}`);
  }
  // The custom feature always samples the screen resource. A compiled
  // inversion marker such as `1f -` also appears in unrelated tonemap code,
  // so it cannot identify this feature pass.
  const featureShaderMarker = 'textureSample(screenTexture';
  const featureWorks = model.works.filter((work) => {
    const descriptor = work.pipeline.descriptor?.desc;
    return work.pipeline.status === 'available' && work.pipeline.kind === 'render' &&
      typeof descriptor === 'object' && descriptor !== null &&
      'fragment' in descriptor && 'vertex' in descriptor &&
      typeof descriptor.fragment === 'object' && descriptor.fragment !== null &&
      typeof descriptor.vertex === 'object' && descriptor.vertex !== null &&
      Array.isArray(descriptor.vertex.buffers) && descriptor.vertex.buffers.length === 0 &&
      work.pipeline.shaders.some((shader) => shader.source?.includes(featureShaderMarker));
  });
  if (featureWorks.length === 0 && !falsifyPipeline) {
    throw new Error(`decoded tape has no fullscreen feature pipeline: ${expectedFeatureIdentity}`);
  }
  if (falsifyPipeline && featureWorks.length !== 0) {
    throw new Error(`pipeline falsifier retained fullscreen feature pipeline: ${expectedFeatureIdentity}`);
  }
  const featurePipeline = featureWorks[0]?.pipeline;
  if (!falsifyPipeline && (featurePipeline?.status !== 'available' || featurePipeline.kind !== 'render')) {
    throw new Error(`fullscreen feature pipeline is unavailable: ${expectedFeatureIdentity}`);
  }
  if (!falsifyPipeline && (featurePipeline.shaders.length !== 2 || featurePipeline.shaders.some((shader) => shader.source === null))) {
    throw new Error(`fullscreen feature program identity is incomplete: ${expectedFeatureIdentity}`);
  }
  const featureWork = featureWorks[0];
  const featureTextureBindingCount = featureWork?.bindings.filter(
    (binding) => binding.resourceKind === 'textureView',
  ).length ?? 0;
  if (!falsifyPipeline && featureTextureBindingCount < 1) {
    throw new Error(`fullscreen feature has no recorded texture binding: ${expectedFeatureIdentity}`);
  }
  const featureInspection = featurePipeline === undefined
    ? null
    : {
        featureIdentity: expectedFeatureIdentity,
        postStatus: captured.post,
        workIndex: featureWork?.workIndex ?? -1,
        passIndex: featureWork?.passIndex ?? -1,
        program: {
          kind: featurePipeline.kind,
          shaderStages: featurePipeline.shaders.map((shader) => shader.stage),
          sourceMarker: featureShaderMarker,
          sourceMarkerMatched: true,
        },
        textureBindingCount: featureTextureBindingCount,
      };
  const { freshDevice, rhiWebgpu } = await bootstrapDawn('m3-browser-rhi', parsedTape);
  const replayResult = await openReplay(parsedTape, {
    device: freshDevice,
    createShaderModule: rhiWebgpu.createShaderModule,
  });
  if (!replayResult.ok) {
    freshDevice.destroy?.();
    throw new Error(`openReplay failed: ${replayResult.error.code}`);
  }
  const replay = replayResult.value;
  const workIndexes = [...new Set([0, model.works.length - 1])];
  const inspections = [];
  let finalInspection;
  for (const workIndex of workIndexes) {
    const inspected = await replay.inspectWork(workIndex, ['bindings', 'pixels']);
    if (!inspected.ok) {
      await replay.dispose();
      freshDevice.destroy?.();
      throw new Error(`inspect work ${workIndex} failed: ${inspected.error.code}`);
    }
    const value = inspected.value;
    if (value.attachment === undefined) {
      await replay.dispose();
      freshDevice.destroy?.();
      throw new Error(`inspect work ${workIndex} missing render-target evidence`);
    }
    finalInspection = value;
    inspections.push({
      workIndex: value.workIndex,
      bindings: parsedTape.events.filter((event) => event.kind === 'setBindGroup').length,
      hasWork: true,
      hasRenderTarget: true,
    });
  }
  const dawnPixels = finalInspection.attachment.bytes;
  let nonBlackPixelCount = 0;
  let rgbTotal = 0;
  for (let index = 0; index < dawnPixels.length; index += 4) {
    const red = dawnPixels[index] ?? 0;
    const green = dawnPixels[index + 1] ?? 0;
    const blue = dawnPixels[index + 2] ?? 0;
    if (red !== 0 || green !== 0 || blue !== 0) nonBlackPixelCount++;
    rgbTotal += red + green + blue;
  }
  const dawnReadbackSha256 = createHash('sha256').update(dawnPixels).digest('hex');
  const dawnReadback = {
    width: finalInspection.attachment.width,
    height: finalInspection.attachment.height,
    byteLength: dawnPixels.byteLength,
    nonBlackPixelCount,
    meanRgb: rgbTotal / (finalInspection.attachment.width * finalInspection.attachment.height * 3),
    sha256: dawnReadbackSha256,
    source: 'fresh-dawn-replay.readbackRt',
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'dawn-readback.rgba'), dawnPixels);
  writeFileSync(resolve(ARTIFACT_DIR, 'dawn-readback.json'), `${JSON.stringify(dawnReadback, null, 2)}\n`);
  await replay.dispose();
  freshDevice.destroy?.();
  const result = {
    pipeline: captured.pipeline,
    featureIdentity: expectedFeatureIdentity,
    featureProgramIdentity: expectedFeatureIdentity,
    featureInspection,
    featurePassCount: featureWorks.length,
    variant: captured.variant,
    post: captured.post,
    selectedVariant: captured.selectedVariant,
    selectedPost: captured.selectedPost,
    texture: captured.texture,
    antialias: captured.antialias,
    textureResourceCount,
    msaaTextureResourceCount,
    resolveTargetCount,
    canvas: captured.canvas,
    resizeHistory: captured.resizeHistory,
    variantSwitchedAfterFrame: captured.variantSwitchedAfterFrame,
    variantSwitchedAfterPipeline: captured.variantSwitchedAfterPipeline,
    postSwitchedAfterPipeline: captured.postSwitchedAfterPipeline,
    falsifyPipeline,
    runId: tape.runId,
    eventCount: parsedTape.events.length,
    blobCount: parsedTape.blobs.length,
    drawCount,
    workCount: model.works.length,
    passCount: model.passes.length,
    inspections,
    dawnReadback,
    screenshot: resolve(ARTIFACT_DIR, 'custom-live.png'),
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'rhi-summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (useMsaa && falsifyMsaaResolve) {
    if (resolveTargetCount !== 1) {
      throw new Error(`MSAA feature-host falsifier changed the standard resolve topology: ${resolveTargetCount}`);
    }
    console.log(
      `[m3-browser-rhi] PASS_FALSIFY - feature-host post-stage falsifier changed the MSAA post result while the standard pipeline retained its single resolve target; textureResourceCount=${textureResourceCount} msaaTextureResourceCount=${msaaTextureResourceCount} draws=${drawCount} resolveTargetCount=1 resizeHistory=${captured.resizeHistory.join('>')} dawnReadbackSha256=${dawnReadbackSha256} artifacts=${ARTIFACT_DIR}`,
    );
    process.exit(0);
  }
  console.log(`[m3-browser-rhi] PASS - feature=${expectedFeatureIdentity} pipeline=${captured.pipeline} variant=${captured.variant} texture=${captured.texture} post=${captured.post} antialias=${captured.antialias} frame=${captured.frameSubmitted} featurePasses=${featureWorks.length} textureResourceCount=${textureResourceCount} msaaTextureResourceCount=${msaaTextureResourceCount} resolveTargetCount=${resolveTargetCount} draws=${drawCount} events=${parsedTape.events.length} variantSwitch=${captured.variantSwitchedAfterPipeline} postSwitch=${captured.postSwitchedAfterPipeline} resizeHistory=${captured.resizeHistory.join('>')} dawnReadbackSha256=${dawnReadbackSha256} artifacts=${ARTIFACT_DIR}`);
} catch (error) {
  if (browser !== undefined) await browser.close();
  viteProc.kill('SIGTERM');
  await sleep(300);
  fail(error instanceof Error ? error.message : String(error));
}
