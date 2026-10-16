import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCssAuthoring } from '../css.js';
import { parseHtmlAuthoring } from '../html.js';

describe('portable implementation support', () => {
  it.each([
    ['made-up-property: 1', 'unknown-css-property'],
    ['scroll-timeline: --progress block', 'unsupported-css-property'],
    ['display: potato', 'css-invalid-value'],
    ['width: red', 'css-invalid-value'],
    ['grid-template-columns: subgrid', 'unsupported-css-value'],
    ['transform: rotateY(40deg)', 'unsupported-css-value'],
    ['mask-mode: luminance', 'unsupported-css-value'],
    ['clip-path: inset(0 round 4px)', 'unsupported-css-value'],
    ['backdrop-filter: blur(4px)', 'unsupported-css-property'],
    ['filter: blur(4px) contrast(2)', 'unsupported-css-value'],
    ['filter: drop-shadow(1px 1px currentColor)', 'unsupported-css-value'],
    ['position: sticky', 'unsupported-css-value'],
    ['outline: 1px dashed red', 'unsupported-css-value'],
    ['color: red !banana', 'css-invalid-priority'],
    ['width: var(width)', 'css-invalid-value'],
  ])('rejects %s with an exact declaration location', (declaration, code) => {
    const source = `/* @import is only a comment */\n.card { ${declaration}; }`;
    const result = parseCssAuthoring(source, 'card.ui.css');
    const diagnostic = result.diagnostics.find((entry) => entry.code === code);
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.sourcePath).toBe('card.ui.css');
    expect(diagnostic?.sourceRange.line).toBe(2);
    expect(diagnostic?.hint).toBeTruthy();
    expect(result.diagnostics.some((entry) => entry.code === 'runtime-css-rule')).toBe(false);
  });

  it('does not interpret CSS strings as declarations, URLs, selectors or rules', () => {
    expect(
      parseCssAuthoring(
        '.card::before { content: "@import css-123 html { width: ; }"; }',
        'card.css',
      ).diagnostics,
    ).toEqual([]);
  });

  it.each(['focus-within'])('rejects unimplemented :%s before native styling', (pseudo) => {
    const source = `button:${pseudo} { outline: 2px solid blue; }`;
    for (const portableOnly of [false, true]) {
      const diagnostic = parseCssAuthoring(source, 'focus.ui.css', {
        portableOnly,
      }).diagnostics.find((entry) => entry.code === 'unsupported-css-selector');
      expect(diagnostic).toMatchObject({ severity: 'error', sourcePath: 'focus.ui.css' });
      expect(source.slice(diagnostic?.sourceRange.start, diagnostic?.sourceRange.end)).toBe(
        `:${pseudo}`,
      );
      expect(diagnostic?.hint).toBeTruthy();
    }
    expect(
      parseCssAuthoring('button:focus { outline: 2px solid blue; }', 'focus.ui.css').diagnostics,
    ).toEqual([]);
  });

  it('retains native planar transforms, fixed-color filters and generated text', () => {
    const css =
      '.card { transform:translate3d(2px, 3px, 0) scale3d(2, 2, 1); translate:1px 2px 0; rotate:z 20deg; filter:drop-shadow(1px 1px red); }';
    expect(parseCssAuthoring(css, 'card.css').diagnostics).toEqual([]);
  });

  it('retains complete guide source and numeric control markup', () => {
    const source = readFileSync(
      new NodeURL('../../../../../templates/game-3d/assets/guide.ui.css', import.meta.url),
      'utf8',
    );
    expect(parseCssAuthoring(source, 'guide.ui.css').diagnostics).toEqual([]);
    const html = readFileSync(
      new NodeURL('../../../../../templates/game-3d/assets/guide.ui.html', import.meta.url),
      'utf8',
    );
    expect(parseHtmlAuthoring(html, 'guide.ui.html').diagnostics).toEqual([]);
    expect(
      parseHtmlAuthoring(
        '<label>Size<input type="number" min="1" max="10" step="0.5"></label><details><summary>More</summary><br>Text</details>',
        'guide.ui.html',
      ).diagnostics,
    ).toEqual([]);
  });

  it('accepts the complete shared startup document', async () => {
    const { hostStartupDocument } = await import(
      fileURLToPath(new NodeURL('../../../../devkit/src/host/startup-source.ts', import.meta.url))
    );
    expect(
      parseHtmlAuthoring(hostStartupDocument('Portable game'), 'startup.html', {
        portableOnly: true,
        context: 'document',
      }).diagnostics,
    ).toEqual([]);
  });

  it('uses HTML parser recovery without rejecting optional end tags or comment text', () => {
    expect(
      parseHtmlAuthoring('<!-- <div> --><ul><li>One<li>Two</ul>', 'menu.html').diagnostics,
    ).toEqual([]);
  });

  it('checks media capabilities without rejecting viewport range syntax', () => {
    expect(
      parseCssAuthoring('@media (400px < width < 800px) {a {color:red}}', 'media.css').diagnostics,
    ).toEqual([]);
    expect(
      parseCssAuthoring('@media (prefers-contrast:more) {a {color:red}}', 'media.css')
        .diagnostics[0]?.code,
    ).toBe('unsupported-css-media-feature');
  });

  it('reports ignored closing tags and parses valid table fragment contexts', () => {
    expect(parseHtmlAuthoring('<div></div></div>', 'bad.html').diagnostics[0]?.code).toBe(
      'html-ignored-tag',
    );
    expect(
      parseHtmlAuthoring('<tr><td>Cell</td></tr>', 'table.html', {
        portableOnly: true,
        contextElement: 'tbody',
      }).diagnostics,
    ).toEqual([]);
    expect(parseCssAuthoring('@media (width:10px);', 'bad.css').diagnostics[0]?.code).toBe(
      'css-syntax-error',
    );
  });

  it('rejects unsupported native controls at their type attribute', () => {
    const source = '<input type="file" aria-label="File">';
    const diagnostic = parseHtmlAuthoring(source, 'form.html').diagnostics.find(
      (entry) => entry.code === 'unsupported-input-type',
    );
    expect(diagnostic).toBeDefined();
    expect(source.slice(diagnostic?.sourceRange.start, diagnostic?.sourceRange.end)).toBe(
      'type="file"',
    );
  });

  it.each(['multiple', 'size="2"'])('rejects unimplemented select listbox mode %s', (attribute) => {
    const source = `<select ${attribute}><option>One</option></select>`;
    const diagnostic = parseHtmlAuthoring(source, 'form.html', {
      portableOnly: true,
    }).diagnostics.find((entry) => entry.code === 'unsupported-select-mode');
    expect(diagnostic).toBeDefined();
    expect(source.slice(diagnostic?.sourceRange.start, diagnostic?.sourceRange.end)).toBe(
      attribute,
    );
  });
});
