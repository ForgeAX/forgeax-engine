import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function isExpandedSourceRepository(root) {
  return ['.forgeax-public-distribution', '.forgeax-standalone-repository'].some((marker) =>
    existsSync(resolve(root, marker)),
  );
}

export function hasExpandedSource(root, path, entry) {
  if (!isExpandedSourceRepository(root)) return false;
  if (!existsSync(resolve(root, path, entry)))
    throw new Error(`expanded-source-missing: ${path}/${entry}`);
  return true;
}
