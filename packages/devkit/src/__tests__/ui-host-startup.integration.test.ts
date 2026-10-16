import { createServer, type ServerResponse } from 'node:http';
import {
  AssetRegistry,
  createAssetRegistry,
  createCatalogSource,
  defineAssetKind,
} from '@forgeax/engine-assets-runtime';
import { createFrontendHost } from '@forgeax/engine-host/frontend';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import {
  createRuntimePackPublication,
  finalizePackageTransportSource,
} from '@forgeax/engine-pack/build';
import { createUiLoader, type UiAsset } from '@forgeax/engine-ui';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { expect, it } from 'vitest';

it.each([
  'pack-loader',
  'decoder',
] as const)('activates the native UI root through %s without preloading its DOM image and font bodies', async (entry) => {
  const guid = '4360b2ef-2f15-4318-843f-c165ffe8d974';
  const uiKind = defineAssetKind<UiAsset, 'ui'>('ui');
  const encode = (value: string) => new TextEncoder().encode(value);
  const importer = createUiImporter();
  const imported = await importer.import({
    source: 'hud.ui.html',
    subAssets: [{ guid, sourceIndex: 0, kind: 'ui' }],
    importSettings: {},
    readSource: async () => ({
      ok: true,
      value: encode('<section><img src="cover.png"><button>Play</button></section>'),
    }),
    readSibling: async (path) => ({
      ok: true,
      value:
        path === 'hud.ui.css'
          ? encode('@font-face { font-family: hud; src: url("hud.woff2"); }')
          : Uint8Array.of(1, 2, 3),
    }),
    decodeImage: async () => {
      throw new Error('UI import retains native media bytes without decoding');
    },
  });
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw imported.error;
  const emitted = new Map<string, Uint8Array>();
  const built = await finalizePackageTransportSource(
    {
      assets: imported.value.assets.map((asset) => ({
        ...asset,
        payload: { ...asset.payload },
        refs: asset.refs.map((ref) => ref.guid),
      })),
    },
    {
      base: '/',
      packagePath: 'ui.pack.json',
      artifactPath: (_guid, key) => `media/${key}`,
      sink: (path, bytes) => {
        emitted.set(path, bytes);
      },
    },
  );
  const { pack, publication } = createRuntimePackPublication({
    pack: built.pack,
    scopeId: 'ui-startup',
    generation: 1,
    sourcePath: 'hud.ui.html',
    sourceRevision: 'one',
    packageUrl: '/ui.pack.json',
  });
  const requests: string[] = [];
  const heldMedia: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    if (path === '/catalog.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify([
          { guid, kind: 'ui', packageUrl: '/ui.pack.json', sourcePath: 'hud.ui.html', publication },
        ]),
      );
    } else if (path === '/ui.pack.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(pack));
    } else {
      // The native media host is allowed to take longer than plugin startup.
      // Eager AssetRegistry reads remain pending here and reproduce the timeout.
      heldMedia.push(response);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP address');
  const origin = `http://127.0.0.1:${address.port}`;
  const registry =
    entry === 'decoder'
      ? createAssetRegistry({
          scopeId: 'ui-startup',
          catalog: createCatalogSource({ url: `${origin}/catalog.json` }),
        })
      : new AssetRegistry({} as never);
  const uiLoader = createUiLoader();
  if (registry instanceof AssetRegistry) {
    registry.configurePackIndex(`${origin}/catalog.json`);
  } else registry.installDecoder(uiKind, uiLoader);
  let loaded: UiAsset | undefined;
  const host = await createFrontendHost({
    autoActivate: false,
    startupTimeoutMs: 1_000,
    assembly: createHostAssembly({ root: { program: 'fixture#frontend', codeRevision: 'one' } }),
    resolveRoot: async () => ({
      name: 'frontend',
      async apply(ctx) {
        await ctx
          .plugin({
            name: 'ui',
            async apply() {
              const result =
                registry instanceof AssetRegistry
                  ? await registry.loadByGuid<UiAsset>(registry.parseGuid(guid))
                  : await registry.load(guid, uiKind);
              if (!result.ok) throw new Error(JSON.stringify(result.error));
              loaded = result.value;
            },
          })
          .await();
      },
    }),
  });
  try {
    await host.activate();
    expect(host.status.state).toBe('active');
    expect(loaded?.html).toContain('src="cover.png"');
    expect(loaded?.css).toContain('url("hud.woff2")');
    expect(loaded?.resources).toEqual({
      'cover.png': { mediaType: 'image/png', url: `${origin}/media/cover.png` },
      'hud.woff2': { mediaType: 'font/woff2', url: `${origin}/media/hud.woff2` },
    });
    expect(requests).toEqual(['/catalog.json', '/ui.pack.json']);
    expect(emitted.get('media/cover.png')).toEqual(Uint8Array.of(1, 2, 3));
    expect(emitted.get('media/hud.woff2')).toEqual(Uint8Array.of(1, 2, 3));
    for (const descriptor of Object.values(built.pack.assets[0]?.artifacts ?? {})) {
      expect(descriptor).toMatchObject({
        delivery: 'stream',
        byteLength: 3,
        integrity: { algorithm: 'sha256', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      });
    }
  } finally {
    for (const response of heldMedia) response.end(Uint8Array.of(1, 2, 3));
    if (!(registry instanceof AssetRegistry)) registry.dispose();
    try {
      await host.dispose();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
