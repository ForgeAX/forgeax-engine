import { relative, resolve } from 'node:path';
import { bevySmokeApps } from '../bevy-demo.mjs';
import { appPackages } from '../build-task-cache.mjs';

// Bevy's required fleet already builds its complete implemented roster before
// running Dawn. App shards own every other build, including partial Bevy demos.
// Both the producer and aggregate derive this partition from the same source.
export function appShardRoster(root) {
  const bevy = new Set(bevySmokeApps(root).map((app) => resolve(app.dir)));
  return appPackages(root)
    .filter((app) => !bevy.has(resolve(app.directory)))
    .map((app) => relative(resolve(root, 'apps'), app.directory).replaceAll('\\', '/'))
    .sort();
}
