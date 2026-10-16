import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyMaterialPublication } from './material-publication.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startMaterialPublication(): Promise<{
      id: string;
      binding: RuntimeAssetBinding;
      guids: string[];
    }>;
    updateMaterialPublication(id: string, value: 'red' | 'blue' | 'broken'): Promise<void>;
    stopMaterialPublication(id: string): Promise<void>;
  }
}

it('loads and rebuilds independent material programs through real Vite HTTP on browser WebGPU', async () => {
  const server = await commands.startMaterialPublication();
  try {
    await verifyMaterialPublication({
      ...server,
      shaderManifestUrl: '/shaders/manifest.json',
      update: (value) => commands.updateMaterialPublication(server.id, value),
    });
  } finally {
    await commands.stopMaterialPublication(server.id);
  }
}, 120_000);
