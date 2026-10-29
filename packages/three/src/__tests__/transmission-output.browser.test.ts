import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
  verifyReplay,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it('preserves transmission depth writes and transparent blending', {
  timeout: 180000,
}, async () => {
  const renderer = rendererFor();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x385060);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const backgroundMaterial = new THREE.MeshBasicMaterial({ color: 0x60b050 });
  const background = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), backgroundMaterial);
  background.position.z = -0.5;
  const glassMaterial = new THREE.MeshPhysicalMaterial({ transmission: 0.7, roughness: 0, ior: 1 });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.5), glassMaterial);
  const stripMaterial = new THREE.MeshBasicMaterial({
    color: 0xe04830,
    transparent: true,
    opacity: 0.8,
  });
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 3), stripMaterial);
  strip.position.z = -0.2;
  scene.add(background, glass, strip, new THREE.AmbientLight(0xffffff, Math.PI));
  try {
    await renderer.init();
    const frame = async (name: string, count = 1) => {
      await readyFrames(renderer, scene, camera, count);
      const capture = await renderer.captureFrame(scene, camera);
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`transmission-output-${name}`, capture, reference);
      comparePixels(displayPixels(capture), reference);
      await verifyReplay(capture);
      return displayPixels(capture);
    };
    const initial = await frame('default-depth', 60);
    strip.renderOrder = 1;
    const ordered = await frame('later-transparent');
    expect(ordered).not.toEqual(initial);
    glassMaterial.depthWrite = false;
    const withoutDepth = await frame('no-depth');
    expect(withoutDepth).not.toEqual(ordered);
    glassMaterial.transparent = true;
    glassMaterial.opacity = 0.4;
    glassMaterial.needsUpdate = true;
    expect(await frame('transparent')).not.toEqual(withoutDepth);
  } finally {
    for (const material of [backgroundMaterial, glassMaterial, stripMaterial]) material.dispose();
  }
});

it('draws all double-sided transmission backs before the sorted fronts', {
  timeout: 180000,
}, async () => {
  const renderer = rendererFor();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x385060);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const backgroundMaterial = new THREE.MeshBasicMaterial({ color: 0x60b050 });
  const background = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), backgroundMaterial);
  background.position.z = -1;
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x80b0ff,
    transmission: 0.7,
    roughness: 0,
    ior: 1,
    side: THREE.DoubleSide,
  });
  const secondMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xff9080,
    transmission: 0.6,
    roughness: 0,
    ior: 1,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.BoxGeometry(1.8, 2.2, 0.5);
  const front = new THREE.Mesh(geometry, glassMaterial);
  front.position.x = -0.4;
  const back = new THREE.Mesh(geometry, secondMaterial);
  back.position.set(0.4, 0, -0.6);
  scene.add(background, front, back, new THREE.AmbientLight(0xffffff, Math.PI));
  try {
    await renderer.init();
    const frame = async (name: string, count = 1) => {
      await readyFrames(renderer, scene, camera, count);
      const capture = await renderer.captureFrame(scene, camera);
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`transmission-double-${name}`, capture, reference);
      comparePixels(displayPixels(capture), reference);
      await verifyReplay(capture);
      return displayPixels(capture);
    };
    const initial = await frame('default', 60);
    glassMaterial.forceSinglePass = secondMaterial.forceSinglePass = true;
    glassMaterial.needsUpdate = secondMaterial.needsUpdate = true;
    expect(await frame('single-pass')).not.toEqual(initial);
    glassMaterial.forceSinglePass = secondMaterial.forceSinglePass = false;
    glassMaterial.transparent = secondMaterial.transparent = true;
    glassMaterial.opacity = secondMaterial.opacity = 0.5;
    glassMaterial.needsUpdate = secondMaterial.needsUpdate = true;
    await frame('transparent');
  } finally {
    for (const material of [backgroundMaterial, glassMaterial, secondMaterial]) material.dispose();
    geometry.dispose();
  }
});
