import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { execFileCommand } from './child-process.js';
import { isFilesystemPathWithin } from './filesystem-path.js';
import { commandError } from './project.js';
import type { SdkManifest } from './sdk.js';
import type { CommandResult } from './types.js';

export interface SdkInstallOptions {
  readonly root: string;
  readonly version?: string;
}

async function materializeEngineArtifacts(
  root: string,
  manifest: SdkManifest,
  download: string,
): Promise<void> {
  const reused = manifest.artifacts.filter((entry) => entry.enginePath !== undefined);
  if (reused.length === 0) return;
  const require = createRequire(resolve(download, 'node_modules/@forgeax/engine-sdk/package.json'));
  const engine = dirname(require.resolve('@forgeax/engine/package.json'));
  if (!isFilesystemPathWithin(download, engine, false)) throw new Error('sdk-carrier-engine-path');
  const identity = JSON.parse(await readFile(resolve(engine, 'package.json'), 'utf8'));
  if (identity.name !== '@forgeax/engine' || identity.version !== manifest.sdkVersion)
    throw new Error('sdk-carrier-engine-version-mismatch');
  for (const entry of reused) {
    const source = resolve(engine, entry.enginePath ?? '');
    const target = resolve(root, entry.path);
    if (
      !isFilesystemPathWithin(engine, source, false) ||
      !isFilesystemPathWithin(root, target, false)
    )
      throw new Error('sdk-carrier-artifact-path');
    const bytes = await readFile(source);
    if (
      bytes.length !== entry.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new Error(`sdk-carrier-artifact-mismatch: ${entry.path}`);
    await mkdir(dirname(target), { recursive: true });
    // Source builds own writable outputs. Never link them to the installed Engine.
    await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  }
}

async function restoreNpmGitIgnores(root: string, manifest: SdkManifest): Promise<void> {
  const paths = new Set(manifest.artifacts.map((entry) => entry.path));
  for (const entry of manifest.artifacts) {
    if (basename(entry.path) !== '.gitignore') continue;
    const target = resolve(root, entry.path);
    if (!isFilesystemPathWithin(root, target, false)) throw new Error('sdk-carrier-artifact-path');
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
    const bytes = await readFile(resolve(root, renamed));
    if (
      bytes.length !== entry.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new Error(`sdk-carrier-artifact-mismatch: ${entry.path}`);
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
  let targetExists = true;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (cause) {
    if (
      cause === null ||
      typeof cause !== 'object' ||
      !('code' in cause) ||
      cause.code !== 'ENOENT'
    ) {
      return { ok: false, error: commandError(cause, 'sdk-install-failed') };
    }
    targetExists = false;
    entries = [];
  }
  if (entries.length > 0) {
    return {
      ok: false,
      error: {
        code: 'sdk-target-not-empty',
        expected: 'the SDK install target to be absent or empty',
        hint: 'Choose an empty versioned SDK directory so existing files cannot be overwritten.',
        detail: { root },
      },
    };
  }

  const version = options.version ?? (await packageVersion());
  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  let staging: string | undefined;
  let download: string | undefined;
  try {
    staging = await mkdtemp(resolve(parent, `.${basename(root)}.forgeax-sdk-staging-`));
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
    // Download and staging are private siblings on the target filesystem.
    // Adopt the extracted bytes without another full SDK copy or link rewrite.
    for (const name of await readdir(carrier)) {
      await rename(resolve(carrier, name), resolve(staging, name));
    }
    if (!targetExists) {
      await rename(staging, root);
      staging = undefined;
    } else {
      for (const name of await readdir(staging)) {
        await rename(resolve(staging, name), resolve(root, name));
      }
    }
    return {
      ok: true,
      value: {
        root,
        sdkVersion: version,
        source: '@forgeax/engine-sdk',
        next: { cwd: root, argv: ['node', './bin/forgeax.mjs', 'project', 'init'] },
      },
    };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'sdk-install-failed') };
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
    if (download !== undefined) await rm(download, { recursive: true, force: true });
  }
}
