import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startVitest } from 'vitest/node';
import {
  createZip,
  GAME_PACKAGE_DOCUMENT_PATHS,
  publishChecksummedFile,
  readGamePackageDocuments,
} from './archive.js';
import type { PluginSourceInventory } from './build/plugin-assets.js';
import { prepareDist, retainPlayerDist } from './delivery-dist.js';
import { readDeliverySource, verifyDeliverySource } from './delivery-identity.js';
import { DIST_MANIFEST_FILE, verifyDist } from './dist.js';
import { engineStatusCommand } from './engine-binding.js';
import { isFilesystemPathWithin } from './filesystem-path.js';
import { buildProject, startDevProjectWithHost, startPreviewProjectWithHost } from './host.js';
import { commandError, readProjectFacts } from './project.js';
import {
  bundleSingleHtmlEntry,
  packageFormatError,
  packageOutputError,
  writeSingleHtml,
} from './single-html.js';
import { installedProjectSkillDirectories } from './skill-install.js';
import { completeCommand, failCommand } from './types.js';

export { assetGuidCommand } from './asset-guid.js';
export {
  assetAddCommand,
  assetInspectCommand,
  assetListCommand,
  assetResolveCommand,
  assetVerifyCommand,
} from './assets.js';
export type { DoctorReport } from './bootstrap-commands.js';
export { doctorCommand, initCommand, newCommand } from './bootstrap-commands.js';
export { browserCaptureCommand } from './browser-capture.js';
export {
  engineDoctorCommand,
  engineStatusCommand,
  engineUnlinkCommand,
  engineUseLocalCommand,
} from './engine-binding.js';
export {
  pluginCreateCommand,
  pluginInspectCommand,
  pluginRootCommand,
} from './plugin-authoring.js';
export { projectLintCommand } from './project/lint.js';
export { createCliRhiDebugOperationContext } from './rhi-debug/cli-context.js';
export { sdkInstallCommand } from './sdk-install.js';
export { shaderCheckCommand } from './shader-check.js';
export { skillInstallCommand, skillVerifyCommand } from './skill-install.js';

import type {
  BuildOptions,
  CommandResult,
  PackageFormat,
  PackageOptions,
  ProjectCommandOptions,
  ProjectFacts,
} from './types.js';

export async function buildCommand(
  options: BuildOptions = {},
  initialSources?: PluginSourceInventory,
): Promise<CommandResult<unknown>> {
  return buildProject(options, initialSources);
}

function releaseSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'forgeax-game';
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function packageOutput(
  facts: ProjectFacts,
  options: PackageOptions,
): CommandResult<{
  readonly format: PackageFormat;
  readonly output: string;
  readonly distRoot: string;
}> {
  const format = options.format ?? 'web-zip';
  if (format !== 'web-zip' && format !== 'single-html') return packageFormatError(String(format));
  const defaultOutput =
    format === 'single-html'
      ? `release/${releaseSlug(facts.name)}-offline.html`
      : `release/${releaseSlug(facts.name)}-web.zip`;
  const output = resolve(facts.root, options.output ?? defaultOutput);
  const expectedSuffix = format === 'single-html' ? '.html' : '.zip';
  if (!output.toLowerCase().endsWith(expectedSuffix)) {
    return packageOutputError(output, format);
  }
  const distRoot = resolve(facts.root, 'dist');
  if (isFilesystemPathWithin(distRoot, output)) {
    return failCommand(
      'release-output-inside-dist',
      'the release artifact to live outside the derived dist directory',
      'Use --output release/<game>-web.zip or release/<game>-offline.html.',
      { output, distRoot, format },
    );
  }
  return { ok: true, value: { format, output, distRoot } };
}

function invalidPackageOptions(options: PackageOptions): CommandResult<never> | undefined {
  const nativeOptions = [
    options.arch,
    options.publisher,
    options.version,
    options.channel,
    options.nodeDist,
    options.vcRuntime,
    options.signThumbprint,
    options.signStore,
    options.timestampUrl,
    options.bundleId,
    options.signIdentity,
    options.notaryKeychainProfile,
  ];
  if (options.format !== 'native' && nativeOptions.some((value) => value !== undefined)) {
    return failCommand(
      'package-options-invalid',
      'native installer options only with the native format',
      'Use --format native with --platform windows or macos.',
      {},
    );
  }
  if (
    (options.format !== 'tauri' && options.prepareOnly !== undefined) ||
    (options.format !== 'tauri' && options.format !== 'native' && options.platform !== undefined)
  ) {
    return failCommand(
      'package-options-invalid',
      'platform and prepareOnly only with the tauri format',
      'Use --format tauri --platform windows|macos|linux|android|ios.',
      {},
    );
  }
  return undefined;
}

export async function packageCommand(
  options: PackageOptions = {},
): Promise<CommandResult<unknown>> {
  const invalid = invalidPackageOptions(options);
  if (invalid !== undefined) return invalid;
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  if (options.format === 'native') {
    const { packageNativeProject } = await import('./native-package.js');
    return packageNativeProject(facts.value, options);
  }
  if (options.format === 'tauri') {
    const { packageTauriProject } = await import('./tauri-package.js');
    return packageTauriProject(facts.value, options);
  }
  const planned = packageOutput(facts.value, options);
  if (!planned.ok) return planned;
  const { format, output, distRoot } = planned.value;
  const packageDocuments = await packageDocumentList(format, facts.value.root);
  if (!packageDocuments.ok) return packageDocuments;
  const source = await readDeliverySource(facts.value.root);
  const engine = await engineStatusCommand({ root: facts.value.root });
  if (!engine.ok) return engine;
  const built = await buildProject(
    {
      root: facts.value.root,
      base: './',
      ...(options.json === undefined ? {} : { json: options.json }),
    },
    undefined,
    format === 'single-html' ? 'native' : undefined,
  );
  if (!built.ok) return built;
  const verified = await verifyDist(distRoot);
  if (!verified.ok) return verified;
  let playerRoot: string | undefined;
  try {
    const player = await prepareDist(distRoot, verified.value, {
      compressDocuments: options.compress !== false,
      ...(format === 'web-zip'
        ? { outputParent: resolve(facts.value.root, '.forgeax/player') }
        : {}),
    });
    playerRoot = player.root;
    if (format === 'single-html') {
      const indexHtml = await readFile(resolve(player.root, 'index.html'), 'utf8');
      const bundle = await bundleSingleHtmlEntry(player.root, indexHtml, facts.value.root);
      if (!bundle.ok) return bundle;
      return await writeSingleHtml({
        distRoot: player.root,
        output,
        manifest: player.manifest,
        bundle: bundle.value,
      });
    }
    const paths = [
      ...player.manifest.artifacts.map((artifact) => artifact.path),
      DIST_MANIFEST_FILE,
    ];
    const entries = await Promise.all(
      paths.map(async (path) => ({ path, bytes: await readFile(resolve(player.root, path)) })),
    );
    const bytes = createZip([...entries, ...packageDocuments.value]);
    const unchanged = await verifyDeliverySource(facts.value.root, source);
    if (!unchanged.ok) return unchanged;
    const retained = await retainPlayerDist(player.root, facts.value.root);
    if (!retained.ok) return retained;
    const { root: servedDirectory, manifestSha256: distManifestSha256 } = retained.value;
    const { checksumPath, ...archive } = await publishChecksummedFile(output, bytes);
    return completeCommand({
      schemaVersion: '1.0.0',
      format: 'forgeax-web-game',
      target: 'web',
      project: verified.value.project,
      base: verified.value.base,
      engine: {
        mode: engine.value.mode,
        version: engine.value.resolved.version,
        runtimeDigest: engine.value.workspace?.digest ?? null,
        delivery: 'bundled-runtime',
        wasm: verified.value.artifacts.some((artifact) => artifact.path.endsWith('.wasm')),
      },
      archive,
      files: player.manifest.artifacts.length,
      bundles: player.bundles,
      documents: [...GAME_PACKAGE_DOCUMENT_PATHS],
      checksumPath,
      distManifestSha256,
      source,
      delivery: { type: 'player', servedDirectory, diagnosticDirectory: distRoot },
      run: {
        local: `forgeax project preview --root ${shellArgument(facts.value.root)} --dist ${shellArgument(servedDirectory)}`,
        localArgv: [
          'forgeax',
          'project',
          'preview',
          '--root',
          facts.value.root,
          '--dist',
          servedDirectory,
        ],
        shared: 'upload the ZIP to an HTTPS static or HTML-game host and share its URL',
      },
    });
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'game-package-failed') };
  } finally {
    if (playerRoot !== undefined) await rm(playerRoot, { recursive: true, force: true });
  }
}

export async function devCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  return startDevProjectWithHost(options);
}

export { startPreviewProjectWithHost as previewCommand };

export async function testCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  try {
    const context = await startVitest(
      'test',
      [],
      {
        root: facts.value.root,
        run: true,
        watch: false,
        // A game may ship without tests; acceptance is the real play journey.
        passWithNoTests: true,
        cliExclude: (await installedProjectSkillDirectories(facts.value.root)).map(
          (directory) => `${directory}/**`,
        ),
        // The minimal reporter hides successful test logs; project diagnostics
        // remain observable on stderr even when the CLI result is JSON.
        reporters: ['default'],
      },
      undefined,
      { stdout: process.stderr, stderr: process.stderr },
    );
    if (context === undefined) {
      return failCommand(
        'test-runner-unavailable',
        'Vitest to create a project test context',
        'Inspect the project test configuration.',
        { root: facts.value.root },
      );
    }
    const failed = context.state.getFiles().filter((file) => file.result?.state === 'fail');
    await context.close();
    if (failed.length > 0) {
      return failCommand(
        'project-tests-failed',
        'all project tests to pass',
        'Repair the failing game test before building a release.',
        { files: failed.map((file) => file.filepath) },
      );
    }
    return { ok: true, value: { root: facts.value.root } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-tests-failed') };
  }
}

async function packageDocumentList(format: string, root: string) {
  return format === 'web-zip' ? readGamePackageDocuments(root) : { ok: true as const, value: [] };
}
