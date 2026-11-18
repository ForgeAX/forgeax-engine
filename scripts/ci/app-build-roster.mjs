import { relative, resolve } from 'node:path';
import { appPackages } from '../build-task-cache.mjs';

// All app builds belong to the existing producers. Native consumers restore
// their shader and Pack closure instead of rebuilding after the smoke roster.
export function appShardRoster(root) {
  return appPackages(root)
    .map((app) => relative(resolve(root, 'apps'), app.directory).replaceAll('\\', '/'))
    .sort();
}
