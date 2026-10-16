import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { type CookMeshLightingFixture, verifyVfxMeshLighting } from './vfx-mesh-lighting.fixture';

declare module 'vitest/internal/browser' {
  interface BrowserCommands {
    cookVfxMeshLighting: CookMeshLightingFixture;
  }
}

it('preserves Mesh/IBL/shadow/depth output and tape replay through native publication', async ({
  signal,
}) => {
  await verifyVfxMeshLighting({
    signal,
    shaderManifestUrl: '/shaders/manifest.json',
    cook: commands.cookVfxMeshLighting,
    publication: true,
  });
}, 180_000);
