import { join } from 'node:path';
import { imageImporter } from '@forgeax/engine/image/image-importer';
import type { RuntimeAssetBinding } from '@forgeax/engine/types';
import { pluginPack } from '@forgeax/engine/vite-plugin-pack';
import { createServer } from 'vite';
import { imageMeta, PNG_1X1, withFixture } from './fixture';

export const SAMPLER_PACKAGE = '019f1a00-0000-7000-8000-0000000002a0';
export const HERO_GUID = '019f1a00-0000-7000-8000-0000000002a1';
export const MISSING_GUID = '019f1a00-0000-7000-8000-0000000002ff';

const FILES = {
  'package.json': '{"name":"feature-lab-pack-fixture","type":"module"}',
  'assets/sampler.pack.json': JSON.stringify({
    schemaVersion: '3.0.0',
    packageId: SAMPLER_PACKAGE,
    assets: { 'sampler/main': { kind: 'sampler', payload: { magFilter: 'nearest' }, refs: [] } },
  }),
  'assets/hero.png': PNG_1X1,
  'assets/hero.png.meta.json': imageMeta(HERO_GUID),
};

export interface PackDevServer {
  readonly root: string;
  readonly plugin: ReturnType<typeof pluginPack>;
  fetch(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }>;
}

export function withPackDevServer<T>(
  binding: RuntimeAssetBinding | undefined,
  body: (server: PackDevServer) => Promise<T>,
): Promise<T> {
  return withFixture(FILES, async (root) => {
    const plugin = pluginPack({
      ...(binding === undefined ? {} : { runtimeBinding: binding }),
      roots: [join(root, 'assets')],
      watch: false,
      importers: [imageImporter],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
    });
    const vite = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    try {
      await vite.listen();
      await plugin.ready();
      const base = vite.resolvedUrls?.local[0] ?? '';
      return await body({
        root,
        plugin,
        async fetch(path, init) {
          const response = await fetch(new URL(path, base), init);
          const text = await response.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {}
          return { status: response.status, body: parsed };
        },
      });
    } finally {
      await vite.close();
    }
  });
}
