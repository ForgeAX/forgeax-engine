import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const cases = [
  'normal',
  'opaque-map',
  'alpha-map',
  'hash',
  'cutoff',
  'coverage',
  'normal-premultiplied',
  'additive-premultiplied',
  'subtractive',
  'multiply',
  'custom',
  'double-sided',
] as const;

it.each([
  ...cases,
  ...cases.filter((name) => name !== 'normal').map((name) => `standard-${name}`),
  'physical-double-sided',
])('matches WebGPU material output: %s', { timeout: 120000 }, async (caseName) => {
  const physical = caseName.startsWith('physical-');
  const standard = physical || caseName.startsWith('standard-');
  const name = caseName.replace(/^(standard|physical)-/, '');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x284860);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const bytes = new Uint8Array(64 * 4);
  for (let i = 0; i < 64; i++) bytes.set([210, 120, 60, Math.round((i * 255) / 63)], i * 4);
  const texture = new THREE.DataTexture(bytes, 64, 1);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const material =
    name === 'normal'
      ? new THREE.MeshNormalMaterial()
      : physical
        ? new THREE.MeshPhysicalMaterial({ color: 0xf0a060 })
        : standard
          ? new THREE.MeshStandardMaterial({ color: 0xf0a060 })
          : new THREE.MeshBasicMaterial({ color: 0xf0a060 });
  if (standard) scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  if (name === 'opaque-map' || name === 'cutoff' || name === 'coverage')
    (material as THREE.MeshBasicMaterial).map = texture;
  if (name === 'alpha-map') {
    for (let i = 0; i < 64; i++)
      bytes.set([Math.round((i * 255) / 63), 255 - Math.round((i * 255) / 63), 0, 255], i * 4);
    (material as THREE.MeshBasicMaterial).alphaMap = texture;
    material.transparent = true;
  }
  if (name === 'hash') {
    material.alphaHash = true;
    material.opacity = 0.5;
  }
  if (name === 'cutoff' || name === 'coverage') material.alphaTest = 0.5;
  if (name === 'coverage') material.alphaToCoverage = true;
  if (name.endsWith('premultiplied') || ['subtractive', 'multiply', 'custom'].includes(name)) {
    material.transparent = true;
    material.opacity = 0.4;
    material.premultipliedAlpha = true;
    if (name === 'additive-premultiplied') material.blending = THREE.AdditiveBlending;
    if (name === 'subtractive') material.blending = THREE.SubtractiveBlending;
    if (name === 'multiply') material.blending = THREE.MultiplyBlending;
    if (name === 'custom') {
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneMinusSrcColorFactor;
    }
  }
  if (name === 'double-sided') {
    material.transparent = true;
    material.opacity = 0.4;
    material.side = THREE.DoubleSide;
  }
  const mesh = new THREE.Mesh(
    name === 'normal' || name === 'double-sided'
      ? new THREE.SphereGeometry(1.3, 48, 24)
      : new THREE.PlaneGeometry(3, 3),
    material,
  );
  scene.add(mesh);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: name === 'coverage' });
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const capture = await renderer.captureFrame(scene, camera);
    const reference = await renderReference(scene, camera, { antialias: name === 'coverage' });
    await saveBrowserEvidence(`material-output-${caseName}`, capture, reference);
    comparePixels(displayPixels(capture), reference);
    const pixels = displayPixels(capture);
    expect(pixels.some((value, index) => index % 4 !== 3 && value !== pixels[index % 4])).toBe(
      true,
    );
    await verifyReplay(capture);
    if (name === 'double-sided') {
      material.forceSinglePass = true;
      await readyFrames(renderer, scene, camera);
      const single = await renderer.captureFrame(scene, camera);
      const expected = await renderReference(scene, camera);
      await saveBrowserEvidence(`material-output-${caseName}-single`, single, expected);
      comparePixels(displayPixels(single), expected);
      expect(displayPixels(single)).not.toEqual(pixels);
      await verifyReplay(single);
    }
  } finally {
    await renderer.dispose();
    material.dispose();
    texture.dispose();
    canvas.remove();
  }
});
