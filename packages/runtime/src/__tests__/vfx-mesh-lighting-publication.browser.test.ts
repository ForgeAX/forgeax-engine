import { it } from 'vitest';
import { commands } from 'vitest/browser';
import type { SaveVfxMeshLightingFailure } from './vfx-mesh-lighting.commands';
import { type CookMeshLightingFixture, verifyVfxMeshLighting } from './vfx-mesh-lighting.fixture';
import { encodeVfxDiagnosticTape } from './vfx-mesh-lighting.transport';

declare module 'vitest/internal/browser' {
  interface BrowserCommands {
    cookVfxMeshLighting: CookMeshLightingFixture;
    saveVfxMeshLightingFailure: SaveVfxMeshLightingFailure;
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
    onIblFailure: async (state, tape) => {
      await commands.saveVfxMeshLightingFailure(
        'full',
        state,
        tape === undefined ? undefined : encodeVfxDiagnosticTape(tape),
      );
    },
  });
}, 180_000);
