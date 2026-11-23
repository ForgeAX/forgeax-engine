import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from '@forgeax/engine-types';
import { nativeInstallerSource, nativeLauncherSource } from './build/native-installer-source.js';
import { DIST_MANIFEST_FILE, type DistManifest, verifyDist, writeDistManifest } from './dist.js';
import { isFilesystemPathWithin } from './filesystem-path.js';
import type { CommandResult, PackageOptions, ProjectFacts } from './types.js';
import { completeCommand, failCommand } from './types.js';

const run = promisify(execFile);

export { run as runNativePackageTool };

const vcLibraries = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'] as const;

function nativeToolOutput(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  const failure = cause as { stdout?: unknown; stderr?: unknown };
  const text = [failure.stdout, failure.stderr]
    .filter((output): output is string => typeof output === 'string')
    .map((output) => output.trim())
    .filter(Boolean)
    .join('\n');
  return text.length === 0 ? undefined : text.slice(-4096);
}

function installerGuid(parts: readonly string[]): string {
  const bytes = createHash('sha256')
    .update('forgeax:msi:v1:')
    .update(JSON.stringify(parts))
    .digest();
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex', 0, 16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function timestampEndpoint(input: string): URL | undefined {
  try {
    const url = new URL(input);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

interface InstallerSignature {
  readonly thumbprint: string;
  readonly timestamp: string;
  readonly machine: boolean;
}

function planNativePackageSignature(
  options: PackageOptions,
): CommandResult<InstallerSignature | undefined> {
  const thumbprint = options.signThumbprint?.replaceAll(' ', '').toUpperCase();
  const timestamp =
    options.timestampUrl === undefined ? undefined : timestampEndpoint(options.timestampUrl);
  if (
    (options.signStore !== undefined && !['user', 'machine'].includes(options.signStore)) ||
    (thumbprint === undefined &&
      (options.timestampUrl !== undefined || options.signStore !== undefined)) ||
    (thumbprint !== undefined && (!/^[0-9A-F]{40}$/.test(thumbprint) || timestamp === undefined))
  ) {
    return failCommand(
      'native-package-signing-invalid',
      'a signing certificate thumbprint and RFC 3161 timestamp URL',
      'Use --sign-thumbprint and --timestamp-url together. The certificate store defaults to CurrentUser\\My.',
    );
  }
  return completeCommand(
    thumbprint && timestamp
      ? { thumbprint, timestamp: timestamp.href, machine: options.signStore === 'machine' }
      : undefined,
  );
}

function isMsiVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})$/.test(value) &&
    value.split('.').every((part, index) => Number(part) <= (index === 2 ? 65535 : 255))
  );
}

/** Validate public inputs before invoking a builder or signer. */
export function planNativePackage(
  facts: Pick<ProjectFacts, 'root' | 'id' | 'name' | 'packageJson'>,
  options: PackageOptions,
) {
  const version = options.version ?? facts.packageJson.version;
  const publisher = options.publisher?.trim();
  const channel = options.channel ?? 'stable';
  if (
    (options.platform !== undefined && options.platform !== 'windows') ||
    (options.arch !== undefined && options.arch !== 'x64') ||
    [options.bundleId, options.signIdentity, options.notaryKeychainProfile].some(
      (value) => value !== undefined,
    ) ||
    options.compress !== undefined
  ) {
    return failCommand(
      'native-package-target-invalid',
      'a Windows x64 native MSI destination',
      'Use --platform windows --arch x64. Compression options belong to web-zip.',
    );
  }
  if (!isMsiVersion(version) || !publisher || !/^[a-z][a-z0-9-]{0,30}$/.test(channel)) {
    return failCommand(
      'native-package-identity-invalid',
      'a publisher, an MSI version and a release channel',
      'Pass --publisher and use a major.minor.build version such as --version 1.0.0. Channel defaults to stable.',
    );
  }
  if (!options.nodeDist || !options.vcRuntime) {
    return failCommand(
      'native-package-runtime-missing',
      'explicit Node and Visual C++ redistribute directories',
      'Pass --node-dist for a Windows x64 Node distribution and --vc-runtime for its x64 Microsoft.VC143.CRT directory.',
    );
  }
  const signature = planNativePackageSignature(options);
  if (!signature.ok) return signature;
  const upgradeCode = installerGuid([publisher, facts.id, channel]);
  const slug = facts.id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 32);
  const installKey = `ForgeaX-${slug}-${upgradeCode.slice(0, 8)}`;
  const fallbackName = installKey;
  const name = channel === 'stable' ? facts.name : `${facts.name} (${channel})`;
  const shortcutName = `${name.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, '') || fallbackName} [${upgradeCode.slice(0, 8)}]`;
  const output = planNativeInstallerOutput(
    facts.root,
    options.output ?? `release/${installKey}-${version}-windows-x64.msi`,
    'msi',
  );
  if (!output.ok) return output;
  return {
    ok: true as const,
    value: {
      name,
      shortcutName,
      publisher,
      version,
      channel,
      upgradeCode,
      productCode: installerGuid([upgradeCode, version]),
      installKey,
      output: output.value,
      nodeDist: resolve(facts.root, options.nodeDist),
      vcRuntime: resolve(facts.root, options.vcRuntime),
      signature: signature.value,
    },
  };
}

async function sign(path: string, options: InstallerSignature, cwd: string) {
  await run(
    'signtool.exe',
    [
      'sign',
      '/s',
      'My',
      ...(options.machine ? ['/sm'] : []),
      '/sha1',
      options.thumbprint,
      '/fd',
      'SHA256',
      '/tr',
      options.timestamp,
      '/td',
      'SHA256',
      path,
    ],
    { cwd, timeout: 120_000, windowsHide: true },
  );
  await run('signtool.exe', ['verify', '/pa', '/tw', path], {
    cwd,
    timeout: 120_000,
    windowsHide: true,
  });
}

export async function verifyPackagedNode(
  executable: string,
  target: 'win32' | 'darwin',
): Promise<CommandResult<string>> {
  const probe = await run(
    executable,
    [
      '-p',
      'JSON.stringify([process.release.name, process.platform, process.arch, process.versions.node])',
    ],
    {
      cwd: dirname(executable),
      timeout: 10_000,
      windowsHide: true,
      ...(target === 'darwin' ? { env: nativeNodeEnvironment() } : {}),
    },
  );
  const [runtime, platform, arch, nodeVersion] = JSON.parse(probe.stdout) as [
    string,
    string,
    string,
    string,
  ];
  const [major = Number.NaN, minor = Number.NaN] = nodeVersion.split('.').map(Number);
  if (
    runtime !== 'node' ||
    platform !== target ||
    arch !== (target === 'win32' ? 'x64' : 'arm64') ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < 22 ||
    (major === 22 && minor < 13)
  ) {
    return failCommand(
      'native-package-runtime-incompatible',
      target === 'win32' ? 'Windows x64 Node.js >=22.13.0' : 'macOS arm64 Node.js >=22.13.0',
      'Use the corresponding extracted official Node distribution for --node-dist.',
      { runtime, platform, arch, nodeVersion },
    );
  }
  return { ok: true, value: nodeVersion };
}

type InstallerKind = 'dmg' | 'msi';

export function planNativeInstallerOutput(root: string, destination: string, kind: InstallerKind) {
  const output = resolve(root, destination);
  if (
    !output.toLowerCase().endsWith(`.${kind}`) ||
    isFilesystemPathWithin(resolve(root, 'dist'), output)
  ) {
    return failCommand(
      'native-package-output-invalid',
      `a${kind === 'msi' ? 'n' : ''} .${kind} output outside the project dist directory`,
      `Choose --output release/game.${kind}.`,
      { output },
    );
  }
  return completeCommand(output);
}

/** Keep destination admission, staging and retirement in the installer transaction. */
export async function buildNativeInstaller(
  output: string,
  kind: InstallerKind,
  build: (stage: string, progress: { phase: string }) => Promise<CommandResult<unknown>>,
  preflight?: () => Promise<unknown>,
): Promise<CommandResult<unknown>> {
  const windows = kind === 'msi';
  const progress = { phase: windows ? 'preflight' : 'staging' };
  let stage: string | undefined;
  try {
    const existing = await lstat(output).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return undefined;
      if (!windows) throw cause;
      return null;
    });
    if (existing === null)
      return failCommand(
        'native-package-output-unavailable',
        'an accessible MSI output path',
        'Check the output directory permissions.',
        { output },
      );
    if (existing !== undefined)
      return failCommand(
        'native-package-output-exists',
        `an unused ${kind.toUpperCase()} output path`,
        'Choose a new --output path.',
        { output },
      );
    if (preflight !== undefined) await preflight();
    progress.phase = 'staging';
    const parent = dirname(output);
    await mkdir(parent, { recursive: true });
    stage = await mkdtemp(join(parent, `.forgeax-${kind}-`));
    return await build(stage, progress);
  } catch (cause) {
    const toolOutput = nativeToolOutput(cause);
    return failCommand(
      'native-package-failed',
      windows ? 'a verified Windows installer' : 'a verified macOS disk image',
      windows
        ? 'Inspect the named phase and provide the matching Windows build or signing input.'
        : 'Inspect the failing phase and provide the matching macOS runtime or signing input.',
      {
        phase: progress.phase,
        reason: cause instanceof Error ? cause.message : String(cause),
        ...(toolOutput === undefined ? {} : { toolOutput }),
      },
    );
  } finally {
    if (stage !== undefined)
      await rm(stage, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}

export async function publishNativeInstaller(installer: string, output: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(installer)) hash.update(bytes);
  const { size: bytes } = await stat(installer);
  await link(installer, output);
  return { bytes, sha256: hash.digest('hex') };
}

export function nativeNodeEnvironment(): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _options, NODE_PATH: _path, ...environment } = process.env;
  return environment;
}

export async function sealNativePackageGame(
  facts: ProjectFacts,
  game: string,
  version: string,
  distribution: Pick<DistManifest, 'base' | 'materialProfile'>,
) {
  // Even identical gameplay bytes belong to distinguishable installed releases.
  await writeFile(join(game, 'forgeax-native-release.json'), `${JSON.stringify({ version })}\n`);
  await writeDistManifest(facts, distribution.base, game, 'native', distribution.materialProfile);
  const verified = await verifyDist(game);
  if (!verified.ok) throw new Error(`${verified.error.code}: ${verified.error.expected}`);
  return sha256(await readFile(join(game, DIST_MANIFEST_FILE)));
}

export async function buildNativePackageGame(
  facts: ProjectFacts,
  game: string,
  target: { platform: 'windows' | 'macos'; arch: 'x64' | 'arm64'; addons: readonly string[] },
  json: PackageOptions['json'],
) {
  const { buildProject } = await import('./host.js');
  const built = await buildProject({
    root: facts.root,
    target: 'native',
    platform: target.platform,
    arch: target.arch,
    outDir: game,
    base: './',
    ...(json === undefined ? {} : { json }),
  });
  if (!built.ok) return built;
  const verified = await verifyDist(game);
  if (!verified.ok) return verified;
  const files = new Set(verified.value.artifacts.map((artifact) => artifact.path));
  if (
    verified.value.target !== 'native' ||
    verified.value.project.id !== facts.id ||
    !files.has('game.mjs') ||
    !target.addons.every((relative) => files.has(relative))
  ) {
    return failCommand(
      'native-package-game-invalid',
      `a sealed ${target.platform} ${target.arch} game distribution`,
      'Rebuild the project with the matching native addon.',
    );
  }
  return verified;
}

export async function packageNativeProject(
  facts: ProjectFacts,
  options: PackageOptions,
): Promise<CommandResult<unknown>> {
  if (options.platform === 'macos') {
    const { packageMacosNativeProject } = await import('./native-package-macos.js');
    return packageMacosNativeProject(facts, options);
  }
  const plan = planNativePackage(facts, options);
  if (!plan.ok) return plan;
  const job = plan.value;
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return failCommand(
      'native-package-host-unsupported',
      'an x64 Windows package producer',
      'Run the installer command on Windows x64 with WiX, .NET Framework and optional SignTool.',
    );
  }
  return buildNativeInstaller(
    job.output,
    'msi',
    async (stage, progress) => {
      const payload = join(stage, 'payload');
      const game = join(payload, 'game');
      const bundledRuntime = join(payload, 'runtime');
      await mkdir(bundledRuntime, { recursive: true });
      await Promise.all([
        copyFile(join(job.nodeDist, 'node.exe'), join(bundledRuntime, 'node.exe')),
        copyFile(join(job.nodeDist, 'LICENSE'), join(bundledRuntime, 'LICENSE')),
      ]);
      progress.phase = 'runtime';
      const runtime = await verifyPackagedNode(join(bundledRuntime, 'node.exe'), 'win32');
      if (!runtime.ok) return runtime;
      progress.phase = 'game-build';
      const verified = await buildNativePackageGame(
        facts,
        game,
        {
          platform: 'windows',
          arch: 'x64',
          addons: ['native/forgeax-rhi-wgpu-native.win32-x64.node'],
        },
        options.json,
      );
      if (!verified.ok) return verified;
      progress.phase = 'native-runtime';
      // Node loads the addon with altered-search-path semantics. Its dependent
      // VC libraries belong beside the addon so Windows searches them first.
      await Promise.all([
        ...vcLibraries.map((name) =>
          copyFile(join(job.vcRuntime, name), join(game, 'native', name)),
        ),
        copyFile(join(job.vcRuntime, 'vcruntime140.dll'), join(game, 'audio', 'vcruntime140.dll')),
      ]);
      const gameManifestSha256 = await sealNativePackageGame(
        facts,
        game,
        job.version,
        verified.value,
      );
      progress.phase = 'launcher';
      await writeFile(join(stage, 'Game.cs'), nativeLauncherSource(job.installKey), 'utf8');
      const csc = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'Microsoft.NET',
        'Framework64',
        'v4.0.30319',
        'csc.exe',
      );
      await run(
        csc,
        [
          '/nologo',
          '/target:winexe',
          '/platform:x64',
          '/optimize+',
          '/reference:System.Windows.Forms.dll',
          '/out:payload\\Game.exe',
          'Game.cs',
        ],
        { cwd: stage, timeout: 30_000, windowsHide: true },
      );
      if (job.signature) {
        progress.phase = 'launcher-signing';
        await sign(join(payload, 'Game.exe'), job.signature, stage);
      }
      progress.phase = 'installer';
      const installer = join(stage, 'game.msi');
      await writeFile(join(stage, 'Game.wxs'), nativeInstallerSource(job), 'utf8');
      await run('wix.exe', ['build', '-arch', 'x64', '-o', installer, 'Game.wxs'], {
        cwd: stage,
        timeout: 300_000,
        windowsHide: true,
      });
      await run('wix.exe', ['msi', 'validate', installer], {
        cwd: stage,
        timeout: 120_000,
        windowsHide: true,
      });
      if (job.signature) {
        progress.phase = 'installer-signing';
        await sign(installer, job.signature, stage);
      }
      progress.phase = 'publish';
      const published = await publishNativeInstaller(installer, job.output);
      return completeCommand({
        format: 'native',
        platform: 'windows',
        arch: 'x64',
        output: job.output,
        project: verified.value.project,
        version: job.version,
        publisher: job.publisher,
        channel: job.channel,
        upgradeCode: job.upgradeCode,
        productCode: job.productCode,
        installDirectory: job.installKey,
        shortcutName: job.shortcutName,
        nodeVersion: runtime.value,
        gameManifestSha256,
        signed: job.signature !== undefined,
        ...(job.signature
          ? { signerThumbprint: job.signature.thumbprint, timestampUrl: job.signature.timestamp }
          : {}),
        ...published,
      });
    },
    () => run('wix.exe', ['--version'], { timeout: 15_000, windowsHide: true }),
  );
}
