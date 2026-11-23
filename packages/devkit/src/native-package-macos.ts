import { copyFile, lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { sha256 } from '@forgeax/engine-types';
import { DIST_MANIFEST_FILE } from './dist.js';
import {
  buildNativeInstaller,
  buildNativePackageGame,
  nativeNodeEnvironment,
  planNativeInstallerOutput,
  publishNativeInstaller,
  runNativePackageTool as run,
  sealNativePackageGame,
  verifyPackagedNode,
} from './native-package.js';
import type { CommandResult, PackageOptions, ProjectFacts } from './types.js';
import { completeCommand, failCommand as fail } from './types.js';

const target = {
  platform: 'macos',
  arch: 'arm64',
  addons: [
    'native/forgeax-rhi-wgpu-native.darwin-arm64.node',
    'audio/node-web-audio-api.darwin-arm64.node',
  ],
} as const;
const developerIdRequirement =
  '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';

interface MacosPackagePlan {
  readonly output: string;
  readonly name: string;
  readonly version: string;
  readonly bundleId: string;
  readonly nodeDist: string;
  readonly signIdentity: string | undefined;
  readonly notaryProfile: string | undefined;
}

function resolveMacosSigning(
  options: PackageOptions,
): CommandResult<Pick<MacosPackagePlan, 'signIdentity' | 'notaryProfile'>> {
  const signIdentity = options.signIdentity?.trim();
  const notaryProfile = options.notaryKeychainProfile?.trim();
  if (
    (signIdentity !== undefined && (!signIdentity || signIdentity === '-')) ||
    (notaryProfile !== undefined && (!notaryProfile || !signIdentity))
  ) {
    return fail(
      'native-package-signing-invalid',
      'a Developer ID Application identity for distribution signing',
      'Pass --sign-identity and optionally --notary-keychain-profile. Omit both for a local ad hoc DMG.',
    );
  }
  return { ok: true, value: { signIdentity, notaryProfile } };
}

export function planMacosNativePackage(
  facts: Pick<ProjectFacts, 'root' | 'id' | 'name' | 'packageJson'>,
  options: PackageOptions,
): CommandResult<MacosPackagePlan> {
  if (
    options.platform !== 'macos' ||
    (options.arch !== undefined && options.arch !== 'arm64') ||
    [
      options.compress,
      options.publisher,
      options.channel,
      options.vcRuntime,
      options.signThumbprint,
      options.signStore,
      options.timestampUrl,
    ].some((value) => value !== undefined)
  ) {
    return fail(
      'native-package-target-invalid',
      'a macOS arm64 native DMG destination',
      'Use --platform macos --arch arm64 with the macOS signing options.',
    );
  }
  const version = options.version ?? facts.packageJson.version;
  const bundleId = options.bundleId?.trim();
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    !bundleId ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)
  ) {
    return fail(
      'native-package-identity-invalid',
      'a reverse-DNS bundle ID and three-part version',
      'Pass --bundle-id com.example.game and use a version such as --version 1.0.0.',
    );
  }
  if (!options.nodeDist?.trim()) {
    return fail(
      'native-package-runtime-missing',
      'an extracted macOS arm64 Node distribution',
      'Pass --node-dist with its bin/node and LICENSE.',
    );
  }
  const signing = resolveMacosSigning(options);
  if (!signing.ok) return signing;
  const output = planNativeInstallerOutput(
    facts.root,
    options.output ?? `release/${bundleId}-${version}-macos-arm64.dmg`,
    'dmg',
  );
  if (!output.ok) return output;
  const name = facts.name.replace(/[\p{Cc}/:]/gu, '-').trim() || facts.id;
  return completeCommand({
    name,
    version,
    bundleId,
    output: output.value,
    nodeDist: resolve(facts.root, options.nodeDist),
    ...signing.value,
  });
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function macosInfoPlist(
  job: Pick<MacosPackagePlan, 'name' | 'bundleId' | 'version'>,
  minimumSystemVersion: string,
): string {
  const pairs = {
    CFBundleExecutable: 'ForgeaXLauncher',
    CFBundleIdentifier: job.bundleId,
    CFBundleName: job.name,
    CFBundleDisplayName: job.name,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: job.version,
    CFBundleVersion: job.version,
    LSMinimumSystemVersion: minimumSystemVersion,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${Object.entries(pairs)
  .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
  .join('\n')}
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

async function admitMachO(file: string): Promise<string> {
  const { stdout: architectures } = await run('/usr/bin/lipo', ['-archs', file], {
    timeout: 15_000,
  });
  if (architectures.trim() !== 'arm64') {
    throw new Error(`${basename(file)} must be a macOS arm64 binary`);
  }
  const { stdout } = await run('/usr/bin/otool', ['-arch', 'arm64', '-l', file], {
    timeout: 15_000,
  });
  const imports = stdout.matchAll(
    /cmd LC_(?:LOAD|LOAD_WEAK|LOAD_UPWARD|REEXPORT|LAZY_LOAD)_DYLIB\s+cmdsize \d+\s+name (.*?) \(offset/g,
  );
  for (const [, dependency] of imports) {
    if (!dependency?.startsWith('/System/Library/') && !dependency?.startsWith('/usr/lib/')) {
      throw new Error(`${basename(file)} requires an unbundled Mach-O dependency: ${dependency}`);
    }
  }
  const minimum = /^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$/m.exec(stdout)?.[1];
  if (!minimum) throw new Error(`Missing macOS deployment version for ${basename(file)}`);
  return minimum;
}

async function signCode(
  path: string,
  identity: string | undefined,
  entitlements?: string,
): Promise<void> {
  await run(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      identity ?? '-',
      ...(identity === undefined ? [] : ['--timestamp', '--options', 'runtime']),
      ...(entitlements === undefined ? [] : ['--entitlements', entitlements]),
      path,
    ],
    { timeout: 120_000 },
  );
  if (identity !== undefined) {
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R', developerIdRequirement, path], {
      timeout: 30_000,
    });
  }
}

async function notarize(dmg: string, profile: string): Promise<string> {
  const result = await run(
    '/usr/bin/xcrun',
    [
      'notarytool',
      'submit',
      dmg,
      '--keychain-profile',
      profile,
      '--wait',
      '--timeout',
      '20m',
      '--output-format',
      'json',
    ],
    { timeout: 1_260_000 },
  );
  const reply = JSON.parse(result.stdout) as { readonly id?: string; readonly status?: string };
  if (reply.status !== 'Accepted' || !reply.id) {
    throw new Error(
      `Apple notarization returned ${reply.status ?? 'unknown'} for submission ${reply.id ?? 'unknown'}`,
    );
  }
  await run('/usr/bin/xcrun', ['stapler', 'staple', dmg], { timeout: 120_000 });
  await run('/usr/bin/xcrun', ['stapler', 'validate', dmg], { timeout: 120_000 });
  await run(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg],
    { timeout: 60_000 },
  );
  return reply.id;
}

async function stageAddons(game: string, frameworks: string): Promise<string[]> {
  const paths: string[] = [];
  for (const addon of target.addons) {
    const source = join(game, addon);
    const destination = join(frameworks, basename(addon));
    if (!(await lstat(source)).isFile())
      throw new Error(`${addon} must be a regular build artifact`);
    await rename(source, destination);
    await symlink(relative(dirname(source), destination), source);
    paths.push(destination);
  }
  return paths;
}

async function sealMacosApp(
  job: MacosPackagePlan,
  stage: string,
  app: string,
  node: string,
  addons: readonly string[],
  deploymentTarget: string,
  sealManifest: () => Promise<string>,
): Promise<string> {
  const contents = join(app, 'Contents');
  const launcher = join(contents, 'MacOS', 'ForgeaXLauncher');
  const launcherSource = join(stage, 'launcher.c');
  const entitlements = job.signIdentity === undefined ? undefined : join(stage, 'jit.plist');
  await writeFile(launcherSource, nativeMacosLauncherSource(job.bundleId));
  await writeFile(join(contents, 'Info.plist'), macosInfoPlist(job, deploymentTarget));
  await run(
    '/usr/bin/xcrun',
    [
      'clang',
      '-arch',
      'arm64',
      `-mmacosx-version-min=${deploymentTarget}`,
      '-Os',
      launcherSource,
      '-o',
      launcher,
    ],
    { timeout: 30_000 },
  );
  if (entitlements) {
    await writeFile(
      entitlements,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n',
    );
  }
  for (const addon of addons) await signCode(addon, job.signIdentity);
  await signCode(node, job.signIdentity, entitlements);
  await run(
    node,
    ['-e', 'for (const binding of process.argv.slice(1)) require(binding)', ...addons],
    {
      env: nativeNodeEnvironment(),
      timeout: 30_000,
    },
  );
  const gameManifestSha256 = await sealManifest();
  await signCode(app, job.signIdentity);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 30_000 });
  return gameManifestSha256;
}

export async function packageMacosNativeProject(
  facts: ProjectFacts,
  options: PackageOptions,
): Promise<CommandResult<unknown>> {
  const plan = planMacosNativePackage(facts, options);
  if (!plan.ok) return plan;
  const job = plan.value;
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return fail(
      'native-package-host-unsupported',
      'a macOS arm64 package producer',
      'Run on Apple Silicon with the Apple command line tools.',
    );
  }
  return buildNativeInstaller(job.output, 'dmg', async (stage, progress) => {
    const imageRoot = join(stage, 'image');
    const app = join(imageRoot, `${Array.from(job.name).slice(0, 48).join('')}.app`);
    const contents = join(app, 'Contents');
    const resources = join(contents, 'Resources');
    const helpers = join(contents, 'Helpers');
    const frameworks = join(contents, 'Frameworks');
    const game = join(resources, 'game');
    const node = join(helpers, 'node');
    await Promise.all(
      [resources, helpers, frameworks, join(contents, 'MacOS')].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    progress.phase = 'runtime';
    await copyFile(join(job.nodeDist, 'bin', 'node'), node);
    await copyFile(join(job.nodeDist, 'LICENSE'), join(resources, 'LICENSE.node.txt'));
    const nodeMinimumVersion = await admitMachO(node);
    const nodeVersion = await verifyPackagedNode(node, 'darwin');
    if (!nodeVersion.ok) return nodeVersion;
    progress.phase = 'game-build';
    const built = await buildNativePackageGame(facts, game, target, options.json);
    if (!built.ok) return built;
    const sourceManifestSha256 = sha256(await readFile(join(game, DIST_MANIFEST_FILE)));
    progress.phase = 'app-signing';
    const addons = await stageAddons(game, frameworks);
    const minimumSystemVersion = (await Promise.all(addons.map(admitMachO))).reduce(
      (latest, value) =>
        latest.localeCompare(value, 'en', { numeric: true }) < 0 ? value : latest,
      nodeMinimumVersion,
    );
    await writeFile(
      join(resources, 'forgeax-release-input.json'),
      `${JSON.stringify({ sourceManifestSha256 }, null, 2)}\n`,
    );
    const gameManifestSha256 = await sealMacosApp(
      job,
      stage,
      app,
      node,
      addons,
      minimumSystemVersion,
      () => sealNativePackageGame(facts, game, job.version, built.value),
    );
    progress.phase = 'disk-image';
    await symlink('/Applications', join(imageRoot, 'Applications'));
    const dmg = join(stage, 'game.dmg');
    await run(
      '/usr/bin/hdiutil',
      [
        'create',
        '-srcfolder',
        imageRoot,
        '-volname',
        basename(app, '.app'),
        '-fs',
        'HFS+',
        '-format',
        'UDZO',
        dmg,
      ],
      { timeout: 300_000 },
    );
    await run(
      '/usr/bin/codesign',
      [
        '--sign',
        job.signIdentity ?? '-',
        ...(job.signIdentity === undefined ? [] : ['--timestamp']),
        dmg,
      ],
      { timeout: 120_000 },
    );
    progress.phase = 'notarization';
    const notarizationId =
      job.notaryProfile === undefined ? undefined : await notarize(dmg, job.notaryProfile);
    progress.phase = 'verify-image';
    await run('/usr/bin/codesign', ['--verify', '--strict', dmg], { timeout: 30_000 });
    await run('/usr/bin/hdiutil', ['verify', dmg], { timeout: 120_000 });
    progress.phase = 'publish';
    const published = await publishNativeInstaller(dmg, job.output);
    return completeCommand({
      format: 'native',
      platform: target.platform,
      arch: target.arch,
      output: job.output,
      project: built.value.project,
      bundleId: job.bundleId,
      version: job.version,
      nodeVersion: nodeVersion.value,
      minimumSystemVersion,
      sourceManifestSha256,
      gameManifestSha256,
      signature: job.signIdentity === undefined ? 'ad-hoc' : 'developer-id',
      notarized: notarizationId !== undefined,
      ...(notarizationId === undefined ? {} : { notarizationId }),
      ...published,
    });
  });
}

export function nativeMacosLauncherSource(bundleId: string): string {
  return String.raw`#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int join_path(char *out, const char *directory, const char *suffix) {
    int length = snprintf(out, PATH_MAX, "%s/%s", directory, suffix);
    return length >= 0 && (size_t)length < PATH_MAX;
}

static void open_log(void) {
    const char *home = getenv("HOME");
    if (!home || home[0] != '/') return;
    char path[PATH_MAX];
    if (!join_path(path, home, "Library")) return;
    mkdir(path, 0700);
    if (!join_path(path, home, "Library/Logs")) return;
    mkdir(path, 0700);
    if (!join_path(path, home, "Library/Logs/ForgeaX")) return;
    mkdir(path, 0700);
    if (!join_path(path, home, "Library/Logs/ForgeaX/${bundleId}")) return;
    mkdir(path, 0700);
    if (!join_path(path, home, "Library/Logs/ForgeaX/${bundleId}/launcher.log")) return;
    int log = open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0600);
    if (log < 0) return;
    dup2(log, STDOUT_FILENO);
    dup2(log, STDERR_FILENO);
    if (log > STDERR_FILENO) close(log);
}

int main(void) {
    open_log();
    char executable[PATH_MAX];
    char directory[PATH_MAX];
    char node[PATH_MAX];
    char entry[PATH_MAX];
    uint32_t size = sizeof executable;
    if (_NSGetExecutablePath(executable, &size) || !realpath(executable, directory)) {
        fputs("Could not resolve the app launcher\n", stderr);
        return 1;
    }
    char *slash = strrchr(directory, '/');
    if (!slash) return 1;
    *slash = '\0';
    if (!join_path(node, directory, "../Helpers/node") ||
        !join_path(entry, directory, "../Resources/game/game.mjs")) {
        fputs("The app path is too long\n", stderr);
        return 1;
    }
    unsetenv("NODE_OPTIONS");
    unsetenv("NODE_PATH");
    if (getenv("FORGEAX_DESKTOP_TRACE")) fprintf(stderr, "[app-launcher] exec pid=%d\n", getpid());
    char *const args[] = {node, entry, NULL};
    execv(node, args);
    fprintf(stderr, "Could not start the bundled runtime: %s\n", strerror(errno));
    return 1;
}
`;
}
