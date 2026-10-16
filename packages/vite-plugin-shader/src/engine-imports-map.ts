// engine-imports-map.ts — buildStart scan *.wgsl for #define_import_path header
// (feat-20260523-shader-template-instance-split M3-T01).
//
// Decision anchors:
//   - plan-strategy D-ImportsMap: buildStart scans engineShaderRoots for all
//     *.wgsl files, reads their `#define_import_path <path>` header line, and
//     builds a { pathIdentifier -> fullFileContents } map.
//   - Cache once per build process (no re-scan on each transform hook call).
//   - Scan is glob-free: uses sync readdir + filter by .wgsl suffix.
//   - Research F11: this closes R-02 (cross-directory #import resolution).

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Regex matching the first `#define_import_path <path>` header line. */
const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m;

/**
 * Scan one or more engine shader root directories for all `*.wgsl` files,
 * extract each file's `#define_import_path <path>` header, and return a
 * `{ canonicalPath -> fileContents }` map suitable for direct injection into
 * `compileShader.options.imports`.
 *
 * Files without a `#define_import_path` header are silently skipped (they are
 * not resolvable as naga_oil import targets and should not appear in the map).
 *
 * The result is cached by a composite key of all root paths. Repeated calls
 * with the same roots return the cached map (same reference).
 */
export function loadEngineImportsMap(roots: readonly string[]): Record<string, string> {
  const cacheKey = roots.join('\0');
  const cached = _cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const map: Record<string, string> = {};
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // Root directory does not exist (e.g. unit-test non-existent path) — skip.
      continue;
    }
    for (const entry of entries) {
      const filePath = join(root, entry);
      let nestedEntries: string[] | undefined;
      try {
        nestedEntries = readdirSync(filePath);
      } catch {
        nestedEntries = undefined;
      }
      if (nestedEntries !== undefined) {
        Object.assign(map, loadEngineImportsMap([filePath]));
        continue;
      }
      if (extname(entry) !== '.wgsl') continue;
      const source = readFileSync(filePath, 'utf8');
      const match = DEFINE_IMPORT_PATH_RE.exec(source);
      if (match?.[1] !== undefined) map[match[1]] = source;
    }
  }
  _cache.set(cacheKey, map);
  return map;
}

/** Internal cache keyed by composite root path key. */
const _cache = new Map<string, Record<string, string>>();
