import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { execFileCommand } from '../child-process.js';
import { findSdkContext } from '../sdk.js';
import type { ProjectFacts } from '../types.js';

export interface HostVersions {
  readonly game: string;
  readonly engine: string;
}

/** 0.0.0 is the source/template placeholder; dev archives already carry a commit. */
export function releaseLabel(version: unknown): string | undefined {
  if (typeof version !== 'string' || version === '' || version === '0.0.0') return undefined;
  return /^0\.0\.0-dev\.([a-f0-9]+)$/.exec(version)?.[1] ?? version;
}

async function commitLabel(root: string): Promise<string> {
  try {
    return (
      await execFileCommand('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], {
        timeout: 5000,
      })
    ).stdout.trim();
  } catch {
    return 'unversioned';
  }
}

/** Resolve at generation time: static/offline players never need Git or Node. */
export async function hostVersions(
  facts: Pick<ProjectFacts, 'root' | 'packageJson'>,
): Promise<HostVersions> {
  const manifestPath = createRequire(import.meta.url).resolve(
    '@forgeax/engine-devkit/package.json',
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  let engine = releaseLabel(manifest.version);
  if (engine === undefined) {
    const sourceRoot = resolve(dirname(manifestPath), '../..');
    // Never attribute an installed SDK to a consuming game's ancestor Git repository.
    if (existsSync(resolve(sourceRoot, '.git'))) engine = await commitLabel(sourceRoot);
    else {
      const sdk = await findSdkContext();
      engine =
        sdk === undefined
          ? 'unversioned'
          : (releaseLabel(sdk.manifest.sdkVersion) ?? sdk.manifest.engineCommit.slice(0, 12));
    }
  }
  return {
    game: releaseLabel(facts.packageJson.version) ?? (await commitLabel(facts.root)),
    engine,
  };
}
