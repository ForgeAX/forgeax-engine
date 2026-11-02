import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Final-target criterion 1 (tool-chain purity): every C-100 Pack builds its geometry from
 * kernel calls only. The source manifest of a Pack is its runtime import closure (type-only
 * imports are erased); it may hold only TypeScript and JSON files under `examples/` and
 * Engine packages, and no file in it reads the filesystem or the network. The stage
 * directory holds no binary asset.
 */
const STAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = resolve(STAGE, '..');
const SPECIFIER = /(?:^|\s)(?:import|export)\s(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const AMBIENT_IO = /\bnode:|\breadFile|\bfetch\s*\(|\bXMLHttpRequest\b|https?:\/\//;

function manifest(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (extname(file) === '.json') return;
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const spec = (match[1] ?? match[2]) as string;
      if (!spec.startsWith('.')) {
        packages.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec);
      visit(extname(target) === '' ? `${target}.ts` : target);
    }
  };
  visit(entry);
  return { files: [...files].sort(), packages: [...packages].sort() };
}

describe('C-100 tool-chain purity (criterion 1)', () => {
  const packs = readdirSync(STAGE).filter((f) => f.endsWith('.pack.ts'));

  it('finds the stage Packs', () => {
    expect(packs.length).toBeGreaterThanOrEqual(8);
  });

  for (const pack of packs) {
    it(`${pack}: the source manifest is kernel code and data only`, () => {
      const { files, packages } = manifest(join(STAGE, pack));
      for (const p of packages) expect([pack, p, p.startsWith('@forgeax/engine-')]).toEqual([pack, p, true]);
      for (const f of files) {
        const name = relative(EXAMPLES, f);
        expect([name, !name.startsWith('..') && ['.ts', '.json'].includes(extname(f))]).toEqual([name, true]);
        if (extname(f) === '.ts') expect([name, AMBIENT_IO.test(readFileSync(f, 'utf8'))]).toEqual([name, false]);
      }
    });
  }

  it('the stage directory holds no model, image or DCC file', () => {
    const allowed = new Set(['.ts', '.json', '.md', '.mjs']);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    expect(walk(STAGE).map((f) => relative(STAGE, f)).filter((f) => !allowed.has(extname(f)))).toEqual([]);
  });
});
