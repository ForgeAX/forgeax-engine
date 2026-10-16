import { type AssetLoadError, ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createUiLoader } from '../../loader.js';
import { mountUi } from '../../mount.js';
import { uiResourceMimeType } from '../../resources.js';
import { createUiImporter } from '../index.js';

async function imported(
  html = '<p>icons/panel.png</p><img src="icons/panel.png?version=1&amp;lang=fr"><template data-ui-template="popup"><img src="./icons/panel.png"></template>',
  source = 'hud.ui.html',
) {
  const css = '.hud{background:url("icons/panel.png")} .hud::before{content:"icons/panel.png"}';
  const readSibling = vi.fn(async (path: string) => ({
    ok: true as const,
    value: path === 'hud.ui.css' ? new TextEncoder().encode(css) : Uint8Array.of(1, 2, 3),
  }));
  const result = await createUiImporter().import({
    source,
    subAssets: [{ guid: 'ui-guid', sourceIndex: 0, kind: 'ui' }],
    importSettings: {},
    readSource: async () => ({ ok: true, value: new TextEncoder().encode(html) }),
    readSibling,
    decodeImage: async () => {
      throw new Error('UI keeps raw companions');
    },
  });
  return { result, html, css, readSibling };
}

describe('ordinary UI companion publication', () => {
  it.each([
    '/project/assets/hud.ui.html',
    'C:\\project\\assets\\hud.ui.html',
  ])('keeps the physical source %s out of its portable payload', async (source) => {
    const { result, css, readSibling } = await imported(undefined, source);
    if (!result.ok) throw result.error;
    expect(result.value.assets[0]?.payload).toMatchObject({ css, sourcePath: 'hud.ui.html' });
    expect(readSibling).toHaveBeenCalledWith('hud.ui.css');
    expect(result.value.sourceDependencies).toContain(source);
  });

  it('preserves author bytes, loads asset-local companions, and projects only syntax URLs', async () => {
    const { result, html, css } = await imported();
    if (!result.ok) throw result.error;
    const asset = result.value.assets[0];
    if (!asset) throw new Error('missing asset');
    expect(asset.payload).toMatchObject({ html, css, sourcePath: 'hud.ui.html' });
    const loaded = createUiLoader().load({
      ...asset,
      artifacts: Object.fromEntries(
        Object.entries(asset.artifacts).map(([key, body]) => [
          key,
          { descriptor: { mediaType: body.mediaType }, bytes: body.bytes },
        ]),
      ),
    });
    if (!loaded.ok) throw loaded.error;
    const mounted = mountUi(loaded.value, { root: document.body, layer: 1 });
    if (!mounted.ok) throw mounted.error;
    const shadow = mounted.value.host.shadowRoot;
    if (!shadow) throw new Error('UI requires an open ShadowRoot');
    expect(shadow.querySelector('p')?.textContent).toBe('icons/panel.png');
    expect(shadow.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID');
    expect(shadow.querySelector('style')?.textContent).toContain('content:"icons/panel.png"');
    expect(
      shadow.querySelector('template')?.content.querySelector('img')?.getAttribute('src'),
    ).toBe('data:image/png;base64,AQID');
    expect(mounted.value.resourceUrl('./icons/panel.png')).toEqual({
      ok: true,
      value: 'data:image/png;base64,AQID',
    });
    for (const reference of [
      'unknown.png',
      '../icons/panel.png',
      '%2e%2e/secret.png',
      'icons%2f..%2f..%2fsecret.png',
      'https://example.com/image.png',
    ]) {
      expect(mounted.value.resourceUrl(reference)).toMatchObject({
        ok: false,
        error: { code: 'ui-resource-invalid' },
      });
    }
    mounted.value.dispose();
    expect(mounted.value.resourceUrl('icons/panel.png')).toMatchObject({
      ok: false,
      error: { detail: { reason: 'instance-disposed' } },
    });
  });

  it('rejects escaped companions before reading outside the author directory', async () => {
    const { result, readSibling } = await imported('<img src="%2e%2e/private.png">');
    expect(result).toMatchObject({ ok: false, error: { code: 'source-validation-failed' } });
    expect(readSibling.mock.calls.some(([path]) => path.includes('private'))).toBe(false);
  });

  it('retains artifact errors and fences an asynchronous result from a retired publication', async () => {
    const controller = new AbortController();
    let complete: ((value: Result<Uint8Array, AssetLoadError>) => void) | undefined;
    const descriptor = {
      path: 'artifacts/panel.png',
      mediaType: 'image/png',
      byteLength: 3,
      contentEncoding: 'identity' as const,
      integrity: { algorithm: 'sha256' as const, digest: 'a'.repeat(64) },
    };
    const envelope = {
      guid: 'ui-guid',
      kind: 'ui',
      payload: {
        guid: 'ui-guid',
        html: '<img src="panel.png">',
        css: '',
        sourcePath: 'hud.ui.html',
      },
      refs: [],
      artifacts: { 'panel.png': descriptor },
    };
    const pending = createUiLoader().decode({
      envelope,
      signal: controller.signal,
      artifacts: {
        read: async () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      },
    });
    controller.abort('old publication retired');
    if (!complete) throw new Error('UI decoder did not read its artifact');
    complete(ok(Uint8Array.of(1, 2, 3)));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'asset-load-cancelled', detail: { guid: 'ui-guid' } },
    });
    expect(uiResourceMimeType('font.ttf')).toBe('font/ttf');
    expect(uiResourceMimeType('font.otf')).toBe('font/otf');
  });
});
