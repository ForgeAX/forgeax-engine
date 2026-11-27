import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
  SIZE,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it('orders visible translucent draws by the Three view and preserves ties, groups and custom order', {
  timeout: 120000,
}, async () => {
  THREE.enableThreeSourceTracking();
  const renderer = rendererFor();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  const geometry = new THREE.PlaneGeometry(1.6, 1.6);
  const make = (color: number) =>
    new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
  const red = make(0xff0000),
    blue = make(0x0000ff);
  blue.position.z = -0.25;
  scene.add(blue, red);
  await renderer.init();
  const center = (pixels: Uint8Array) =>
    pixels.slice((SIZE * (SIZE / 2) + SIZE / 2) * 4).slice(0, 4);
  const frame = async (oracle = true) => {
    await readyFrames(renderer, scene, camera);
    const pixels = displayPixels(await renderer.captureFrame(scene, camera));
    if (oracle) comparePixels(pixels, await renderReference(scene, camera), 4 / 255);
    return center(pixels);
  };
  try {
    const front = await frame();
    expect(front[0] as number).toBeGreaterThan(front[2] as number);
    camera.position.z = -3;
    camera.rotation.y = Math.PI;
    const back = await frame();
    expect(back[2] as number).toBeGreaterThan(back[0] as number);

    camera.position.z = 3;
    camera.rotation.y = 0;
    blue.position.z = 0;
    const tied = await frame(false);
    expect(tied[2] as number).toBeGreaterThan(tied[0] as number);

    const group = new THREE.Group();
    group.renderOrder = 5;
    group.add(red);
    scene.add(group);
    const grouped = await frame();
    expect(grouped[0] as number).toBeGreaterThan(grouped[2] as number);

    renderer.setTransparentSort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    const custom = await frame(false);
    expect(custom[2] as number).toBeGreaterThan(custom[0] as number);
    renderer.setTransparentSort(null);
    expect(await frame()).toEqual(grouped);
  } finally {
    renderer.setTransparentSort(null);
    geometry.dispose();
    red.material.dispose();
    blue.material.dispose();
  }
});

it('keeps 512 untextured transparent draws resident while the camera moves', {
  timeout: 120000,
}, async () => {
  THREE.enableThreeSourceTracking();
  const renderer = rendererFor();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  const geometry = new THREE.PlaneGeometry(0.065, 0.065);
  const material = new THREE.MeshBasicMaterial({
    color: 0x649afe,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  for (let i = 0; i < 512; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(((i % 24) - 12) * 0.08, (Math.floor(i / 24) - 10) * 0.08, (i % 5) * 0.04);
    scene.add(mesh);
  }
  await renderer.init();
  try {
    await readyFrames(renderer, scene, camera, 60);
    camera.position.x = 0.2;
    camera.rotation.y = 0.15;
    await readyFrames(renderer, scene, camera);
    const work = renderer.inspect().sourceWork;
    if (work === undefined) throw new Error('Missing source work for the completed frame');
    expect(work.mode).toBe('tracked');
    expect(work.residentNodes).toBeGreaterThanOrEqual(512);
    expect(work.meshPlans).toBe(0);
    expect(work.viewBindings).toBe(0);
    expect(
      displayPixels(await renderer.captureFrame(scene, camera)).some(
        (x, i) => i % 4 === 2 && x > 80,
      ),
    ).toBe(true);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

it('keeps tracking through a hidden transparent instance batch and preserves its draw order', {
  timeout: 120000,
}, async () => {
  const end = THREE.enableThreeSourceTracking();
  const renderer = rendererFor();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  const geometry = new THREE.PlaneGeometry(1.6, 1.6);
  const make = (color: number) =>
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      depthTest: false,
    });
  const red = new THREE.Mesh(geometry, make(0xff0000));
  const blue = new THREE.InstancedMesh(geometry, make(0x0000ff), 1);
  blue.setMatrixAt(0, new THREE.Matrix4());
  blue.renderOrder = 5;
  blue.visible = false;
  scene.add(blue, red);
  end();
  const center = async () => {
    await readyFrames(renderer, scene, camera, 2);
    expect(renderer.inspect().sourceWork?.mode).toBe('tracked');
    const pixels = displayPixels(await renderer.captureFrame(scene, camera));
    const offset = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
    return Array.from(pixels.subarray(offset, offset + 3));
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const hidden = await center();
    expect(hidden[0]).toBeGreaterThan(hidden[2] ?? 0);
    blue.visible = true;
    const front = await center();
    expect(front[2]).toBeGreaterThan(front[0] ?? 0);
    blue.renderOrder = -5;
    const back = await center();
    expect(back[0]).toBeGreaterThan(back[2] ?? 0);
    THREE.setThreeSceneTracking(scene, false);
    await readyFrames(renderer, scene, camera);
    const pixels = displayPixels(await renderer.captureFrame(scene, camera));
    const offset = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
    expect(Array.from(pixels.subarray(offset, offset + 3))).toEqual(back);
  } finally {
    blue.dispose();
    geometry.dispose();
    red.material.dispose();
    blue.material.dispose();
  }
});
