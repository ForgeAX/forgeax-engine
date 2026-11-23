import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectImportProductForBuild } from '@forgeax/engine-import';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { describe, expect, it } from 'vitest';
import {
  AssetRegistry,
  createCatalogSource,
  defineAssetKind,
} from '../../../assets-runtime/src/index.js';
import { metaFixture } from '../../../pack/src/__tests__/support/direct-pack-fixture.js';
import type { UiAsset } from '../../../ui/src/asset.js';
import { createUiImporter } from '../../../ui/src/importer/index.js';
import { createUiLoader } from '../../../ui/src/loader.js';
import { createPluginPackInternal } from '../plugin-pack.js';
import { packHttpFixture } from './vite-fixtures.js';

describe('UI Pack v2 artifact transport', () => {
  it('loads an ordinary absolute-path UI import through its served publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-dev-ui-transport-'));
    const guid = '019f0000-0000-7000-8000-000000000703';
    const html = '<img src="icon.svg"><button data-i18n="submit">Submit</button>';
    const css = 'button { color: white; }';
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    const localization = {
      resources: { en: { translation: { submit: 'Submit' } } },
      fallbackLng: 'en',
      defaultNS: 'translation',
    };
    await writeFile(join(root, 'guide.ui.html'), html);
    await writeFile(join(root, 'guide.ui.css'), css);
    await writeFile(join(root, 'icon.svg'), icon);
    await writeFile(join(root, 'guide.ui.i18n.json'), JSON.stringify(localization));
    await writeFile(
      join(root, 'guide.ui.html.meta.json'),
      metaFixture(
        'guide.ui.html',
        'ui',
        [{ guid, sourceIndex: 0, sourceKey: 'ui/guide', kind: 'ui' }],
        { localization: 'guide.ui.i18n.json' },
      ),
    );
    const plugin = createPluginPackInternal({
      roots: [root],
      watch: false,
      ddc: { projectDdcRoot: join(root, 'ddc') },
      importers: [createUiImporter()],
    });
    const http = packHttpFixture(plugin);
    let registry: AssetRegistry | undefined;
    try {
      const { base, accepted } = await http.listen(root, 'dev-ui-transport');
      const response = await fetch(new URL(accepted.catalogUrl, base));
      expect(response.status).toBe(200);
      const catalog = decodeCatalogWire(await response.json()).unwrap();
      registry = new AssetRegistry({
        scopeId: accepted.scopeId,
        catalog: createCatalogSource({ entries: catalog }),
        fetcher: (input, init) => fetch(new URL(String(input), base), init),
      });
      const uiKind = defineAssetKind<UiAsset, 'ui'>('ui');
      registry.installDecoder(uiKind, createUiLoader());
      const loaded = await registry.load(guid, uiKind);
      expect(loaded, JSON.stringify(loaded)).toMatchObject({ ok: true });
      if (!loaded.ok) throw loaded.error;
      const payload = registry.read(loaded.value).unwrap();
      expect(payload).toMatchObject({
        guid,
        html,
        css,
        sourcePath: 'guide.ui.html',
        localization,
        resources: {
          'icon.svg': { mediaType: 'image/svg+xml', url: expect.any(String) },
        },
      });
      const resource = payload.resources?.['icon.svg'];
      if (resource === undefined || !('url' in resource)) throw new Error('missing streamed icon');
      expect(resource).not.toHaveProperty('bytes');
      const iconResponse = await fetch(new URL(resource.url, base));
      expect(iconResponse.status).toBe(200);
      expect(iconResponse.headers.get('content-type')).toBe('image/svg+xml');
      expect(new Uint8Array(await iconResponse.arrayBuffer())).toEqual(
        new TextEncoder().encode(icon),
      );
    } finally {
      registry?.dispose();
      await http.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps companion bytes asset-local instead of publishing top-level payload URLs', () => {
    const pack = projectImportProductForBuild({
      assets: [
        {
          guid: 'ui-guid',
          kind: 'ui',
          payload: { guid: 'ui-guid', html: '<img src="hero.png">', css: '' },
          refs: [],
          artifacts: {
            'hero.png': { mediaType: 'image/png', bytes: new Uint8Array([137]) },
            'font.woff2': { mediaType: 'font/woff2', bytes: new Uint8Array([119]) },
          },
        },
      ],
    });
    const asset = pack.assets[0];
    expect(pack.schemaVersion).toBe('2.0.0');
    expect(asset?.payload).toMatchObject({ guid: 'ui-guid' });
    expect(Object.keys(asset?.artifacts ?? {})).toEqual(['hero.png', 'font.woff2']);
    expect(JSON.stringify(pack)).not.toContain('/__ui/');
  });

  it('normalises typed-array payload fields before JSON transport', () => {
    const pack = projectImportProductForBuild({
      assets: [
        {
          guid: 'skeleton-guid',
          kind: 'skeleton',
          payload: { inverseBindMatrices: new Float32Array([1, 2, 3, 4]) },
          refs: [],
          artifacts: {},
        },
      ],
    });
    expect(pack.assets[0]?.payload.inverseBindMatrices).toEqual([1, 2, 3, 4]);
  });
});
