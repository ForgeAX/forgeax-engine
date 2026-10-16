import { describe, expect, it, vi } from 'vitest';
import { mountUi } from '../../mount.js';
import { bindUiLocalization, createUiLocalization, refreshUiLocalization } from '../index.js';

const asset = {
  guid: 'browser-localized-ui',
  html: '<span data-ui-part="title"></span>',
  css: '',
  localization: {
    fallbackLng: 'en',
    defaultNS: 'game',
    resources: {
      en: {
        game: {
          title: 'Inventory',
          item_one: '{{count}} item',
          item_other: '{{count}} items',
          fallback: 'Fallback',
        },
      },
      fr: {
        game: { title: 'Inventaire', item_one: '{{count}} objet', item_other: '{{count}} objets' },
      },
    },
  },
};

describe('native browser localization lifecycle', () => {
  it('updates real ShadowRoot text, isolates instances, refreshes, and releases subscriptions', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const opened = await createUiLocalization(asset, { lng: 'fr-CA' });
    const second = await createUiLocalization(asset, { lng: 'en' });
    if (!opened.ok || !second.ok) throw new Error('localization initialization failed');
    const mounted = mountUi(asset, { root, layer: 1 });
    if (!mounted.ok) throw mounted.error;
    try {
      const title = mounted.value.host.shadowRoot?.querySelector('span');
      if (!title) throw new Error('title missing');
      const render = vi.fn((t) => {
        title.textContent = t('title');
      });
      bindUiLocalization(mounted.value, opened.value, render);
      expect(title.textContent).toBe('Inventaire');
      expect(opened.value.t('item', { count: 2 })).toBe('2 objets');
      expect(opened.value.t('fallback')).toBe('Fallback');
      await opened.value.changeLanguage('en');
      expect(title.textContent).toBe('Inventory');
      const revision = {
        ...asset,
        localization: {
          ...asset.localization,
          resources: { en: { game: { title: '<Updated>' } } },
        },
      };
      expect((await refreshUiLocalization(opened.value, revision)).ok).toBe(true);
      expect(title.textContent).toBe('<Updated>');
      expect(title.childElementCount).toBe(0);
      expect(opened.value.exists('fallback')).toBe(false);
      expect(second.value.t('title')).toBe('Inventory');
      mounted.value.dispose();
      const count = render.mock.calls.length;
      await opened.value.changeLanguage('fr');
      opened.value.addResourceBundle('fr', 'game', { title: 'After disposal' });
      expect(render).toHaveBeenCalledTimes(count);
      expect(root.childElementCount).toBe(0);
    } finally {
      mounted.value.dispose();
      root.remove();
    }
  });
});
