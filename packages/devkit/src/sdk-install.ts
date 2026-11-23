import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { execFileCommand } from './child-process.js';
import { matchesArtifactBytes } from './dist.js';
import {
  directoryOccupancy,
  isFilesystemPathWithin,
  publishPreparedDirectory,
} from './filesystem-path.js';
import { commandError } from './project.js';
import type { SdkManifest } from './sdk.js';
import type { CommandResult } from './types.js';
import { completeCommand, failCommand } from './types.js';

export interface SdkInstallOptions {
  readonly root: string;
  readonly version?: string;
}

function carrierArtifactPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!isFilesystemPathWithin(root, absolute, false)) throw new Error('sdk-carrier-artifact-path');
  return absolute;
}

async function materializeEngineArtifacts(
  root: string,
  manifest: SdkManifest,
  download: string,
): Promise<void> {
  const reused = manifest.artifacts.filter((entry) => entry.enginePath !== undefined);
  if (reused.length === 0) return;
  const require = createRequire(resolve(download, 'node_modules/@forgeax/engine-sdk/package.json'));
  const engine = await realpath(dirname(require.resolve('@forgeax/engine/package.json')));
  const downloadRoot = await realpath(download);
  if (!isFilesystemPathWithin(downloadRoot, engine, false))
    throw new Error('sdk-carrier-engine-path');
  const identity = JSON.parse(await readFile(resolve(engine, 'package.json'), 'utf8'));
  if (identity.name !== '@forgeax/engine' || identity.version !== manifest.sdkVersion)
    throw new Error('sdk-carrier-engine-version-mismatch');
  for (const entry of reused) {
    const source = carrierArtifactPath(engine, entry.enginePath ?? '');
    const target = carrierArtifactPath(root, entry.path);
    assertCarrierArtifact(await readFile(source), entry);
    await mkdir(dirname(target), { recursive: true });
    // Source builds own writable outputs. Never link them to the installed Engine.
    await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  }
}

async function restoreNpmGitIgnores(root: string, manifest: SdkManifest): Promise<void> {
  const paths = new Set(manifest.artifacts.map((entry) => entry.path));
  for (const entry of manifest.artifacts) {
    if (basename(entry.path) !== '.gitignore') continue;
    const target = carrierArtifactPath(root, entry.path);
    try {
      await readFile(target);
      continue;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    // npm's extractor renames .gitignore. Restore only the exact bytes the
    // SDK promised, without consuming a separately authored .npmignore.
    const renamed = entry.path.replace(/\.gitignore$/, '.npmignore');
    if (paths.has(renamed)) throw new Error(`sdk-carrier-ignore-collision: ${entry.path}`);
    assertCarrierArtifact(await readFile(resolve(root, renamed)), entry);
    await rename(resolve(root, renamed), target);
  }
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('sdk-installer-version-missing');
  }
  return manifest.version;
}

export async function sdkInstallCommand(
  options: SdkInstallOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root);
  const occupancy = await directoryOccupancy(root).catch((cause) =>
    commandError(cause, 'sdk-install-failed'),
  );
  if (typeof occupancy !== 'string') return { ok: false, error: occupancy };
  if (occupancy === 'occupied') {
    return failCommand(
      'sdk-target-not-empty',
      'the SDK install target to be absent or empty',
      'Choose an empty versioned SDK directory so existing files cannot be overwritten.',
      { root },
    );
  }

  const version = options.version ?? (await packageVersion());
  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  let download: string | undefined;
  try {
    download = await mkdtemp(resolve(parent, `.${basename(root)}.forgeax-sdk-download-`));
    await execFileCommand(
      process.env.FORGEAX_NPM_CLIENT ?? 'npm',
      [
        'install',
        '--prefix',
        download,
        '--ignore-scripts',
        '--no-package-lock',
        '--no-save',
        '--fund=false',
        '--audit=false',
        `@forgeax/engine-sdk@${version}`,
      ],
      { env: { ...process.env, CI: 'true' }, maxBuffer: 16 * 1024 * 1024 },
    );
    const carrier = resolve(download, 'node_modules', '@forgeax', 'engine-sdk', 'sdk');
    const manifest = JSON.parse(
      await readFile(resolve(carrier, 'sdk-manifest.json'), 'utf8'),
    ) as SdkManifest;
    if (manifest.sdkVersion !== version) throw new Error('sdk-carrier-version-mismatch');
    if (manifest.source?.root !== 'source/engine') throw new Error('sdk-carrier-source-missing');
    await materializeEngineArtifacts(carrier, manifest, download);
    await Promise.all(
      ['.forgeax-public-distribution', 'package.json', 'pnpm-lock.yaml', 'scripts/build.mjs'].map(
        (path) => readFile(resolve(carrier, 'source/engine', path)),
      ),
    );
    await restoreNpmGitIgnores(carrier, manifest);
    // A physical carrier already lives on the destination filesystem. A
    // custom installer can expose it through a link, which must stay private.
    let prepared = carrier;
    if (!(await lstat(carrier)).isDirectory()) {
      prepared = await mkdtemp(resolve(download, 'prepared-'));
      for (const name of await readdir(carrier))
        await rename(resolve(carrier, name), resolve(prepared, name));
    }
    if (occupancy === 'absent') await chmod(prepared, (await stat(download)).mode & 0o777);
    return await publishPreparedDirectory(prepared, root, occupancy, async () =>
      completeCommand({
        root,
        sdkVersion: version,
        source: '@forgeax/engine-sdk',
        next: { cwd: root, argv: ['node', './bin/forgeax.mjs', 'project', 'init'] },
      }),
    );
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'sdk-install-failed') };
  } finally {
    if (download !== undefined) await rm(download, { recursive: true, force: true });
  }
}

function assertCarrierArtifact(bytes: Buffer, entry: SdkManifest['artifacts'][number]): void {
  if (matchesArtifactBytes(bytes, entry)) return;
  throw new Error(`sdk-carrier-artifact-mismatch: ${entry.path}`);
}
