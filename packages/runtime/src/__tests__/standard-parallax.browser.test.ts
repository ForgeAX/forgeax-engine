import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { PARALLAX_SIZE, verifyStandardParallax } from './standard-parallax.fixture';

it('renders parallax displacement off/on and its analytic edge shift in browser WebGPU', {
  timeout: 300_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PARALLAX_SIZE;
  document.body.append(canvas);
  const host = renderValue(await constructRuntimeRendererHost(canvas));
  try {
    await verifyStandardParallax(host.renderer, async (name, bytes) => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await commands.writeFile(
        `artifacts/standard-parallax/browser/${name}`,
        btoa(binary),
        'base64',
      );
    });
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
  }
});
