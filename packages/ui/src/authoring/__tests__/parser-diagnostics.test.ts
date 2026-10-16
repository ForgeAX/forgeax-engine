import { describe, expect, it } from 'vitest';
import { parseCssAuthoring } from '../css.js';
import { serializeDiagnostics } from '../diagnostics.js';
import { parseHtmlAuthoring } from '../html.js';
import { validateUiAuthoring } from '../index.js';

describe('authoring parser diagnostics', () => {
  it('recovers malformed HTML with a non-empty source range', () => {
    const result = parseHtmlAuthoring('<section><span>broken</section>', 'hud.ui.html');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.sourceRange.end).toBeGreaterThan(diagnostic.sourceRange.start);
      expect(diagnostic.sourcePath).toBe('hud.ui.html');
      expect(diagnostic.rule.length).toBeGreaterThan(0);
      expect(diagnostic.hint.length).toBeGreaterThan(0);
    }
  });

  it('recovers malformed CSS tokens and reports the grammar rule', () => {
    const result = parseCssAuthoring(
      '.card { color: ; background: url("icons/card.png"; }',
      'hud.ui.css',
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.sourceRange.end).toBeGreaterThan(
      result.diagnostics[0]?.sourceRange.start ?? 0,
    );
    expect(result.diagnostics[0]?.rule).toContain('css');
  });

  it('links missing companion attempts to the referencing source location', async () => {
    const result = await validateUiAuthoring({
      sourcePath: 'hud.ui.html',
      html: '<img src="icons/missing.png" alt="Missing" />',
      css: '.hud { color: red; }',
      readCompanion: async (path) => ({ ok: false as const, path, reason: 'not found' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('diagnostics' in result.error.detail).toBe(true);
    if (!('diagnostics' in result.error.detail)) return;
    const diagnostic = result.error.detail.diagnostics.find(
      (entry) => entry.code === 'companion-missing',
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.sourcePath).toBe('hud.ui.html');
    expect(diagnostic?.relatedLocations?.[0]?.sourcePath).toBe('icons/missing.png');
    expect(diagnostic?.relatedLocations?.[0]?.sourceRange.end).toBeGreaterThan(
      diagnostic?.relatedLocations?.[0]?.sourceRange.start ?? 0,
    );
  });

  it('serializes diagnostics in stable JSON order without message parsing', async () => {
    const result = await validateUiAuthoring({
      sourcePath: 'bad.ui.html',
      html: '<script>bad</script>',
      css: '@import "x.css";',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('diagnostics' in result.error.detail).toBe(true);
    if (!('diagnostics' in result.error.detail)) return;
    const first = serializeDiagnostics(result.error.detail.diagnostics);
    const second = serializeDiagnostics(JSON.parse(first));
    expect(second).toBe(first);
    expect(first).toContain('sourceRange');
    expect(first).toContain('hint');
    expect(first).not.toContain('message');
  });

  it('keeps HTML and CSS parser results source-addressable', () => {
    const html = parseHtmlAuthoring('<div data-ui-part="root">ok</div>', 'hud.ui.html');
    const css = parseCssAuthoring('.root { color: red; }', 'hud.ui.css');
    expect(html.sourcePath).toBe('hud.ui.html');
    expect(css.sourcePath).toBe('hud.ui.css');
    expect(html.diagnostics).toEqual([]);
    expect(css.diagnostics).toEqual([]);
  });
});
