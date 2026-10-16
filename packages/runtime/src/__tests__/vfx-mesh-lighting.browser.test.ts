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

// The publication carrier owns unrestricted Mesh/IBL lighting. This carrier
// retains the same full fixture at the portable sampled-texture limit.
it('keeps clustered Mesh/IBL lighting valid with exactly 16 sampled textures', async ({
  signal,
}) => {
  await verifyVfxMeshLighting({
    signal,
    shaderManifestUrl: '/shaders/manifest.json',
    cook: commands.cookVfxMeshLighting,
    onIblFailure: saveFailure,
    sampledTextureLimit: 16,
  });
}, 120_000);

async function saveFailure(state: unknown, tape?: Uint8Array) {
  await commands.saveVfxMeshLightingFailure(
    'limit16',
    state,
    tape === undefined ? undefined : encodeVfxDiagnosticTape(tape),
  );
}
