import { describe, expect, it } from 'vitest';
import { extractViteLocalUrl } from '../vite-local-url.mjs';

describe('extractViteLocalUrl', () => {
  it('parses Vite local URLs when the banner contains ANSI color codes', () => {
    const output = '\u001b[32mLocal:\u001b[39m   \u001b[36mhttp://localhost:5195/\u001b[39m';

    expect(extractViteLocalUrl(output)).toBe('http://localhost:5195/');
  });

  it('parses a URL from a plain Vite banner', () => {
    expect(extractViteLocalUrl('Local:   http://localhost:5195/\n')).toBe(
      'http://localhost:5195/',
    );
  });
});
