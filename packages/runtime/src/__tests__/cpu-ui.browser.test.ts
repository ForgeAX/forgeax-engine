import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { ensureReady, rhi as wgpu } from '../../../rhi-wgpu/src/index';
import { verifyCpuUiComposition, verifyCpuUiFailure } from './cpu-ui.fixture';

const save = async (name: string, pixels: Uint8Array) => {
  const image = document.createElement('canvas');
  image.width = image.height = 64;
  const context = image.getContext('2d');
  if (context === null) throw new Error('PNG evidence requires 2D context');
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), 64, 64), 0, 0);
  await commands.writeFile(
    `artifacts/cpu-ui/browser/${name}.png`,
    image.toDataURL('image/png').split(',')[1] ?? '',
    'base64',
  );
};

it('presents startup and CPU UI transparently over the actual browser game surface', {
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  try {
    await verifyCpuUiComposition(canvas, '/shaders/manifest.json', save);
  } finally {
    canvas.remove();
  }
});

it('retains the browser graphics/UI surface after game initialization failure', {
  timeout: 60_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  try {
    await verifyCpuUiFailure(canvas, save);
  } finally {
    canvas.remove();
  }
});

it.each([
  false,
  true,
])('submits scene and UI against one real wgpu WebGL2 surface texture (CameraView=%s)', {
  timeout: 180_000,
}, async (cameraViews) => {
  await ensureReady();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  try {
    await verifyCpuUiComposition(
      canvas,
      '/shaders/manifest.json',
      (name, pixels) => save(`webgl2-${cameraViews ? 'views-' : ''}${name}`, pixels),
      wgpu,
      cameraViews,
    );
  } finally {
    canvas.remove();
  }
});
