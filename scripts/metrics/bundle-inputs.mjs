import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appPackages } from '../build-task-cache.mjs';

/** App shards transfer shader/Pack closures; metric consumers need the actual bundles. */
export function declaredBundleApps(root) {
  return appPackages(root).filter(
    (app) => app.manifest.forgeax?.metrics?.['bundle-size']?.enabled === true,
  );
}

export function prepareBundleInputs({ root, manifestPath, run = spawnSync }) {
  if (!manifestPath)
    throw new Error('bundle preparation requires the selected shared input manifest');
  const selected = resolve(root, manifestPath);
  const manifest = JSON.parse(readFileSync(selected, 'utf8'));
  const payload = manifest.payload?.engineShaderManifest;
  if (
    typeof payload !== 'string' ||
    !manifest.inventory?.includes(payload) ||
    !existsSync(resolve(root, payload))
  )
    throw new Error('bundle preparation requires the declared shared shader payload');
  const apps = declaredBundleApps(root);
  if (apps.length === 0) return;
  const result = run(
    process.execPath,
    [
      resolve(root, 'scripts/build-apps.mjs'),
      '--shared-input-manifest',
      selected,
      ...apps.map((app) => app.relativeDirectory.replaceAll('\\', '/').replace(/^apps\//, '')),
    ],
    { cwd: root, env: process.env, stdio: 'inherit', shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `bundle input producer failed: exit ${result.status}, signal ${result.signal ?? 'none'}`,
    );
  for (const app of apps) {
    const path = resolve(app.directory, app.manifest.forgeax.metrics['bundle-size'].path);
    if (!existsSync(path)) throw new Error(`bundle input producer did not publish ${path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  prepareBundleInputs({
    root: process.cwd(),
    manifestPath: process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST,
  });
