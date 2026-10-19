import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { filesystemPathRelative } from './filesystem-path.js';
import { readProjectFacts } from './project.js';
import type { CommandError, CommandResult, ProjectCommandOptions } from './types.js';

export const ENGINE_BINDING_SCHEMA_VERSION = '1.0.0' as const;

export type EngineBindingMode = 'sdk' | 'local';

export interface EngineBinding {
  readonly schemaVersion: typeof ENGINE_BINDING_SCHEMA_VERSION;
  readonly path: string;
}

/** One path-addressed byte in a package's consumed runtime payload. */
export interface EngineRuntimeFile {
  readonly path: string;
  readonly digest: string;
}

export interface EnginePackageStatus {
  readonly name: string;
  readonly root: string;
  readonly version: string;
  readonly entry: string | null;
  readonly built: boolean;
  readonly entryDigest: string | null;
  readonly manifestDigest: string;
  readonly runtimeDigest: string;
  readonly runtimeFiles: readonly EngineRuntimeFile[];
  readonly builtAt: string | null;
}

export interface EngineWorkspaceStatus {
  readonly root: string;
  readonly packageCount: number;
  readonly builtPackages: number;
  readonly missingBuilds: readonly string[];
  readonly versions: readonly string[];
  readonly packages: readonly EnginePackageStatus[];
  readonly digest: string;
  readonly builtAt: string | null;
}

export interface EngineStatusReport {
  readonly schemaVersion: typeof ENGINE_BINDING_SCHEMA_VERSION;
  readonly root: string;
  readonly binding: EngineBinding | null;
  readonly mode: EngineBindingMode;
  readonly resolved: {
    readonly root: string | null;
    readonly version: string | null;
    readonly entry: string | null;
    readonly built: boolean;
    readonly source: 'sdk' | 'local' | 'unresolved';
  };
  readonly workspace: EngineWorkspaceStatus | null;
  readonly projectDependencies: 'registry' | 'workspace' | 'mixed' | 'none';
  readonly npmCompatible: boolean;
  readonly healthy: boolean;
  readonly next: readonly string[];
  readonly diagnostic?: CommandError;
}

export interface EngineBindingCommandOptions extends ProjectCommandOptions {
  readonly path?: string;
  readonly dryRun?: boolean;
}

interface PackageManifest extends Readonly<Record<string, unknown>> {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly main?: unknown;
  readonly module?: unknown;
  readonly exports?: unknown;
}

const bindingFile = (root: string): string => resolve(root, '.forgeax', 'engine-binding.json');

function bindingError(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

function isMissing(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseBinding(value: unknown, path: string): CommandResult<EngineBinding> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return bindingError(
      'engine-binding-invalid',
      'engine-binding.json to contain one object',
      'Run forgeax project engine unlink, then select a binding again.',
      { path },
    );
  }
  const candidate = value as {
    readonly schemaVersion?: unknown;
    readonly path?: unknown;
  };
  if (candidate.schemaVersion !== ENGINE_BINDING_SCHEMA_VERSION) {
    return bindingError(
      'engine-binding-version-unsupported',
      `engine-binding.json schemaVersion ${ENGINE_BINDING_SCHEMA_VERSION}`,
      'Upgrade the SDK or remove the stale binding with forgeax project engine unlink.',
      { path, schemaVersion: candidate.schemaVersion ?? null },
    );
  }
  if (typeof candidate.path !== 'string' || candidate.path.length === 0) {
    return bindingError(
      'engine-binding-path-missing',
      'engine-binding.json to contain one non-empty local Engine path',
      'Run forgeax project engine use-local <engine-directory>.',
      { path },
    );
  }
  return {
    ok: true,
    value: {
      schemaVersion: ENGINE_BINDING_SCHEMA_VERSION,
      path: resolve(candidate.path),
    },
  };
}

export async function readEngineBinding(
  rootInput = process.cwd(),
): Promise<CommandResult<EngineBinding | null>> {
  const root = resolve(rootInput);
  const path = bindingFile(root);
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parseBinding(value, path);
  } catch (cause) {
    if (isMissing(cause)) return { ok: true, value: null };
    return bindingError(
      'engine-binding-unreadable',
      'engine-binding.json to be readable JSON',
      'Repair or remove .forgeax/engine-binding.json, then select a binding again.',
      { path, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

async function writeEngineBinding(root: string, binding: EngineBinding): Promise<void> {
  const path = bindingFile(root);
  const partial = `${path}.partial-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(partial, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
  await rename(partial, path);
}

function conditionalExport(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['import', 'browser', 'node', 'default', 'require', 'types']) {
    const candidate = record[key];
    const selected = conditionalExport(candidate);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      result[key] = canonicalJson((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestText(value: string): string {
  return digestBytes(Buffer.from(value, 'utf8'));
}

function manifestDigest(manifest: PackageManifest): string {
  return digestText(JSON.stringify(canonicalJson(manifest)));
}

const nonRuntimeSuffixes = ['.d.ts.map', '.d.ts', '.map', '.tsbuildinfo', '.md'];
const nonRuntimePrefixes = ['dist/engine-inputs/'];

function isRuntimeFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    !nonRuntimePrefixes.some((prefix) => lower.startsWith(prefix)) &&
    !nonRuntimeSuffixes.some((suffix) => lower.endsWith(suffix))
  );
}

function packageRelativePath(packageRoot: string, target: string): string | null {
  const absolute = resolve(packageRoot, target);
  const candidate = filesystemPathRelative(packageRoot, absolute, false);
  if (candidate === undefined) return null;
  return candidate.split(sep).join('/');
}

function manifestRuntimeTargets(manifest: PackageManifest): readonly string[] {
  const targets: string[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (key === 'types') return;
    if (typeof value === 'string') {
      if (value.startsWith('./') && !value.includes('*') && value !== './package.json') {
        targets.push(value);
      }
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  for (const key of ['exports', 'main', 'module', 'browser', 'bin'] as const) visit(manifest[key]);
  return [...new Set(targets)].sort();
}

async function collectRuntimeFiles(
  packageRoot: string,
  manifest: PackageManifest,
): Promise<readonly EngineRuntimeFile[]> {
  const paths = new Set<string>();
  const addFile = async (absolute: string, relativePath?: string): Promise<void> => {
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(absolute);
    } catch {
      return;
    }
    if (!metadata.isFile()) return;
    const path = relativePath ?? packageRelativePath(packageRoot, absolute);
    if (path === null || !isRuntimeFile(path)) return;
    paths.add(path);
  };
  const walk = async (directory: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      if (isMissing(cause)) return;
      throw cause;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) await addFile(absolute);
    }
  };

  // Dist contains the complete bundler closure: public sub-entry modules and
  // the chunks they import. pkg/assets carry runtime JS/WASM and packaged
  // media which are outside dist and therefore need an explicit root.
  for (const root of ['dist', 'pkg', 'assets']) await walk(resolve(packageRoot, root));
  for (const target of manifestRuntimeTargets(manifest)) {
    const path = packageRelativePath(packageRoot, target);
    if (path !== null) await addFile(resolve(packageRoot, path), path);
  }

  const result: EngineRuntimeFile[] = [];
  for (const path of [...paths].sort()) {
    result.push({ path, digest: digestBytes(await readFile(resolve(packageRoot, path))) });
  }
  return result;
}

function runtimeDigest(files: readonly EngineRuntimeFile[]): string {
  return digestText(files.map((file) => `${file.path}\0${file.digest}`).join('\n'));
}

function packageEntry(manifest: PackageManifest): string | undefined {
  const exportsValue = manifest.exports;
  if (exportsValue !== undefined) {
    if (typeof exportsValue === 'object' && exportsValue !== null && !Array.isArray(exportsValue)) {
      const exportMap = exportsValue as Record<string, unknown>;
      const root = exportMap['.'];
      const selectedRoot = conditionalExport(root);
      if (selectedRoot !== undefined) return selectedRoot;

      // Some valid packages expose only named entry points (for example the
      // browser/node pair in net-websocket). The previous implementation
      // treated the subpath map as a condition map, so it never saw
      // `./browser` or `./node` and reported an already-built package as
      // missing. Pick one concrete runtime subpath for workspace identity;
      // package.json and wildcard entries are metadata/routing, not builds.
      for (const key of Object.keys(exportMap)
        .filter(
          (candidate) =>
            candidate.startsWith('./') &&
            candidate !== './package.json' &&
            !candidate.includes('*'),
        )
        .sort()) {
        const selected = conditionalExport(exportMap[key]);
        if (selected !== undefined) return selected;
      }
    }
    const selected = conditionalExport(exportsValue);
    if (selected !== undefined) return selected;
  }
  return typeof manifest.module === 'string'
    ? manifest.module
    : typeof manifest.main === 'string'
      ? manifest.main
      : undefined;
}

async function readManifest(path: string): Promise<PackageManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`engine-package-manifest-invalid: ${path}`);
  }
  return value as PackageManifest;
}

/** Byte identity for a selected installed package; shared with frontend source admission. */
export async function enginePackageRuntimeIdentity(packageRoot: string): Promise<string> {
  const manifest = await readManifest(resolve(packageRoot, 'package.json'));
  return digestText(
    `${manifestDigest(manifest)}\0${runtimeDigest(await collectRuntimeFiles(packageRoot, manifest))}`,
  );
}

export async function inspectEngineWorkspace(
  workspaceInput: string,
): Promise<CommandResult<EngineWorkspaceStatus>> {
  const root = resolve(workspaceInput);
  const packageRoot = resolve(root, 'packages');
  try {
    await access(resolve(root, 'pnpm-workspace.yaml'));
    const entries = await readdir(packageRoot, { withFileTypes: true });
    const packages: EnginePackageStatus[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packagePath = resolve(packageRoot, entry.name);
      let manifest: PackageManifest;
      try {
        manifest = await readManifest(resolve(packagePath, 'package.json'));
      } catch {
        continue;
      }
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@forgeax/engine'))
        continue;
      if (typeof manifest.version !== 'string') {
        return bindingError(
          'engine-package-version-missing',
          'every local Engine package to declare a version',
          'Restore the package manifest version before selecting a local Engine.',
          { package: manifest.name, root: packagePath },
        );
      }
      const target = packageEntry(manifest);
      const entryPath = target === undefined ? undefined : resolve(packagePath, target);
      let entryDigest: string | null = null;
      let builtAt: string | null = null;
      if (entryPath !== undefined && (await pathExists(entryPath))) {
        const [bytes, metadata] = await Promise.all([readFile(entryPath), stat(entryPath)]);
        entryDigest = digestBytes(bytes);
        builtAt = metadata.mtime.toISOString();
      }
      const runtimeFiles = await collectRuntimeFiles(packagePath, manifest);
      packages.push({
        name: manifest.name,
        root: packagePath,
        version: manifest.version,
        entry: entryPath ?? null,
        built: entryDigest !== null,
        entryDigest,
        manifestDigest: manifestDigest(manifest),
        runtimeDigest: runtimeDigest(runtimeFiles),
        runtimeFiles,
        builtAt,
      });
    }
    packages.sort((a, b) => a.name.localeCompare(b.name));
    if (packages.length === 0) {
      return bindingError(
        'engine-workspace-empty',
        'the local Engine workspace to contain @forgeax/engine packages',
        'Pass the Engine repository or its source/engine SDK directory.',
        { root, packageRoot },
      );
    }
    const versions = [...new Set(packages.map((item) => item.version))].sort();
    const missingBuilds = packages.filter((item) => !item.built).map((item) => item.name);
    const builtAt =
      packages
        .flatMap((item) => (item.builtAt === null ? [] : [item.builtAt]))
        .sort()
        .at(-1) ?? null;
    const digest = `sha256:${createHash('sha256')
      .update(
        packages
          .map((item) => `${item.name}\0${item.version}\0${item.entryDigest ?? 'unbuilt'}`)
          .map((identity, index) => {
            const item = packages[index];
            return `${identity}\0${item?.manifestDigest ?? 'unmanifested'}\0${item?.runtimeDigest ?? 'unruntime'}\0${item?.runtimeFiles.map((file) => `${file.path}\0${file.digest}`).join('\0') ?? ''}`;
          })
          .join('\n'),
      )
      .digest('hex')}`;
    return {
      ok: true,
      value: {
        root,
        packageCount: packages.length,
        builtPackages: packages.length - missingBuilds.length,
        missingBuilds,
        versions,
        packages,
        digest,
        builtAt,
      },
    };
  } catch (cause) {
    return bindingError(
      isMissing(cause) ? 'engine-workspace-missing' : 'engine-workspace-unreadable',
      'a readable Engine workspace with pnpm-workspace.yaml and packages/',
      'Pass the Engine repository root, not its packages/ directory.',
      { root, packageRoot, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function projectDependencyMode(
  packageJson: Readonly<Record<string, unknown>>,
): EngineStatusReport['projectDependencies'] {
  let workspace = false;
  let registry = false;
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const value = packageJson[section];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const version of Object.values(value)) {
      if (typeof version !== 'string') continue;
      if (version.startsWith('workspace:') || version.startsWith('file:')) workspace = true;
      else registry = true;
    }
  }
  return workspace ? (registry ? 'mixed' : 'workspace') : registry ? 'registry' : 'none';
}

async function sdkResolution(root: string): Promise<EngineStatusReport['resolved']> {
  const packageJson = resolve(root, 'node_modules', '@forgeax', 'engine', 'package.json');
  try {
    const manifest = await readManifest(packageJson);
    const target = packageEntry(manifest);
    const entry = target === undefined ? null : resolve(dirname(packageJson), target);
    return {
      root: dirname(packageJson),
      version: typeof manifest.version === 'string' ? manifest.version : null,
      entry,
      built: entry !== null && (await pathExists(entry)),
      source: 'sdk',
    };
  } catch {
    return { root: null, version: null, entry: null, built: false, source: 'unresolved' };
  }
}

export async function engineStatusCommand(
  options: EngineBindingCommandOptions = {},
): Promise<CommandResult<EngineStatusReport>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const bindingResult = await readEngineBinding(facts.value.root);
  if (!bindingResult.ok) return bindingResult;
  const binding = bindingResult.value;
  const mode: EngineBindingMode = binding === null ? 'sdk' : 'local';
  const projectDependencies = projectDependencyMode(facts.value.packageJson);
  if (binding !== null) {
    const localPath = binding.path;
    const localBinding: EngineBinding = {
      schemaVersion: ENGINE_BINDING_SCHEMA_VERSION,
      path: localPath,
    };
    const workspaceResult = await inspectEngineWorkspace(localPath);
    if (!workspaceResult.ok) {
      const resolved: EngineStatusReport['resolved'] = {
        root: localPath,
        version: null,
        entry: null,
        built: false,
        source: 'local',
      };
      return {
        ok: true,
        value: {
          schemaVersion: ENGINE_BINDING_SCHEMA_VERSION,
          root: facts.value.root,
          binding: localBinding,
          mode,
          resolved,
          workspace: null,
          projectDependencies,
          npmCompatible: projectDependencies === 'registry' || projectDependencies === 'none',
          healthy: false,
          next: [
            'forgeax project engine unlink',
            'forgeax project engine use-local <engine-directory>',
          ],
          diagnostic: workspaceResult.error,
        },
      };
    }
    const workspace = workspaceResult.value;
    const version = workspace.versions.length === 1 ? (workspace.versions[0] ?? null) : null;
    const umbrella = workspace.packages.find((item) => item.name === '@forgeax/engine');
    const resolved: EngineStatusReport['resolved'] = {
      root: localPath,
      version,
      entry: umbrella?.entry ?? null,
      built: umbrella?.built ?? false,
      source: 'local',
    };
    const healthy = workspace.versions.length === 1 && workspace.missingBuilds.length === 0;
    return {
      ok: true,
      value: {
        schemaVersion: ENGINE_BINDING_SCHEMA_VERSION,
        root: facts.value.root,
        binding: localBinding,
        mode,
        resolved,
        workspace,
        projectDependencies,
        npmCompatible: projectDependencies === 'registry' || projectDependencies === 'none',
        healthy,
        next: healthy
          ? ['forgeax project build', 'forgeax project capture --backend auto --require-ui']
          : ['pnpm build:engine', 'forgeax project engine check'],
      },
    };
  }
  const resolved = await sdkResolution(facts.value.root);
  return {
    ok: true,
    value: {
      schemaVersion: ENGINE_BINDING_SCHEMA_VERSION,
      root: facts.value.root,
      binding,
      mode,
      resolved,
      workspace: null,
      projectDependencies,
      npmCompatible: projectDependencies === 'registry' || projectDependencies === 'none',
      healthy: resolved.source === 'sdk' && resolved.built,
      next:
        resolved.source === 'sdk' && resolved.built
          ? ['forgeax project build', 'forgeax project capture --backend auto --require-ui']
          : ['pnpm install', 'forgeax project check'],
    },
  };
}

export async function engineUseLocalCommand(
  options: EngineBindingCommandOptions,
): Promise<CommandResult<EngineStatusReport>> {
  const root = resolve(options.root ?? process.cwd());
  if (options.path === undefined || options.path.trim().length === 0) {
    return bindingError(
      'engine-binding-path-missing',
      'forgeax project engine use-local <engine-directory>',
      'Pass the local Engine repository or SDK source directory.',
    );
  }
  let localPath: string;
  try {
    localPath = await realpath(resolve(root, options.path));
  } catch (cause) {
    return bindingError(
      'engine-workspace-missing',
      'the local Engine directory to exist',
      'Pass an existing Engine repository or SDK source directory.',
      {
        path: resolve(root, options.path),
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
  const workspace = await inspectEngineWorkspace(localPath);
  if (!workspace.ok) return workspace;
  const binding: EngineBinding = {
    schemaVersion: ENGINE_BINDING_SCHEMA_VERSION,
    path: localPath,
  };
  if (options.dryRun !== true) await writeEngineBinding(root, binding);
  const status = await engineStatusCommand({ root });
  if (!status.ok) return status;
  return {
    ok: true,
    value: {
      ...status.value,
      next:
        workspace.value.missingBuilds.length === 0
          ? ['forgeax project build', 'forgeax project capture --backend auto --require-ui']
          : ['pnpm build:engine', 'forgeax project engine check'],
    },
  };
}

export async function engineUnlinkCommand(
  options: EngineBindingCommandOptions = {},
): Promise<CommandResult<EngineStatusReport>> {
  const root = resolve(options.root ?? process.cwd());
  if (options.dryRun !== true) await rm(bindingFile(root), { force: true });
  return engineStatusCommand({ root });
}

export async function engineDoctorCommand(
  options: EngineBindingCommandOptions = {},
): Promise<CommandResult<EngineStatusReport>> {
  const status = await engineStatusCommand(options);
  if (!status.ok) return status;
  if (status.value.diagnostic !== undefined) return { ok: false, error: status.value.diagnostic };
  if (!status.value.healthy) {
    return {
      ok: false,
      error: {
        code:
          status.value.mode === 'local' ? 'engine-local-build-missing' : 'engine-sdk-unresolved',
        expected: 'the selected Engine binding to resolve to built packages',
        hint:
          status.value.mode === 'local'
            ? 'Run pnpm build:engine in the selected Engine checkout, then rerun forgeax project engine check.'
            : 'Run pnpm install in the game project or select a valid local Engine checkout.',
        detail: { status: status.value },
      },
    };
  }
  return status;
}

export function engineBindingFilePath(rootInput = process.cwd()): string {
  return bindingFile(resolve(rootInput));
}
