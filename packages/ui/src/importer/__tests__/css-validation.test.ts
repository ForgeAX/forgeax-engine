import { describe, expect, it } from 'vitest';
import { validateCssSource } from '../css.js';

describe('ui css author source validation', () => {
  it('accepts local rules and rewrites private URLs', () => {
    const result = validateCssSource('.panel { color: red; background: url("icons/panel.png"); }');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.css).toContain('icons/panel.png');
  });
  it('accepts a local companion URL', () => {
    const result = validateCssSource('.panel { background: url("icons/panel.png"); }');
    expect(result.ok).toBe(true);
  });
  it.each([
    '@import "https://example.com/a.css";',
    'background: url("../outside.png");',
    'src: url("https://x.test/font.woff2");',
  ])('rejects unsafe CSS %s with a range', (source) => {
    const result = validateCssSource(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.location).toBeDefined();
  });
});
