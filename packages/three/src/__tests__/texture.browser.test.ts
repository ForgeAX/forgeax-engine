import { CanvasTexture, RedFormat, RGFormat } from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { projectTexture } from '../texture';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { flatShadingMaterialTypes, verifyFlatShading } from './flat-shading.fixture';
import { browserRendererFixture } from './render.fixture';
import { verifyTextures } from './texture.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it('matches independently authored r187 WebGPU inputs: textures', {
  timeout: 120000,
}, async () => {
  // Each upstream Renderer keeps independent node/material caches while its
  // file-owned device avoids repeated adapter/device startup per comparison.
  await verifyTextures(rendererFor(), renderReference, saveBrowserEvidence);
});

it.each(
  flatShadingMaterialTypes,
)('matches independently authored r187 WebGPU inputs: flat shading %s', {
  timeout: 120000,
}, async (materialType) => {
  await verifyFlatShading(rendererFor(), renderReference, saveBrowserEvidence, materialType);
});

it('publishes independent RGBA canvas snapshots with the requested orientation and alpha convention', () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Missing 2D context');
  ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 1, 1, 1);
  const texture = new CanvasTexture(canvas);
  const read = () => projectTexture(texture).unwrap().data;
  texture.flipY = false;
  const first = read();
  expect(Array.from(first)).toEqual([255, 0, 0, 128, 0, 255, 0, 255]);
  texture.flipY = true;
  expect(Array.from(read())).toEqual([0, 255, 0, 255, 255, 0, 0, 128]);
  texture.premultiplyAlpha = true;
  expect(Array.from(read())).toEqual([0, 255, 0, 255, 128, 0, 0, 128]);
  texture.format = RGFormat;
  expect(Array.from(read())).toEqual([0, 255, 128, 0]);
  texture.format = RedFormat;
  expect(Array.from(read())).toEqual([0, 128]);
  ctx.clearRect(0, 0, 1, 2);
  expect(Array.from(first)).toEqual([255, 0, 0, 128, 0, 255, 0, 255]);
  texture.dispose();
});
