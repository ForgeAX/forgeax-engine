import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const MAX_ENTRY_LINES = 1500;
const repositoryRoot = resolve(import.meta.dirname, '../../../..');

function passesEntryCohesion(lineCount: number): boolean {
  return lineCount <= MAX_ENTRY_LINES;
}

describe('Pack plugin entry cohesion contract', () => {
  it('rejects an entry above the declared threshold and accepts the boundary', () => {
    expect(passesEntryCohesion(MAX_ENTRY_LINES + 1)).toBe(false);
    expect(passesEntryCohesion(MAX_ENTRY_LINES)).toBe(true);
  });

  it('keeps the public factory contract available at the extracted boundary', () => {
    const plugin = pluginPack({ roots: [] });
    expect(plugin.name).toBe('forgeax:pack');
    expect(typeof plugin.configureServer).toBe('function');
    expect(typeof plugin.generateBundle).toBe('function');
    expect(typeof plugin.closeBundle).toBe('function');
  });

  it('keeps the entry as a composition root without local owner implementations', () => {
    const source = readFileSync(
      resolve(repositoryRoot, 'packages/vite-plugin-pack/src/index.ts'),
      'utf8',
    );
    const lineCount = source.split('\n').length - 1;

    expect(lineCount).toBeLessThanOrEqual(MAX_ENTRY_LINES);
    expect(source).not.toContain("from './ddc-cache.js'");
    expect(source).not.toContain("from './package-finalizer.js'");
    expect(source).not.toContain("from './producer/");
    expect(source).not.toContain("from './material/");
  });
});
