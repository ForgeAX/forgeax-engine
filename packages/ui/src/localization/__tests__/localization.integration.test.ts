import { describe, expect, it, vi } from 'vitest';
import { createUiImporter } from '../../importer/index.js';
import { createUiLoader } from '../../loader.js';
import { mountUi } from '../../mount.js';
import { bindUiLocalization, createUiLocalization, refreshUiLocalization } from '../index.js';
import { isUiLocalization } from '../resources.js';

const localization = {
  fallbackLng: 'en',
  defaultNS: 'game',
  resources: {
    en: {
      game: {
        title: 'Inventory',
        item_one: '{{count}} item for {{name}}',
        item_other: '{{count}} items for {{name}}',
        fallback: 'Fallback',
      },
    },
    fr: {
      game: {
        title: 'Inventaire',
        item_one: '{{count}} objet pour {{name}}',
        item_other: '{{count}} objets pour {{name}}',
      },
    },
  },
};
const asset = {
  guid: 'hud-guid',
  html: '<span data-ui-part="title"></span>',
  css: '',
  localization,
};
async function open(input: unknown = asset, lng = 'en', onMissingKey = vi.fn()) {
  const loaded = createUiLoader().load(JSON.parse(JSON.stringify(input)));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw loaded.error;
  const result = await createUiLocalization(loaded.value, { lng, onMissingKey });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('UI localization production and native consumption', () => {
  it('imports a tracked companion, finalizes transport, and consumes the JSON roundtrip offline', async () => {
    const result = await createUiImporter().import({
      source: 'hud.ui.html',
      subAssets: [{ guid: asset.guid, sourceIndex: 0, kind: 'ui' }],
      importSettings: { localization: 'hud.ui.i18n.json' },
      readSource: async () => ({ ok: true, value: new TextEncoder().encode(asset.html) }),
      readSibling: async (path) => ({
        ok: true,
        value: new TextEncoder().encode(path.endsWith('.css') ? '' : JSON.stringify(localization)),
      }),
      decodeImage: async () => {
        throw new Error('not an image');
      },
    });
    if (!result.ok) throw result.error;
    expect(result.value.sourceDependencies).toContain('hud.ui.i18n.json');
    const i18n = await open(result.value.assets[0]?.payload, 'fr-CA');
    expect(i18n.t('item', { count: 2, name: '<Player>' })).toBe('2 objets pour <Player>');
    expect(i18n.t('fallback')).toBe('Fallback');
  });

  it('isolates projects and reports missing keys through the native handler', async () => {
    const missing = vi.fn();
    const a = await open(asset, 'en', missing),
      b = await open(asset, 'fr');
    await a.changeLanguage('fr');
    await b.changeLanguage('en');
    expect(a.t('title')).toBe('Inventaire');
    expect(b.t('title')).toBe('Inventory');
    expect(a.t('item', { count: 1, name: 'Ada' })).toBe('1 objet pour Ada');
    expect(a.t('missing')).toBe('missing');
    expect(missing).toHaveBeenCalledWith(['en'], 'game', 'missing');
  });

  it('updates DOM on language and resource changes, removes stale keys, and detaches on disposal', async () => {
    const i18n = await open();
    const root = document.createElement('div');
    document.body.append(root);
    const mounted = mountUi(asset, { root, layer: 1 });
    if (!mounted.ok) throw mounted.error;
    const span = mounted.value.host.shadowRoot?.querySelector('span');
    if (!span) throw new Error('UI title span missing');
    const render = vi.fn((t) => {
      span.textContent = t('title');
    });
    bindUiLocalization(mounted.value, i18n, render);
    await i18n.changeLanguage('fr');
    expect(span.textContent).toBe('Inventaire');
    const refreshed = {
      ...asset,
      localization: {
        ...localization,
        resources: { en: { game: { title: 'New inventory' } }, fr: { game: { title: 'Nouveau' } } },
      },
    };
    expect((await refreshUiLocalization(i18n, refreshed)).ok).toBe(true);
    expect(span.textContent).toBe('Nouveau');
    expect(i18n.exists('fallback')).toBe(false);
    expect(localization.resources.fr.game.title).toBe('Inventaire');
    i18n.addResourceBundle('fr', 'game', { title: 'External refresh' }, true, true);
    expect(span.textContent).toBe('External refresh');
    mounted.value.dispose();
    const calls = render.mock.calls.length;
    await i18n.changeLanguage('en');
    i18n.addResourceBundle('en', 'game', { title: 'Later' }, true, true);
    expect(render).toHaveBeenCalledTimes(calls);
    root.remove();
  });

  it('rejects invalid revisions without losing accepted translations', async () => {
    const i18n = await open();
    const invalid = {
      ...asset,
      localization: { ...localization, resources: { en: { game: { bad: 42 } } } },
    };
    expect(createUiLoader().load(invalid).ok).toBe(false);
    expect((await refreshUiLocalization(i18n, invalid as unknown as typeof asset)).ok).toBe(false);
    expect(i18n.t('title')).toBe('Inventory');
    expect((await createUiLocalization({ guid: 'x', html: '', css: '' }, { lng: 'en' })).ok).toBe(
      false,
    );
    expect(
      isUiLocalization(
        JSON.parse(
          '{"fallbackLng":"en","defaultNS":"game","resources":{"en":{"game":{"__proto__":"x"}}}}',
        ),
      ),
    ).toBe(false);
  });

  it('reports malformed JSON at its producer source', async () => {
    const result = await createUiImporter().import({
      source: 'hud.ui.html',
      subAssets: [{ guid: asset.guid, sourceIndex: 0, kind: 'ui' }],
      importSettings: { localization: 'hud.ui.i18n.json' },
      readSource: async () => ({ ok: true, value: new Uint8Array() }),
      readSibling: async (path) => ({
        ok: true,
        value: new TextEncoder().encode(path.endsWith('.json') ? '{ invalid' : ''),
      }),
      decodeImage: async () => {
        throw new Error('not an image');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        code: 'source-validation-failed',
        detail: {
          diagnostics: [
            {
              code: 'ui-localization-invalid',
              sourcePath: 'hud.ui.i18n.json',
              rule: 'ui-localization-json',
            },
          ],
        },
      });
  });

  it('detaches a failed initial render and ignores disposed UI', async () => {
    const i18n = await open();
    const mounted = mountUi(asset, { root: document.createElement('div'), layer: 1 });
    if (!mounted.ok) throw mounted.error;
    const render = vi.fn(() => {
      throw new Error('consumer failed');
    });
    expect(() => bindUiLocalization(mounted.value, i18n, render)).toThrow('consumer failed');
    await i18n.changeLanguage('fr');
    i18n.addResourceBundle('fr', 'game', { title: 'Updated' }, true, true);
    expect(render).toHaveBeenCalledTimes(1);
    mounted.value.dispose();
    bindUiLocalization(mounted.value, i18n, render);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it.each([
    '../outside.json',
    '/absolute.json',
    'https://remote.json',
    'missing.txt',
  ])('rejects unsafe companion %s', async (path) => {
    const result = await createUiImporter().import({
      source: 'hud.ui.html',
      subAssets: [{ guid: asset.guid, sourceIndex: 0, kind: 'ui' }],
      importSettings: { localization: path },
      readSource: async () => ({ ok: true, value: new Uint8Array() }),
      readSibling: async () => ({ ok: true, value: new Uint8Array() }),
      decodeImage: async () => {
        throw new Error('not an image');
      },
    });
    expect(result.ok).toBe(false);
  });
});
