import { describe, expect, it } from 'vitest';
import { parseCssAuthoring } from '../index.js';

describe('ui css author source validation', () => {
  it('accepts local rules and rewrites private URLs', () => {
    const result = parseCssAuthoring(
      '.panel { color: red; background: url("icons/panel.png"); }',
      'fixture.ui.css',
    );
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(result.source).toContain('icons/panel.png');
    expect(result.references).toEqual([expect.objectContaining({ value: 'icons/panel.png' })]);
  });
  it('accepts a local companion URL', () => {
    const result = parseCssAuthoring(
      '.panel { background: url("icons/panel.png"); }',
      'fixture.ui.css',
    );
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
  it.each([
    '@import "https://example.com/a.css";',
    'background: url("../outside.png");',
    'src: url("https://x.test/font.woff2");',
  ])('rejects unsafe CSS %s with a range', (source) => {
    const result = parseCssAuthoring(source, 'fixture.ui.css');
    const blocking = result.diagnostics.find((entry) => entry.severity === 'error');
    expect(blocking).toMatchObject({
      sourcePath: 'fixture.ui.css',
      sourceRange: expect.any(Object),
    });
  });
});
