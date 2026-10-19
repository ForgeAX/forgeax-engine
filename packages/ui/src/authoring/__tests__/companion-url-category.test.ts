import { describe, expect, it } from 'vitest';
import { classifyUiAuthoring, parseCssAuthoring, parseHtmlAuthoring } from '../index.js';

describe('HTML and CSS companion URL policy', () => {
  it.each([
    ['icons/a.png', 'native'],
    ['./icons/a.png', 'native'],
    ['#icon', 'native'],
    ['/icons/a.png', 'normalizable'],
    ['../icons/a.png', 'normalizable'],
    ['https://example.test/a.png', 'runtime-bound'],
    ['//example.test/a.png', 'runtime-bound'],
    ['data:image/png;base64,AA==', 'runtime-bound'],
    ['custom+asset://icons/a.png', 'runtime-bound'],
  ] as const)('classifies %s as %s through both grammars', (url, category) => {
    const html = parseHtmlAuthoring(`<img src="${url}" alt="icon">`, 'url.ui.html');
    const css = parseCssAuthoring(`.icon { background: url("${url}"); }`, 'url.ui.css');
    expect(html.category).toBe(category);
    expect(css.category).toBe(category);
    for (const parsed of [html, css]) {
      const urlError = parsed.diagnostics.find((entry) => entry.code.endsWith('-url'));
      if (category === 'native') expect(urlError).toBeUndefined();
      else {
        expect(urlError?.actual).toBe(url);
        expect(urlError?.sourcePath).toBe(parsed.sourcePath);
        expect(urlError?.sourceRange?.end).toBeGreaterThan(urlError?.sourceRange?.start ?? 0);
      }
    }
  });

  it('retains the stronger category whichever grammar reports it', () => {
    for (const [htmlUrl, cssUrl] of [
      ['../local.png', 'https://example.test/a.png'],
      ['https://example.test/a.png', '../local.png'],
    ]) {
      expect(
        classifyUiAuthoring({
          sourcePath: 'mixed.ui.html',
          html: `<img src="${htmlUrl}" alt="icon">`,
          css: `.icon { background: url("${cssUrl}"); }`,
        }),
      ).toMatchObject({ category: 'runtime-bound', blocking: true });
    }
  });
});
