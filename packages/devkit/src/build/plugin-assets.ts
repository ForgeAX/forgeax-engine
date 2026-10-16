import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  pluginAssetOutputProducer,
  resolvePluginProgram,
  type ScriptablePackBuildProductCache,
} from '@forgeax/engine-import';
import {
  listPackSourcePaths,
  type ScanInventory,
  type ScriptablePackSourceDeclaration,
  scanInventory,
} from '@forgeax/engine-pack/scanner';
import {
  type AnyScriptablePackDefinition,
  AssetGuid,
  PackageId,
  type PackBuildReadContext,
  type PackOutputMap,
  type PluginAssetSource,
  projectDirectPackJson,
  resolvePackParameterValues,
  validatePluginAssetSource,
} from '@forgeax/engine-pack/source';
import {
  createLazyScriptablePackDefinition,
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  loadScriptablePack,
  type ScriptablePackSourceSnapshot,
} from '@forgeax/engine-pack/source-node';
import { err, type PluginAsset, type PluginAssetDefinition } from '@forgeax/engine-types';
import ts from 'typescript';
import {
  filesystemPathKey,
  filesystemPathSegments,
  isFilesystemPathWithin,
} from '../filesystem-path.js';
import type { ProjectFacts } from '../types.js';

export interface PluginSourceRecord {
  readonly definition: PluginAssetDefinition;
  readonly source: PluginAssetSource;
  readonly sourcePath: string;
  readonly sourceKey: string;
  readonly refs: readonly string[];
  readonly module: string;
  readonly export: string;
}

export interface PluginSourceInventory {
  readonly assets: ReadonlyMap<string, PluginSourceRecord>;
  readonly deferred: readonly string[];
  readonly sourceInputs: ReadonlyMap<string, string>;
  readonly sourceSnapshot: ScriptablePackSourceSnapshot;
  readonly filesystemInputs: readonly string[] | undefined;
}

function sourceInputPathCandidates(path: string): readonly string[] {
  const normalized = filesystemPathKey(path);
  const windows = normalized.replaceAll('/', '\\');
  return normalized === windows ? [normalized] : [normalized, windows];
}

export function pluginSourceInputRevision(
  sourceInputs: ReadonlyMap<string, string>,
  path: string,
): string | undefined {
  let selected: string | undefined;
  for (const candidate of sourceInputPathCandidates(path)) {
    const revision = sourceInputs.get(candidate);
    if (revision === undefined) continue;
    // Two spellings of one file cannot carry conflicting snapshots; preserve the source fence.
    if (selected !== undefined && selected !== revision) return undefined;
    selected = revision;
  }
  return selected;
}

export function hasPluginSourceInput(
  sourceInputs: ReadonlyMap<string, string>,
  path: string,
): boolean {
  return sourceInputPathCandidates(path).some((candidate) => sourceInputs.has(candidate));
}

export function isPluginAssetSourceIgnoredPath(root: string, path: string): boolean {
  return filesystemPathSegments(relative(root, path)).some(
    (part) => part === 'node_modules' || part === '.forgeax',
  );
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function failure(path: string, reason: unknown): never {
  const diagnostic = {
    code: 'plugin-bootstrap-failed',
    expected: 'deterministic plugin definitions discoverable without cooked reads',
    hint: 'repair the source or move build-root definitions to a self-contained Pack',
    detail: { sourcePath: path, cause: reason },
  };
  // Bundlers transport Error.message; a plain diagnostic object loses the
  // rejected source and byte identities at the native plugin boundary.
  throw Object.assign(new Error(JSON.stringify(diagnostic)), diagnostic);
}

async function observeCompilerConfig(
  snapshot: ScriptablePackSourceSnapshot,
  path: string,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(path)) return;
  seen.add(path);
  if (!(await snapshot.observeFile(path))) return;
  const parsed = ts.parseConfigFileTextToJson(path, await snapshot.readText(path));
  const extensions: unknown = parsed.config?.extends;
  for (const specifier of typeof extensions === 'string'
    ? [extensions]
    : Array.isArray(extensions)
      ? extensions
      : []) {
    if (typeof specifier !== 'string') continue;
    if (specifier.startsWith('.')) {
      const candidate = resolve(dirname(path), specifier);
      const selected = (await snapshot.observeFile(candidate))
        ? candidate
        : candidate.endsWith('.json')
          ? candidate
          : `${candidate}.json`;
      await observeCompilerConfig(snapshot, selected, seen);
    } else {
      await observeCompilerConfig(snapshot, createRequire(path).resolve(specifier), seen);
    }
  }
}

export function assertPluginSourceRevision(
  path: string,
  expected: string | undefined,
  actual: string,
): void {
  if (actual !== expected)
    failure(path, { reason: 'source changed during plugin compilation', expected, actual });
}

/** Add declared local programs to the existing fence without rebasing any frozen input. */
export async function capturePluginProgramInputs(
  projectRoot: string,
  inventory: Pick<PluginSourceInventory, 'sourceSnapshot'>,
  module: string,
  resolveModule?: (specifier: string, importer: string) => Promise<string | undefined>,
): Promise<void> {
  const root = await realpath(projectRoot);
  const resolveLocal = async (importer: string, specifier: string) => {
    const resolved = resolveModule ? await resolveModule(specifier, importer) : specifier;
    if (!resolved || !isAbsolute(resolved)) return undefined;
    let path: string;
    try {
      path = await realpath(resolved.split('?')[0] ?? resolved);
    } catch (cause) {
      // A .js declaration can resolve to authored .ts; discovery does not
      // choose the compiler's extension or condition rules.
      if (
        (cause as NodeJS.ErrnoException).code === 'ENOENT' &&
        (!resolveModule || isPluginAssetSourceIgnoredPath(root, resolved.split('?')[0] ?? resolved))
      )
        return undefined;
      throw cause;
    }
    if (!resolveModule && !(await stat(path)).isFile()) return undefined;
    if (!isFilesystemPathWithin(root, path, false) || isPluginAssetSourceIgnoredPath(root, path))
      return undefined;
    return resolved.split('?')[0] ?? resolved;
  };
  const entry = await resolveLocal(resolve(root, 'package.json'), module);
  if (!entry) return;
  // Discovery freezes known files. The actual compiler/contract loader supplies
  // its resolver before consuming the closure; no second build configuration exists.
  const inputs = await inventory.sourceSnapshot.inventory(
    entry,
    undefined,
    resolveModule ? resolveLocal : undefined,
  );
  const directories = new Set<string>();
  // Package boundaries and tsconfig candidates affect compiler resolution even
  // when they are not JavaScript imports. Observe absence as well as content.
  for (const input of inputs) {
    let directory = dirname(input.path);
    while (isFilesystemPathWithin(root, directory, true) && !directories.has(directory)) {
      directories.add(directory);
      await inventory.sourceSnapshot.observeFile(resolve(directory, 'package.json'));
      await observeCompilerConfig(inventory.sourceSnapshot, resolve(directory, 'tsconfig.json'));
      if (directory === root) break;
      directory = dirname(directory);
    }
  }
}

async function capturePluginSourceInput(
  snapshot: ScriptablePackSourceSnapshot,
  path: string,
  revision: string,
): Promise<void> {
  const actual = await snapshot.digest(path);
  if (actual !== revision)
    failure(path, {
      reason: 'source changed during plugin compilation',
      expected: revision,
      actual,
    });
}

async function hasUnboundedFilesystemReads(
  snapshot: ScriptablePackSourceSnapshot,
): Promise<boolean> {
  for (const path of snapshot.inputs.keys()) {
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    const source = await snapshot.readText(path);
    if (
      ts
        .preProcessFile(source, true, true)
        .importedFiles.some(({ fileName }) => /^(?:node:)?fs(?:\/promises)?$/.test(fileName)) ||
      /\b(?:readFile(?:Sync)?|readdir(?:Sync)?|createReadStream)\s*\(/.test(source)
    )
      return true;
  }
  return false;
}

async function filesystemSourcePaths(root: string): Promise<readonly string[]> {
  const ignored = new Set([
    'node_modules',
    '.git',
    '.forgeax',
    '.assetlib',
    '.worktrees',
    'artifacts',
    'dist',
    'coverage',
    '__tests__',
    '.forgeax-harness',
  ]);
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.isFile() &&
        /(?:\.[cm]?[jt]sx?|\.wgsl|\.json|lock\.yaml|bun\.lock)$/.test(entry.name)
      )
        paths.push(path);
    }
  }
  await visit(root);
  return paths.sort();
}

async function captureFilesystemSourceInputs(
  root: string,
  snapshot: ScriptablePackSourceSnapshot,
): Promise<readonly string[]> {
  const paths = await snapshot.observePaths(root, () => filesystemSourcePaths(root));
  for (let start = 0; start < paths.length; start += 16)
    await Promise.all(paths.slice(start, start + 16).map((path) => snapshot.digest(path)));
  return paths;
}

/** Metadata inventories carry their snapshot; two-argument inventories retain their existing leases. */
export async function discoverPluginAssets(
  facts: Pick<ProjectFacts, 'root' | 'assetRoots'>,
  scannedInventory?: ScanInventory,
  sourceSnapshot?: ScriptablePackSourceSnapshot,
  productCache?: ScriptablePackBuildProductCache,
): Promise<PluginSourceInventory> {
  const retainedInventory = scannedInventory !== undefined && sourceSnapshot === undefined;
  const capturedSources = sourceSnapshot ?? createScriptablePackSourceSnapshot();
  const sourceRoots = facts.assetRoots.map((path) => resolve(facts.root, path));
  const sourcePaths = await capturedSources.observePaths(facts.root, () =>
    listPackSourcePaths(sourceRoots, {
      ignorePath: (path) => isPluginAssetSourceIgnoredPath(facts.root, path),
    }),
  );
  let filesystemInputs: readonly string[] | undefined;
  for (const path of sourcePaths)
    if (path.endsWith('.pack.ts')) await capturedSources.inventory(path);
  if (await hasUnboundedFilesystemReads(capturedSources))
    filesystemInputs = await captureFilesystemSourceInputs(facts.root, capturedSources);
  let inventory = scannedInventory;
  if (!inventory) {
    const scanned = await scanInventory(
      facts.assetRoots.map((root) => resolve(facts.root, root)),
      {
        ignorePath: (path) => isPluginAssetSourceIgnoredPath(facts.root, path),
        scriptablePack: { metadataOnly: true, sourceSnapshot: capturedSources },
      },
    );
    if (!scanned.ok) throw scanned.error;
    inventory = scanned.value;
  }
  const assets = new Map<string, PluginSourceRecord>();
  for (const file of [
    'forge.json',
    'package.json',
    'pnpm-lock.yaml',
    'bun.lock',
    'package-lock.json',
    'tsconfig.json',
  ])
    await capturedSources.observeFile(resolve(facts.root, file));
  await observeCompilerConfig(capturedSources, resolve(facts.root, 'tsconfig.json'));
  for (const declaration of inventory.declarations.values()) {
    await capturePluginSourceInput(
      capturedSources,
      declaration.sourcePath,
      declaration.sourceRevision,
    );
    if (declaration.format === 'pack.ts')
      for (const input of declaration.sourceClosure)
        await capturePluginSourceInput(capturedSources, input.path, input.digest);
  }
  const sourceInputs = capturedSources.inputs;
  const programInputs = { sourceSnapshot: capturedSources };
  const deferred: string[] = [];
  const sourceDeclarations = inventory.declarations;
  const declarations = [...sourceDeclarations.values()];

  async function add(
    sourcePath: string,
    revision: string,
    packageId: PackageId,
    outputs: PackOutputMap,
  ): Promise<void> {
    for (const [sourceKey, output] of Object.entries(outputs)) {
      if (output.kind !== 'plugin') continue;
      const declaration = sourceDeclarations.get(sourcePath);
      await capturePluginSourceInput(
        capturedSources,
        sourcePath,
        declaration?.sourceRevision ?? revision,
      );
      if (declaration?.format === 'pack.ts')
        for (const input of declaration.sourceClosure)
          await capturePluginSourceInput(capturedSources, input.path, input.digest);
      const source = validatePluginAssetSource(output);
      if (!source.ok) failure(sourcePath, source.error);
      const guid = AssetGuid.format(AssetGuid.derive(packageId, sourceKey));
      if (assets.has(guid)) failure(sourcePath, `duplicate plugin GUID ${guid}`);
      const resolved = resolvePluginProgram(sourcePath, source.value.module, facts.root);
      await capturePluginProgramInputs(facts.root, programInputs, resolved.module);
      const contract = source.value.toolContract;
      if (contract && 'specifier' in contract)
        await capturePluginProgramInputs(
          facts.root,
          programInputs,
          contract.specifier.startsWith('.')
            ? resolve(dirname(sourcePath), contract.specifier)
            : contract.specifier,
        );
      const cooked = await pluginAssetOutputProducer.produce({
        guid,
        sourceKey,
        asset: source.value,
        sourcePath,
        projectRoot: facts.root,
      });
      if (!cooked.ok) failure(sourcePath, cooked.error);
      const asset = cooked.value.payload as PluginAsset;
      assets.set(guid, {
        definition: { guid, asset, evidence: { kind: 'source', revision, digest: digest(asset) } },
        source: source.value,
        sourcePath,
        sourceKey,
        refs: cooked.value.refs.map((ref) => ref.guid),
        module: resolved.module,
        export: resolved.export,
      });
    }
  }

  async function evaluate(
    sourcePath: string,
    definition: AnyScriptablePackDefinition,
    packageId = definition.packageId,
    overrides: Readonly<Record<string, unknown>> = {},
  ): Promise<PackOutputMap | undefined> {
    const declaration = sourceDeclarations.get(sourcePath);
    if (
      productCache !== undefined &&
      declaration?.format === 'pack.ts' &&
      PackageId.format(packageId) === PackageId.format(declaration.definition.packageId) &&
      Object.keys(overrides).length === 0
    ) {
      const product = await productCache.read({
        definition,
        sourcePath,
        sourceClosure: declaration.sourceClosure,
        publicationGeneration: 1,
      });
      if (product !== undefined)
        return Object.fromEntries(
          product.stagedOutputs.map((output) => [output.sourceKey, output.asset]),
        ) as PackOutputMap;
    }
    let blocked = false;
    const context: PackBuildReadContext & { packageId: PackageId } = {
      packageId,
      async readByGuid(guid) {
        blocked = true;
        return err({
          code: 'plugin-bootstrap-read-blocked',
          expected: 'source-only bootstrap inputs',
          hint: 'defer this Pack to normal cooking',
          detail: { guid: AssetGuid.format(guid) },
        });
      },
    };
    const result =
      'parameters' in definition
        ? await definition.build({
            ...context,
            values: resolvePackParameterValues(definition, overrides).unwrap(),
          })
        : await definition.build(context);
    if (blocked) return undefined;
    if (!result.ok) failure(sourcePath, result.error);
    return result.value;
  }

  // Match the metadata scan's four independent workers. Caller-owned retained
  // definitions stay serial; each owned bootstrap lease still retires after one task.
  const batchSize = retainedInventory ? 1 : 4;
  const executors = createScriptablePackModuleExecutorPool({
    maxWorkers: batchSize,
    maxTasksPerWorker: 1,
  });
  const definitionFor = (declaration: ScriptablePackSourceDeclaration) =>
    retainedInventory
      ? declaration.definition
      : createLazyScriptablePackDefinition({
          sourcePath: declaration.sourcePath,
          definition: declaration.definition,
          sourceClosure: declaration.sourceClosure,
          sourceSnapshot: capturedSources,
          executors,
        });
  try {
    for (let start = 0; start < declarations.length; start += batchSize) {
      const batch = declarations.slice(start, start + batchSize);
      const completed = await Promise.allSettled(
        batch.map(async (declaration) => ({
          declaration,
          outputs:
            declaration.format === 'pack.ts'
              ? await evaluate(declaration.sourcePath, definitionFor(declaration))
              : undefined,
        })),
      );
      // All started work settles before source-ordered validation/publication.
      // A later build failure cannot hide an earlier invalid or duplicate output.
      for (const result of completed) {
        if (result.status === 'rejected') throw result.reason;
        const { declaration, outputs } = result.value;
        if (declaration.format === 'pack.ts') {
          if (outputs === undefined) deferred.push(relative(facts.root, declaration.sourcePath));
          else
            await add(
              declaration.sourcePath,
              declaration.sourceRevision,
              declaration.definition.packageId,
              outputs,
            );
        } else if (
          declaration.format === 'pack.json' &&
          declaration.value.schemaVersion === '3.0.0'
        ) {
          const parsed = declaration.value;
          if (parsed.format !== 'direct') continue;
          const projected = projectDirectPackJson(parsed);
          const outputs = Object.fromEntries(
            projected.assets.map((asset) => [
              asset.sourceKey,
              { ...asset.payload, kind: asset.kind },
            ]),
          ) as PackOutputMap;
          await add(declaration.sourcePath, declaration.sourceRevision, parsed.packageId, outputs);
        }
      }
    }
    // Instances must execute the original declaring module; moving an instance does not rebase imports.
    for (const [sourcePath, instance] of inventory.instances) {
      await capturePluginSourceInput(capturedSources, sourcePath, instance.sourceRevision);
      const definition = retainedInventory
        ? (await loadScriptablePack(instance.root.sourcePath)).unwrap()
        : definitionFor(instance.root);
      const outputs = await evaluate(
        instance.root.sourcePath,
        definition,
        instance.packageId,
        instance.values,
      );
      if (outputs === undefined) deferred.push(relative(facts.root, instance.root.sourcePath));
      else
        await add(
          instance.root.sourcePath,
          digest([instance.sourceRevision, instance.root.sourceRevision]),
          instance.packageId,
          outputs,
        );
    }
    if (filesystemInputs === undefined && (await hasUnboundedFilesystemReads(capturedSources)))
      filesystemInputs = await captureFilesystemSourceInputs(facts.root, capturedSources);
    return {
      assets,
      sourceInputs,
      sourceSnapshot: capturedSources,
      filesystemInputs,
      deferred: [...new Set(deferred)].sort(),
    };
  } finally {
    await executors.dispose();
  }
}

export function pluginAssetClosure(
  inventory: PluginSourceInventory,
  root: string | undefined,
): readonly PluginSourceRecord[] {
  if (!root) return [];
  const result = new Map<string, PluginSourceRecord>();
  const queue = [root];
  for (const guid of queue) {
    if (result.has(guid)) continue;
    const record = inventory.assets.get(guid);
    if (!record) failure(guid, { missingPlugin: guid, deferredSources: inventory.deferred });
    result.set(guid, record);
    for (const ref of record.refs) if (inventory.assets.has(ref)) queue.push(ref);
  }
  return [...result.values()];
}

/** Merge the final producer projection, rejecting bootstrap definitions that changed while cooking. */
export async function publishedPluginInventory(
  projectRoot: string,
  bootstrap: PluginSourceInventory,
  pack: Pick<import('@forgeax/engine-vite-plugin-pack').PluginPack, 'readPluginDefinitions'>,
): Promise<PluginSourceInventory> {
  await assertPluginSourceInputs(bootstrap, projectRoot);
  const assets = new Map(bootstrap.assets);
  const published = await pack.readPluginDefinitions();
  for (const item of published) {
    const previous = bootstrap.assets.get(item.definition.guid);
    if (previous && digest(previous.definition.asset) !== digest(item.definition.asset)) {
      failure(
        previous.sourcePath,
        'plugin definition changed between bootstrap and ordinary cooking',
      );
    }
    const program = item.definition.asset.program;
    const split = program.lastIndexOf('#');
    const locator = program.slice(0, split);
    const name = decodeURIComponent(program.slice(split + 1));
    const module = locator.startsWith('project:')
      ? resolve(projectRoot, locator.slice(8))
      : locator.slice(4);
    if ((!locator.startsWith('project:') && !locator.startsWith('npm:')) || split < 0)
      failure(item.sourcePath, 'invalid program locator');
    await capturePluginProgramInputs(projectRoot, bootstrap, module);
    assets.set(
      item.definition.guid,
      previous
        ? { ...previous, definition: item.definition }
        : {
            ...item,
            sourceKey: item.definition.guid,
            module,
            export: name,
            source: { kind: 'plugin', module: { specifier: module, export: name } },
          },
    );
  }
  return { ...bootstrap, assets, deferred: [] };
}

/** Publication must use the exact authored definitions used to bootstrap this session. */
export async function assertPluginSourceInputs(
  inventory: PluginSourceInventory,
  projectRoot: string,
): Promise<void> {
  const verified = await inventory.sourceSnapshot.verify();
  if (!verified.ok)
    failure(String(verified.error.detail.sourcePath ?? projectRoot), {
      ...verified.error.detail,
      reason: 'source changed during plugin compilation',
      conflict: verified.error.detail.reason,
    });
}
