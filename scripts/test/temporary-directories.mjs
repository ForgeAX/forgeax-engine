import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function temporaryDirectories() {
  const paths = [];
  return {
    async make(prefix) {
      const directory = await mkdtemp(join(tmpdir(), prefix));
      paths.push(directory);
      return directory;
    },
    async clear() {
      await Promise.all(paths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
    },
  };
}
