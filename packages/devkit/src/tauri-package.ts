import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { readDeliverySource } from './delivery-identity.js';
import { verifyDist, writeDistManifest } from './dist.js';
import { buildProject } from './host.js';
import { commandError } from './project.js';
import type { CommandResult, PackageOptions, ProjectFacts, TauriPlatform } from './types.js';

export const TAURI_PLATFORMS = ['windows', 'macos', 'linux', 'android', 'ios'] as const;

export function tauriHostPlatform(host: string = process.platform): TauriPlatform | undefined {
  return host === 'darwin'
    ? 'macos'
    : host === 'win32'
      ? 'windows'
      : host === 'linux'
        ? 'linux'
        : undefined;
}

export function canBuildTauriPlatform(
  platform: TauriPlatform,
  host: string = process.platform,
): boolean {
  return (
    platform === 'android' ||
    (platform === 'ios' ? host === 'darwin' : platform === tauriHostPlatform(host))
  );
}

/** Keep native installers and application bundles, excluding intermediate compiler output. */
export async function collectTauriBundles(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) paths.push(path);
        else await visit(path);
      } else if (
        entry.isFile() &&
        /\.(dmg|exe|msi|AppImage|deb|rpm|apk|aab|ipa)$/i.test(entry.name) &&
        !entry.name.endsWith('-unaligned.apk')
      )
        paths.push(path);
    }
  }
  await visit(root);
  return paths.sort();
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CARGO_TARGET_DIR: resolve(cwd, 'src-tauri/target') },
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32' && command === 'npm',
      timeout: 1_800_000,
    });
    child.stdout?.pipe(process.stderr, { end: false });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? accept()
        : reject(new Error(`Tauri packaging subprocess failed (${code ?? signal})`)),
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

async function planTauriPackage(
  facts: ProjectFacts,
  options: PackageOptions,
): Promise<CommandResult<{ platform: TauriPlatform; output: string }>> {
  const platform = options.platform ?? tauriHostPlatform();
  if (
    platform === undefined ||
    !TAURI_PLATFORMS.includes(platform) ||
    (options.prepareOnly !== undefined && typeof options.prepareOnly !== 'boolean') ||
    options.compress !== undefined
  ) {
    return {
      ok: false,
      error: {
        code: 'tauri-package-options-invalid',
        expected: 'a supported Tauri platform and optional boolean prepareOnly',
        hint: 'Use --format tauri --platform windows|macos|linux|android|ios [--prepare-only]. Web compression belongs to web-zip.',
        detail: {},
      },
    };
  }
  if (!options.prepareOnly && !canBuildTauriPlatform(platform)) {
    return {
      ok: false,
      error: {
        code: 'tauri-build-host-unsupported',
        expected: `${platform} native packaging prerequisites on a supported host`,
        hint: 'Use --prepare-only to export the project, then run its build script on the target desktop OS (iOS requires macOS).',
        detail: { platform, host: process.platform },
      },
    };
  }
  const slug = facts.id.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'game';
  const output = resolve(facts.root, options.output ?? `release/${slug}-tauri-${platform}`);
  if (await exists(output))
    return {
      ok: false,
      error: {
        code: 'tauri-package-output-exists',
        expected: 'a new output directory',
        hint: 'Choose a new --output directory; existing packages are preserved.',
        detail: { output },
      },
    };
  return { ok: true, value: { platform, output } };
}

interface TauriPackageArtifact {
  readonly path: string;
  readonly bytes?: number;
  readonly sha256?: string;
}

async function buildTauriPackages(
  project: string,
  platform: TauriPlatform,
): Promise<TauriPackageArtifact[]> {
  const artifacts: TauriPackageArtifact[] = [];
  // The generated project owns a pinned CLI; do not install tools in the game.
  await run(
    'npm',
    [
      'install',
      '--include=dev',
      '--include=optional',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    project,
  );
  await run(
    process.execPath,
    [resolve(project, 'scripts/build.mjs'), '--platform', platform],
    project,
  );
  const bundleRoot =
    platform === 'android'
      ? resolve(project, 'src-tauri/gen/android/app/build/outputs')
      : platform === 'ios'
        ? resolve(project, 'src-tauri/gen/apple/build')
        : resolve(project, 'src-tauri/target/release/bundle');
  const bundles = (await collectTauriBundles(bundleRoot)).filter(
    (path) => platform !== 'ios' || path.endsWith('.ipa'),
  );
  if (bundles.length === 0) throw new Error('Tauri completed without producing a native package');
  for (const path of bundles) {
    const destination = resolve(project, 'artifacts', relative(bundleRoot, path));
    await mkdir(dirname(destination), { recursive: true });
    await cp(path, destination, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    const info = await lstat(destination);
    artifacts.push(
      info.isFile()
        ? {
            path: relative(project, destination),
            bytes: info.size,
            sha256: createHash('sha256')
              .update(await readFile(destination))
              .digest('hex'),
          }
        : { path: relative(project, destination) },
    );
  }
  // Preserve Cargo.lock; regenerate mobile projects after moving to avoid absolute staging paths.
  for (const path of ['node_modules', 'src-tauri/target', 'src-tauri/gen'])
    await rm(resolve(project, path), { recursive: true, force: true });
  return artifacts;
}

export async function packageTauriProject(
  facts: ProjectFacts,
  options: PackageOptions,
): Promise<CommandResult<unknown>> {
  let staging: string | undefined;
  try {
    const planned = await planTauriPackage(facts, options);
    if (!planned.ok) return planned;
    const { platform, output } = planned.value;
    const source = await readDeliverySource(facts.root);
    const work = resolve(facts.root, '.forgeax');
    await mkdir(work, { recursive: true });
    staging = await mkdtemp(resolve(work, 'tauri-package-'));
    const project = resolve(staging, 'project');
    const built = await buildProject({
      root: facts.root,
      target: 'tauri',
      outDir: project,
      base: './',
    });
    if (!built.ok) return built;
    const verified = await verifyDist(project);
    if (!verified.ok) return verified;
    const artifacts = options.prepareOnly ? [] : await buildTauriPackages(project, platform);
    if (!options.prepareOnly) {
      await writeDistManifest(facts, './', project, 'tauri');
      const sealed = await verifyDist(project);
      if (!sealed.ok) return sealed;
    }
    const finalSource = await readDeliverySource(facts.root);
    if (JSON.stringify(source) !== JSON.stringify(finalSource))
      return {
        ok: false,
        error: {
          code: 'package-source-changed',
          expected: 'the source identity to remain fixed during packaging',
          hint: 'Finish source edits and rerun packaging from one stable source tree.',
          detail: { before: source, after: finalSource },
        },
      };
    await mkdir(dirname(output), { recursive: true });
    if (await exists(output))
      throw new Error('Tauri output appeared while packaging; choose a new output directory');
    await rename(project, output);
    return {
      ok: true,
      value: {
        format: 'forgeax-tauri-game',
        platform,
        status: options.prepareOnly ? 'prepared' : 'built',
        directory: output,
        artifacts,
        source,
        run: {
          cwd: output,
          install: 'pnpm install',
          build: `pnpm build:${platform}`,
          smoke: platform === 'android' || platform === 'ios' ? null : 'pnpm smoke',
        },
        verification: {
          distribution: 'passed',
          nativeBuild: options.prepareOnly ? 'not-run' : 'passed',
          runtime: 'not-run',
        },
      },
    };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'tauri-package-failed') };
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
  }
}
