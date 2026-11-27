import { createHash } from 'node:crypto';
import { type BigIntStats, createReadStream, createWriteStream, realpathSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sha256 } from '@forgeax/engine-types';
import { packlist } from '@pnpm/fs.packlist';
import { parse } from 'yaml';
import {
  enginePackageRuntimeIdentity,
  inspectEngineWorkspace,
  packageTargetPaths,
  readEngineBinding,
} from './engine-binding.js';
import { filesystemPathRelative, isFilesystemPathWithin } from './filesystem-path.js';
import { parsePnpmLockDocuments } from './sdk-bootstrap.js';
import type { CommandError } from './types.js';

const omitted = new Set([
  '.git',
  '.agents',
  '.claude',
  '.codex',
  '.forgeax',
  '.forgeax-debug',
  '.forgeax-harness',
  '.worktrees',
  'node_modules',
  'artifacts',
  'coverage',
]);

export function runStateDirectory(projectRoot: string): string {
  let root = resolve(projectRoot);
  try {
    root = realpathSync.native(root);
  } catch (error) {
    // Missing projects retain the ordinary stopped-run lookup; other I/O errors
    // must not silently create another ownership identity.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity = sha256(root);
  return resolve(
    process.env.FORGEAX_RUNS_DIR ?? join(homedir(), '.local/share/ForgeaX/runs'),
    identity,
  );
}

interface SnapshotFile {
  readonly source: string;
  readonly target: string;
  readonly stamp: string;
  readonly mode: number;
  readonly size: number;
}

interface SnapshotPlan {
  readonly binding: string;
  readonly files: SnapshotFile[];
  readonly links: Array<{ readonly target: string; readonly destination: string }>;
  readonly proofs: SnapshotProof[];
}

interface SnapshotProof {
  readonly path: string;
  readonly realPath: string;
  readonly identity: string;
  readonly digest: string;
  readonly kind: 'file' | 'engine-runtime';
}

interface InstalledPackage {
  readonly path: string;
  readonly root: string;
}

interface PnpmLockEntry {
  readonly specifier?: unknown;
  readonly version?: unknown;
}

interface PnpmImporter {
  readonly dependencies?: Record<string, PnpmLockEntry>;
  readonly devDependencies?: Record<string, PnpmLockEntry>;
  readonly optionalDependencies?: Record<string, PnpmLockEntry>;
  readonly peerDependencies?: Record<string, PnpmLockEntry>;
}

interface PnpmLockfile {
  readonly lockfileVersion?: unknown;
  readonly overrides?: unknown;
  readonly importers?: Record<string, PnpmImporter>;
  readonly packages?: Record<string, { readonly resolution?: Record<string, unknown> }>;
  readonly snapshots?: Record<string, unknown>;
}

interface PnpmWorkspaceState {
  readonly projects?: Record<string, { readonly name?: unknown; readonly version?: unknown }>;
  readonly settings?: { readonly workspacePackagePatterns?: unknown };
}

interface PnpmModulesState {
  readonly packageManager?: unknown;
  readonly virtualStoreDir?: unknown;
  readonly virtualStoreDirMaxLength?: unknown;
}

interface PnpmContext {
  readonly root: string;
  readonly packageRoot: string;
  readonly importer: PnpmImporter;
  readonly lock: PnpmLockfile;
  readonly modules: PnpmModulesState;
  readonly proofs: Map<string, SnapshotProof>;
  readonly snapshotKey?: string;
  readonly sourceRoot?: string;
  readonly workspace?: {
    readonly state: PnpmWorkspaceState;
    readonly overrides: Readonly<Record<string, string>>;
  };
}

interface DependencyProofRequest {
  readonly expectedBinding: string;
  readonly expectedEngineDigest: string | undefined;
  readonly pnpmVersion: string;
}

class SnapshotChangedError extends Error {}

const SNAPSHOT_ATTEMPTS = 3;

/**
 * A package's published payload. npm-packlist also lists dependencies that
 * declared bundles reach outside the package (pnpm siblings, as `../`); those
 * are separate installed packages that the dependency traversal copies itself.
 */
async function packageFiles(root: string): Promise<string[]> {
  return (await packlist(root)).filter((file) => !file.startsWith('../')).sort();
}

function stamp(info: BigIntStats): { stamp: string; mode: number; size: number } {
  return {
    stamp: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(':'),
    mode: Number(info.mode),
    size: Number(info.size),
  };
}

function dependencyClosureError(
  code: string,
  reason: string,
  detail: Readonly<Record<string, unknown>> = {},
): Error & CommandError {
  const error = new Error(reason) as Error & CommandError;
  Object.assign(error, {
    code,
    expected: 'the installed dependency closure to match its package manifests and pnpm records',
    hint: 'Repair the package manifest, pnpm lockfile, local binding, or installed dependency link.',
    detail: { reason, ...detail },
  });
  return error;
}

function normalizeRecordedPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function workspaceProject(
  state: PnpmWorkspaceState,
  root: string,
): { readonly name?: unknown; readonly version?: unknown } | undefined {
  const projects = state.projects;
  if (projects === undefined) return undefined;
  const key = Object.keys(projects).find(
    (candidate) => normalizeRecordedPath(candidate) === normalizeRecordedPath(root),
  );
  return key === undefined ? undefined : projects[key];
}

function packageManifest(value: unknown, root: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw dependencyClosureError(
      'project-dependency-manifest-invalid',
      'Dependency package.json is not an object.',
      { root },
    );
  return value as Record<string, unknown>;
}

async function readPackageManifest(root: string): Promise<Record<string, unknown>> {
  try {
    return packageManifest(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), root);
  } catch (cause) {
    if (
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      cause.code === 'project-dependency-manifest-invalid'
    )
      throw cause;
    throw dependencyClosureError(
      'project-dependency-manifest-unreadable',
      'Dependency package.json could not be read.',
      {
        root,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

function contentDigest(content: Uint8Array): string {
  return sha256(content);
}

interface ProofPathIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly identity: string;
}

async function proofPathIdentity(path: string): Promise<ProofPathIdentity> {
  const absolute = resolve(path);
  const [resolvedPath, info, linkInfo] = await Promise.all([
    realpath(absolute),
    stat(absolute, { bigint: true }),
    lstat(absolute, { bigint: true }),
  ]);
  return {
    path: absolute,
    realPath: resolvedPath,
    identity: JSON.stringify([stamp(info).stamp, stamp(linkInfo).stamp, linkInfo.isSymbolicLink()]),
  };
}

function sameProof(left: SnapshotProof, right: SnapshotProof): boolean {
  return (
    left.path === right.path &&
    left.realPath === right.realPath &&
    left.identity === right.identity &&
    left.digest === right.digest &&
    left.kind === right.kind
  );
}

function recordSnapshotProof(proofs: Map<string, SnapshotProof>, proof: SnapshotProof): void {
  const key = normalizeRecordedPath(proof.path);
  const previous = proofs.get(key);
  if (previous !== undefined && !sameProof(previous, proof))
    throw dependencySourceChanged(proof.path);
  proofs.set(key, proof);
}

async function readProvenFile(proofs: Map<string, SnapshotProof>, path: string): Promise<Buffer> {
  const identity = await proofPathIdentity(path);
  const content = await readFile(path);
  recordSnapshotProof(proofs, {
    ...identity,
    digest: contentDigest(content),
    kind: 'file',
  });
  return content;
}

async function rememberEngineRuntimeProof(
  proofs: Map<string, SnapshotProof>,
  path: string,
): Promise<void> {
  const identity = await proofPathIdentity(path);
  const digest = await enginePackageRuntimeIdentity(identity.realPath);
  recordSnapshotProof(proofs, { ...identity, digest, kind: 'engine-runtime' });
}

function proofPathMatches(proof: SnapshotProof, identity: ProofPathIdentity): boolean {
  return (
    normalizeRecordedPath(proof.path) === normalizeRecordedPath(identity.path) &&
    normalizeRecordedPath(proof.realPath) === normalizeRecordedPath(identity.realPath) &&
    proof.identity === identity.identity
  );
}

function dependencySourceChanged(path: string, cause?: unknown): Error & CommandError {
  const error = dependencyClosureError(
    'project-dependency-source-changed',
    'A pnpm record or installed package identity changed during dependency inspection.',
    { path, ...(cause instanceof Error ? { reason: cause.message } : {}) },
  );
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function isDependencySourceChanged(error: unknown): error is Error & CommandError {
  return (
    error instanceof Error && 'code' in error && error.code === 'project-dependency-source-changed'
  );
}

async function verifySnapshotProofs(proofs: readonly SnapshotProof[]): Promise<void> {
  for (const proof of proofs) {
    try {
      const before = await proofPathIdentity(proof.path);
      if (!proofPathMatches(proof, before)) throw dependencySourceChanged(proof.path);
      const digest =
        proof.kind === 'file'
          ? contentDigest(await readFile(proof.path))
          : await enginePackageRuntimeIdentity(proof.realPath);
      const after = await proofPathIdentity(proof.path);
      if (!proofPathMatches(proof, after) || digest !== proof.digest)
        throw dependencySourceChanged(proof.path);
    } catch (cause) {
      if (isDependencySourceChanged(cause)) throw cause;
      throw dependencySourceChanged(proof.path, cause);
    }
  }
}

function parsePnpmLockfile(bytes: Buffer): PnpmLockfile {
  const lock = parsePnpmLockDocuments(bytes.toString('utf8')).at(-1)?.toJS() as
    | PnpmLockfile
    | undefined;
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock))
    throw new Error('The pnpm project lockfile document must be a mapping.');
  return lock;
}

async function readPnpmWorkspace(
  root: string,
  lock: PnpmLockfile,
  modules: PnpmModulesState,
  proofs: Map<string, SnapshotProof>,
): Promise<NonNullable<PnpmContext['workspace']>> {
  let workspaceManifest: unknown;
  let state: PnpmWorkspaceState;
  try {
    const workspacePath = join(root, 'pnpm-workspace.yaml');
    const workspaceStatePath = join(root, 'node_modules', '.pnpm-workspace-state-v1.json');
    const [workspaceBytes, workspaceStateBytes] = await Promise.all([
      readProvenFile(proofs, workspacePath),
      readProvenFile(proofs, workspaceStatePath),
    ]);
    workspaceManifest = parse(workspaceBytes.toString('utf8')) as unknown;
    state = JSON.parse(workspaceStateBytes.toString('utf8')) as PnpmWorkspaceState;
  } catch (cause) {
    if (isDependencySourceChanged(cause)) throw cause;
    throw dependencyClosureError(
      'project-pnpm-workspace-state-missing',
      'pnpm workspace patterns or installed workspace state are unavailable.',
      {
        root,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
  const configuredPatterns = (workspaceManifest as { readonly packages?: unknown } | null)
    ?.packages;
  const patterns = configuredPatterns === undefined ? [] : configuredPatterns;
  // pnpm 12's native writer may omit this optional setting. Installed
  // project identities and lock locators remain the workspace authority.
  const recordedPatterns = state.settings?.workspacePackagePatterns;
  // A configuration-only workspace has an implicit root package. pnpm 12
  // records that root as ['.']; explicit package selections remain exact.
  const implicitRoot =
    configuredPatterns === undefined &&
    Array.isArray(recordedPatterns) &&
    recordedPatterns.length === 1 &&
    recordedPatterns[0] === '.';
  if (
    !Array.isArray(patterns) ||
    patterns.some((pattern) => typeof pattern !== 'string') ||
    (recordedPatterns !== undefined &&
      (!Array.isArray(recordedPatterns) ||
        (!implicitRoot && JSON.stringify(patterns) !== JSON.stringify(recordedPatterns))))
  )
    throw dependencyClosureError(
      'project-pnpm-workspace-state-stale',
      'pnpm installed workspace patterns do not match pnpm-workspace.yaml.',
      {
        root,
      },
    );
  const configuredOverrides = pnpmOverrides(
    (workspaceManifest as { readonly overrides?: unknown }).overrides,
    root,
  );
  const lockedOverrides = pnpmOverrides(lock.overrides, root);
  if (JSON.stringify(configuredOverrides) !== JSON.stringify(lockedOverrides))
    throw dependencyClosureError(
      'project-pnpm-overrides-mismatch',
      'The installing workspace overrides differ from the project lockfile.',
      { root },
    );
  if (Object.keys(configuredOverrides).length > 0) {
    if (typeof modules.virtualStoreDir !== 'string')
      throw dependencyClosureError(
        'project-pnpm-overrides-mismatch',
        'The overridden dependency graph has no installed virtual-store identity.',
        { root },
      );
    const installedLockBytes = await readProvenFile(
      proofs,
      join(resolve(root, modules.virtualStoreDir), 'lock.yaml'),
    );
    const installedLock = parsePnpmLockfile(installedLockBytes);
    if (
      JSON.stringify(pnpmOverrides(installedLock.overrides, root)) !==
        JSON.stringify(lockedOverrides) ||
      JSON.stringify(installedLock.importers) !== JSON.stringify(lock.importers)
    )
      throw dependencyClosureError(
        'project-pnpm-overrides-mismatch',
        'The installed override graph or importers differ from the project lockfile.',
        { root },
      );
  }
  return { state, overrides: configuredOverrides };
}

async function pnpmRoots(packageRoot: string): Promise<{
  readonly root: string | undefined;
  readonly workspaceRoot: string | undefined;
}> {
  let workspaceRoot: string | undefined;
  let lockRoot: string | undefined;
  for (let directory = packageRoot; ; directory = dirname(directory)) {
    if (lockRoot === undefined && (await pathIsFile(join(directory, 'pnpm-lock.yaml'))))
      lockRoot = directory;
    if (await pathIsFile(join(directory, 'pnpm-workspace.yaml'))) {
      if (
        (await pathIsFile(join(directory, 'pnpm-lock.yaml'))) ||
        (await pathIsFile(join(directory, 'node_modules/.modules.yaml')))
      ) {
        workspaceRoot = directory;
        break;
      }
      const manifest = parse(await readFile(join(directory, 'pnpm-workspace.yaml'), 'utf8')) as {
        readonly packages?: unknown;
      } | null;
      // Template policy files without an installation do not own source-workspace packages.
      if (Array.isArray(manifest?.packages)) {
        workspaceRoot = directory;
        break;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
  }
  const root = workspaceRoot ?? (lockRoot === packageRoot ? packageRoot : undefined);
  return { root, workspaceRoot };
}

type LocalDependencyProtocol = 'workspace:' | 'file:' | 'link:';

export function localDependencyProtocol(specifier: string): LocalDependencyProtocol | undefined {
  if (specifier.startsWith('workspace:')) return 'workspace:';
  if (specifier.startsWith('file:')) return 'file:';
  return specifier.startsWith('link:') ? 'link:' : undefined;
}

/** Require an Engine binding even when pnpm supplies the local specifier via an override. */
export async function hasLocalEngineDependencyOverride(projectRoot: string): Promise<boolean> {
  const { workspaceRoot } = await pnpmRoots(await realpath(projectRoot));
  if (workspaceRoot === undefined) return false;
  const manifest = parse(await readFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8')) as {
    readonly overrides?: unknown;
  } | null;
  return Object.entries(pnpmOverrides(manifest?.overrides, workspaceRoot)).some(
    ([name, specifier]) =>
      isEngineDependency(name) && localDependencyProtocol(specifier) !== undefined,
  );
}

function pnpmImporter(
  root: string,
  packageRoot: string,
  lock: PnpmLockfile,
  linked = false,
): PnpmImporter {
  const path = filesystemPathRelative(root, packageRoot);
  if (path === undefined)
    throw dependencyClosureError(
      'project-pnpm-importer-mismatch',
      linked
        ? 'The linked package is outside its installing pnpm workspace.'
        : 'The package is outside its pnpm workspace root.',
      { packageRoot, root },
    );
  const key = path === '' ? '.' : path.split(sep).join('/');
  const importer = lock.importers?.[key];
  if (importer === undefined)
    throw dependencyClosureError(
      'project-pnpm-importer-missing',
      linked
        ? 'The linked package has no importer in its installing pnpm lockfile.'
        : 'The current package has no importer in pnpm-lock.yaml.',
      { importer: key, packageRoot, root },
    );
  return importer;
}

async function pnpmContext(
  packageRootInput: string,
  expectedPnpmVersion: string,
  proofs: Map<string, SnapshotProof>,
): Promise<PnpmContext> {
  const packageRoot = await realpath(packageRootInput);
  const { root, workspaceRoot } = await pnpmRoots(packageRoot);
  if (root === undefined)
    throw dependencyClosureError(
      'project-pnpm-record-missing',
      'No pnpm workspace or project lockfile owns this package.',
      {
        packageRoot,
      },
    );

  let lock: PnpmLockfile;
  let modules: PnpmModulesState;
  const lockPath = join(root, 'pnpm-lock.yaml');
  const modulesPath = join(root, 'node_modules', '.modules.yaml');
  try {
    const [lockBytes, modulesBytes] = await Promise.all([
      readProvenFile(proofs, lockPath),
      readProvenFile(proofs, modulesPath),
    ]);
    lock = parsePnpmLockfile(lockBytes);
    modules = parse(modulesBytes.toString('utf8')) as PnpmModulesState;
    // Relative store paths belong to .modules.yaml's directory, not the workspace root.
    if (typeof modules.virtualStoreDir === 'string')
      modules = {
        ...modules,
        virtualStoreDir: resolve(dirname(modulesPath), modules.virtualStoreDir),
      };
  } catch (cause) {
    if (isDependencySourceChanged(cause)) throw cause;
    throw dependencyClosureError(
      'project-pnpm-record-unreadable',
      'The pnpm lockfile or installed module metadata is unavailable.',
      {
        root,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
  if (String(lock.lockfileVersion) !== '9.0')
    throw dependencyClosureError(
      'project-pnpm-lock-unsupported',
      'Only pnpm lockfile version 9.0 is supported for local dependency proof.',
      {
        root,
        lockfileVersion: lock.lockfileVersion ?? null,
      },
    );
  if (modules.packageManager !== `pnpm@${expectedPnpmVersion}`)
    throw dependencyClosureError(
      'project-pnpm-install-mismatch',
      'Installed modules were not produced by the package-manager version reported by doctor.',
      {
        root,
        expected: `pnpm@${expectedPnpmVersion}`,
        actual: modules.packageManager ?? null,
      },
    );

  const importer = pnpmImporter(root, packageRoot, lock);

  let workspace: PnpmContext['workspace'];
  if (workspaceRoot !== undefined) {
    workspace = await readPnpmWorkspace(root, lock, modules, proofs);
  }
  return {
    root,
    packageRoot,
    importer,
    lock,
    modules,
    proofs,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function assertWorkspaceProject(
  context: PnpmContext,
  packageRoot: string,
  manifest: Record<string, unknown>,
  dependency: string,
): void {
  if (context.snapshotKey !== undefined && packageRoot === context.packageRoot) return;
  if (context.workspace === undefined) return;
  const installed = workspaceProject(context.workspace.state, packageRoot);
  if (
    installed === undefined ||
    installed.name !== manifest.name ||
    (typeof manifest.version === 'string' && installed.version !== manifest.version)
  )
    throw dependencyClosureError(
      'project-workspace-package-mismatch',
      'The current workspace package differs from pnpm installed workspace identity.',
      {
        dependency,
        packageRoot,
        expectedName: manifest.name ?? null,
        installedName: installed?.name ?? null,
        expectedVersion: manifest.version ?? null,
        installedVersion: installed?.version ?? null,
      },
    );
}

function isEngineDependency(name: string): boolean {
  return name === '@forgeax/engine' || name.startsWith('@forgeax/engine-');
}

function pnpmOverrides(value: unknown, root: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  )
    throw dependencyClosureError(
      'project-pnpm-overrides-mismatch',
      'pnpm overrides must be a mapping of selectors to string specifiers.',
      { root },
    );
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function dependencySpecifier(context: PnpmContext, name: string, declared: string): string {
  const overrides = context.workspace?.overrides ?? {};
  const owner =
    context.workspace === undefined
      ? undefined
      : workspaceProject(context.workspace.state, context.packageRoot)?.name;
  const scoped = typeof owner === 'string' ? `${owner}>${name}` : undefined;
  const selectedRule = scoped !== undefined && Object.hasOwn(overrides, scoped) ? scoped : name;
  if (!Object.hasOwn(overrides, selectedRule)) return declared;
  const selected = overrides[selectedRule] as string;
  // Resolve only unambiguous exact selectors. Other matching selector shapes
  // are left to pnpm and cannot be independently proven by this local doctor.
  const competing = Object.keys(overrides).some((selector) => {
    if (selector === selectedRule) return false;
    const target = selector.slice(selector.lastIndexOf('>') + 1).trim();
    return target === name || target.startsWith(`${name}@`);
  });
  if (competing || selected === '-' || selected.startsWith('$') || selected.startsWith('catalog:'))
    throw dependencyClosureError(
      'project-pnpm-override-unsupported',
      'This dependency override needs selector, removal, or catalog resolution that is not proven by the local doctor.',
      { root: context.root, dependency: name, declared, override: selected },
    );
  if (!selected.startsWith('link:./') && !selected.startsWith('link:../')) return selected;
  const target = resolve(context.root, selected.slice('link:'.length));
  return `link:${relative(context.packageRoot, target).split(sep).join('/') || '.'}`;
}

function lockEntry(context: PnpmContext, name: string, specifier: string): string {
  if (context.snapshotKey !== undefined) {
    const snapshot = context.lock.snapshots?.[context.snapshotKey] as
      | {
          readonly dependencies?: Record<string, unknown>;
          readonly optionalDependencies?: Record<string, unknown>;
        }
      | undefined;
    const locator = snapshot?.dependencies?.[name] ?? snapshot?.optionalDependencies?.[name];
    if (typeof locator !== 'string')
      throw dependencyClosureError(
        'project-pnpm-dependency-mismatch',
        'The installed file package dependency has no selected pnpm snapshot locator.',
        { dependency: name, from: context.packageRoot, snapshot: context.snapshotKey },
      );
    return locator;
  }
  const candidates = [
    context.importer.dependencies?.[name],
    context.importer.devDependencies?.[name],
    context.importer.optionalDependencies?.[name],
    context.importer.peerDependencies?.[name],
  ].filter((entry): entry is PnpmLockEntry => entry !== undefined);
  const entry = candidates.find((candidate) => candidate.specifier === specifier);
  if (entry === undefined || typeof entry.version !== 'string')
    throw dependencyClosureError(
      'project-pnpm-dependency-mismatch',
      'The package manifest dependency does not match its pnpm importer record.',
      {
        dependency: name,
        from: context.packageRoot,
        specifier,
        recorded: candidates.map((candidate) => ({
          specifier: candidate.specifier ?? null,
          version: candidate.version ?? null,
        })),
      },
    );
  if (candidates.length !== 1)
    throw dependencyClosureError(
      'project-pnpm-dependency-ambiguous',
      'The pnpm importer contains more than one record for a dependency.',
      {
        dependency: name,
        from: context.packageRoot,
      },
    );
  return entry.version;
}

function pnpmVirtualStoreEntry(depPath: string, maxLength: number): string | undefined {
  if (!Number.isSafeInteger(maxLength) || maxLength < 33) return undefined;
  let filename = depPath.replace(/[\\/:*?"<>|#]/g, '+');
  if (filename.includes('(')) filename = filename.replace(/\)$/, '').replace(/\)\(|\(|\)/g, '_');
  if (
    filename.length > maxLength ||
    (filename !== filename.toLowerCase() && !filename.startsWith('file+'))
  ) {
    const hash = sha256(filename).slice(0, 32);
    return `${filename.slice(0, maxLength - 33)}_${hash}`;
  }
  return filename;
}

function isPackageName(value: string): boolean {
  return /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(value);
}

function npmAliasTarget(specifier: string): string | undefined {
  if (!specifier.startsWith('npm:')) return undefined;
  const target = packageReference(specifier.slice('npm:'.length));
  return target !== undefined && isPackageName(target.name) ? target.name : undefined;
}

function packageReference(locator: string) {
  const separator = locator.indexOf('@', locator.startsWith('@') ? locator.indexOf('/') + 1 : 0);
  if (separator <= 0 || separator === locator.length - 1) return undefined;
  return { name: locator.slice(0, separator), reference: locator.slice(separator + 1) };
}

/** Package content ignores peers. Snapshot identity still includes its peer-qualified locator. */
function lockedSnapshotIdentity(lock: PnpmLockfile, locator: string) {
  const identity = packageReference(locator);
  const version = identity?.reference.split('(')[0];
  if (
    !identity ||
    !version ||
    lock.packages?.[`${identity.name}@${version}`] === undefined ||
    !Object.hasOwn(lock.snapshots ?? {}, locator)
  )
    return undefined;
  return { name: identity.name, version };
}

async function resolveVirtualStore(
  context: PnpmContext,
  fail: (reason: string, missingLayout?: boolean) => never,
): Promise<{ root: string; maxLength: number }> {
  const { virtualStoreDir, virtualStoreDirMaxLength } = context.modules;
  if (typeof virtualStoreDir !== 'string' || typeof virtualStoreDirMaxLength !== 'number')
    fail('Installed pnpm metadata does not identify a bounded virtual-store layout.', true);
  try {
    return {
      root: await realpath(resolve(context.root, virtualStoreDir)),
      maxLength: virtualStoreDirMaxLength,
    };
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}

async function resolveVirtualPackage(
  store: { root: string; maxLength: number },
  locator: string,
  name: string,
  fail: (reason: string) => never,
  unrepresentable: string,
): Promise<string> {
  const entry = pnpmVirtualStoreEntry(locator, store.maxLength);
  if (entry === undefined) fail(unrepresentable);
  try {
    return await realpath(join(store.root, entry, 'node_modules', ...name.split('/')));
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}

async function matchesVirtualPackageLink(
  actual: InstalledPackage,
  store: string,
  expected: string,
): Promise<boolean> {
  return (
    normalizeRecordedPath(expected) === normalizeRecordedPath(actual.root) &&
    isFilesystemPathWithin(store, actual.root) &&
    (await lstat(actual.path)).isSymbolicLink()
  );
}

async function verifyNpmAliasPlacement(
  context: PnpmContext,
  dependency: string,
  targetName: string,
  locator: string,
  actual: InstalledPackage,
  actualManifest: Record<string, unknown>,
): Promise<void> {
  const identity = lockedSnapshotIdentity(context.lock, locator);
  if (
    identity === undefined ||
    identity.name !== targetName ||
    typeof actualManifest.version !== 'string' ||
    identity.version !== actualManifest.version
  )
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      'The npm alias target does not match its pnpm locator and installed package manifest.',
      {
        dependency,
        targetName,
        locator,
        actualName: actualManifest.name ?? null,
        actualVersion: actualManifest.version ?? null,
      },
    );

  const fail = (reason: string, missingLayout = false): never => {
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      missingLayout
        ? 'Installed pnpm metadata does not identify a bounded virtual-store layout for the npm alias.'
        : 'The npm alias target has no resolvable pnpm virtual-store placement.',
      { dependency, locator, installed: actual.root, ...(missingLayout ? {} : { reason }) },
    );
  };
  const store = await resolveVirtualStore(context, fail);
  const expectedPackageRoot = await resolveVirtualPackage(
    store,
    locator,
    targetName,
    fail,
    'The pnpm locator exceeds the recorded store layout.',
  );
  if (!(await matchesVirtualPackageLink(actual, store.root, expectedPackageRoot)))
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      'The installed npm alias link does not resolve to the package placement selected by its pnpm locator.',
      {
        dependency,
        targetName,
        locator,
        installed: actual.root,
        expected: expectedPackageRoot,
      },
    );
}

function fileDependencyUnverified(
  dependency: string,
  declaredTarget: string,
  installed: string,
  reason: string,
): never {
  throw dependencyClosureError(
    'project-file-dependency-unverified',
    'The installed file package copy cannot be proven equal to its declared directory source and pnpm placement.',
    { dependency, declaredTarget, installed, reason },
  );
}

async function verifyFileDependencyPlacement(
  context: PnpmContext,
  name: string,
  locator: string,
  declaredTarget: string,
  actual: InstalledPackage,
): Promise<void> {
  const fail = (reason: string): never =>
    fileDependencyUnverified(name, declaredTarget, actual.root, reason);
  const store = await resolveVirtualStore(context, fail);
  const virtualLock = await readProvenFile(context.proofs, join(store.root, 'lock.yaml'))
    .then(parsePnpmLockfile)
    .catch((cause) => {
      if (isDependencySourceChanged(cause)) throw cause;
      return fail(cause instanceof Error ? cause.message : String(cause));
    });
  if (JSON.stringify(virtualLock) !== JSON.stringify(context.lock))
    fail('The installed virtual-store lock does not match the project lockfile.');
  const snapshotKey = `${name}@${locator}`;
  if (lockedSnapshotIdentity(context.lock, snapshotKey) === undefined)
    fail(
      'The current lockfile does not resolve the declared installed package snapshot for this locator.',
    );
  const expected = await resolveVirtualPackage(
    store,
    snapshotKey,
    name,
    fail,
    'The pnpm locator cannot be represented within the recorded virtual-store path limit.',
  );
  if (!(await matchesVirtualPackageLink(actual, store.root, expected)))
    fail(
      'The installed link does not resolve to the package placement selected by its pnpm locator.',
    );
}

async function packageFileMatches(source: string, installed: string): Promise<boolean> {
  const [sourceInfo, installedInfo] = await Promise.all([lstat(source), lstat(installed)]);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    !installedInfo.isFile() ||
    installedInfo.isSymbolicLink() ||
    sourceInfo.size !== installedInfo.size ||
    (sourceInfo.mode & 0o111) !== (installedInfo.mode & 0o111)
  )
    return false;
  const digest = async (path: string): Promise<string> => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  };
  const [sourceDigest, installedDigest] = await Promise.all([digest(source), digest(installed)]);
  return sourceDigest === installedDigest;
}

async function packagePayloadMatches(source: string, installed: string): Promise<boolean> {
  const [files, installedFiles] = await Promise.all([
    packageFiles(source),
    packageFiles(installed),
  ]);
  if (JSON.stringify(files) !== JSON.stringify(installedFiles)) return false;
  for (const file of files)
    if (!(await packageFileMatches(join(source, file), join(installed, file)))) return false;
  return true;
}

interface DependencyPlacement {
  readonly source: string;
  readonly name: string;
  readonly specifier: string;
  readonly actual: InstalledPackage;
  readonly actualManifest: Record<string, unknown>;
  readonly context: PnpmContext;
  readonly boundPackage: string | undefined;
  readonly locator: string;
}

function resolveLockedLink(context: PnpmContext, locator: string): Promise<string> {
  // Snapshot links are relative to the install root, unlike importer links.
  const owner = context.snapshotKey === undefined ? context.packageRoot : context.root;
  return realpath(resolve(owner, locator.slice('link:'.length)));
}

function matchesInstalledSource(
  actual: InstalledPackage,
  source: string,
  binding?: string,
): boolean {
  return actual.root === source && (binding === undefined || source === binding);
}

function dependencyDeclaration({ name, source, specifier, locator }: DependencyPlacement) {
  return { dependency: name, from: source, specifier, locator };
}

async function verifyLinkedDependency(placement: DependencyPlacement): Promise<string> {
  const { source, name, specifier, actual, context, boundPackage, locator } = placement;
  if (context.snapshotKey !== undefined && isEngineDependency(name) && boundPackage === undefined)
    throw dependencyClosureError(
      'project-local-dependency',
      'Local Engine packages require an explicit healthy Engine source binding.',
      { dependencies: [name] },
    );
  if (!locator.startsWith('link:'))
    throw dependencyClosureError(
      'project-pnpm-dependency-mismatch',
      'A linked dependency is not recorded as a pnpm link locator.',
      { dependency: name, from: source, specifier, locator },
    );
  let declaredTarget: string;
  let lockedTarget: string;
  try {
    lockedTarget = await resolveLockedLink(context, locator);
    declaredTarget = specifier.startsWith('link:')
      ? await resolveDeclaredDependency(context, specifier, 'link:')
      : lockedTarget;
  } catch (cause) {
    throw dependencyClosureError(
      'project-dependency-link-unresolved',
      'The declared or locked dependency link target is unavailable.',
      {
        ...dependencyDeclaration(placement),
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
  if (
    !(await lstat(actual.path)).isSymbolicLink() ||
    declaredTarget !== lockedTarget ||
    !matchesInstalledSource(actual, declaredTarget, boundPackage)
  )
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      'The installed symbolic link must match its declaration, pnpm locator and Engine binding.',
      {
        ...dependencyDeclaration(placement),
        declaredTarget,
        lockedTarget,
        installed: actual.root,
        boundPackage: boundPackage ?? null,
      },
    );
  return declaredTarget;
}

async function verifyWorkspaceDependency(placement: DependencyPlacement): Promise<string> {
  const { source, name, actual, context, boundPackage, locator } = placement;
  if (!locator.startsWith('link:'))
    throw dependencyClosureError(
      'project-workspace-locator-mismatch',
      'A workspace dependency is not recorded as a pnpm workspace link.',
      {
        ...dependencyDeclaration(placement),
      },
    );
  if (context.workspace === undefined)
    throw dependencyClosureError(
      'project-workspace-state-missing',
      'A workspace dependency has no normal pnpm workspace state.',
      {
        dependency: name,
        from: source,
      },
    );
  const target = await resolveLockedLink(context, locator);
  if (!matchesInstalledSource(actual, target, boundPackage))
    throw dependencyClosureError(
      'project-workspace-locator-mismatch',
      'The installed workspace package does not resolve to the lockfile and Engine binding target.',
      {
        dependency: name,
        from: source,
        locator,
        installed: actual.root,
        boundPackage: boundPackage ?? null,
        target,
      },
    );
  const targetManifest = await readPackageManifest(target);
  if (targetManifest.name !== name)
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      'The workspace target package name does not match its requested name.',
      {
        dependency: name,
        target,
        actualName: targetManifest.name ?? null,
      },
    );
  assertWorkspaceProject(context, target, targetManifest, name);
  return target;
}

type VerifiedPlacement = {
  readonly installed: string;
  readonly fileCopy?: { readonly manifestRoot: string; readonly snapshotKey: string };
};

function resolveDeclaredDependency(
  context: PnpmContext,
  specifier: string,
  protocol: 'file:' | 'link:',
): Promise<string> {
  return realpath(
    resolve(context.sourceRoot ?? context.packageRoot, specifier.slice(protocol.length)),
  );
}

function filePlacement(
  { boundPackage, actual, name, locator }: DependencyPlacement,
  manifestRoot: string,
): VerifiedPlacement {
  return boundPackage === undefined && actual.root !== manifestRoot
    ? { installed: actual.root, fileCopy: { manifestRoot, snapshotKey: `${name}@${locator}` } }
    : { installed: boundPackage ?? actual.root };
}

async function verifyFileDependency(placement: DependencyPlacement): Promise<VerifiedPlacement> {
  const { source, name, specifier, actual, actualManifest, context, boundPackage, locator } =
    placement;
  if (!locator.startsWith('file:'))
    throw dependencyClosureError(
      'project-file-locator-mismatch',
      'A file dependency is not recorded as a pnpm file locator.',
      {
        ...dependencyDeclaration(placement),
      },
    );
  const declaredTarget = await resolveDeclaredDependency(context, specifier, 'file:');
  const targetStat = await stat(declaredTarget);
  if (!targetStat.isDirectory())
    throw dependencyClosureError(
      'project-file-dependency-unsupported',
      'Only file: directory dependencies are supported; archive inputs are not proven by this doctor leaf.',
      {
        dependency: name,
        from: source,
        target: declaredTarget,
      },
    );
  const resolution = context.lock.packages?.[`${name}@${locator.split('(')[0]}`]?.resolution;
  if (resolution?.type !== 'directory' || typeof resolution.directory !== 'string')
    throw dependencyClosureError(
      'project-file-dependency-unsupported',
      'The pnpm lockfile does not identify a file directory source for this dependency.',
      {
        dependency: name,
        locator,
        resolution: resolution ?? null,
      },
    );
  const lockedTarget = await realpath(resolve(context.root, resolution.directory));
  if (
    lockedTarget !== declaredTarget ||
    (boundPackage !== undefined && lockedTarget !== boundPackage)
  )
    throw dependencyClosureError(
      'project-file-locator-mismatch',
      'The file dependency source differs from its pnpm lock locator or Engine binding.',
      {
        ...dependencyDeclaration(placement),
        lockedTarget,
        declaredTarget,
        boundPackage: boundPackage ?? null,
      },
    );
  const sourceManifest = await readPackageManifest(declaredTarget);
  if (sourceManifest.name !== name || actualManifest.name !== name)
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      'The file dependency package name does not match its requested name.',
      {
        dependency: name,
        declaredTarget,
        actualName: actualManifest.name ?? null,
        sourceName: sourceManifest.name ?? null,
      },
    );
  if (actual.root !== declaredTarget) {
    await verifyFileDependencyPlacement(context, name, locator, declaredTarget, actual);
    if (!(await packagePayloadMatches(declaredTarget, actual.root)))
      fileDependencyUnverified(
        name,
        declaredTarget,
        actual.root,
        'The installed package payload differs from its declared directory source.',
      );
  }
  return filePlacement(placement, declaredTarget);
}

async function verifyRegistryDependency({
  name,
  specifier,
  actual,
  actualManifest,
  context,
  boundPackage,
  locator,
}: DependencyPlacement): Promise<string> {
  const resolvedVersion = locator.split('(')[0];
  if (typeof actualManifest.version !== 'string' || resolvedVersion !== actualManifest.version)
    throw dependencyClosureError(
      'project-engine-version-mismatch',
      'The installed registry package version does not match the version resolved by pnpm.',
      {
        dependency: name,
        specifier,
        locator,
        installedName: actualManifest.name ?? null,
        installedVersion: actualManifest.version ?? null,
      },
    );
  const boundManifest =
    boundPackage === undefined ? undefined : await readPackageManifest(boundPackage);
  if (
    boundManifest !== undefined &&
    (boundManifest.name !== name || typeof boundManifest.version !== 'string')
  )
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      'The selected local Engine package does not match its public package identity.',
      {
        dependency: name,
        boundName: boundManifest.name ?? null,
        boundVersion: boundManifest.version ?? null,
      },
    );
  await assertPublicPackageExports(actual.root, actualManifest);
  await rememberEngineRuntimeProof(context.proofs, actual.root);
  return boundPackage ?? actual.root;
}

async function verifyLocalDependency(
  dependency: Omit<DependencyPlacement, 'locator'>,
): Promise<VerifiedPlacement> {
  const { context, name, specifier, boundPackage } = dependency;
  const locator = lockEntry(context, name, specifier);
  const protocol = localDependencyProtocol(specifier);
  const placement = { ...dependency, locator };
  if (protocol === 'link:' || (context.snapshotKey !== undefined && locator.startsWith('link:'))) {
    const installed = await verifyLinkedDependency(placement);
    // A nested snapshot can resolve a file declaration to a link. Its declared source still
    // determines how relative dependencies of the linked package are resolved.
    if (protocol === 'file:' && boundPackage === undefined)
      return filePlacement(placement, await resolveDeclaredDependency(context, specifier, 'file:'));
    return { installed };
  }
  if (protocol === 'workspace:') return { installed: await verifyWorkspaceDependency(placement) };
  if (protocol === 'file:') return verifyFileDependency(placement);
  return { installed: await verifyRegistryDependency(placement) };
}

async function installedPackage(from: string, name: string): Promise<InstalledPackage | undefined> {
  if (!isPackageName(name)) throw new Error(`Invalid package name: ${name}`);
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const path = join(directory, 'node_modules', name);
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (dirname(directory) === directory) return undefined;
      continue;
    }
    try {
      return { path, root: await realpath(path) };
    } catch (cause) {
      throw dependencyClosureError(
        'project-dependency-link-unresolved',
        'An installed package link exists but its target is unavailable.',
        {
          dependency: name,
          path,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      );
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertPublicPackageExports(
  packageRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const targets = packageTargetPaths([
    manifest.exports,
    ...['main', 'module', 'types', 'typings'].map((key) =>
      typeof manifest[key] === 'string' ? manifest[key] : undefined,
    ),
  ]);
  for (const target of new Set(targets)) {
    if (!target.startsWith('./'))
      throw dependencyClosureError(
        'project-engine-export-invalid',
        'A local Engine public target must be package-relative.',
        {
          packageRoot,
          target,
        },
      );
    const wildcardCount = [...target].filter((character) => character === '*').length;
    const absolute = resolve(packageRoot, target);
    if (!isFilesystemPathWithin(packageRoot, absolute))
      throw dependencyClosureError(
        'project-engine-export-invalid',
        'A local Engine public target escapes its package.',
        {
          packageRoot,
          target,
        },
      );
    if (wildcardCount === 0) {
      if (!(await pathIsFile(absolute)))
        throw dependencyClosureError(
          'project-engine-export-missing',
          'A local Engine public export target is missing.',
          {
            packageRoot,
            target,
          },
        );
      continue;
    }
    if (wildcardCount !== 1 || !basename(target).includes('*'))
      throw dependencyClosureError(
        'project-engine-export-unsupported',
        'Only one filename wildcard in a public export target is supported.',
        {
          packageRoot,
          target,
        },
      );
    const directory = resolve(packageRoot, dirname(target));
    const filenamePattern = basename(target);
    const wildcard = filenamePattern.indexOf('*');
    const matches = (await readdir(directory)).filter((name) =>
      new RegExp(
        `^${escapeRegExp(filenamePattern.slice(0, wildcard))}.+${escapeRegExp(filenamePattern.slice(wildcard + 1))}$`,
      ).test(name),
    );
    if (matches.length === 0)
      throw dependencyClosureError(
        'project-engine-export-missing',
        'A local Engine public export wildcard has no built target.',
        {
          packageRoot,
          target,
        },
      );
  }
}

async function planSnapshot(
  projectRoot: string,
  signal?: AbortSignal,
  proofRequest?: DependencyProofRequest,
): Promise<SnapshotPlan> {
  signal?.throwIfAborted();
  const bindingResult = await readEngineBinding(projectRoot);
  if (!bindingResult.ok)
    throw new Error(`${bindingResult.error.code}: ${bindingResult.error.hint}`);
  const binding = bindingResult.value;
  const bindingIdentity = JSON.stringify(binding);
  if (proofRequest !== undefined && proofRequest.expectedBinding !== bindingIdentity)
    throw dependencyClosureError(
      'project-engine-binding-changed',
      'The Engine binding changed while doctor was checking dependencies.',
      {
        expectedBinding: proofRequest.expectedBinding,
        actualBinding: bindingIdentity,
      },
    );
  const boundPackages = new Map<string, string>();
  if (binding) {
    const inspected = await inspectEngineWorkspace(binding.path);
    if (!inspected.ok) throw new Error(`${inspected.error.code}: ${inspected.error.hint}`);
    if (proofRequest !== undefined) {
      if (
        inspected.value.missingBuilds.length > 0 ||
        inspected.value.versions.length !== 1 ||
        (proofRequest.expectedEngineDigest !== undefined &&
          inspected.value.digest !== proofRequest.expectedEngineDigest)
      )
        throw dependencyClosureError(
          'project-engine-binding-changed',
          'The local Engine is no longer healthy or differs from the status doctor just observed.',
          {
            root: inspected.value.root,
            missingBuilds: inspected.value.missingBuilds,
            versions: inspected.value.versions,
            expectedDigest: proofRequest.expectedEngineDigest ?? null,
            actualDigest: inspected.value.digest,
          },
        );
      for (const entry of inspected.value.packages)
        await assertPublicPackageExports(entry.root, await readPackageManifest(entry.root));
    }
    for (const entry of inspected.value.packages)
      boundPackages.set(entry.name, await realpath(entry.root));
  }
  const files: SnapshotFile[] = [];
  const links: SnapshotPlan['links'] = [];
  const packages = new Map<string, string>();
  const expandedPackages = new Set<string>();
  const contexts = new Map<string, PnpmContext>();
  const proofsByPath = new Map<string, SnapshotProof>();
  async function contextFor(source: string, installedBy?: PnpmContext): Promise<PnpmContext> {
    const canonical = await realpath(source);
    const existing = contexts.get(canonical);
    if (existing !== undefined) {
      if (installedBy !== undefined && existing.root !== installedBy.root)
        throw dependencyClosureError(
          'project-pnpm-dependency-ambiguous',
          'The same workspace package was selected by different pnpm install roots.',
          { packageRoot: canonical, root: existing.root, installedBy: installedBy.root },
        );
      return existing;
    }
    if (installedBy !== undefined) {
      // A verified workspace link belongs to the install that selected it,
      // even when the linked checkout contains its own workspace manifest.
      const context: PnpmContext = {
        root: installedBy.root,
        packageRoot: canonical,
        importer: pnpmImporter(installedBy.root, canonical, installedBy.lock, true),
        lock: installedBy.lock,
        modules: installedBy.modules,
        proofs: installedBy.proofs,
        ...(installedBy.workspace === undefined ? {} : { workspace: installedBy.workspace }),
      };
      contexts.set(canonical, context);
      return context;
    }
    if (proofRequest?.pnpmVersion === undefined)
      throw dependencyClosureError(
        'project-pnpm-version-missing',
        'The package-manager version was not supplied for local dependency verification.',
      );
    const context = await pnpmContext(canonical, proofRequest.pnpmVersion, proofsByPath);
    contexts.set(canonical, context);
    return context;
  }
  async function tree(
    source: string,
    target: string,
    ancestors = new Set<string>(),
  ): Promise<void> {
    signal?.throwIfAborted();
    // Compiler state can change during a run start; it is not a runtime input.
    if (source.endsWith('.tsbuildinfo')) return;
    const canonical = await realpath(source);
    const info = await stat(canonical, { bigint: true });
    if (info.isFile()) {
      files.push({ source: canonical, target, ...stamp(info) });
      return;
    }
    if (!info.isDirectory() || ancestors.has(canonical))
      throw new Error(`Unsupported or cyclic input: ${source}`);
    const next = new Set([...ancestors, canonical]);
    for (const name of (await readdir(canonical)).sort()) {
      if (!omitted.has(name)) await tree(join(canonical, name), join(target, name), next);
    }
  }
  function peerFromLink(
    consumer: PnpmContext | undefined,
    name: string,
    specifier: string,
  ): { context: PnpmContext; specifier: string } | undefined {
    if (consumer === undefined || specifier !== '*' || !isEngineDependency(name)) return undefined;
    const entry =
      consumer.importer.dependencies?.[name] ?? consumer.importer.peerDependencies?.[name];
    return typeof entry?.specifier === 'string'
      ? { context: consumer, specifier: entry.specifier }
      : undefined;
  }

  async function proveDependencyPlacement(
    context: PnpmContext | undefined,
    name: string,
    specifier: string,
    actual: InstalledPackage,
    actualManifest: Record<string, unknown>,
    boundPackage: string | undefined,
    source: string,
    installed: string,
  ): Promise<{ installed: string; context: PnpmContext | undefined }> {
    const alias = npmAliasTarget(specifier);
    const enginePackage = isEngineDependency(name);
    // Published registry bundles own their nested aliases; only project/workspace
    // importers have pnpm placement records in this installation.
    if (specifier.startsWith('npm:') && context !== undefined) {
      if (alias === undefined || alias !== actualManifest.name)
        throw dependencyClosureError(
          'project-dependency-identity-mismatch',
          'The npm alias target does not match the installed package manifest.',
          {
            dependency: name,
            from: source,
            specifier,
            installed: actual.root,
            actualName: actualManifest.name ?? null,
          },
        );
      const locator = lockEntry(context, name, specifier);
      await verifyNpmAliasPlacement(context, name, alias, locator, actual, actualManifest);
    } else if (
      localDependencyProtocol(specifier) !== undefined ||
      boundPackage !== undefined ||
      (enginePackage && context !== undefined)
    ) {
      context ??= await contextFor(source);
      const sourceManifest = await readPackageManifest(context.packageRoot);
      assertWorkspaceProject(context, context.packageRoot, sourceManifest, name);
      const placement = await verifyLocalDependency({
        source: context.packageRoot,
        name,
        specifier,
        actual,
        actualManifest,
        context,
        boundPackage,
      });
      installed = placement.installed;
      if (placement.fileCopy !== undefined)
        contexts.set(installed, {
          ...context,
          packageRoot: installed,
          importer: {},
          snapshotKey: placement.fileCopy.snapshotKey,
          sourceRoot: placement.fileCopy.manifestRoot,
        });
    }
    return { installed, context };
  }
  function requireLocalEngineBinding(name: string, protocol: LocalDependencyProtocol | undefined) {
    if (
      proofRequest !== undefined &&
      binding === null &&
      protocol !== undefined &&
      isEngineDependency(name)
    )
      throw dependencyClosureError(
        'project-local-dependency',
        'Local Engine packages require an explicit healthy Engine source binding.',
        { dependencies: [name] },
      );
  }

  async function dependencies(
    source: string,
    target: string,
    project = false,
    installedBy?: PnpmContext,
    linkConsumer?: PnpmContext,
  ): Promise<void> {
    const manifest = packageManifest(
      JSON.parse(await readFile(join(source, 'package.json'), 'utf8')),
      source,
    ) as {
      readonly name?: unknown;
      readonly version?: unknown;
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
      readonly optionalDependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
      readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
    };
    const names = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...(project ? manifest.devDependencies : {}),
      ...manifest.optionalDependencies,
    };
    let context: PnpmContext | undefined;
    if (
      proofRequest !== undefined &&
      (project || installedBy !== undefined || contexts.has(source))
    ) {
      context = await contextFor(source, installedBy);
      assertWorkspaceProject(context, context.packageRoot, manifest, '@project');
    }
    for (const name of Object.keys(names).sort()) {
      signal?.throwIfAborted();
      const declaredSpecifier = names[name];
      if (typeof declaredSpecifier !== 'string')
        throw dependencyClosureError(
          'project-dependency-manifest-invalid',
          'A dependency declaration must be a string.',
          {
            dependency: name,
            from: source,
          },
        );
      const specifier =
        context === undefined
          ? declaredSpecifier
          : dependencySpecifier(context, name, declaredSpecifier);
      const peer =
        specifier === manifest.peerDependencies?.[name]
          ? peerFromLink(linkConsumer, name, specifier)
          : undefined;
      const protocol = localDependencyProtocol(specifier);
      requireLocalEngineBinding(name, protocol);
      const boundPackage = boundPackages.get(name);
      const actual = await installedPackage(source, name);
      let installed = boundPackage ?? actual?.root;
      if (
        actual === undefined &&
        (name in (manifest.optionalDependencies ?? {}) ||
          manifest.peerDependenciesMeta?.[name]?.optional)
      )
        continue;
      if (installed === undefined || (actual === undefined && proofRequest !== undefined))
        throw dependencyClosureError(
          'project-dependency-not-installed',
          `Snapshot dependency is not installed: ${name} (from ${source}).`,
          { dependency: name, from: source },
        );
      if (actual !== undefined && proofRequest !== undefined) {
        const actualManifest = await readPackageManifest(actual.root);
        const alias = npmAliasTarget(specifier);
        if (actualManifest.name !== name && alias !== actualManifest.name)
          throw dependencyClosureError(
            'project-dependency-identity-mismatch',
            'The installed package name does not match its dependency declaration.',
            {
              dependency: name,
              from: source,
              installed: actual.root,
              actualName: actualManifest.name ?? null,
            },
          );
        const placement = await proveDependencyPlacement(
          peer?.context ?? context,
          name,
          peer?.specifier ?? specifier,
          actual,
          actualManifest,
          boundPackage,
          source,
          installed,
        );
        installed = placement.installed;
        if (peer === undefined) context = placement.context;
      }
      let destination = packages.get(installed);
      const existing = destination !== undefined;
      destination ??= join('dependencies', sha256(installed));
      packages.set(installed, destination);
      const dependencyTarget = join(target, 'node_modules', name);
      if (dependencyTarget !== destination) links.push({ target: dependencyTarget, destination });
      if (!existing) {
        // The package's published payload owns dependency inputs, not its checkout.
        for (const file of await packageFiles(installed)) {
          if (file.split('/').some((part) => part !== 'node_modules' && omitted.has(part)))
            continue;
          // packlist includes declared npm bundles. Keep their physical layout:
          // bundled modules can resolve platform leaves provided by the root.
          if (file.startsWith('node_modules/') && file.endsWith('/package.json')) {
            packages.set(
              await realpath(dirname(join(installed, file))),
              dirname(join(destination, file)),
            );
          }
          await tree(join(installed, file), join(destination, file));
        }
      }
      if (!expandedPackages.has(installed)) {
        expandedPackages.add(installed);
        await dependencies(
          installed,
          destination,
          false,
          proofRequest !== undefined && protocol === 'workspace:' ? context : undefined,
          proofRequest !== undefined && protocol === 'link:' ? context : undefined,
        );
      }
    }
  }
  // Doctor validates installed dependencies, not the mutable consumer tree.
  // Real run snapshots still capture and compare every project runtime input.
  if (proofRequest === undefined) await tree(projectRoot, 'project');
  await dependencies(projectRoot, 'project', true);
  const proofs = [...proofsByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return { binding: bindingIdentity, files, links, proofs };
}

function firstChangedRow<T>(
  section: keyof SnapshotPlan,
  before: readonly T[],
  after: readonly T[],
  same: (left: T, right: T) => boolean,
): { section: keyof SnapshotPlan; before: T | undefined; after: T | undefined } | undefined {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index++) {
    const left = before[index];
    const right = after[index];
    if (left === undefined || right === undefined || !same(left, right))
      return { section, before: left, after: right };
  }
  return undefined;
}

function snapshotChange(before: SnapshotPlan, after: SnapshotPlan) {
  if (before.binding !== after.binding)
    return { section: 'binding', before: before.binding, after: after.binding };
  return (
    firstChangedRow(
      'files',
      before.files,
      after.files,
      (left, right) =>
        // A file's stamp includes its mode and size.
        left.source === right.source && left.target === right.target && left.stamp === right.stamp,
    ) ??
    firstChangedRow(
      'links',
      before.links,
      after.links,
      (left, right) => left.target === right.target && left.destination === right.destination,
    ) ??
    firstChangedRow('proofs', before.proofs, after.proofs, sameProof)
  );
}

/** Reuse the snapshot dependency owner without copying files or publishing a run. */
export async function inspectRunDependencyClosure(
  projectRoot: string,
  binding: { readonly schemaVersion: string; readonly path: string } | null,
  engineDigest: string | undefined,
  pnpmVersion: string,
): Promise<void> {
  const root = resolve(projectRoot);
  const proofRequest = {
    expectedBinding: JSON.stringify(binding),
    expectedEngineDigest: engineDigest,
    pnpmVersion,
  };
  const first = await planSnapshot(root, undefined, proofRequest);
  const second = await planSnapshot(root, undefined, proofRequest);
  if (snapshotChange(first, second) !== undefined) {
    const inputs = (plan: SnapshotPlan) =>
      new Map([
        ...plan.files.map((file) => [file.source, file.stamp] as const),
        ...plan.proofs.map((proof) => [proof.path, JSON.stringify(proof)] as const),
        ...plan.links.map((link) => [resolve(root, link.target), link.destination] as const),
        [resolve(root, '.forgeax/engine-binding.json'), plan.binding] as const,
      ]);
    const before = inputs(first),
      after = inputs(second);
    const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path))
      .sort();
    throw dependencyClosureError(
      'project-dependency-source-changed',
      'Installed dependency inputs or links changed during doctor inspection.',
      {
        root,
        changedPaths: changedPaths.slice(0, 64),
        omittedPathCount: Math.max(0, changedPaths.length - 64),
      },
    );
  }
  await verifySnapshotProofs(second.proofs);
}

/** Copy the resolved installed closure, including dirty inputs, before publishing a run. */
async function createRunSnapshotAttempt(
  projectRoot: string,
  directory: string,
  signal?: AbortSignal,
): Promise<{
  readonly root: string;
  readonly version: string;
  readonly dispose: () => Promise<void>;
}> {
  if (isFilesystemPathWithin(projectRoot, directory))
    throw new Error('Run snapshots must be stored outside the project inputs.');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const plan = await planSnapshot(resolve(projectRoot), signal);
    const digest = createHash('sha256');
    for (const file of plan.files) {
      signal?.throwIfAborted();
      const target = join(directory, file.target);
      await mkdir(dirname(target), { recursive: true });
      digest.update(JSON.stringify([file.target, file.mode & 0o111, file.size]));
      // Most installed files are tiny. Avoid constructing three streams per file;
      // bound the buffer and retain streaming for larger payloads such as WASM.
      if (file.size <= 64 * 1024) {
        const bytes = await readFile(file.source, { signal });
        digest.update(bytes);
        await writeFile(target, bytes, { signal });
      } else
        await pipeline(
          createReadStream(file.source),
          new Transform({
            transform(chunk, _encoding, callback) {
              digest.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(target),
          { signal },
        );
      if (stamp(await stat(file.source, { bigint: true })).stamp !== file.stamp)
        throw new SnapshotChangedError(`Input changed while snapshotting: ${file.source}`);
      await chmod(target, file.mode & 0o111 ? 0o555 : 0o444);
    }
    for (const link of plan.links) {
      signal?.throwIfAborted();
      const target = join(directory, link.target);
      const destination = join(directory, link.destination);
      await mkdir(dirname(target), { recursive: true });
      await symlink(
        process.platform === 'win32' ? destination : relative(dirname(target), destination),
        target,
        'junction',
      );
      digest.update(JSON.stringify(link));
    }
    // Re-resolve links as well as file metadata: an installed package can be
    // replaced without modifying the old directory that we just copied.
    const currentPlan = await planSnapshot(resolve(projectRoot), signal);
    const change = snapshotChange(plan, currentPlan);
    if (change !== undefined) {
      throw new SnapshotChangedError(
        `Project inputs changed while snapshotting; retry from a stable version: ${JSON.stringify(change)}`,
        { cause: change },
      );
    }
    signal?.throwIfAborted();
    return { root: join(directory, 'project'), version: `sha256:${digest.digest('hex')}`, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Retry short watcher races while preserving the fail-closed stable-input contract. */
export async function createRunSnapshot(
  projectRoot: string,
  directory: string,
  signal?: AbortSignal,
): Promise<{
  readonly root: string;
  readonly version: string;
  readonly dispose: () => Promise<void>;
}> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createRunSnapshotAttempt(projectRoot, directory, signal);
    } catch (error) {
      if (!(error instanceof SnapshotChangedError) || attempt >= SNAPSHOT_ATTEMPTS) throw error;
      signal?.throwIfAborted();
      await new Promise((resolveRetry) => setTimeout(resolveRetry, attempt * 50));
    }
  }
}
