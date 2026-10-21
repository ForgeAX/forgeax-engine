/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  AssetRegistry,
  createCatalogSource,
  defineAssetKind,
} from '@forgeax/engine-assets-runtime';
import { createRuntimePackPublication } from '@forgeax/engine-pack/build';
import { createUiLoader, mountUi, type UiAsset } from '@forgeax/engine-ui';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { afterEach, expect, it } from 'vitest';
import { type BlitzUi, createBlitzUi, UiResourceError, type UiWasmHost } from '../index.js';
import { required } from './fixture.js';

const wasm = await readFile(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url));
const host: UiWasmHost = {
  readWasm: async () => wasm,
  instantiate: (imports) => WebAssembly.instantiate(wasm, imports as WebAssembly.Imports),
};
const source = createRequire(new URL('../../../devkit/package.json', import.meta.url));
const fontPackage = dirname(source.resolve('@fontsource-variable/noto-sans-sc/package.json'));
const latin = await readFile(join(fontPackage, 'files/noto-sans-sc-latin-wght-normal.woff2'));
const red = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const live: BlitzUi[] = [];
afterEach(() => {
  for (const ui of live.splice(0)) ui.dispose();
});
const defaults = {
  wasm: host,
  width: 180,
  height: 80,
  onError: (cause: unknown) => {
    throw cause;
  },
};

it('retains bundled disclosure and list glyphs alongside native controls with a prepared font context', async () => {
  const bullet = await readFile(
    new URL(
      '../../../../third_party/blitz/packages/blitz-dom/assets/moz-bullet-font.otf',
      import.meta.url,
    ),
  );
  const lists = ['outside', 'inside']
    .map(
      (position) =>
        `<section style="list-style-position:${position}"><ul><li>Disc</li><li style="list-style-type:circle">Circle</li><li style="list-style-type:square">Square</li></ul><ol><li>Ordered</li></ol></section>`,
    )
    .join('');
  const html = `<style>body{margin:0;background:white;color:black;font:20px/28px system-ui}pre,ul,ol{margin:0}main{display:grid;grid-template-columns:1fr 1fr}input{width:20px;height:20px}</style><details><summary>Diagnostics</summary><pre>Failure details</pre></details><main>${lists}</main><label><input type="checkbox" checked>Check</label><label><input type="radio" checked>Radio</label>`;
  const implicit = await createBlitzUi({
    ...defaults,
    width: 320,
    height: 250,
    html,
    font: latin,
    fontFamily: 'Noto Sans SC Variable',
  });
  const explicit = await createBlitzUi({
    ...defaults,
    width: 320,
    height: 250,
    html: `<style>@font-face{font-family:Bullet;src:url(bullet.otf)}</style>${html}`,
    font: latin,
    fontFamily: 'Noto Sans SC Variable',
    resources: { baseUrl: 'https://fonts.test/', read: async () => bullet },
  });
  live.push(implicit, explicit);
  for (const open of [false, true]) {
    for (const ui of [implicit, explicit])
      required(ui.document.querySelector('details')).toggleAttribute('open', open);
    const actual = required(implicit.paint(0));
    const expected = required(explicit.paint(0));
    expect(actual.length).toBe(expected.length);
    expect(
      actual.every((value, index) => value === expected[index]),
      `disclosure-${open ? 'open' : 'closed'} must use the bundled marker font`,
    ).toBe(true);
  }
});

it('loads nested stylesheets and companion image pixels through the core resource graph', async () => {
  const urls: string[] = [];
  const files = new Map([
    ['css/main.css', new TextEncoder().encode('@import "nested.css"; body{margin:0}')],
    ['css/nested.css', new TextEncoder().encode('img{width:20px;height:20px}')],
    ['images/red.png', red],
  ]);
  const ui = await createBlitzUi({
    ...defaults,
    html: '<link rel="stylesheet" href="css/main.css"><img src="images/red.png">',
    resources: {
      baseUrl: 'https://ui.test/guide/',
      async read(url) {
        urls.push(url);
        return required(files.get(url.replace('https://ui.test/guide/', '')));
      },
    },
  });
  live.push(ui);
  expect(urls.sort()).toEqual(
    ['css/main.css', 'css/nested.css', 'images/red.png'].map(
      (path) => `https://ui.test/guide/${path}`,
    ),
  );
  const image = required(ui.document.querySelector('img'));
  expect(image.getBoundingClientRect().width).toBe(20);
  const pixels = required(ui.paint(0));
  const offset = (10 * 180 + 10) * 4;
  expect([...pixels.slice(offset, offset + 4)]).toEqual([255, 0, 0, 255]);
});

it('loads the licensed production WOFF2 family for French and distinct Chinese characters', async () => {
  const requested: string[] = [];
  const ui = await createBlitzUi({
    ...defaults,
    html: '<link rel="stylesheet" href="index.css"><style>body{margin:0;font:32px/40px system-ui;color:black;background:white}</style>\u4f60\u597d\u4e2d\u6587<br>Fran\u00e7ais',
    font: latin,
    fontFamily: 'Noto Sans SC Variable',
    resources: {
      baseUrl: 'https://fonts.test/',
      async read(url) {
        requested.push(url);
        return readFile(join(fontPackage, url.replace('https://fonts.test/', '')));
      },
    },
  });
  live.push(ui);
  expect(requested.filter((url) => url.endsWith('.woff2')).length).toBeGreaterThan(100);
  const pixels = required(ui.paint(0));
  const tiles = Array.from({ length: 4 }, (_, tile) =>
    Array.from({ length: 40 }, (_, row) =>
      [...pixels.slice((row * 180 + tile * 32) * 4, (row * 180 + tile * 32 + 32) * 4)].join(','),
    ).join(';'),
  );
  expect(new Set(tiles).size).toBe(4);
  expect([...pixels.slice(40 * 180 * 4)].filter((value) => value < 128).length).toBeGreaterThan(
    100,
  );
});

it('retains transport causes and reports invalid image decoding with its URL', async () => {
  const cause = new Error('missing published companion');
  const options = {
    ...defaults,
    html: '<link rel="stylesheet" href="absent.css">',
    resources: { baseUrl: 'https://ui.test/', read: async () => Promise.reject(cause) },
  };
  await expect(createBlitzUi(options)).rejects.toMatchObject({
    code: 'ui-resource-load-failed',
    url: 'https://ui.test/absent.css',
    cause,
  });
  await expect(
    createBlitzUi({
      ...defaults,
      html: '<img src="broken.png">',
      resources: {
        baseUrl: 'https://ui.test/',
        read: async () => new TextEncoder().encode('not an image'),
      },
    }),
  ).rejects.toMatchObject({
    code: 'ui-resource-load-failed',
    url: 'https://ui.test/broken.png',
    cause: expect.stringContaining('Could not parse image'),
  });
  await expect(
    createBlitzUi({ ...defaults, html: '<img src="unconfigured.png">' }),
  ).rejects.toBeInstanceOf(UiResourceError);
});

it('uses the published production fallback for an arrow absent from a UiAsset Latin face', async () => {
  const ui = await createBlitzUi({
    ...defaults,
    html: '<link rel="stylesheet" href="index.css"><style>body{margin:0;background:white}</style>',
    font: latin,
    fontFamily: 'Noto Sans SC Variable',
    resources: {
      baseUrl: 'https://fonts.test/',
      read: (url) => readFile(join(fontPackage, url.replace('https://fonts.test/', ''))),
    },
  });
  live.push(ui);
  const loaded = createUiLoader().load({
    guid: 'fallback',
    kind: 'ui',
    refs: [],
    payload: {
      guid: 'fallback',
      sourcePath: 'hud.ui.html',
      html: '<span>→</span>',
      css: '@font-face{font-family:Companion;src:url(latin.woff2)}span{display:block;font:32px/40px Companion;color:black}',
    },
    artifacts: { 'latin.woff2': { descriptor: { mediaType: 'font/woff2' }, bytes: latin } },
  });
  if (!loaded.ok) throw loaded.error;
  const mounted = mountUi(loaded.value, { root: ui.document.body, layer: 1 });
  if (!mounted.ok) throw mounted.error;
  try {
    await ui.loadResources();
    const fallback = required(ui.paint(0));
    const text = required(mounted.value.host.shadowRoot?.querySelector('span'));
    text.style.fontFamily = '"Noto Sans SC Variable"';
    const explicit = required(ui.paint(0));
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    expect(digest(fallback)).toBe(digest(explicit));
    text.textContent = '\u{10ffff}';
    expect(digest(required(ui.paint(0)))).not.toBe(digest(explicit));
  } finally {
    mounted.value.dispose();
  }
});

it('aborts dynamic reads on disposal and ignores bytes arriving after core retirement', async () => {
  let finish: ((bytes: Uint8Array) => void) | undefined;
  let signal: AbortSignal | undefined;
  const ui = await createBlitzUi({
    ...defaults,
    html: '',
    resources: {
      baseUrl: 'https://ui.test/',
      read: async (_url, active) => {
        signal = active;
        return new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const image = ui.document.createElement('img');
  image.setAttribute('src', 'late.png');
  ui.document.body.append(image);
  const pending = ui.loadResources();
  ui.dispose();
  expect(required(signal).aborted).toBe(true);
  await expect(pending).rejects.toThrow('UI document disposed');
  required(finish)(red);
  await Promise.resolve();
});

it.each([
  'eager',
  'stream',
] as const)('carries %s authored UI companions through Pack admission and the same Blitz mount', async (delivery) => {
  const guid = '11111111-2222-4333-8444-555555555555';
  const html = '<img src="images/red.png"><span>Fran\u00e7ais</span>';
  const css =
    ':host{display:block;background:white}img{width:20px;height:20px}span{font:24px Companion}@font-face{font-family:Companion;src:url(fonts/latin.woff2)}';
  const files = new Map([
    ['hud.ui.css', new TextEncoder().encode(css)],
    ['images/red.png', red],
    ['fonts/latin.woff2', latin],
  ]);
  const imported = await createUiImporter().import({
    source: 'hud.ui.html',
    importSettings: {},
    subAssets: [{ guid, kind: 'ui', sourceIndex: 0 }],
    readSource: async () => ({ ok: true, value: new TextEncoder().encode(html) }),
    readSibling: async (path) => ({ ok: true, value: required(files.get(path)) }),
    decodeImage: async () => {
      throw new Error('raw UI bytes remain companions');
    },
  });
  if (!imported.ok) throw imported.error;
  const importedAsset = required(imported.value.assets[0]);
  const artifacts = Object.fromEntries(
    Object.entries(importedAsset.artifacts).map(([key, body]) => [
      key,
      {
        path: key,
        ...(delivery === 'stream' ? { delivery } : {}),
        mediaType: body.mediaType,
        contentEncoding: 'identity' as const,
        byteLength: body.bytes.length,
        integrity: {
          algorithm: 'sha256' as const,
          digest: `sha256:${createHash('sha256').update(body.bytes).digest('hex')}`,
        },
      },
    ]),
  );
  const { pack, publication } = createRuntimePackPublication({
    pack: { assets: [{ ...importedAsset, refs: [], artifacts }] },
    scopeId: 'ui-closure-test',
    generation: 1,
    sourcePath: 'hud.ui.html',
    sourceRevision: 'r1',
    packageUrl: 'https://ui.test/hud.pack.json',
  });
  for (const corrupt of delivery === 'stream' ? [false] : [false, true]) {
    const requested: string[] = [];
    const fetcher = async (url: string) => {
      requested.push(url);
      if (url.endsWith('.pack.json')) return Response.json(pack);
      const bytes = new Uint8Array(required(files.get(url.replace('https://ui.test/', ''))));
      if (corrupt) bytes[0] = (bytes[0] ?? 0) ^ 1;
      return new Response(bytes);
    };
    const registry = new AssetRegistry({
      scopeId: 'ui-closure-test',
      catalog: createCatalogSource({
        entries: [
          {
            guid,
            kind: 'ui',
            sourcePath: 'hud.ui.html',
            packageUrl: 'https://ui.test/hud.pack.json',
            publication,
          },
        ],
      }),
      fetcher,
    });
    const kind = defineAssetKind<UiAsset, 'ui'>('ui');
    registry.installDecoder(kind, createUiLoader());
    try {
      const loaded = await registry.load(guid, kind);
      if (corrupt) {
        expect(loaded).toMatchObject({ ok: false, error: { code: 'asset-integrity-failed' } });
        continue;
      }
      if (!loaded.ok) throw loaded.error;
      const asset = registry.read(loaded.value).unwrap();
      expect(asset.html).toBe(html);
      expect(asset.css).toBe(css);
      if (delivery === 'stream') expect(requested).toEqual(['https://ui.test/hud.pack.json']);
      const ui = await createBlitzUi({
        ...defaults,
        html: '<style>body{margin:0}</style>',
        resources: {
          baseUrl: 'https://ui.test/',
          read: async (url) => new Uint8Array(await (await fetcher(url)).arrayBuffer()),
        },
      });
      live.push(ui);
      const mounted = mountUi(asset, { root: ui.document.body, layer: 1 });
      if (!mounted.ok) throw mounted.error;
      await ui.loadResources();
      expect(requested).toContain('https://ui.test/images/red.png');
      expect(requested).toContain('https://ui.test/fonts/latin.woff2');
      const pixels = required(ui.paint(0));
      const image = required(mounted.value.host.shadowRoot?.querySelector('img'));
      const rect = image.getBoundingClientRect();
      const offset = (Math.floor(rect.y + 10) * 180 + Math.floor(rect.x + 10)) * 4;
      expect([...pixels.slice(offset, offset + 4)]).toEqual([255, 0, 0, 255]);
      expect(
        required(mounted.value.host.shadowRoot?.querySelector('span')).getBoundingClientRect()
          .width,
      ).toBeGreaterThan(50);
      expect(ui.document.head.querySelectorAll('style').length).toBe(2);
      mounted.value.dispose();
      expect(ui.document.head.querySelectorAll('style').length).toBe(1);
      expect(mounted.value.resourceUrl('images/red.png')).toMatchObject({
        ok: false,
        error: { code: 'ui-resource-invalid' },
      });
    } finally {
      registry.dispose();
    }
  }
});
