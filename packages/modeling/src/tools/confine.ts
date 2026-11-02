import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function within(root: string, target: string): boolean {
  const inside = relative(root, target);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

function realWithTail(path: string): string {
  const tail: string[] = [];
  let probe = path;
  for (;;) {
    try {
      return join(realpathSync(probe), ...tail.reverse());
    } catch (cause) {
      const parent = dirname(probe);
      if (parent === probe || (cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      tail.push(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolve `path` against `projectRoot` and return its absolute form only when the
 * lexical path and its symlink-resolved location (through the deepest existing
 * ancestor) both stay inside the root.
 */
export function confineToRoot(projectRoot: string, path: string): string | undefined {
  const absolute = resolve(projectRoot, path);
  if (!within(projectRoot, absolute)) return undefined;
  try {
    return within(realpathSync(projectRoot), realWithTail(absolute)) ? absolute : undefined;
  } catch {
    return undefined;
  }
}
