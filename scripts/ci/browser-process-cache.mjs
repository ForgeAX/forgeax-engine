import { join } from 'node:path';

export function browserProcessCacheDir(root, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Browser cache requires an owned process PID');
  return join(root, 'node_modules/.vite/browser-processes', String(pid));
}
