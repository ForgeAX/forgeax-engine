import { describe, expect, it } from 'vitest';
import { createUiLoader } from '../loader.js';

describe('ui loader errors', () => {
  it('rejects malformed payload with a closed, recoverable error', () => {
    const result = createUiLoader().load({ guid: '', html: 1, css: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-asset');
      expect(result.error.expected).toBeTruthy();
      expect(result.error.hint).toBeTruthy();
      expect(result.error.detail).toBeTruthy();
    }
  });
  it('loads a valid payload without requiring a DOM', () => {
    const result = createUiLoader().load({ guid: 'a', html: '<div/>', css: '' });
    expect(result.ok).toBe(true);
  });

  it('returns a structured error when localization cannot become an owned snapshot', () => {
    expect(
      createUiLoader().load({
        guid: 'a',
        html: '<div/>',
        css: '',
        localization: {
          fallbackLng: 'en',
          defaultNS: 'translation',
          resources: new Proxy({ en: { translation: { label: 'Play' } } }, {}),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-asset' } });
  });

  it('accepts Pack v2 loader input and rejects a catalog row as content', () => {
    const loader = createUiLoader();
    const result = loader.load({
      guid: 'a',
      kind: 'ui',
      payload: { guid: 'a', html: '<div/>', css: '' },
      refs: [],
      artifacts: {},
    });
    expect(result.ok).toBe(true);
    expect(loader.load({ guid: 'a', packageUrl: '/a.ui.html' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-asset' },
    });
  });
});
