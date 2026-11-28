import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REFERENCE = fileURLToPath(new URL('../../reference', import.meta.url));
const DOC = readFileSync(join(REFERENCE, 'tool-library.md'), 'utf8');
const IMAGES = join(REFERENCE, 'images/tool-library');

const rows = [...DOC.matchAll(/^\| !\[(T-[\w-]+)\]\(([^)]+)\) \|/gm)].map((m) => ({
  id: m[1] as string,
  drawing: m[2] as string,
}));

describe('tool library reference', () => {
  it('lists every tool once with a drawing that exists', () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.drawing).toBe(`images/tool-library/${row.id}.svg`);
      expect(existsSync(join(REFERENCE, row.drawing))).toBe(true);
    }
  });

  it('keeps one drawing per tool and no orphan files', () => {
    const drawings = readdirSync(IMAGES)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -4));
    expect(drawings.sort()).toEqual(rows.map((r) => r.id).sort());
    const renders = readdirSync(join(IMAGES, 'render')).map((f) => f.replace(/\.png$/, ''));
    for (const id of renders) expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it('states the counts the table holds', () => {
    const count = (state: string) => [...DOC.matchAll(new RegExp(`\\| ${state} \\|`, 'g'))].length;
    const header =
      /\*\*(\d+) tools\*\*: (\d+) done, (\d+) deferred to v2\.x, (\d+) in phase 2/.exec(DOC);
    if (header === null) throw new Error('tool-library.md lost its count line');
    expect(Number(header[1])).toBe(rows.length);
    expect(Number(header[2])).toBe(count('Done'));
    expect(Number(header[3])).toBe(count('Not done: deferred to v2.x'));
    expect(Number(header[4])).toBe(count('Not done: phase 2'));
  });

  it('links every render that ships', () => {
    for (const f of readdirSync(join(IMAGES, 'render'))) {
      expect(DOC).toContain(`images/tool-library/render/${f}`);
    }
  });
});
