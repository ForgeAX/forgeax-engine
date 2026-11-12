import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Enumerate the stance gate's source scope without changing symlink admission. */
export function* walkSourceFiles(rootDir, exts, excludedFile) {
  if (!existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of entries) {
      const { name } = dirent;
      if (name === 'dist' || name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      let entry = dirent;
      if (dirent.isSymbolicLink()) {
        try {
          entry = statSync(full);
        } catch {
          continue;
        }
      }
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.isFile() &&
        full !== excludedFile &&
        exts.some((ext) => full.endsWith(ext))
      ) {
        yield full;
      }
    }
  }
}
