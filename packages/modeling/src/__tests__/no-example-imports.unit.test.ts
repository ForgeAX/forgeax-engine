import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TESTS = fileURLToPath(new URL('.', import.meta.url));
// Assembled so this file does not match its own pattern.
const EXAMPLES = ['examples', '/'].join('');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

describe('kernel tests own their inputs', () => {
  it('nothing under src/__tests__ imports or names an example path', () => {
    const text = files(TESTS).filter((f) => /\.(ts|mts|mjs|js|json)$/.test(f));
    expect(text.length).toBeGreaterThan(0);
    const offenders = text
      .filter((f) => readFileSync(f, 'utf8').includes(EXAMPLES))
      .map((f) => relative(TESTS, f));
    expect(offenders).toEqual([]);
  });
});
