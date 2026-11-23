import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
  type AuthorPackClosure,
  assertAuthorPackUnchanged,
  collectAuthorPackClosure,
} from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { declarationPackageId, scanInventory } from '@forgeax/engine-pack/scanner';
import { stringify } from 'yaml';
import {
  assertPluginSourceInputs,
  discoverPluginAssets,
  pluginAssetClosure,
} from './build/plugin-assets.js';
import {
  compilePluginAuthoringCandidate,
  copyProjectSourceCandidate,
  pluginProgramSource,
} from './build/plugin-programs.js';
import { execFileCommand } from './child-process.js';
import { projectEngineSourceOptions } from './engine-binding.js';
import {
  filesystemPathRelative,
  filesystemPathSegments,
  isFilesystemPathWithin,
} from './filesystem-path.js';
import { commandError, readProjectFacts } from './project.js';
import { parsePnpmLockDocuments } from './sdk-bootstrap.js';
import type { CommandResult, ProjectCommandOptions } from './types.js';
import { completeCommand } from './types.js';

export interface SourceTransferOptions extends ProjectCommandOptions {
  readonly sourceRoot: string;
  readonly sourcePath: string;
  /** New directory beneath one of the target project's configured asset directories. */
  readonly targetPath: string;
  readonly cloneIdentities?: boolean;
  readonly expectedRevision?: string;
}
function conflict(
  path: string,
  reason: string,
  versions?: { readonly sourceVersion: string; readonly targetVersion: string },
): never {
  throw {
    code: 'pack-source-revision-conflict',
    expected: 'one validated author closure with consistent identities and locked dependencies',
    hint:
      versions === undefined
        ? 'Repair detail.reason at detail.path; clone only when intentionally creating independent asset identities.'
        : 'Align the producer and consumer dependency versions and lock evidence before retrying; cloning asset identity does not resolve SDK incompatibility.',
    detail: {
      path,
      reason,
      ...(versions === undefined ? {} : { kind: 'dependency-version', ...versions }),
    },
  };
}
/** Source mutations reject symlink ancestors instead of writing outside the selected project. */
async function assertWritablePath(root: string, path: string): Promise<void> {
  const rel = filesystemPathRelative(root, path);
  if (rel === undefined) conflict(path, 'write escapes project');
  let current = root;
  for (const part of filesystemPathSegments(rel)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        conflict(current, 'source write crosses a symlink');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      break;
    }
  }
}
async function importedFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) conflict(path, 'import contains a symlink');
    if (entry.isDirectory()) files.push(...(await importedFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    else conflict(path, 'import contains a non-file resource');
  }
  return files;
}

interface LockEntry {
  specifier: string;
  version: string;
}
interface Lockfile {
  lockfileVersion: string | number;
  importers: Record<
    string,
    { dependencies?: Record<string, LockEntry>; devDependencies?: Record<string, LockEntry> }
  >;
  packages?: Record<string, unknown>;
  snapshots?: Record<
    string,
    { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  >;
  [key: string]: unknown;
}
function ignoreMissing(cause: unknown): undefined {
  if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
}

function optionalText(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(ignoreMissing);
}

/** pnpm's project lockfile is the last YAML document; earlier documents hold environment dependencies. */
function parseProjectLockfile(text: string, root: string) {
  let documents: ReturnType<typeof parsePnpmLockDocuments>;
  try {
    documents = parsePnpmLockDocuments(text);
  } catch {
    conflict(root, 'pnpm lockfile contains invalid YAML');
  }
  const document = documents.at(-1);
  const value = document?.toJSON();
  if (
    document === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    conflict(root, 'project pnpm lockfile document is missing or invalid');
  }
  return { documents, value: value as Lockfile };
}

function mergedProjectLockText(
  locked: Lockfile,
  previous?: ReturnType<typeof parseProjectLockfile>,
) {
  const project = stringify(locked);
  if (previous === undefined) return project;
  const prefix = previous.documents.slice(0, -1).map(String).join('');
  return `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}---\n${project}`;
}

/** Merge exact resolved nodes, then let pnpm verify the frozen candidate without choosing new versions. */
async function dependencyCandidate(
  closure: AuthorPackClosure,
  target: string,
  candidate: string,
  sourceText: string | undefined,
  targetText: string | undefined,
  targetManifest: string,
): Promise<boolean> {
  if (!Object.keys(closure.dependencies).length) return false;
  if (!sourceText) conflict(closure.root, 'source dependencies require a project pnpm-lock.yaml');
  const source = parseProjectLockfile(sourceText, closure.root).value;
  if (String(source.lockfileVersion) !== '9.0')
    conflict(closure.root, 'expected the supported pnpm lockfile format 9.0');
  const targetProject = targetText ? parseProjectLockfile(targetText, target) : undefined;
  const locked = targetProject
    ? targetProject.value
    : {
        lockfileVersion: '9.0',
        settings: source.settings,
        importers: { '.': {} },
      };
  if (String(locked.lockfileVersion) !== '9.0')
    conflict(target, 'incompatible target lockfile format');
  const manifest = JSON.parse(targetManifest);
  manifest.dependencies ??= {};
  locked.importers['.'] ??= {};
  const imports = locked.importers['.'];
  imports.dependencies ??= {};
  const pending: string[] = [];
  let changed = false;
  for (const [name, specifier] of Object.entries(closure.dependencies)) {
    const entry =
      source.importers['.']?.dependencies?.[name] ?? source.importers['.']?.devDependencies?.[name];
    if (!entry) conflict(name, 'source dependency must have locked resolution evidence');
    if (entry.specifier !== specifier) conflict(name, 'source manifest and lock specifier differ');
    const declared = manifest.dependencies[name] ?? manifest.devDependencies?.[name];
    const current = imports.dependencies[name] ?? imports.devDependencies?.[name];
    if (declared !== undefined && (!current || current.specifier !== declared))
      conflict(name, 'target manifest and lock differ');
    // SDK tarballs can have different local paths but must carry identical integrity.
    const integrity = (lock: Lockfile, version: string): unknown => {
      const value = lock.packages?.[`${name}@${version.split('(')[0]}`] as
        | { resolution?: { integrity?: string } }
        | undefined;
      return value?.resolution?.integrity;
    };
    if (
      current &&
      entry.version.startsWith('file:') &&
      current.version.startsWith('file:') &&
      integrity(source, entry.version) &&
      integrity(source, entry.version) === integrity(locked, current.version)
    )
      continue;
    if (!/^\d+\.\d+\.\d+(?:[-+][^()]*)?(?:\(.*\))?$/.test(entry.version))
      conflict(
        name,
        'local SDK dependencies need matching target integrity; new dependencies require registry versions',
      );
    if (current && current.version !== entry.version)
      conflict(name, 'locked dependency versions differ', {
        sourceVersion: entry.version,
        targetVersion: current.version,
      });
    if (!current) {
      changed = true;
      const version = entry.version.split('(')[0] ?? entry.version;
      manifest.dependencies[name] = version;
      imports.dependencies[name] = { specifier: version, version: entry.version };
    }
    pending.push(`${name}@${entry.version}`);
  }
  const visited = new Set<string>();
  locked.packages ??= {};
  locked.snapshots ??= {};
  while (pending.length) {
    const key = pending.pop();
    if (key === undefined) break;
    if (visited.has(key)) continue;
    visited.add(key);
    const packageKey = key.split('(')[0] ?? key;
    const value = source.packages?.[packageKey];
    const snapshot = source.snapshots?.[key];
    if (!value || !snapshot) conflict(key, 'source lock closure is incomplete');
    if (
      locked.packages[packageKey] &&
      JSON.stringify(locked.packages[packageKey]) !== JSON.stringify(value)
    )
      conflict(key, 'package integrity or resolution differs');
    if (locked.snapshots[key] && JSON.stringify(locked.snapshots[key]) !== JSON.stringify(snapshot))
      conflict(key, 'transitive dependency closure differs');
    locked.packages[packageKey] = value;
    locked.snapshots[key] = snapshot;
    for (const [name, version] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    }))
      pending.push(`${name}@${version}`);
  }
  if (changed) {
    await writeFile(resolve(candidate, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      resolve(candidate, 'pnpm-lock.yaml'),
      mergedProjectLockText(locked, targetProject),
    );
    await execFileCommand(
      'pnpm',
      ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace'],
      {
        cwd: candidate,
        env: { ...process.env, CI: 'true' },
        timeout: 5 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  }
  return changed;
}

function discoverTransferPlugins(
  facts: Parameters<typeof discoverPluginAssets>[0],
  engine: Awaited<ReturnType<typeof projectEngineSourceOptions>>,
) {
  return discoverPluginAssets(facts, undefined, undefined, undefined, engine);
}

function cloneMap(closure: AuthorPackClosure): Map<string, string> {
  const map = new Map<string, string>();
  for (const declaration of closure.declarations) {
    const oldNamespace = declarationPackageId(declaration);
    if (oldNamespace) map.set(oldNamespace.toLowerCase(), randomUUID());
  }
  for (const [guid, identity] of closure.identities) {
    const next = identity.packageId ? map.get(identity.packageId.toLowerCase()) : undefined;
    const parsed = next ? PackageId.parse(next) : undefined;
    if (parsed && !parsed.ok) throw parsed.error;
    map.set(
      guid,
      parsed?.ok && identity.sourceKey
        ? AssetGuid.format(AssetGuid.derive(parsed.value, identity.sourceKey))
        : randomUUID(),
    );
  }
  return map;
}

/** An author transfer is prepared in isolation and commits only after validation and revision fences. */
export async function assetSourceImportCommand(
  options: SourceTransferOptions,
): Promise<CommandResult<unknown>> {
  let candidate: string | undefined;
  let lock: string | undefined;
  try {
    const facts = await readProjectFacts(options.root);
    if (!facts.ok) return facts;
    const root = await realpath(facts.value.root);
    const target = resolve(root, options.targetPath);
    if (
      !facts.value.assetRoots.some((directory) =>
        isFilesystemPathWithin(resolve(root, directory), target, false),
      )
    )
      conflict(
        options.targetPath,
        'target must be a new directory beneath a configured asset directory',
      );
    await assertWritablePath(root, target);
    for (const name of ['package.json', 'pnpm-lock.yaml', '.forgeax/source-transfer.lock'])
      await assertWritablePath(root, resolve(root, name));
    const lockPath = resolve(root, '.forgeax/source-transfer.lock');
    await mkdir(dirname(lockPath), { recursive: true });
    await mkdir(lockPath);
    lock = lockPath;
    const sourceFacts = await readProjectFacts(options.sourceRoot);
    if (!sourceFacts.ok) return sourceFacts;
    const sourceEngineOptions = await projectEngineSourceOptions(sourceFacts.value.root);
    const closure = await collectAuthorPackClosure(
      sourceFacts.value.root,
      options.sourcePath,
      sourceFacts.value.assetRoots,
      sourceEngineOptions,
    );
    const sourceLock = await optionalText(resolve(closure.root, 'pnpm-lock.yaml'));
    if (
      options.expectedRevision &&
      closure.files.find((file) => file.path === closure.sourcePath)?.digest !==
        options.expectedRevision
    )
      conflict(options.sourcePath, 'source revision changed');
    const reused = (await lstat(target).catch(ignoreMissing)) !== undefined;
    if (reused) {
      if (options.cloneIdentities) conflict(target, 'clone target already exists');
      const paths = closure.files.map((file) => file.path).sort();
      for (const file of closure.files) {
        const existing = await readFile(resolve(target, file.path)).catch(ignoreMissing);
        if (existing === undefined) conflict(target, 'existing import is incomplete');
        if (!existing.equals(file.bytes)) conflict(target, 'existing import differs from source');
      }
      if (JSON.stringify((await importedFiles(target)).sort()) !== JSON.stringify(paths))
        conflict(target, 'existing import has extra or missing source files');
    }
    const engineOptions = await projectEngineSourceOptions(root);
    const engineScanOptions = { scriptablePack: engineOptions };
    const targetInventory = await discoverTransferPlugins(facts.value, engineOptions);
    const assetRoots = facts.value.assetRoots.map((directory) => resolve(root, directory));
    const sourceRevisions = async () => {
      const sources = await scanInventory(assetRoots, engineScanOptions);
      if (!sources.ok) throw sources.error;
      return JSON.stringify(
        [...sources.value.declarations]
          .map(([path, source]) => [path, source.sourceRevision])
          .sort(),
      );
    };
    const targetRevisions = await sourceRevisions();
    const identities = options.cloneIdentities ? cloneMap(closure) : new Map<string, string>();
    const shaderModules = new Map<string, string>();
    if (options.cloneIdentities) {
      const prefix = `clone_${randomUUID().replaceAll('-', '')}`;
      for (const file of closure.files) {
        if (!file.path.endsWith('.wgsl')) continue;
        const module = /^\s*#define_import_path\s+([\w:.-]+)/m.exec(
          new TextDecoder().decode(file.bytes),
        )?.[1];
        if (module) shaderModules.set(module, `${prefix}::${module}`);
      }
    }
    const originalManifest = await readFile(resolve(root, 'package.json'), 'utf8');
    const originalLock = await optionalText(resolve(root, 'pnpm-lock.yaml'));
    candidate = await mkdtemp(resolve(dirname(root), '.forgeax-transfer-'));
    await copyProjectSourceCandidate(root, candidate);
    const dependenciesMatch = async (directory: string) =>
      (await optionalText(resolve(directory, 'package.json'))) === originalManifest &&
      (await optionalText(resolve(directory, 'pnpm-lock.yaml'))) === originalLock;
    if (!(await dependenciesMatch(candidate)))
      conflict(root, 'target dependencies changed during transfer');
    const destination = resolve(candidate, relative(root, target));
    for (const file of closure.files) {
      const path = resolve(destination, file.path);
      await mkdir(dirname(path), { recursive: true });
      let bytes = file.bytes;
      if (identities.size && /\.(?:[cm]?[jt]sx?|json|gltf|wgsl)$/.test(path)) {
        let source = new TextDecoder()
          .decode(bytes)
          .replace(/(['"])([^'"\\\r\n]*)\1/g, (literal, quote: string, value: string) => {
            const replacement = identities.get(value.toLowerCase()) ?? shaderModules.get(value);
            return replacement === undefined ? literal : quote + replacement + quote;
          });
        if (path.endsWith('.wgsl'))
          source = source.replace(/[A-Za-z_][\w:.-]*/g, (token) => {
            const module = [...shaderModules.keys()].find(
              (name) => token === name || token.startsWith(`${name}::`),
            );
            return module === undefined
              ? token
              : shaderModules.get(module) + token.slice(module.length);
          });
        bytes = new TextEncoder().encode(source);
      }
      await writeFile(path, bytes);
    }
    const installed = await dependencyCandidate(
      closure,
      root,
      candidate,
      sourceLock,
      originalLock,
      originalManifest,
    );
    if (!installed) {
      try {
        await lstat(resolve(root, 'node_modules'));
        await symlink(resolve(root, 'node_modules'), resolve(candidate, 'node_modules'), 'dir');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
    }
    // Source discovery evaluates Pack declarations. Its locked dependencies
    // must exist in the isolated candidate before that first evaluation.
    // Duplicate identities still fail before any target files are published.
    const candidateClosure = await collectAuthorPackClosure(
      candidate,
      relative(candidate, resolve(destination, closure.sourcePath)),
      facts.value.assetRoots,
      engineOptions,
    );
    const destinationPrefix = `${relative(candidate, destination).replaceAll('\\', '/')}/`;
    if (
      options.cloneIdentities &&
      candidateClosure.files.some((file) => !file.path.startsWith(destinationPrefix))
    )
      conflict(destination, 'computed references must resolve inside the cloned source closure');
    const inventory = await discoverTransferPlugins(
      { root: candidate, assetRoots: facts.value.assetRoots },
      engineOptions,
    );
    const sourceInventory = await discoverTransferPlugins(sourceFacts.value, sourceEngineOptions);
    const buildGuids = new Set([
      ...pluginAssetClosure(sourceInventory, sourceFacts.value.roots.build).map(
        (record) => identities.get(record.definition.guid) ?? record.definition.guid,
      ),
      ...pluginAssetClosure(inventory, facts.value.roots.build).map(
        (record) => record.definition.guid,
      ),
    ]);
    for (const target of ['build', 'engine'] as const) {
      const records = [...inventory.assets.values()].filter(
        (record) => buildGuids.has(record.definition.guid) === (target === 'build'),
      );
      if (!records.length) continue;
      const input = resolve(candidate, '.forgeax', `transfer-${target}.ts`);
      await compilePluginAuthoringCandidate({
        root: candidate,
        input,
        source:
          pluginProgramSource(records, target, []) +
          '\nexport const validation = createPrograms("transfer", "candidate", 1);',
        target,
        browserFileName: 'validation',
        plugin: {
          name: 'forgeax:transfer-target-check',
          generateBundle(_options, bundle) {
            if (target === 'build') return;
            for (const output of Object.values(bundle)) {
              if (output.type !== 'chunk') continue;
              if (Object.keys(output.modules).some((id) => id.includes('__vite-browser-external')))
                conflict(input, 'Node dependencies cannot enter a browser plugin closure');
            }
          },
        },
      });
    }
    await assertAuthorPackUnchanged(closure);
    if ((await optionalText(resolve(closure.root, 'pnpm-lock.yaml'))) !== sourceLock)
      conflict(closure.root, 'source lock changed during transfer');
    await assertPluginSourceInputs(targetInventory, root);
    if ((await sourceRevisions()) !== targetRevisions)
      conflict(root, 'target sources changed during transfer');
    for (const [project, selected] of [
      [closure.root, sourceEngineOptions],
      [root, engineOptions],
    ] as const) {
      const current = await projectEngineSourceOptions(project);
      if (current.packageBinding?.root !== selected.packageBinding?.root)
        conflict(project, 'Engine selection changed during transfer');
    }
    if (!(await dependenciesMatch(root)))
      conflict(root, 'target dependencies changed during transfer');
    await assertWritablePath(root, target);
    if (reused) {
      if (installed)
        conflict(
          target,
          'existing import dependencies changed; restore its locked dependencies first',
        );
      return completeCommand({
        sourcePath: resolve(target, closure.sourcePath),
        files: closure.files.length,
        reused: true,
      });
    }
    // Reserve the new destination without overwriting a concurrently created directory.
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target);
    const changes = [
      relative(root, target),
      ...(installed ? ['package.json', 'pnpm-lock.yaml', 'node_modules'] : []),
    ];
    const rollback = resolve(candidate, '.rollback');
    await mkdir(rollback);
    const committed: { path: string; backup?: string }[] = [];
    try {
      for (const [index, path] of changes.entries()) {
        const current = resolve(root, path),
          next = resolve(candidate, path);
        await mkdir(dirname(current), { recursive: true });
        const backup = resolve(rollback, String(index));
        const saved = await rename(current, backup).then(() => backup, ignoreMissing);
        committed.push(saved === undefined ? { path: current } : { path: current, backup: saved });
        await rename(next, current);
      }
    } catch (cause) {
      const failures = [cause];
      for (const change of committed.reverse()) {
        try {
          await rm(change.path, { recursive: true, force: true });
          if (change.backup !== undefined) await rename(change.backup, change.path);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 1) {
        const recovery = candidate;
        candidate = undefined;
        throw new AggregateError(
          failures,
          `transfer rollback failed; recovery files preserved at ${recovery}`,
        );
      }
      throw cause;
    }
    return completeCommand({
      sourcePath: resolve(target, closure.sourcePath),
      files: closure.files.length,
      identities: Object.fromEntries(identities),
      dependencies: closure.dependencies,
    });
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'asset-source-transfer-failed') };
  } finally {
    try {
      if (candidate) await rm(candidate, { recursive: true, force: true });
    } finally {
      if (lock) await rm(lock, { recursive: true, force: true });
    }
  }
}

/** The Pack gateway retains operation idempotency; DevKit owns the project transaction. */
export async function transferPackOperation(
  root: string,
  operation: import('@forgeax/engine-pack/source').PackAuthoringOperation,
) {
  const { ok, err } = await import('@forgeax/engine-types');
  if (operation.packageId !== undefined)
    return err({
      code: 'pack-source-mutation-unsupported' as const,
      expected: 'sourcePath selection and automatically cloned closure identities',
      hint: 'omit packageId; closure cloning remaps every owned namespace together',
      detail: { packageId: operation.packageId },
    });
  const result = await assetSourceImportCommand({
    root,
    sourceRoot: operation.sourceRoot ?? root,
    sourcePath: operation.sourcePath ?? '',
    targetPath: operation.targetPath ?? '',
    cloneIdentities: operation.operation === 'asset.source.clone',
    ...(operation.expectedRevision ? { expectedRevision: operation.expectedRevision } : {}),
  });
  if (!result.ok)
    return err({
      code:
        result.error.code === 'pack-source-revision-conflict'
          ? ('pack-source-revision-conflict' as const)
          : ('pack-source-mutation-unsupported' as const),
      expected: result.error.expected,
      hint: result.error.hint,
      detail: { cause: result.error },
    });
  return ok({
    operation: operation.operation,
    requestId: operation.requestId,
    ...(result.value as Record<string, unknown>),
  });
}
