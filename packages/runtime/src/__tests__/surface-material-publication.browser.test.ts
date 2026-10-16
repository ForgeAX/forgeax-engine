import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import type { SurfaceMaterialPublicationValue } from './material-publication.server';
import { verifySurfaceMaterialPublication } from './surface-material-publication.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startSurfaceMaterialPublication(): Promise<{
      id: string;
      binding: RuntimeAssetBinding;
      baseUrl: string;
      hmrToken: string;
      guid: string;
    }>;
    updateSurfaceMaterialPublication(
      id: string,
      value: SurfaceMaterialPublicationValue,
    ): Promise<void>;
    stopSurfaceMaterialPublication(id: string): Promise<void>;
  }
}

it('consumes same-GUID Surface re-cook and schema replacement through real Vite HMR on Browser', async () => {
  const server = await commands.startSurfaceMaterialPublication();
  try {
    const evidence = await verifySurfaceMaterialPublication({
      ...server,
      lane: 'gpu-driven',
      shaderManifestUrl: '/shaders/manifest.json',
      update: (value) => commands.updateSurfaceMaterialPublication(server.id, value),
    });
    // biome-ignore lint/suspicious/noConsole: receipt-bound publication overlap evidence is the test artifact.
    console.log(
      JSON.stringify({
        kind: 'surface-publication-overlap',
        backend: 'browser',
        lane: evidence.lane,
        directBaselineFrameId: evidence.directBaselineFrameId,
        ...evidence.overlap,
      }),
    );
  } finally {
    await commands.stopSurfaceMaterialPublication(server.id);
  }
}, 120_000);
