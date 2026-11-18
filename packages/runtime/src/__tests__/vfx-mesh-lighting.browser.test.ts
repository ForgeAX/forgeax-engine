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
// retains lighting, IBL, point/spot shadows and depth replay at the portable limit.
// Core CI defers redundant point-shadow directions to the unrestricted carrier.
it('keeps clustered Mesh/IBL lighting valid with exactly 16 sampled textures', async ({
  signal,
}) => {
  await verifyVfxMeshLighting({
    signal,
    shaderManifestUrl: '/shaders/manifest.json',
    cook: commands.cookVfxMeshLighting,
    onIblFailure: saveFailure,
    sampledTextureLimit: 16,
    coreValidation: import.meta.env.FORGEAX_CI_CORE_VALIDATION === '1',
  });
}, 120_000);

async function saveFailure(state: unknown, tape?: Uint8Array) {
  await commands.saveVfxMeshLightingFailure(
    'limit16',
    state,
    tape === undefined ? undefined : encodeVfxDiagnosticTape(tape),
  );
}
