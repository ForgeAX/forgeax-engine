import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package documents and ships itself: every reference in its text points inside the
 * package. This scan fails on a link or path that leaves it and on a named outside
 * product. Format names the tools read and write stay legal.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.scratch', 'golden']);
const TEXT = new Set(['.md', '.ts', '.mts', '.mjs', '.json']);
const SELF = 'src/__tests__/self-contained.unit.test.ts';
/** Process and research notes that legitimately cite literature and dated design files; not shipped (absent from package.json files). */
const EXEMPT_PREFIXES = ['knowledge/notes/'];

const FORBIDDEN: readonly [string, RegExp][] = [
  ['outside workspace path', /modeling-studio|modeling studio/i],
  ['outside workspace wording', /\bstudio (case|directory|evidence|finding)\b/i],
  [
    'outside product',
    /\b(houdini|blender|maya|unreal|substance|zbrush|renderdoc|occt|three\.js|rhino|catia|solidworks|marmoset|xnormal|mixamo|clipper|pmp|openvdb)\b/i,
  ],
  ['outside product (case-sensitive)', /\b(UE|Alias|Unity)\b/],
  [
    'research or case id',
    /\b(?:D-\d{2}|W-F\d+[a-z]?|R\d[b]? (?:K\d+|section))\b|\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md/,
  ],
  ['web link', /https?:\/\//i],
];
/** Lines that carry a URL as functional data: the SVG namespace, the link validator and its fixture. */
const FUNCTIONAL_URL =
  /xmlns="http:\/\/www\.w3\.org\/2000\/svg"|\^https\?:\\\/\\\/|sources\[\$\{i\}\]\.url is an http|https:\/\/example\.com\/spec|LICENSE-2\.0/;

function functionalUrl(file: string, line: string): boolean {
  if (FUNCTIONAL_URL.test(line)) return true;
  return (
    ['scripts/ci/reuse-owner.mjs', 'scripts/ci/__tests__/reuse-owner.test.mjs'].includes(file) &&
    /^\s*sourceUrl:\s*`https:\/\/github\.com\/\$\{repository\}\/actions\/runs\/(?:\$\{run\.id\}|\d+)\/job\/(?:\$\{job\.id\}|\d+)`,?\s*$/.test(
      line,
    )
  );
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (TEXT.has(extname(entry.name)) && entry.name !== 'LICENSE') {
      out.push(join(dir, entry.name));
    }
  }
}

describe('self-contained package text', () => {
  it('admits qualified CI receipt data while retaining the documentation URL boundary', () => {
    const receipt =
      'sourceUrl: `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`,';
    const fixture = 'sourceUrl: `https://github.com/${repository}/actions/runs/1/job/2`,';
    expect(functionalUrl('scripts/ci/reuse-owner.mjs', receipt)).toBe(true);
    expect(functionalUrl('scripts/ci/__tests__/reuse-owner.test.mjs', fixture)).toBe(true);
    expect(functionalUrl('README.md', receipt)).toBe(false);
    expect(functionalUrl('src/model.ts', receipt)).toBe(false);
    expect(functionalUrl('scripts/ci/reuse-owner.mjs', 'See https://github.com/owner/repo')).toBe(
      false,
    );
    expect(
      functionalUrl('scripts/ci/reuse-owner.mjs', receipt.replace('actions/runs', 'issues')),
    ).toBe(false);
  });

  it('has no reference that leaves the package', () => {
    const files: string[] = [];
    walk(ROOT, files);
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (rel === SELF) continue;
      if (EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const [why, pattern] of FORBIDDEN) {
            if (!pattern.test(line)) continue;
            if (why === 'web link' && functionalUrl(rel, line)) continue;
            hits.push(`${rel}:${i + 1} ${why}: ${line.trim().slice(0, 100)}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});
