import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { filesUnder, writePackageArchive } from './sdk-lib.mjs';

/** Compressed Engine tarball, exclusive of package-manager registry dependencies. */
export const ENGINE_AUTHORING_PACKAGE_LIMIT = 64_000_000;

export function checkEngineAuthoringPackageSize(bytes) {
  if (bytes > ENGINE_AUTHORING_PACKAGE_LIMIT)
    throw new Error(
      `engine-authoring-package-budget-exceeded: ${bytes} > ${ENGINE_AUTHORING_PACKAGE_LIMIT}`,
    );
}

const execute = promisify(execFile);

export async function packEngineAuthoring({
  engineArchive,
  authoringStage,
  destination,
  version,
  engineCommit,
  pnpmVersion,
  pnpmSnapshots,
  templates,
  skillIds,
}) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-engine-authoring-'));
  try {
    await execute('tar', ['-xzf', engineArchive, '-C', temporary]);
    const packageRoot = resolve(temporary, 'package');
    const authoring = resolve(packageRoot, 'authoring');
    await mkdir(authoring);
    for (const name of ['templates', 'skills', 'build-cache', 'tools/view', 'licenses'])
      await cp(resolve(authoringStage, name), resolve(authoring, name), { recursive: true });
    const manifestPath = resolve(packageRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const view = JSON.parse(await readFile(resolve(authoring, 'tools/view/package.json'), 'utf8'));
    if (
      manifest.name !== '@forgeax/engine' ||
      manifest.version !== version ||
      view.version !== version
    )
      throw new Error('engine-authoring-version-mismatch');
    // View is an authoring tool reached from its host Pack. Its ordinary
    // registry dependencies resolve through this installed package.
    for (const [name, requirement] of Object.entries(view.dependencies ?? {})) {
      if (name === manifest.name) continue;
      if (manifest.dependencies[name] !== undefined && manifest.dependencies[name] !== requirement)
        throw new Error(`engine-authoring-dependency-conflict: ${name}`);
      manifest.dependencies[name] = requirement;
    }
    // npm can lose the optional flag for a transitive package in a global
    // bundled install. Keep Vite's macOS watcher explicitly optional.
    const vite = `vite@${manifest.dependencies.vite}`;
    const watcherVersions = new Set(
      Object.entries(pnpmSnapshots)
        .filter(([name]) => name === vite || name.startsWith(`${vite}(`))
        .map(([, snapshot]) => snapshot.optionalDependencies?.fsevents),
    );
    if (watcherVersions.size !== 1 || watcherVersions.has(undefined))
      throw new Error('engine-authoring-watcher-lock-mismatch');
    manifest.optionalDependencies = {
      ...manifest.optionalDependencies,
      fsevents: [...watcherVersions][0],
    };
    manifest.engines = { ...manifest.engines, node: manifest.engines?.node ?? '>=22.13.0' };
    manifest.files = [...new Set([...(manifest.files ?? []), 'authoring'])];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const skills = await Promise.all(
      skillIds.map(async (id) => {
        const root = `skills/${id}`;
        const files = await filesUnder(resolve(authoring, root));
        const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
        return {
          id,
          root,
          fileCount: files.length,
          byteCount: sizes.reduce((sum, size) => sum + size, 0),
        };
      }),
    );
    const inventory = {
      sdkVersion: version,
      engineCommit,
      requirements: { node: manifest.engines.node, pnpm: pnpmVersion, pnpmStoreFormat: 'registry' },
      packages: [
        { role: 'runtime', name: manifest.name, root: '..', version, fileCount: 0, byteCount: 0 },
      ],
      templates,
      skills,
      artifacts: [],
    };
    await writeFile(
      resolve(authoring, 'engine-authoring.json'),
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    await writeFile(
      resolve(authoring, 'AGENTS.md'),
      '# ForgeAX Engine\n\nRun `forgeax project new <path> --template game-3d`. Each project pins its Engine version.\n',
    );
    await writePackageArchive(temporary, destination, { releaseVersion: version });
    const bytes = (await stat(destination)).size;
    checkEngineAuthoringPackageSize(bytes);
    return bytes;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
