import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { exerciseOpaqueOrder } from './opaque-order.fixture';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();
it('matches r187 authored, group, custom, traversal and reset opaque ordering', {
  timeout: 120000,
}, async () => {
  const renderer = rendererFor();
  await renderer.init();
  await exerciseOpaqueOrder(renderer, async (capture, stage, { scene, camera }) => {
    const reference = await renderReference(scene, camera, {
      ...(stage === 'custom' ? { opaqueSort: (a, b) => (b.id ?? 0) - (a.id ?? 0) } : {}),
      sortObjects: stage !== 'traversal',
    });
    await saveBrowserEvidence(`r187-opaque-${stage}`, capture, reference);
    comparePixels(displayPixels(capture), reference);
  });
});

it('saves, resets and restores renderer and scene state through original r187 utilities', {
  timeout: 120000,
}, async () => {
  const renderer = rendererFor();
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  scene.background = new THREE.Color(0x225588);
  renderer.setClearColor(0x336699, 0.5);
  renderer.setPixelRatio(1);
  renderer.autoClearStencil = false;
  renderer.opaque = false;
  await readyFrames(renderer, scene, camera, 60);
  const before = await renderer.captureFrame(scene, camera);
  const reusable = {};
  const state = THREE.RendererUtils.resetRendererAndSceneState(renderer, scene, reusable);
  expect(state).toBe(reusable);
  expect(state.renderTarget).toBeNull();
  expect(state.mrt).toBeNull();
  expect(state.renderObjectFunction).toBeNull();
  expect(scene.background).toBeNull();
  expect(renderer.autoClearStencil).toBe(true);
  expect(renderer.opaque).toBe(true);
  THREE.RendererUtils.restoreRendererAndSceneState(renderer, scene, state);
  expect(renderer.autoClearStencil).toBe(false);
  expect(renderer.opaque).toBe(false);
  expect(renderer.getClearAlpha()).toBe(0.5);
  await readyFrames(renderer, scene, camera, 1);
  const restored = await renderer.captureFrame(scene, camera);
  expect(displayPixels(restored)).toEqual(displayPixels(before));
  renderer.autoClearDepth = false;
  const noClear = THREE.RendererUtils.resetRendererState(renderer);
  expect(renderer.autoClearDepth).toBe(true);
  THREE.RendererUtils.restoreRendererState(renderer, noClear);
  expect(renderer.autoClearDepth).toBe(false);
  expect(() => renderer.render(scene, camera)).toThrow('partial/no-clear rendering');
  renderer.autoClearDepth = true;
  expect(renderer.setMRT(null)).toBe(renderer);
  expect(() => renderer.setMRT({} as Parameters<typeof renderer.setMRT>[0])).toThrow(
    'Renderer.setMRT',
  );
  expect(() => renderer.setRenderObjectFunction(() => {})).toThrow(
    'Renderer.setRenderObjectFunction',
  );
  renderer.setRenderTarget(null, 1);
  expect(renderer.getActiveCubeFace()).toBe(1);
  expect(renderer.getActiveMipmapLevel()).toBe(0);
  expect(() => renderer.setRenderTarget(null, 6)).toThrow('three-invalid-value');
  renderer.setRenderTarget(null);
  await saveBrowserEvidence('r187-renderer-state-restored', restored);
  renderer.autoClearStencil = true;
  renderer.opaque = true;
  renderer.setClearColor(0, 0);
});
