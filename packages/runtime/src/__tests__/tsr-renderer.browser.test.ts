import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyTsrRenderer } from './tsr-renderer.fixture';

it.each([
  'forward',
  'deferred',
] as const)('renders sixty %s TSR frames on a Browser canvas with the same replay and lifecycle oracle as Dawn', {
  timeout: 240_000,
}, async (renderPath) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  try {
    await verifyTsrRenderer(
      canvas,
      undefined,
      async (filename, bytes) => {
        if (filename !== 'shared-exposure-bloom-failure.rhitape' || typeof bytes === 'string')
          return;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }
        await commands.writeFile(
          `artifacts/ci-focus/tsr-renderer/${renderPath}/${filename}`,
          btoa(binary),
          'base64',
        );
      },
      renderPath,
    );
  } finally {
    canvas.remove();
  }
});
