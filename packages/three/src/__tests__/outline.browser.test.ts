import {
  Group,
  Mesh,
  MeshBasicMaterial,
  RenderTarget,
  setThreeOutline,
} from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { browserRendererFixture, displayPixels, readyFrames, testScene } from './render.fixture';

const rendererFor = browserRendererFixture();
const redPixels = (pixels: Uint8Array) => {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 180 && (pixels[i + 1] ?? 0) < 60 && (pixels[i + 2] ?? 0) < 60) count++;
  }
  return count;
};

it('projects a display camera outline with live Three group membership', {
  timeout: 120_000,
}, async () => {
  const renderer = rendererFor({ antialias: true });
  const { scene, camera, mesh } = testScene();
  const group = new Group();
  scene.add(group);
  group.add(mesh);
  await renderer.init();
  renderer.setClearColor(0, 0);

  const image = async () => {
    await readyFrames(renderer, scene, camera);
    return displayPixels(await renderer.captureFrame(scene, camera));
  };
  expect(redPixels(await image())).toBe(0);
  setThreeOutline(renderer, camera, { objects: [group], width: 2, visibleColor: '#ff0000' });
  await readyFrames(renderer, scene, camera, 60);
  expect(redPixels(await image())).toBeGreaterThan(20);

  const target = new RenderTarget(128, 128);
  try {
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, camera);
    expect(renderer.inspect().receipt?.presentation).toBe('ready');
    expect(renderer.inspect().renderer.perFramePassNames).not.toContain('outline-composite');
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
  }

  group.remove(mesh);
  scene.add(mesh);
  expect(redPixels(await image())).toBe(0);
  const replacement = new Mesh(mesh.geometry, new MeshBasicMaterial({ color: 0x99aa44 }));
  replacement.position.x = 0.85;
  group.add(replacement);
  expect(redPixels(await image())).toBeGreaterThan(20);
  replacement.visible = false;
  expect(redPixels(await image())).toBe(0);
  replacement.visible = true;

  setThreeOutline(renderer, camera, { objects: [group] });
  expect(redPixels(await image())).toBe(0);
  setThreeOutline(renderer, camera, null);
  expect(redPixels(await image())).toBe(0);
  replacement.material.dispose();
});
