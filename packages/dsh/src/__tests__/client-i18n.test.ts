import { describe, expect, it } from 'vitest';
import { clientLabels } from '../client-i18n';
import en from '../locales/en.json';
import zhCN from '../locales/zh-CN.json';

describe('DSH client labels', () => {
  it('provides complete nonempty English and Simplified Chinese catalogs', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    for (const catalog of [en, zhCN]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), key).not.toBe('');
      }
    }
    expect(zhCN.hidePreview).not.toBe(en.hidePreview);
    expect(zhCN.toggleState).not.toBe(en.toggleState);
  });

  it.each([
    'zh',
    'zh-CN',
    'zh-SG',
    'zh-Hans',
    'zh-Hans-CN',
  ])('selects Simplified Chinese for %s', (locale) => expect(clientLabels(locale)).toBe(zhCN));

  it.each(['en', 'en-GB', 'fr', 'zh-TW', 'zh-Hant'])('uses English fallback for %s', (locale) =>
    expect(clientLabels(locale)).toBe(en));
});
