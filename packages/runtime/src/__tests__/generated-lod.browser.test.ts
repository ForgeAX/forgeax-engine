import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyGeneratedLods } from './generated-lod.fixture';
import type { startGeneratedLodServer } from './generated-lod.server';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startGeneratedLod(): Promise<
      Omit<Awaited<ReturnType<typeof startGeneratedLodServer>>, 'close'>
    >;
    stopGeneratedLod(url: string): Promise<void>;
  }
}

it('renders generated Mesh LODs through HTTP/Catalog and verifies fresh RHI replay in Browser WebGPU', async () => {
  const server = await commands.startGeneratedLod();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  try {
    const host = await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi });
    if (!host.ok) throw host.error;
    try {
      await verifyGeneratedLods(
        host.value.renderer,
        host.value.assets,
        recorder,
        server,
        async (name, bytes) => {
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 8192)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          await commands.writeFile(
            `artifacts/generated-lod/browser/${name}`,
            btoa(binary),
            'base64',
          );
        },
      );
    } finally {
      await host.value.renderer.dispose();
    }
  } finally {
    (await recorder.dispose()).unwrap();
    canvas.remove();
    await commands.stopGeneratedLod(server.url);
  }
}, 600_000);
