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
import { packlist } from '@pnpm/fs.packlist';
import { parse, parseAllDocuments } from 'yaml';
import {
  enginePackageRuntimeIdentity,
  inspectEngineWorkspace,
  readEngineBinding,
} from './engine-binding.js';
import { filesystemPathRelative, isFilesystemPathWithin } from './filesystem-path.js';
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
  const identity = createHash('sha256').update(root).digest('hex');
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
  readonly workspace?: {
    readonly state: PnpmWorkspaceState;
    readonly overrides: Readonly<Record<string, string>>;
  };
}

interface SnapshotPlanOptions {
  readonly verifyLocalDependencies?: boolean;
  readonly expectedBinding?: string;
  readonly expectedEngineDigest?: string;
  readonly pnpmVersion?: string;
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
  return createHash('sha256').update(content).digest('hex');
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

function proofKey(path: string): string {
  return normalizeRecordedPath(path);
}

async function readProvenFile(proofs: Map<string, SnapshotProof>, path: string): Promise<Buffer> {
  const identity = await proofPathIdentity(path);
  const content = await readFile(path);
  proofs.set(proofKey(identity.path), {
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
  proofs.set(proofKey(identity.path), { ...identity, digest, kind: 'engine-runtime' });
}

function proofPathMatches(proof: SnapshotProof, identity: ProofPathIdentity): boolean {
  return (
    proofKey(proof.path) === proofKey(identity.path) &&
    proofKey(proof.realPath) === proofKey(identity.realPath) &&
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
      if (
        !proofPathMatches(proof, after) ||
        proofKey(before.realPath) !== proofKey(after.realPath) ||
        before.identity !== after.identity ||
        digest !== proof.digest
      )
        throw dependencySourceChanged(proof.path);
    } catch (cause) {
      if (isDependencySourceChanged(cause)) throw cause;
      throw dependencySourceChanged(proof.path, cause);
    }
  }
}

function parsePnpmLockfile(bytes: Buffer): PnpmLockfile {
  const documents = parseAllDocuments(bytes.toString('utf8'));
  for (const document of documents) {
    if (document.errors.length > 0) throw document.errors[0];
  }
  // pnpm places its environment graph first and the project graph last.
  // They have separate importer and package identities; never merge them.
  const lock = documents.at(-1)?.toJS() as PnpmLockfile | undefined;
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock))
    throw new Error('The pnpm project lockfile document must be a mapping.');
  return lock;
}

async function pnpmContext(
  packageRootInput: string,
  expectedPnpmVersion: string,
): Promise<PnpmContext> {
  const packageRoot = await realpath(packageRootInput);
  let workspaceRoot: string | undefined;
  let lockRoot: string | undefined;
  for (let directory = packageRoot; ; directory = dirname(directory)) {
    if (lockRoot === undefined && (await pathIsFile(join(directory, 'pnpm-lock.yaml'))))
      lockRoot = directory;
    if (await pathIsFile(join(directory, 'pnpm-workspace.yaml'))) {
      workspaceRoot = directory;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
  }
  const root = workspaceRoot ?? (lockRoot === packageRoot ? packageRoot : undefined);
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
  const proofs = new Map<string, SnapshotProof>();
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

  const importerPath = filesystemPathRelative(root, packageRoot);
  if (importerPath === undefined)
    throw dependencyClosureError(
      'project-pnpm-importer-mismatch',
      'The package is outside its pnpm workspace root.',
      {
        packageRoot,
        root,
      },
    );
  const importerKey = importerPath.length === 0 ? '.' : importerPath.split(sep).join('/');
  const importer = lock.importers?.[importerKey];
  if (importer === undefined)
    throw dependencyClosureError(
      'project-pnpm-importer-missing',
      'The current package has no importer in pnpm-lock.yaml.',
      {
        importer: importerKey,
        packageRoot,
        root,
      },
    );

  let workspace: PnpmContext['workspace'];
  if (workspaceRoot !== undefined) {
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
    if (
      !Array.isArray(patterns) ||
      patterns.some((pattern) => typeof pattern !== 'string') ||
      (recordedPatterns !== undefined &&
        (!Array.isArray(recordedPatterns) ||
          JSON.stringify(patterns) !== JSON.stringify(recordedPatterns)))
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
    workspace = { state, overrides: configuredOverrides };
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
  const selected = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
  if (selected === undefined) return declared;
  // Only an unqualified, unconditional rule has a unique meaning without a
  // second pnpm selector resolver. Never guess precedence against scoped rules.
  const competing = Object.keys(overrides).some((selector) => {
    if (selector === name) return false;
    const target = selector.slice(selector.lastIndexOf('>') + 1).trim();
    return target === name || target.startsWith(`${name}@`);
  });
  if (competing || selected === '-' || selected.startsWith('$') || selected.startsWith('catalog:'))
    throw dependencyClosureError(
      'project-pnpm-override-unsupported',
      'This dependency override needs selector, removal, or catalog resolution that is not proven by the local doctor.',
      { root: context.root, dependency: name, declared, override: selected },
    );
  return selected;
}

function lockEntry(context: PnpmContext, name: string, specifier: string): string {
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
    const hash = createHash('sha256').update(filename).digest('hex').slice(0, 32);
    return `${filename.slice(0, maxLength - 33)}_${hash}`;
  }
  return filename;
}

function npmAliasTarget(specifier: string): { readonly name: string } | undefined {
  if (!specifier.startsWith('npm:')) return undefined;
  const target = specifier.slice('npm:'.length);
  const separator = target.startsWith('@')
    ? target.indexOf('@', target.indexOf('/') + 1)
    : target.indexOf('@');
  if (separator <= 0 || separator === target.length - 1) return undefined;
  const name = target.slice(0, separator);
  if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) return undefined;
  return { name };
}

function pnpmLocatorIdentity(
  locator: string,
): { readonly name: string; readonly version: string } | undefined {
  const separator = locator.startsWith('@')
    ? locator.indexOf('@', locator.indexOf('/') + 1)
    : locator.indexOf('@');
  if (separator <= 0) return undefined;
  const name = locator.slice(0, separator);
  const version = locator.slice(separator + 1).split('(')[0];
  if (!version) return undefined;
  return { name, version };
}

async function verifyNpmAliasPlacement(
  context: PnpmContext,
  dependency: string,
  targetName: string,
  locator: string,
  actual: InstalledPackage,
  actualManifest: Record<string, unknown>,
): Promise<void> {
  const identity = pnpmLocatorIdentity(locator);
  // Package content is peer-independent; the selected snapshot and physical
  // placement still require the complete peer-qualified locator below.
  const packageRecord =
    identity === undefined
      ? undefined
      : context.lock.packages?.[`${identity.name}@${identity.version}`];
  const hasSnapshot = Object.hasOwn(context.lock.snapshots ?? {}, locator);
  if (
    identity === undefined ||
    identity.name !== targetName ||
    typeof actualManifest.version !== 'string' ||
    identity.version !== actualManifest.version ||
    packageRecord === undefined ||
    !hasSnapshot
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

  const virtualStore = context.modules.virtualStoreDir;
  const maxLength = context.modules.virtualStoreDirMaxLength;
  if (typeof virtualStore !== 'string' || typeof maxLength !== 'number')
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      'Installed pnpm metadata does not identify a bounded virtual-store layout for the npm alias.',
      { dependency, locator, installed: actual.root },
    );

  let virtualStoreRoot: string;
  let expectedPackageRoot: string;
  try {
    virtualStoreRoot = await realpath(resolve(context.root, virtualStore));
    const entry = pnpmVirtualStoreEntry(locator, maxLength);
    if (entry === undefined) throw new Error('The pnpm locator exceeds the recorded store layout.');
    expectedPackageRoot = await realpath(
      join(virtualStoreRoot, entry, 'node_modules', ...targetName.split('/')),
    );
  } catch (cause) {
    throw dependencyClosureError(
      'project-dependency-identity-mismatch',
      'The npm alias target has no resolvable pnpm virtual-store placement.',
      {
        dependency,
        locator,
        installed: actual.root,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }

  if (
    proofKey(expectedPackageRoot) !== proofKey(actual.root) ||
    !isFilesystemPathWithin(virtualStoreRoot, actual.root) ||
    !(await lstat(actual.path)).isSymbolicLink()
  )
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
  const virtualStore = context.modules.virtualStoreDir;
  const virtualStoreMaxLength = context.modules.virtualStoreDirMaxLength;
  if (typeof virtualStore !== 'string' || typeof virtualStoreMaxLength !== 'number')
    fileDependencyUnverified(
      name,
      declaredTarget,
      actual.root,
      'Installed pnpm metadata does not identify a bounded virtual-store layout.',
    );

  let virtualStoreRoot: string;
  let virtualStoreLock: PnpmLockfile;
  try {
    virtualStoreRoot = await realpath(resolve(context.root, virtualStore));
    const virtualStoreLockPath = join(virtualStoreRoot, 'lock.yaml');
    const virtualStoreLockBytes = await readProvenFile(context.proofs, virtualStoreLockPath);
    virtualStoreLock = parsePnpmLockfile(virtualStoreLockBytes);
  } catch (cause) {
    fileDependencyUnverified(
      name,
      declaredTarget,
      actual.root,
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  if (JSON.stringify(virtualStoreLock) !== JSON.stringify(context.lock))
    fileDependencyUnverified(
      name,
      declaredTarget,
      actual.root,
      'The installed virtual-store lock does not match the project lockfile.',
    );

  const packageKey = `${name}@${locator}`;
  const snapshotKeys = Object.keys(context.lock.snapshots ?? {}).filter(
    (key) => key === packageKey || key.startsWith(`${packageKey}(`),
  );
  if (context.lock.packages?.[packageKey] === undefined || snapshotKeys.length !== 1)
    fileDependencyUnverified(
      name,
      declaredTarget,
      actual.root,
      'The current lockfile does not resolve one installed package snapshot for this locator.',
    );

  const snapshotKey = snapshotKeys[0];
  if (snapshotKey === undefined)
    fileDependencyUnverified(
      name,
      declaredTarget,
      actual.root,
      'The current lockfile does not resolve one installed package snapshot for this locator.',
    );
  const entryName = pnpmVirtualStoreEntry(snapshotKey, virtualStoreMaxLength);
  if (entryName === undefined)
    fileDependencyUnverified(
      name,
      declaredTarget,
      actual.root,
      'The pnpm locator cannot be represented within the recorded virtual-store path limit.',
    );
  const expectedPackagePath = join(virtualStoreRoot, entryName, 'node_modules', ...name.split('/'));
  let expectedPackageRoot: string;
  try {
    expectedPackageRoot = await realpath(expectedPackagePath);
  } catch (cause) {
    fileDependencyUnverified(
      name,
      declaredTarget,
      actual.root,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (
    normalizeRecordedPath(expectedPackageRoot) !== normalizeRecordedPath(actual.root) ||
    !isFilesystemPathWithin(virtualStoreRoot, actual.root) ||
    !(await lstat(actual.path)).isSymbolicLink()
  )
    fileDependencyUnverified(
      name,
      declaredTarget,
      actual.root,
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

async function verifyLocalDependency(
  source: string,
  name: string,
  specifier: string,
  actual: InstalledPackage,
  actualManifest: Record<string, unknown>,
  context: PnpmContext,
  boundPackage?: string,
): Promise<string> {
  const locator = lockEntry(context, name, specifier);
  if (specifier.startsWith('workspace:')) {
    if (!locator.startsWith('link:'))
      throw dependencyClosureError(
        'project-workspace-locator-mismatch',
        'A workspace dependency is not recorded as a pnpm workspace link.',
        {
          dependency: name,
          from: source,
          specifier,
          locator,
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
    const target = await realpath(resolve(context.packageRoot, locator.slice('link:'.length)));
    if (target !== actual.root || (boundPackage !== undefined && target !== boundPackage))
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

  if (specifier.startsWith('file:')) {
    if (!locator.startsWith('file:'))
      throw dependencyClosureError(
        'project-file-locator-mismatch',
        'A file dependency is not recorded as a pnpm file locator.',
        {
          dependency: name,
          from: source,
          specifier,
          locator,
        },
      );
    const declaredTarget = await realpath(
      resolve(context.packageRoot, specifier.slice('file:'.length)),
    );
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
    const packageRecord = context.lock.packages?.[`${name}@${locator}`];
    const resolution = packageRecord?.resolution;
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
          dependency: name,
          from: source,
          specifier,
          locator,
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
    if (boundPackage !== undefined && declaredTarget !== boundPackage)
      throw dependencyClosureError(
        'project-file-locator-mismatch',
        'The file dependency does not resolve to the selected Engine binding.',
        {
          dependency: name,
          declaredTarget,
          boundPackage,
        },
      );
    return boundPackage ?? actual.root;
  }

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
  await assertPublicPackageExports(actual.root);
  await rememberEngineRuntimeProof(context.proofs, actual.root);
  return boundPackage ?? actual.root;
}

async function installedPackage(from: string, name: string): Promise<InstalledPackage | undefined> {
  if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name))
    throw new Error(`Invalid package name: ${name}`);
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

function exportedFiles(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportedFiles);
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(exportedFiles);
  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertPublicPackageExports(packageRoot: string): Promise<void> {
  const manifest = await readPackageManifest(packageRoot);
  const targets = [
    ...exportedFiles(manifest.exports),
    ...['main', 'module', 'types', 'typings'].flatMap((key) =>
      typeof manifest[key] === 'string' ? [manifest[key] as string] : [],
    ),
  ];
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
  options: SnapshotPlanOptions = {},
): Promise<SnapshotPlan> {
  signal?.throwIfAborted();
  const bindingResult = await readEngineBinding(projectRoot);
  if (!bindingResult.ok)
    throw new Error(`${bindingResult.error.code}: ${bindingResult.error.hint}`);
  const binding = bindingResult.value;
  const bindingIdentity = JSON.stringify(binding);
  if (options.verifyLocalDependencies && options.expectedBinding !== bindingIdentity)
    throw dependencyClosureError(
      'project-engine-binding-changed',
      'The Engine binding changed while doctor was checking dependencies.',
      {
        expectedBinding: options.expectedBinding ?? null,
        actualBinding: bindingIdentity,
      },
    );
  const boundPackages = new Map<string, string>();
  if (binding) {
    const inspected = await inspectEngineWorkspace(binding.path);
    if (!inspected.ok) throw new Error(`${inspected.error.code}: ${inspected.error.hint}`);
    if (options.verifyLocalDependencies) {
      if (
        inspected.value.missingBuilds.length > 0 ||
        inspected.value.versions.length !== 1 ||
        (options.expectedEngineDigest !== undefined &&
          inspected.value.digest !== options.expectedEngineDigest)
      )
        throw dependencyClosureError(
          'project-engine-binding-changed',
          'The local Engine is no longer healthy or differs from the status doctor just observed.',
          {
            root: inspected.value.root,
            missingBuilds: inspected.value.missingBuilds,
            versions: inspected.value.versions,
            expectedDigest: options.expectedEngineDigest ?? null,
            actualDigest: inspected.value.digest,
          },
        );
      for (const entry of inspected.value.packages) await assertPublicPackageExports(entry.root);
    }
    for (const entry of inspected.value.packages)
      boundPackages.set(entry.name, await realpath(entry.root));
  }
  const files: SnapshotFile[] = [];
  const links: SnapshotPlan['links'] = [];
  const packages = new Map<string, string>();
  const expandedPackages = new Set<string>();
  const contexts = new Map<string, PnpmContext>();
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
      const path = filesystemPathRelative(installedBy.root, canonical);
      if (path === undefined)
        throw dependencyClosureError(
          'project-pnpm-importer-mismatch',
          'The linked package is outside its installing pnpm workspace.',
          { packageRoot: canonical, root: installedBy.root },
        );
      const importerKey = path.length === 0 ? '.' : path.split(sep).join('/');
      const importer = installedBy.lock.importers?.[importerKey];
      if (importer === undefined)
        throw dependencyClosureError(
          'project-pnpm-importer-missing',
          'The linked package has no importer in its installing pnpm lockfile.',
          { packageRoot: canonical, root: installedBy.root, importer: importerKey },
        );
      const context = { ...installedBy, packageRoot: canonical, importer };
      contexts.set(canonical, context);
      return context;
    }
    const version = options.pnpmVersion;
    if (version === undefined)
      throw dependencyClosureError(
        'project-pnpm-version-missing',
        'The package-manager version was not supplied for local dependency verification.',
      );
    const context = await pnpmContext(canonical, version);
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
  async function dependencies(
    source: string,
    target: string,
    project = false,
    installedBy?: PnpmContext,
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
    if (options.verifyLocalDependencies && (project || installedBy !== undefined)) {
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
      const enginePackage = name === '@forgeax/engine' || name.startsWith('@forgeax/engine-');
      if (
        options.verifyLocalDependencies &&
        binding === null &&
        enginePackage &&
        (specifier.startsWith('workspace:') || specifier.startsWith('file:'))
      )
        throw dependencyClosureError(
          'project-local-dependency',
          'Local Engine packages require an explicit healthy Engine source binding.',
          { dependencies: [name] },
        );
      const boundPackage = boundPackages.get(name);
      const actual = await installedPackage(source, name);
      if (actual === undefined) {
        if (
          name in (manifest.optionalDependencies ?? {}) ||
          manifest.peerDependenciesMeta?.[name]?.optional
        )
          continue;
        if (options.verifyLocalDependencies || boundPackage === undefined)
          throw dependencyClosureError(
            'project-dependency-not-installed',
            `Snapshot dependency is not installed: ${name} (from ${source}).`,
            {
              dependency: name,
              from: source,
            },
          );
      }
      let installed = boundPackage ?? actual?.root;
      if (installed === undefined)
        throw new Error(`Snapshot dependency is not installed: ${name} (from ${source}).`);
      if (options.verifyLocalDependencies) {
        if (actual === undefined)
          throw new Error(`Verified dependency is not installed: ${name} (from ${source}).`);
        const actualManifest = await readPackageManifest(actual.root);
        const alias = npmAliasTarget(specifier);
        if (actualManifest.name !== name && alias?.name !== actualManifest.name)
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
        // Published registry bundles own their nested aliases; only project/workspace
        // importers have pnpm placement records in this installation.
        if (specifier.startsWith('npm:') && context !== undefined) {
          if (alias === undefined || alias.name !== actualManifest.name)
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
          await verifyNpmAliasPlacement(context, name, alias.name, locator, actual, actualManifest);
        } else if (
          specifier.startsWith('workspace:') ||
          specifier.startsWith('file:') ||
          boundPackage !== undefined ||
          (enginePackage && context !== undefined)
        ) {
          context ??= await contextFor(source);
          const sourceManifest = await readPackageManifest(context.packageRoot);
          assertWorkspaceProject(context, context.packageRoot, sourceManifest, name);
          installed = await verifyLocalDependency(
            context.packageRoot,
            name,
            specifier,
            actual,
            actualManifest,
            context,
            boundPackage,
          );
        }
      }
      let destination = packages.get(installed);
      const existing = destination !== undefined;
      destination ??= join('dependencies', createHash('sha256').update(installed).digest('hex'));
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
          options.verifyLocalDependencies && specifier.startsWith('workspace:')
            ? context
            : undefined,
        );
      }
    }
  }
  await tree(projectRoot, 'project');
  await dependencies(projectRoot, 'project', true);
  const proofsByPath = new Map<string, SnapshotProof>();
  for (const context of contexts.values()) {
    for (const [path, proof] of context.proofs) {
      const previous = proofsByPath.get(path);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(proof))
        throw dependencySourceChanged(proof.path);
      proofsByPath.set(path, proof);
    }
  }
  const proofs = [...proofsByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return { binding: JSON.stringify(binding), files, links, proofs };
}

/** Reuse the snapshot dependency owner without copying files or publishing a run. */
export async function inspectRunDependencyClosure(
  projectRoot: string,
  binding: { readonly schemaVersion: string; readonly path: string } | null,
  engineDigest: string | undefined,
  pnpmVersion: string,
): Promise<void> {
  const options: SnapshotPlanOptions = {
    verifyLocalDependencies: true,
    expectedBinding: JSON.stringify(binding),
    ...(engineDigest === undefined ? {} : { expectedEngineDigest: engineDigest }),
    pnpmVersion,
  };
  const first = await planSnapshot(resolve(projectRoot), undefined, options);
  const second = await planSnapshot(resolve(projectRoot), undefined, options);
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw dependencyClosureError(
      'project-dependency-source-changed',
      'Project files or installed dependency links changed during doctor inspection.',
      {
        root: resolve(projectRoot),
      },
    );
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
    if (JSON.stringify(currentPlan) !== JSON.stringify(plan)) {
      let change: { section: keyof SnapshotPlan; before: unknown; after: unknown } = {
        section: 'binding',
        before: plan.binding,
        after: currentPlan.binding,
      };
      if (plan.binding === currentPlan.binding) {
        for (const section of ['files', 'links', 'proofs'] as const) {
          const before = plan[section];
          const after = currentPlan[section];
          const length = Math.max(before.length, after.length);
          let index = 0;
          while (index < length && JSON.stringify(before[index]) === JSON.stringify(after[index]))
            index++;
          if (index < length) {
            change = { section, before: before[index], after: after[index] };
            break;
          }
        }
      }
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
