import { describe, expect, it } from 'vitest';
import diagnosticEn from '../../../../tools/view-plugins/locales/en.json';
import diagnosticZh from '../../../../tools/view-plugins/locales/zh.json';
import { viewerTranslation } from '../i18n';
import en from '../locales/en.json';
import zh from '../locales/zh.json';

describe('diagnostic interface translations', () => {
  for (const [name, english, chinese] of [
    ['RHI', en, zh],
    ['Engine tools', diagnosticEn, diagnosticZh],
  ] as const) {
    it(`${name} catalogs have matching keys and interpolation parameters`, () => {
      expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
      const placeholders = (value: string) =>
        [...new Set([...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))].sort();
      for (const [key, left] of Object.entries(english)) {
        const right = (chinese as Record<string, string>)[key] ?? '';
        expect(left.trim()).not.toBe('');
        expect(right.trim()).not.toBe('');
        expect(placeholders(right), key).toEqual(placeholders(left));
      }
    });
  }

  it('keeps technical resource identifiers intact in translated navigation', () => {
    const t = viewerTranslation('zh');
    expect(t('openResource', { id: 'buffer:linked', panel: t('resourceInspector') })).toBe(
      zh.openResource.replace('{{id}}', 'buffer:linked').replace('{{panel}}', zh.resourceInspector),
    );
  });
});
