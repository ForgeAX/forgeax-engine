import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'test-output']);
const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

/**
 * Source inventory shared by the legacy literal gates. Keep their established
 * comment heuristic and best-effort filesystem reads; this is not a JS parser.
 */
export function* grepSourceFiles(roots, { exempt, skipDirs = new Set() }) {
  function* walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || skipDirs.has(name)) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        yield* walk(path);
        continue;
      }
      if (!CODE_EXTS.has(path.slice(path.lastIndexOf('.'))) || exempt.has(path)) continue;
      let source;
      try {
        source = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
      yield { path, code };
    }
  }
  for (const root of roots) yield* walk(root);
}
