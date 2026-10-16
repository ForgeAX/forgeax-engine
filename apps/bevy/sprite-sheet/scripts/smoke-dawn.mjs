#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Dawn smoke for Bevy `sprite_sheet`: only source-sheet frames 1 through 6 animate.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const frames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const width = 320;
const height = 180;
// Cover the full animation journey with fewer rendered samples.
const dt = 5 / frames;
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
const here = dirname(fileURLToPath(import.meta.url));
const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
let device;
let target;
const canvas = { width, height, getContext(kind) { if (kind !== 'webgpu') return null; return { configure(desc) { target ??= desc.device.createTexture({ size: { width, height, depthOrArrayLayers: 1 }, format: desc.format ?? 'rgba8unorm', usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] }); device ??= desc.device; }, unconfigure() {}, getCurrentTexture() { return target; } }; }, addEventListener() {}, removeEventListener() {} };
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => { const adapter = await originalRequestAdapter(options); if (!adapter) return adapter; const requestDevice = adapter.requestDevice.bind(adapter); adapter.requestDevice = async (descriptor) => { device = await requestDevice(descriptor); return device; }; return adapter; };
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { SpriteAnimation } = await import('@forgeax/engine-render/authoring');
const { propagateTransforms } = await import('@forgeax/engine-scene');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { animationRegions, buildSpriteSheetWorld, makeSpriteSheetPixels, SHEET_HEIGHT, SHEET_WIDTH, tickSpriteSheet, ANIMATION_FRAME_COUNT, FIRST_ANIMATION_FRAME, LAST_ANIMATION_FRAME } = await import(resolve(here, '..', 'src', 'sprite-sheet.ts'));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}` });
gpu.requestAdapter = originalRequestAdapter;
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error));
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const pixels = makeSpriteSheetPixels();
const texture = { kind: 'texture', shape: { viewDimension: '2d', extent: { width: SHEET_WIDTH, height: SHEET_HEIGHT } }, format: 'rgba8unorm-srgb', data: pixels, colorSpace: 'srgb', mips: { kind: 'none' } };
const textureHandle = world.allocSharedRef('TextureAsset', texture);
buildSpriteSheetWorld(world, unwrapHandle(textureHandle));
const query = world.query({ with: [SpriteAnimation] }).unwrap();
const animationEntities = [];
for (const row of query) animationEntities.push(row.entity);
if (animationEntities.length !== 1) throw new Error(`expected one animated sprite, got ${animationEntities.length}`);
const animationEntity = animationEntities[0];
const initial = world.get(animationEntity, SpriteAnimation);
if (!initial.ok || Math.abs((initial.value.regions[0] ?? 0) - FIRST_ANIMATION_FRAME / 7) > 1e-6) throw new Error('animation does not start at source-sheet frame 1');
const regions = animationRegions();
if (regions.length !== ANIMATION_FRAME_COUNT * 4 || regions[(ANIMATION_FRAME_COUNT - 1) * 4] >= LAST_ANIMATION_FRAME / 7 + 1 / 7) throw new Error('animation subset region contract is invalid');

async function capture() {
  await device.queue.onSubmittedWorkDone();
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap(); buffer.destroy();
  const tight = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return tight;
}

const seen = new Set();
let changes = 0;
let previous = -1;
let earlyFrame;
let lateFrame;
for (let i = 0; i < frames; i += 1) {
  world.update(dt).unwrap();
  tickSpriteSheet(world);
  const current = world.get(animationEntity, SpriteAnimation);
  if (!current.ok) throw new Error('animated sprite disappeared');
  seen.add(current.value.currentFrame);
  if (current.value.currentFrame !== previous) changes += 1;
  previous = current.value.currentFrame;
  propagateTransforms(world);
  const draw = drawSmokeFrame(renderer, world);
  if (!draw.ok) throw new Error(`${draw.error.code}: ${draw.error.hint}`);
  if (i === 5) earlyFrame = await capture();
  if (i === frames - 1) lateFrame = await capture();
}
let motionDelta = 0;
let leadInPixels = 0;
for (let i = 0; i < earlyFrame.length; i += 4) {
  motionDelta += Math.abs((earlyFrame[i] ?? 0) - (lateFrame[i] ?? 0));
  motionDelta += Math.abs((earlyFrame[i + 1] ?? 0) - (lateFrame[i + 1] ?? 0));
  motionDelta += Math.abs((earlyFrame[i + 2] ?? 0) - (lateFrame[i + 2] ?? 0));
  if ((lateFrame[i] ?? 0) > 220 && (lateFrame[i + 1] ?? 0) < 80 && (lateFrame[i + 2] ?? 0) > 150) leadInPixels += 1;
}
motionDelta /= earlyFrame.length * 255;
const outDir = process.env.SMOKE_PNG_DIR ?? resolve(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'sprite-sheet.png'), writeReferencePng(lateFrame, width, height));
let coloredPixels = 0;
for (let i = 0; i < lateFrame.length; i += 4) {
  const max = Math.max(lateFrame[i], lateFrame[i + 1], lateFrame[i + 2]);
  const min = Math.min(lateFrame[i], lateFrame[i + 1], lateFrame[i + 2]);
  if (max - min > 35 && max > 40) coloredPixels += 1;
}
console.log(`[smoke] frames=${frames} logicalFrameSet=${[...seen].sort((a, b) => a - b).join(',')} changes=${changes} coloredPixels=${coloredPixels} motionMeanDelta=${motionDelta.toFixed(5)} leadInPixels=${leadInPixels} errors=${errors.length}`);
if (rendererBackend(renderer) !== 'webgpu' || frames < 60 || seen.size < 3 || [...seen].some((frame) => frame < 0 || frame >= ANIMATION_FRAME_COUNT) || changes < 10 || coloredPixels < 500 || motionDelta <= 0.0005 || leadInPixels > 5 || errors.length > 0) {
  console.error('[smoke] FAIL - sprite-sheet subset/animation/visibility/error criterion failed');
  process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, source frames ${FIRST_ANIMATION_FRAME}-${LAST_ANIMATION_FRAME}, logicalFrames=${seen.size}, changes=${changes}, errors=0`);
device.destroy?.();
