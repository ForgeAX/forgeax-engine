import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { startVitest } from 'vitest/node';
import { createZip } from './archive.js';
import type { PluginSourceInventory } from './build/plugin-assets.js';
import { verifyDist } from './dist.js';
import { isFilesystemPathWithin } from './filesystem-path.js';
import { buildProject, startDevProjectWithHost, startPreviewProjectWithHost } from './host.js';
import { GAME_PACKAGE_DOCUMENT_PATHS, readGamePackageDocuments } from './package-documents.js';
import { commandError, readProjectFacts } from './project.js';
import {
  bundleSingleHtmlEntry,
  packageFormatError,
  packageOutputError,
  writeSingleHtml,
} from './single-html.js';
import { installedProjectSkillDirectories } from './skill-install.js';

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
export type {
  ArtifactRef,
  CapturedRhiTape,
  ReplayBackendLease,
  RhiCaptureFrameValue,
  RhiDebugOperationContext,
  RhiDebugOperationDescriptor,
  RhiDebugOperationInput,
  RhiDebugOperationName,
  RhiDebugOperationOutput,
  RhiInspectInput,
  RhiInspectOutput,
  RhiSummaryInput,
  RhiSummaryOutput,
} from './rhi-debug/operations.js';
export {
  createRhiDebugOperationContext,
  discoverRhiDebugOperations,
  RHI_DEBUG_OPERATION_MANIFEST,
  recoverRhiDebugError,
  renderRhiDebugHelp,
  runRhiDebugOperation,
} from './rhi-debug/operations.js';
export { sdkInstallCommand } from './sdk-install.js';
export { shaderCheckCommand } from './shader-check.js';
export { skillInstallCommand, skillVerifyCommand } from './skill-install.js';

import {
  type RhiDebugOperationContext,
  type RhiDebugOperationInput,
  type RhiDebugOperationName,
  type RhiDebugOperationOutput,
  runRhiDebugOperation,
} from './rhi-debug/operations.js';
import type {
  BuildOptions,
  CommandResult,
  PackageOptions,
  ProjectCommandOptions,
} from './types.js';

export function runRhiDebugCommand(
  name: RhiDebugOperationName,
  input: RhiDebugOperationInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiDebugOperationOutput>> {
  return runRhiDebugOperation(name, input, context);
}

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

export async function packageCommand(
  options: PackageOptions = {},
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const format = options.format ?? 'web-zip';
  if (format !== 'web-zip' && format !== 'single-html') return packageFormatError(String(format));
  const defaultOutput =
    format === 'single-html'
      ? `release/${releaseSlug(facts.value.name)}-offline.html`
      : `release/${releaseSlug(facts.value.name)}-web.zip`;
  const output = resolve(facts.value.root, options.output ?? defaultOutput);
  const expectedSuffix = format === 'single-html' ? '.html' : '.zip';
  if (!output.toLowerCase().endsWith(expectedSuffix)) {
    return packageOutputError(output, format);
  }
  const distRoot = resolve(facts.value.root, 'dist');
  if (isFilesystemPathWithin(distRoot, output)) {
    return {
      ok: false,
      error: {
        code: 'release-output-inside-dist',
        expected: 'the release artifact to live outside the derived dist directory',
        hint: 'Use --output release/<game>-web.zip or release/<game>-offline.html.',
        detail: { output, distRoot, format },
      },
    };
  }
  const packageDocuments =
    format === 'web-zip' ? await readGamePackageDocuments(facts.value.root) : undefined;
  if (packageDocuments !== undefined && !packageDocuments.ok) return packageDocuments;
  const built = await buildCommand({
    root: facts.value.root,
    base: './',
    ...(options.json === undefined ? {} : { json: options.json }),
  });
  if (!built.ok) return built;
  const verified = await verifyDist(distRoot);
  if (!verified.ok) return verified;
  if (format === 'single-html') {
    const indexHtml = await readFile(resolve(distRoot, 'index.html'), 'utf8');
    const bundle = await bundleSingleHtmlEntry(distRoot, indexHtml, facts.value.root);
    if (!bundle.ok) return bundle;
    return writeSingleHtml({
      distRoot,
      output,
      manifest: verified.value,
      bundle: bundle.value,
    });
  }
  const archive = output;
  const temporaryArchive = `${archive}.partial-${process.pid}`;
  const checksumPath = `${archive}.sha256`;
  const temporaryChecksum = `${checksumPath}.partial-${process.pid}`;
  try {
    const paths = [
      ...verified.value.artifacts.map((artifact) => artifact.path),
      'forgeax-dist.json',
    ];
    const entries = await Promise.all(
      paths.map(async (path) => ({ path, bytes: await readFile(resolve(distRoot, path)) })),
    );
    const bytes = createZip([
      ...entries,
      ...(packageDocuments?.ok === true ? packageDocuments.value : []),
    ]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifestBytes = await readFile(resolve(distRoot, 'forgeax-dist.json'));
    await mkdir(dirname(archive), { recursive: true });
    await writeFile(temporaryArchive, bytes);
    await writeFile(temporaryChecksum, `${sha256}  ${basename(archive)}\n`);
    await rename(temporaryChecksum, checksumPath);
    await rename(temporaryArchive, archive);
    return {
      ok: true,
      value: {
        schemaVersion: '1.0.0',
        format: 'forgeax-web-game',
        target: 'web',
        project: verified.value.project,
        base: verified.value.base,
        engine: {
          delivery: 'bundled-runtime',
          wasm: verified.value.artifacts.some((artifact) => artifact.path.endsWith('.wasm')),
        },
        archive: { path: archive, bytes: bytes.byteLength, sha256 },
        documents: [...GAME_PACKAGE_DOCUMENT_PATHS],
        checksumPath,
        distManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        run: {
          local: 'forgeax project preview',
          shared: 'upload the ZIP to an HTTPS static or HTML-game host and share its URL',
        },
      },
    };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'game-package-failed') };
  } finally {
    await Promise.all([
      rm(temporaryArchive, { force: true }),
      rm(temporaryChecksum, { force: true }),
    ]);
  }
}

export async function devCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  return startDevProjectWithHost(options);
}

export async function previewCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  return startPreviewProjectWithHost(options);
}

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
        passWithNoTests: false,
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
      return {
        ok: false,
        error: {
          code: 'test-runner-unavailable',
          expected: 'Vitest to create a project test context',
          hint: 'Inspect the project test configuration.',
          detail: { root: facts.value.root },
        },
      };
    }
    const failed = context.state.getFiles().filter((file) => file.result?.state === 'fail');
    await context.close();
    if (failed.length > 0) {
      return {
        ok: false,
        error: {
          code: 'project-tests-failed',
          expected: 'all project tests to pass',
          hint: 'Repair the failing game test before building a release.',
          detail: { files: failed.map((file) => file.filepath) },
        },
      };
    }
    return { ok: true, value: { root: facts.value.root } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-tests-failed') };
  }
}
