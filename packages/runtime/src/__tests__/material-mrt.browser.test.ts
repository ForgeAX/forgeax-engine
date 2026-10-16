import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyMaterialMrt } from './material-mrt.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startMaterialMrt(): Promise<{ id: string; guid: string; binding: RuntimeAssetBinding }>;
    stopMaterialMrt(id: string): Promise<void>;
  }
}
it('captures and replays every public material MRT attachment on Browser WebGPU', async () => {
  const server = await commands.startMaterialMrt();
  try {
    await verifyMaterialMrt({
      ...server,
      shaderManifestUrl: '/shaders/manifest.json',
      save: async (name, bytes) => {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        await commands.writeFile(`artifacts/material-mrt/browser/${name}`, btoa(binary), 'base64');
      },
    });
  } finally {
    await commands.stopMaterialMrt(server.id);
  }
}, 120_000);
