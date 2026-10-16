import { randomUUID } from 'node:crypto';
import {
  cp,
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
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  type AuthorPackClosure,
  assertAuthorPackUnchanged,
  collectAuthorPackClosure,
} from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { declarationPackageId, scanInventory } from '@forgeax/engine-pack/scanner';
import { build } from 'vite';
import { parseAllDocuments, stringify } from 'yaml';
import {
  assertPluginSourceInputs,
  discoverPluginAssets,
  pluginAssetClosure,
} from './build/plugin-assets.js';
import { pluginProgramSource, pluginRuntimeProjection } from './build/plugin-programs.js';
import { execFileCommand } from './child-process.js';
import { commandError, readProjectFacts } from './project.js';
import type { CommandResult, ProjectCommandOptions } from './types.js';

export interface SourceTransferOptions extends ProjectCommandOptions {
  readonly sourceRoot: string;
  readonly sourcePath: string;
  /** New directory beneath the target project's assets tree. */
  readonly targetPath: string;
  readonly cloneIdentities?: boolean;
  readonly expectedRevision?: string;
}
function conflict(path: string, reason: string): never {
  throw {
    code: 'pack-source-revision-conflict',
    expected: 'one validated author closure with consistent identities and locked dependencies',
    hint: 'repair the reported conflict or explicitly clone identities into an unused directory',
    detail: { path, reason },
  };
}
/** Source mutations reject symlink ancestors instead of writing outside the selected project. */
async function assertWritablePath(root: string, path: string): Promise<void> {
  const rel = relative(root, path).replaceAll('\\', '/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    conflict(path, 'write escapes project');
  let current = root;
  for (const part of rel.split('/')) {
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
  return files.sort();
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
async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

/** pnpm's project lockfile is the last YAML document; earlier documents hold environment dependencies. */
function parseProjectLockfile(text: string, root: string) {
  const documents = parseAllDocuments(text);
  if (documents.some((document) => document.errors.length > 0))
    conflict(root, 'pnpm lockfile contains invalid YAML');
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

/** Merge exact resolved nodes, then let pnpm verify the frozen candidate without choosing new versions. */
async function dependencyCandidate(
  closure: AuthorPackClosure,
  target: string,
  candidate: string,
): Promise<boolean> {
  if (!Object.keys(closure.dependencies).length) return false;
  const sourceText = await optionalText(resolve(closure.root, 'pnpm-lock.yaml'));
  if (!sourceText) conflict(closure.root, 'source dependencies require a project pnpm-lock.yaml');
  const source = parseProjectLockfile(sourceText, closure.root).value;
  if (String(source.lockfileVersion) !== '9.0')
    conflict(closure.root, 'expected the supported pnpm lockfile format 9.0');
  const targetText = await optionalText(resolve(target, 'pnpm-lock.yaml'));
  const targetProject = targetText ? parseProjectLockfile(targetText, target) : undefined;
  const locked = targetProject
    ? targetProject.value
    : {
        lockfileVersion: '9.0',
        settings: source.settings,
        importers: { '.': {} },
        packages: {},
        snapshots: {},
      };
  if (String(locked.lockfileVersion) !== '9.0')
    conflict(target, 'incompatible target lockfile format');
  const manifest = JSON.parse(await readFile(resolve(candidate, 'package.json'), 'utf8'));
  manifest.dependencies ??= {};
  locked.importers['.'] ??= {};
  const imports = locked.importers['.'];
  imports.dependencies ??= {};
  const pending: string[] = [];
  let changed = false;
  for (const [name] of Object.entries(closure.dependencies)) {
    const entry =
      source.importers['.']?.dependencies?.[name] ?? source.importers['.']?.devDependencies?.[name];
    if (!entry) conflict(name, 'source dependency must have locked resolution evidence');
    if (entry.specifier !== closure.dependencies[name])
      conflict(name, 'source manifest and lock specifier differ');
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
      conflict(name, `locked version conflict: ${current.version} versus ${entry.version}`);
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
    if (targetProject) {
      const prefix = targetProject.documents
        .slice(0, -1)
        .map((document) => document.toString())
        .join('');
      const separator = prefix && !prefix.endsWith('\n') ? '\n' : '';
      await writeFile(
        resolve(candidate, 'pnpm-lock.yaml'),
        `${prefix}${separator}---\n${stringify(locked)}`,
      );
    } else {
      await writeFile(resolve(candidate, 'pnpm-lock.yaml'), stringify(locked));
    }
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

async function cloneMap(closure: AuthorPackClosure): Promise<Map<string, string>> {
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
  const committed: { path: string; backup?: string }[] = [];
  try {
    const facts = await readProjectFacts(options.root);
    if (!facts.ok) return facts;
    const root = await realpath(facts.value.root);
    const target = resolve(root, options.targetPath);
    const targetRelative = relative(resolve(root, 'assets'), target).replaceAll('\\', '/');
    if (
      !targetRelative ||
      targetRelative === '..' ||
      targetRelative.startsWith('../') ||
      isAbsolute(targetRelative)
    )
      conflict(options.targetPath, 'target must be a new directory beneath assets');
    await assertWritablePath(root, target);
    for (const name of ['package.json', 'pnpm-lock.yaml', '.forgeax/source-transfer.lock'])
      await assertWritablePath(root, resolve(root, name));
    const lockPath = resolve(root, '.forgeax/source-transfer.lock');
    await mkdir(dirname(lockPath), { recursive: true });
    await mkdir(lockPath);
    lock = lockPath;
    const closure = await collectAuthorPackClosure(options.sourceRoot, options.sourcePath);
    const sourceLock = await optionalText(resolve(closure.root, 'pnpm-lock.yaml'));
    if (
      options.expectedRevision &&
      closure.files.find((file) => file.path === closure.sourcePath)?.digest !==
        options.expectedRevision
    )
      conflict(options.sourcePath, 'source revision changed');
    let reused = false;
    try {
      await lstat(target);
      if (options.cloneIdentities) conflict(target, 'clone target already exists');
      for (const file of closure.files) {
        const existing = await readFile(resolve(target, file.path));
        if (!existing.equals(file.bytes)) conflict(target, 'existing import differs from source');
      }
      if (
        JSON.stringify(await importedFiles(target)) !==
        JSON.stringify(closure.files.map((file) => file.path).sort())
      )
        conflict(target, 'existing import has extra or missing source files');
      reused = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    // An existing partial directory is a conflict, never a repair-by-overwrite.
    try {
      if (!reused) {
        await lstat(target);
        conflict(target, 'existing import is incomplete');
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    const targetInventory = await discoverPluginAssets(facts.value);
    const targetSources = await scanInventory([resolve(root, 'assets')]);
    if (!targetSources.ok) throw targetSources.error;
    const targetRevisions = JSON.stringify(
      [...targetSources.value.declarations]
        .map(([path, source]) => [path, source.sourceRevision])
        .sort(),
    );
    const identities = options.cloneIdentities
      ? await cloneMap(closure)
      : new Map<string, string>();
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
    await cp(root, candidate, {
      recursive: true,
      filter: (path) =>
        !relative(root, path)
          .split(/[\\/]/)
          .some((part) =>
            ['node_modules', '.git', '.forgeax', '.worktrees', 'dist'].includes(part),
          ),
    });
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
    const installed = await dependencyCandidate(closure, root, candidate);
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
    const scanned = await scanInventory([resolve(candidate, 'assets')]);
    if (!scanned.ok) throw scanned.error;
    const candidateClosure = await collectAuthorPackClosure(
      candidate,
      relative(candidate, resolve(destination, closure.sourcePath)),
    );
    const destinationPrefix = `${relative(candidate, destination).replaceAll('\\', '/')}/`;
    if (
      options.cloneIdentities &&
      candidateClosure.files.some((file) => !file.path.startsWith(destinationPrefix))
    )
      conflict(destination, 'computed references must resolve inside the cloned source closure');
    const inventory = await discoverPluginAssets({ root: candidate, assetRoots: ['assets'] });
    const sourceFacts = await readProjectFacts(closure.root);
    if (!sourceFacts.ok) throw sourceFacts.error;
    const sourceInventory = await discoverPluginAssets(sourceFacts.value);
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
      await mkdir(dirname(input), { recursive: true });
      await writeFile(
        input,
        pluginProgramSource(records, target, []) +
          '\nexport const validation = createPrograms("transfer", "candidate", 1);',
      );
      await build({
        root: candidate,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          pluginRuntimeProjection(candidate),
          {
            name: 'forgeax:transfer-target-check',
            generateBundle(_options, bundle) {
              if (target === 'build') return;
              for (const output of Object.values(bundle)) {
                if (output.type !== 'chunk') continue;
                if (
                  Object.keys(output.modules).some((id) => id.includes('__vite-browser-external'))
                )
                  conflict(input, 'Node dependencies cannot enter a browser plugin closure');
              }
            },
          },
        ],
        build: {
          write: false,
          target: 'esnext',
          minify: false,
          ...(target === 'build'
            ? { ssr: input }
            : { lib: { entry: input, formats: ['es'] as 'es'[], fileName: 'validation' } }),
        },
      });
    }
    await assertAuthorPackUnchanged(closure);
    if ((await optionalText(resolve(closure.root, 'pnpm-lock.yaml'))) !== sourceLock)
      conflict(closure.root, 'source lock changed during transfer');
    if (
      (await readFile(resolve(root, 'package.json'), 'utf8')) !== originalManifest ||
      (await optionalText(resolve(root, 'pnpm-lock.yaml'))) !== originalLock
    )
      conflict(root, 'target dependencies changed during transfer');
    await assertPluginSourceInputs(targetInventory, root);
    const currentSources = await scanInventory([resolve(root, 'assets')]);
    if (!currentSources.ok) throw currentSources.error;
    if (
      JSON.stringify(
        [...currentSources.value.declarations]
          .map(([path, source]) => [path, source.sourceRevision])
          .sort(),
      ) !== targetRevisions
    )
      conflict(root, 'target sources changed during transfer');
    await assertWritablePath(root, target);
    if (reused) {
      if (installed)
        conflict(
          target,
          'existing import dependencies changed; restore its locked dependencies first',
        );
      return {
        ok: true,
        value: {
          sourcePath: resolve(target, closure.sourcePath),
          files: closure.files.length,
          reused: true,
        },
      };
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
    try {
      for (const [index, path] of changes.entries()) {
        const current = resolve(root, path),
          next = resolve(candidate, path);
        await mkdir(dirname(current), { recursive: true });
        let backup: string | undefined;
        try {
          await lstat(current);
          backup = resolve(rollback, String(index));
          await rename(current, backup);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
        committed.push({ path: current, ...(backup ? { backup } : {}) });
        await rename(next, current);
      }
    } catch (cause) {
      const failures = [cause];
      for (const change of committed.reverse()) {
        try {
          await rm(change.path, { recursive: true, force: true });
          if (change.backup) await rename(change.backup, change.path);
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
    return {
      ok: true,
      value: {
        sourcePath: resolve(target, closure.sourcePath),
        files: closure.files.length,
        identities: Object.fromEntries(identities),
        dependencies: closure.dependencies,
      },
    };
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
