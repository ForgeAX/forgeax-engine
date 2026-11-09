import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyMultiCameraVfx } from './multi-camera-vfx.fixture';

// Dawn owns direct World VFX; Browser owns its native publication transport.
it('simulates published VFX and replays two Browser camera views', {
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  document.body.append(canvas);
  try {
    await verifyMultiCameraVfx({
      canvas,
      shaderManifestUrl: '/shaders/manifest.json',
      publication: true,
      warmupFrames: import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 12 : 60,
      cook: commands.cookVfxMeshLighting,
      save: async (name, bytes) => {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        await commands.writeFile(
          `artifacts/multi-camera/publication-browser/${name}`,
          btoa(binary),
          'base64',
        );
      },
    });
  } finally {
    canvas.remove();
  }
});
