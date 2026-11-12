import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The README is a map into the reference and example directories; a moved section or
 * renamed example must not leave a dangling link or `#anchor` behind.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOCS = [
  'README.md',
  ...readdirSync(join(ROOT, 'reference')).map((f) => `reference/${f}`),
  ...readdirSync(join(ROOT, 'examples'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('examples', f)),
].filter((f) => f.endsWith('.md'));

function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-');
}

function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const m = !fenced && /^#{1,6} (.+)$/.exec(line);
    if (!m) continue;
    const base = slug(m[1] as string);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

function brokenLinks(doc: string): string[] {
  const file = join(ROOT, doc);
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  const broken: string[] = [];
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!target || /^[a-z]+:/.test(target)) continue;
    const [path, hash] = target.split('#') as [string, string | undefined];
    const resolved = path === '' ? file : join(dirname(file), path);
    if (!resolved.startsWith(ROOT) || !existsSync(resolved)) {
      broken.push(target);
      continue;
    }
    if (hash !== undefined && (statSync(resolved).isDirectory() || !anchors(resolved).has(hash)))
      broken.push(target);
  }
  return broken.map((t) => `${relative(ROOT, file)} -> ${t}`);
}

describe('documentation links', () => {
  it.each(DOCS)('%s links resolve', (doc) => {
    expect(brokenLinks(doc)).toEqual([]);
  });
});
