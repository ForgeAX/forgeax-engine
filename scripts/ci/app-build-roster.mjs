import { relative, resolve } from 'node:path';
import { appPackages } from '../build-task-cache.mjs';
import artifactContract from './build-artifact-contract.json' with { type: 'json' };

// All app builds belong to the existing producers. Native consumers restore
// their shader and Pack closure instead of rebuilding after the smoke roster.
export function appShardRoster(root) {
  return appPackages(root)
    .map((app) => relative(resolve(root, 'apps'), app.directory).replaceAll('\\', '/'))
    .sort();
}

// Core CI builds only transferable Smoke inputs. The standalone project,
// preview and metrics jobs already build their own bundles.
export function coreAppBuildsOutsideSmoke(roster) {
  const roots = artifactContract.consumers['smoke-fleet'].sourceAppRoots;
  return roster.filter(
    (app) =>
      !roots.some((prefix) => `apps/${app}` === prefix || `apps/${app}`.startsWith(`${prefix}/`)),
  );
}
