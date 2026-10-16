// brand-lint-lib.mjs — shared cross-platform grep core for the two brand-lint
// gates (lint-brand-cast / lint-brand-runtime).
//
// Replaces the prior `grep -rEn` shells: pure Node fs walk + RegExp so the gate
// runs identically on Linux CI and a Windows dev box (no system grep needed).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Recursively collect files under `roots` whose extension is in `exts`,
 * skipping any path segment in `excludeDirs` plus a caller-supplied predicate.
 *
 * @param {object} o
 * @param {string} o.repoRoot       absolute repo root (paths reported relative to it)
 * @param {string[]} o.roots        dirs to scan, relative to repoRoot (e.g. ['packages','apps'])
 * @param {string[]} o.exts         file extensions incl. dot (e.g. ['.ts','.tsx'])
 * @param {string[]} [o.excludeDirs] dir names pruned anywhere in the tree
 * @param {(relPath: string) => boolean} [o.excludePath] extra per-file filter (true = skip); relPath uses '/'
 * @returns {string[]} repo-relative file paths (POSIX '/' separators)
 */
function collectFiles({ repoRoot, roots, exts, excludeDirs = [], excludePath }) {
  const out = [];
  const skipDir = new Set(excludeDirs);
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // missing root — nothing to scan
    }
    for (const e of entries) {
      const childAbs = join(abs, e.name);
      if (e.isDirectory()) {
        if (skipDir.has(e.name)) continue;
        walk(childAbs);
      } else if (e.isFile()) {
        if (!exts.some((x) => e.name.endsWith(x))) continue;
        const rel = relative(repoRoot, childAbs).split(sep).join('/');
        if (excludePath?.(rel)) continue;
        out.push(rel);
      }
    }
  };
  for (const r of roots) walk(join(repoRoot, r));
  return out;
}

/**
 * Run a line-level regex gate over source files. Prints offending `file:line: text`
 * lines and returns them; empty array means clean.
 *
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {RegExp} o.pattern        applied per line (include the `g`-less form; we test per line)
 * @param {string[]} o.roots
 * @param {string[]} o.exts
 * @param {string[]} [o.excludeDirs]
 * @param {(relPath: string) => boolean} [o.excludePath]
 * @param {string} [o.skipMarker]   lines containing this substring are exempt (inline opt-out)
 * @returns {string[]} hit lines formatted as `relPath:lineNo:lineText`
 */
export function grepHits({ repoRoot, pattern, roots, exts, excludeDirs, excludePath, skipMarker }) {
  const files = collectFiles({ repoRoot, roots, exts, excludeDirs, excludePath });
  const hits = [];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Fresh lastIndex each line: pattern is used without global flag.
      if (!pattern.test(lines[i])) continue;
      // Inline opt-out: marker on the same line or the line above (mirrors the
      // `biome-ignore` preceding-comment idiom used across the engine).
      if (skipMarker && (lines[i].includes(skipMarker) || lines[i - 1]?.includes(skipMarker)))
        continue;
      hits.push(`${rel}:${i + 1}:${lines[i]}`);
    }
  }
  return hits;
}
