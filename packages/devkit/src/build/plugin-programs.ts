import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import type { HostRootDescriptor } from '@forgeax/engine-host/protocol';
import { resolvePluginProgram } from '@forgeax/engine-import';
import { lowerPluginToolContract } from '@forgeax/engine-pack/source';
import {
  defineToolCommandContract,
  type ToolCommandContract,
  type ToolCommandDeclaration,
} from '@forgeax/engine-tool-runtime';
import type {
  PluginAssetDefinition,
  PluginBuildTarget,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import MagicString from 'magic-string';
import ts from 'typescript';
import type { Plugin, ResolvedConfig } from 'vite';
import {
  filesystemPathKey,
  filesystemPathRelative,
  filesystemPathSegments,
  isFilesystemPathWithin,
} from '../filesystem-path.js';
import { discoverProjectTools, type ProjectToolBinding } from '../tools/project-tools.js';
import { markDevProgramResources } from './dev-program-resources.js';
import {
  devProgramSession,
  devProgramSessionQuery,
  normalizeDevProgramUrl,
  withDevProgramSession,
} from './dev-program-url.js';
import { engineCapabilityMeta } from './execution-workers.js';
import { runtimeProgramIdentity } from './pack-program-imports.js';
import {
  assertPluginSourceInputs,
  assertPluginSourceRevision,
  capturePluginProgramInputs,
  hasPluginSourceInput,
  type PluginSourceInventory,
  type PluginSourceRecord,
  pluginAssetClosure,
} from './plugin-assets.js';
import { BrowserPluginProgramArchive } from './plugin-programs-browser.js';
import { captureDevPluginPrograms } from './plugin-programs-dev.js';

export const pluginRuntimeQuery = '?forgeax-plugin-runtime';
const prefix = 'virtual:forgeax/plugin-programs/';
const exportPrefix = 'virtual:forgeax/plugin-export/';
const nativeEntriesMarker = '__forgeax_native_program_entries__';
const devProgramSessions = new WeakMap<ResolvedConfig, string>();

export function exportModule(module: string, name: string): string {
  return (
    exportPrefix +
    encodeURIComponent(name) +
    '?source=' +
    encodeURIComponent(JSON.stringify([module, name]))
  );
}

export function assertStaticPluginImports(source: string, filename: string): void {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      (node.arguments.length !== 1 ||
        node.arguments[0] === undefined ||
        !ts.isStringLiteralLike(node.arguments[0]))
    ) {
      throw new TypeError(`${filename}: plugin runtime imports must have literal specifiers`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

/** Remove the authoring expression. Remaining exports use standard bundler semantics. */
export function projectPluginRuntimeSource(source: string, filename: string) {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const defineNames = new Set<string>();
  for (const node of file.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !['@forgeax/engine/pack/source', '@forgeax/engine-pack/source'].includes(
        node.moduleSpecifier.text,
      )
    )
      continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'definePack')
          defineNames.add(binding.name.text);
      }
  }
  const declaration = file.statements.find(
    (node) =>
      ts.isExportAssignment(node) &&
      !node.isExportEquals &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      defineNames.has(node.expression.expression.text),
  );
  if (!declaration)
    throw new TypeError(`${filename}: expected default definePack(...) for the runtime projection`);
  const edits = [{ start: declaration.getStart(file), end: declaration.end, text: '' }];
  for (const node of file.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !node.importClause?.namedBindings ||
      !ts.isNamedImports(node.importClause.namedBindings)
    )
      continue;
    const bindings = node.importClause.namedBindings;
    const remaining = bindings.elements.filter((binding) => !defineNames.has(binding.name.text));
    if (remaining.length === bindings.elements.length) continue;
    const clause = ts.factory.updateImportClause(
      node.importClause,
      node.importClause.isTypeOnly,
      node.importClause.name,
      remaining.length ? ts.factory.updateNamedImports(bindings, remaining) : undefined,
    );
    const replacement =
      remaining.length || clause.name
        ? ts
            .createPrinter()
            .printNode(
              ts.EmitHint.Unspecified,
              ts.factory.updateImportDeclaration(
                node,
                node.modifiers,
                clause,
                node.moduleSpecifier,
                node.attributes,
              ),
              file,
            )
        : '';
    edits.push({ start: node.getStart(file), end: node.end, text: replacement });
  }
  const output = new MagicString(source);
  for (const edit of edits) output.overwrite(edit.start, edit.end, edit.text);
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: filename, includeContent: true }),
  };
}

export function pluginRootDescriptor(definition: PluginAssetDefinition): HostRootDescriptor {
  return {
    program: definition.asset.program,
    source: definition.guid,
    codeRevision: JSON.stringify(definition.evidence),
    ...(definition.asset.config === undefined ? {} : { config: definition.asset.config }),
  };
}

export function pluginProgramSpecifier(
  record: Pick<PluginSourceRecord, 'module' | 'export' | 'sourcePath'>,
): string {
  if (!record.module.endsWith('.pack.ts')) return record.module;
  if (record.export === 'default')
    throw new TypeError(`${record.sourcePath}: a Pack runtime plugin requires a named export`);
  return `${record.module}${pluginRuntimeQuery}`;
}

/** Pure producer projection shared by normal delivery and portable program capture. */
export function projectPluginPrograms(
  records: readonly PluginSourceRecord[],
  target: PluginBuildTarget,
  tools: readonly ProjectToolBinding[] = [],
  projectRoot?: string,
) {
  const programs = new Map<string, { readonly module: string; readonly export: string }>();
  const add = (key: string, module: string, name: string) => {
    const previous = programs.get(key);
    if (previous && (previous.module !== module || previous.export !== name))
      throw new TypeError(`conflicting delivered program ${key}`);
    programs.set(key, { module, export: name });
  };
  for (const record of records) {
    add(record.definition.asset.program, pluginProgramSpecifier(record), record.export);
  }
  const declarations = new Map<string, ToolCommandDeclaration[]>(
    records.map((record) => [record.definition.guid, []]),
  );
  for (const tool of tools) {
    const rows = declarations.get(tool.assetGuid);
    if (tool.realm !== target || !rows) continue;
    const contract = lowerPluginToolContract(
      defineToolCommandContract([tool.declaration]),
      (reference) => {
        const resolved = resolvePluginProgram(tool.moduleName, reference, projectRoot);
        const module = pluginProgramSpecifier({ ...resolved, sourcePath: tool.moduleName });
        add(resolved.program, module, resolved.export);
        return resolved.program;
      },
    );
    if (!contract.ok) throw new TypeError(contract.error.detail.reason);
    rows.push(...contract.value.commands);
  }
  const contracts = new Map<string, ToolCommandContract>(
    [...declarations].map(([guid, rows]) => [guid, defineToolCommandContract(rows)]),
  );
  return { programs, tools: contracts };
}

export function pluginProgramSource(
  records: readonly PluginSourceRecord[],
  target: PluginBuildTarget,
  definitions: readonly (readonly [string, PluginAssetDefinition['evidence']])[],
  tools: readonly ProjectToolBinding[] = [],
  projectRoot?: string,
  archiveSuffix?: string,
): string {
  const projection = projectPluginPrograms(records, target, tools, projectRoot);
  const programs = [...projection.programs].map(
    ([key, value]) =>
      `[${JSON.stringify(key)}, { ${archiveSuffix ? `exportSource: () => exportProgram(${JSON.stringify(key)}),` : ''} load: () => import(${JSON.stringify(exportModule(value.module, value.export))}).then(module => module.default) }]`,
  );
  return `${
    archiveSuffix
      ? `
import { packProgramModuleIdentity, verifyPackProgram } from '@forgeax/engine/pack/runtime';
import imports from 'virtual:forgeax/pack-program-imports';
const nativeEntries = Object.freeze(${JSON.stringify(nativeEntriesMarker)});
const archiveUrl = new URL(import.meta.url);
const archiveSession = archiveUrl.searchParams.get(${JSON.stringify(devProgramSessionQuery)});
archiveUrl.search = ''; archiveUrl.hash = ''; archiveUrl.pathname += ${JSON.stringify(archiveSuffix)};
if (archiveSession) archiveUrl.searchParams.set(${JSON.stringify(devProgramSessionQuery)}, archiveSession);
let archived;
async function readArchive() {
  const archive = await (archived ??= fetch(archiveUrl).then(async response => {
    if (!response.ok) throw new TypeError('plugin program archive unavailable: ' + response.status);
    return response.json();
  }).catch(cause => { archived = undefined; throw cause; }));
  if (archive.error) throw new TypeError(archive.error);
  return archive;
}
async function exportProgram(key) {
  const archive = await readArchive();
  return verifyPackProgram(archive.programs?.[key]).unwrap();
}
function createProgramHost(fallback) {
  // When the fallback owns a native loader, remember only the URLs this
  // wrapper published itself. Other imports retain the publishing host.
  const nativeUrls = fallback?.importModule ? new Set() : undefined;
  return { async publish(program, bindings) {
    // Missing a delivered selection proves this is a different graph. Such a
    // program must not depend on unrelated static archive availability.
    if (nativeEntries.length && nativeEntries.every(name => Object.hasOwn(program.modules, name))) {
      const archive = await readArchive();
      const delivered = Object.values(archive.programs)[0];
      if (delivered) {
        const nativeImports = Object.fromEntries(Object.entries(archive.imports).map(([name, entry]) => [name, { ...entry, url: new URL(entry.url, archiveUrl).href }]));
        if (packProgramModuleIdentity(program, bindings).unwrap() === packProgramModuleIdentity(delivered, nativeImports).unwrap()) {
          const url = new URL(archive.urls[program.entry], archiveUrl).href;
          nativeUrls?.add(url);
          return url;
        }
      }
    }
    if (!fallback) throw new TypeError('New program modules require runtime module delivery');
    return fallback.publish(program, bindings);
  }, ...(nativeUrls ? { async importModule(url) {
    return nativeUrls.has(url) ? import(/* @vite-ignore */ url) : fallback.importModule(url);
  } } : {}) };
}
`
      : ''
  }const tools = new Map(${JSON.stringify([...projection.tools])});
const programs = new Map([${programs.join(',\n')}]);
const definitions = new Map(${JSON.stringify(definitions)});
export function createPrograms(sessionId, contextId, sessionGeneration, programHost) {
  return Object.freeze({ sessionId, contextId, sessionGeneration, target: ${JSON.stringify(target)}, programs, definitions, tools${archiveSuffix ? ', imports, programHost: createProgramHost(programHost)' : ''} });
}`;
}

/** Shared projection for Node, browser and Worker module graphs. */
export function pluginRuntimeProjection(
  projectRoot?: string,
  sourceInputs?: ReadonlyMap<string, string>,
): Plugin {
  const canonicalPath = (path: string): string => {
    const absolute = resolve(filesystemPathKey(path));
    try {
      return realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  };
  const canonicalProjectRoot = projectRoot === undefined ? undefined : canonicalPath(projectRoot);
  const canonicalSourceInputs =
    sourceInputs === undefined ? undefined : new Map<string, string | undefined>();
  function captureSource(path: string, digest: string): void {
    if (!canonicalSourceInputs) return;
    const canonical = canonicalPath(path);
    const previous = canonicalSourceInputs.get(canonical);
    canonicalSourceInputs.set(
      canonical,
      canonicalSourceInputs.has(canonical) && previous !== digest ? undefined : digest,
    );
  }
  for (const [path, digest] of sourceInputs ?? []) captureSource(path, digest);
  let observedSourceInputCount = sourceInputs?.size ?? 0;
  let sourceInputsFrozen = false;
  function refreshSourceInputAdditions(): void {
    if (
      !sourceInputs ||
      !canonicalSourceInputs ||
      sourceInputsFrozen ||
      sourceInputs.size === observedSourceInputCount
    )
      return;
    for (const [path, digest] of sourceInputs) captureSource(path, digest);
    observedSourceInputCount = sourceInputs.size;
  }
  function assertSource(path: string, source: string | Uint8Array): void {
    if (!canonicalSourceInputs) return;
    refreshSourceInputAdditions();
    const digest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    const expected = canonicalSourceInputs.get(canonicalPath(path));
    // The first authored module reaches this guard only after DevKit has
    // captured its compiler-resolved graph. Seal the append-only additions
    // before accepting or rejecting that first transform.
    sourceInputsFrozen = true;
    assertPluginSourceRevision(path, expected, digest);
  }
  return {
    name: 'forgeax:plugin-runtime-projection',
    enforce: 'pre',
    resolveId(id) {
      if (id.startsWith(exportPrefix)) return `\0${id}`;
      if (id.startsWith(`\0${exportPrefix}`)) return id;
      return new URLSearchParams(id.slice(id.indexOf('?') + 1)).has(pluginRuntimeQuery.slice(1))
        ? id
        : null;
    },
    transform(code, id) {
      if (!canonicalProjectRoot || !isAbsolute(id)) return null;
      const sourcePath = id.split('?')[0] ?? id;
      const path = filesystemPathRelative(canonicalProjectRoot, canonicalPath(sourcePath));
      if (
        path === undefined ||
        filesystemPathSegments(path).some((part) => part === '.forgeax' || part === 'node_modules')
      )
        return null;
      if (/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) {
        if (
          canonicalSourceInputs?.has(canonicalPath(sourcePath)) &&
          !new URLSearchParams(id.slice(id.indexOf('?') + 1)).has(pluginRuntimeQuery.slice(1))
        )
          assertSource(sourcePath, readFileSync(sourcePath));
        assertStaticPluginImports(code, id);
      }
      return null;
    },
    async load(id) {
      id = withDevProgramSession(id, null);
      if (id.startsWith(`\0${exportPrefix}`)) {
        const encoded = new URLSearchParams(id.slice(id.indexOf('?') + 1)).get('source');
        if (!encoded) throw new TypeError('missing plugin export source');
        const [module, name] = JSON.parse(encoded) as [string, string];
        return `export { ${JSON.stringify(name)} as default } from ${JSON.stringify(module)};`;
      }
      if (!new URLSearchParams(id.slice(id.indexOf('?') + 1)).has(pluginRuntimeQuery.slice(1)))
        return null;
      const filename = id.slice(0, id.indexOf('?'));
      if (projectRoot) {
        if (!isFilesystemPathWithin(projectRoot, filename, false))
          throw new TypeError(`${filename}: plugin runtime source escapes project root`);
        // Metadata queries read files; alias targets must remain inside the same project root.
        if (!isFilesystemPathWithin(await realpath(projectRoot), await realpath(filename), false))
          throw new TypeError(`${filename}: plugin runtime source real path escapes project root`);
      }
      this.addWatchFile(filename);
      const source = await readFile(filename, 'utf8');
      assertSource(filename, source);
      const projected = projectPluginRuntimeSource(source, filename);
      assertStaticPluginImports(projected.code, filename);
      return projected;
    },
  };
}

export function assertPluginProgramGraphInputs(
  projectRoot: string,
  inventory: PluginSourceInventory,
  modules: Iterable<string>,
  moduleInfo: (id: string) => {
    readonly importedIds: readonly string[];
    readonly dynamicallyImportedIds: readonly string[];
  } | null,
): void {
  const root = realpathSync.native(projectRoot);
  const physical = new Map<string, string | undefined>();
  const local = (id: string): string | undefined => {
    if (!isAbsolute(id)) return undefined;
    const file = id.split('?')[0] ?? id;
    if (physical.has(file)) return physical.get(file);
    const path = realpathSync.native(file);
    const result =
      isFilesystemPathWithin(root, path, false) &&
      !relative(root, path)
        .split(/[\\/]/)
        .some((part) => part === '.forgeax' || part === 'node_modules')
        ? path
        : undefined;
    physical.set(file, result);
    return result;
  };
  const pending = [...modules].filter((id) => {
    const path = local(id);
    return path !== undefined && hasPluginSourceInput(inventory.sourceInputs, path);
  });
  const visited = new Set<string>();
  for (const id of pending) {
    if (visited.has(id)) continue;
    visited.add(id);
    const info = moduleInfo(id);
    for (const dependency of [
      ...(info?.importedIds ?? []),
      ...(info?.dynamicallyImportedIds ?? []),
    ]) {
      const path = local(dependency);
      if (path !== undefined && !hasPluginSourceInput(inventory.sourceInputs, path))
        assertPluginSourceRevision(
          path,
          undefined,
          'compiler consumed an uncaptured program input',
        );
      pending.push(dependency);
    }
  }
}

export interface PluginProgramBuildOptions {
  /** Native package modules use the same static projection without browser archive delivery. */
  readonly delivery?: 'browser' | 'native';
  readonly projectRoot: string;
  readonly namespace?: string;
  readonly tools?: readonly ProjectToolBinding[];
  readonly roots: Readonly<Partial<Record<PluginBuildTarget, string | undefined>>>;
  readonly inventory: () => Promise<PluginSourceInventory>;
  readonly binding: RuntimeAssetBinding;
  readonly pack: PluginPack;
}

export function pluginProgramsBuild(options: PluginProgramBuildOptions): Plugin {
  const modulePrefix = options.namespace ? `${prefix}${options.namespace}/` : prefix;
  let command: 'build' | 'serve' = 'build';
  const projections = new Map<string, unknown>();
  const archive = new BrowserPluginProgramArchive();
  const archiveSuffix = options.namespace
    ? `.programs-${encodeURIComponent(options.namespace)}.json`
    : '.programs.json';
  let engineIdentity = '';
  let session = '';
  const sessionModules = new Set<string>();
  const hasRoots = options.roots.engine !== undefined || options.roots.frontend !== undefined;
  let dev:
    | (Awaited<ReturnType<typeof captureDevPluginPrograms>> & { inventory: PluginSourceInventory })
    | undefined;
  return {
    name: 'forgeax:plugin-programs',
    enforce: 'pre',
    options(input) {
      // Selected public plugin chunks preserve their own strict signatures.
      // Internal app facades may expose the shared closure used by grouping.
      if (options.delivery !== 'native' && hasRoots && input.preserveEntrySignatures === 'strict')
        return { ...input, preserveEntrySignatures: 'allow-extension' };
      return null;
    },
    closeBundle() {
      if (command === 'serve') {
        dev?.inventory.sourceSnapshot.releaseResolvers();
        dev = undefined;
        sessionModules.clear();
      }
    },
    configResolved(config) {
      command = config.command;
      // A restarted standalone Vite Host can reuse its root. Its previous
      // frozen graph must retire, while all namespaces share the current Host.
      const identity = devProgramSessions.get(config) ?? randomUUID();
      devProgramSessions.set(config, identity);
      session = identity;
    },
    hotUpdate: {
      order: 'pre',
      handler(context) {
        if (
          this.environment.name !== 'client' ||
          !dev?.inventory.sourceInputs.has(resolve(context.file))
        )
          return;
        // Generated Hosts validate and replace through their project-session owner.
        // An inline configuration reuses these plugin instances on restart, which
        // would overwrite the accepted frozen graph before a candidate is ready.
        // Only a reloadable config file can prepare fresh instances through Vite's
        // create-before-close restart; inline callers retain their frozen session.
        if (
          !context.server.config.configFile ||
          context.server.config.plugins.some((plugin) => plugin.name === 'forgeax:project-session')
        )
          return [];
        // A publication and its executable snapshot are one Host generation.
        // Recapture through the normal Vite startup instead of pairing a new
        // Catalog definition with the old frozen program.
        const accepted = dev;
        // Restart closes the previous environment. Finish HMR dispatch first
        // so that environment cleanup never waits on its own restart handler.
        void new Promise<void>((resolve) => setTimeout(resolve, 0))
          .then(async () => {
            if (dev !== accepted) return;
            await context.server.restart();
          })
          .catch((cause) => {
            context.server.config.logger.error(
              cause instanceof Error ? cause.message : String(cause),
            );
          });
        return [];
      },
    },
    buildStart: {
      order: 'post',
      sequential: true,
      async handler() {
        if (command !== 'build' || !hasRoots) return;
        const inventory = await options.inventory();
        const tools =
          options.tools ?? (await discoverProjectTools(options.projectRoot, { inventory }));
        for (const target of ['engine', 'frontend'] as const)
          for (const value of projectPluginPrograms(
            pluginAssetClosure(inventory, options.roots[target]),
            target,
            tools,
            options.projectRoot,
          ).programs.values())
            await capturePluginProgramInputs(
              options.projectRoot,
              inventory,
              value.module,
              async (specifier, importer) => (await this.resolve(specifier, importer))?.id,
            );
      },
    },
    async configureServer(server) {
      try {
        const base = server.config.base;
        const frozenSource = (url: string) => {
          let local = url.startsWith(base) ? `/${url.slice(base.length)}` : url;
          if (local.startsWith('\0') || local.startsWith('virtual:'))
            local = `/@id/${local.replace('\0', '__x00__')}`;
          return dev?.responses.get(normalizeDevProgramUrl(local));
        };
        server.middlewares.use((request, response, next) => {
          if (request.method !== 'GET' || !request.url?.startsWith(base)) return next();
          const url = normalizeDevProgramUrl(`/${request.url.slice(base.length)}`);
          const requestedSession = devProgramSession(url);
          if (requestedSession !== null && requestedSession !== session) {
            response.statusCode = 410;
            response.setHeader('cache-control', 'no-store');
            response.end('Plugin program session retired');
            return;
          }
          const pathname = url.split('?')[0];
          if (
            pathname?.startsWith(`/@id/__x00__${modulePrefix}`) &&
            pathname.endsWith(archiveSuffix)
          ) {
            if (requestedSession !== session) {
              response.statusCode = 410;
              response.end('Plugin program archive requires its session');
              return;
            }
            response.setHeader('content-type', 'application/json');
            response.end(
              JSON.stringify(dev?.archive ?? { error: 'No browser plugin programs in this Host' }),
            );
            return;
          }
          const source = frozenSource(request.url);
          if (source === undefined) return next();
          response.setHeader('content-type', 'text/javascript');
          response.end(source);
        });
        if (!hasRoots) return;
        const environment = server.environments.client;
        if (!environment) throw new TypeError('plugin capture requires a client environment');
        const transform = environment.transformRequest.bind(environment);
        const warmup = environment.warmupRequest.bind(environment);
        environment.transformRequest = async (url, ...options) => {
          const code = frozenSource(url);
          return code === undefined ? transform(url, ...options) : { code, map: null };
        };
        // These bytes already completed Vite's final transform. Repeating warmup
        // could read a broken candidate or invoke a foreign producer under an alias.
        environment.warmupRequest = async (url) => {
          if (frozenSource(url) === undefined) await warmup(url);
        };
        markDevProgramResources(environment.plugins);
        await options.pack.ready();
        const inventory = await options.inventory();
        const tools =
          options.tools ?? (await discoverProjectTools(options.projectRoot, { inventory }));
        const selections = new Map<string, string>();
        for (const target of ['engine', 'frontend'] as const)
          for (const [key, value] of projectPluginPrograms(
            pluginAssetClosure(inventory, options.roots[target]),
            target,
            tools,
            options.projectRoot,
          ).programs) {
            await capturePluginProgramInputs(
              options.projectRoot,
              inventory,
              value.module,
              async (specifier, importer) =>
                (await environment.pluginContainer.resolveId(specifier, importer))?.id,
            );
            selections.set(key, `/@id/__x00__${exportModule(value.module, value.export)}`);
          }
        const engineManifest = await environment.pluginContainer.resolveId(
          '@forgeax/engine/package.json',
        );
        if (!engineManifest || engineManifest.external)
          throw new Error('Engine manifest unavailable from the Vite host');
        dev = {
          ...(await captureDevPluginPrograms(
            server,
            selections,
            await runtimeProgramIdentity(engineManifest.id),
            session,
          )),
          inventory,
        };
        assertPluginProgramGraphInputs(options.projectRoot, inventory, dev.moduleIds, (id) => {
          const node = environment.moduleGraph.getModuleById(id);
          return node
            ? {
                importedIds: [...node.importedModules].flatMap((dependency) =>
                  dependency.id ? [dependency.id] : [],
                ),
                dynamicallyImportedIds: [],
              }
            : null;
        });
        for (const id of dev.moduleIds) sessionModules.add(id);
        await assertPluginSourceInputs(inventory, options.projectRoot);
        server.watcher.add([...inventory.sourceInputs.keys()]);
      } catch (cause) {
        // Vite retains the accepted server when replacement preparation fails.
        // This rejected candidate still owns native environments and must close.
        await server.close();
        throw cause;
      }
    },
    resolveId: {
      order: 'pre',
      async handler(id, importer, resolveOptions) {
        const marker = 'forgeax:program-session';
        if (resolveOptions.custom?.[marker]) return null;
        const requestedSession = devProgramSession(id);
        if (command === 'serve' && requestedSession !== null && requestedSession !== session)
          this.error('Plugin program session retired');
        if (command !== 'serve' || !hasRoots || ('scan' in resolveOptions && resolveOptions.scan))
          return id.startsWith(modulePrefix) ? `\0${id}` : null;
        const clean = withDevProgramSession(id, null);
        const parent = importer === undefined ? undefined : withDevProgramSession(importer, null);
        const resolved = clean.startsWith(modulePrefix)
          ? { id: `\0${clean}` }
          : await this.resolve(clean, parent, {
              ...resolveOptions,
              skipSelf: true,
              custom: { ...resolveOptions.custom, [marker]: true },
            });
        if (
          !resolved ||
          ('external' in resolved && resolved.external) ||
          ('meta' in resolved && resolved.meta?.[engineCapabilityMeta])
        )
          return resolved;
        const filename = resolved.id.split('?')[0] ?? resolved.id;
        const path = filesystemPathRelative(options.projectRoot, filename);
        const projectModule =
          isAbsolute(filename) &&
          /\.[cm]?[jt]sx?$/.test(filename) &&
          path !== undefined &&
          !filesystemPathSegments(path).includes('node_modules');
        const facade =
          resolved.id.startsWith(`\0${exportPrefix}`) ||
          resolved.id.startsWith(`\0${modulePrefix}`);
        if (
          facade ||
          projectModule ||
          sessionModules.has(resolved.id) ||
          (isAbsolute(filename) &&
            /\.[cm]?[jt]sx?$/.test(filename) &&
            importer !== undefined &&
            devProgramSession(importer) === session)
        ) {
          sessionModules.add(resolved.id);
          return { ...resolved, id: withDevProgramSession(resolved.id, session) };
        }
        return resolved;
      },
    },
    async load(id) {
      id = withDevProgramSession(id, null);
      if (!id.startsWith(`\0${modulePrefix}`)) return null;
      const target = id.slice(modulePrefix.length + 1) as PluginBuildTarget;
      if (target !== 'frontend' && target !== 'engine')
        throw new TypeError(`unknown player plugin target ${target}`);
      if (command === 'serve') await options.pack.ready();
      const inventory = dev?.inventory ?? (await options.inventory());
      const records = pluginAssetClosure(inventory, options.roots[target]);
      const rows = options.pack.catalogSnapshot();
      const definitions = records.map((record) => {
        const guid = record.definition.guid;
        const row = rows.find((entry) => entry.guid === guid);
        if (!row?.publication)
          throw new TypeError(`${guid}: plugin has no accepted publication for this program build`);
        const { generation, digest, outputSetDigest } = row.publication;
        return [
          guid,
          {
            kind: 'publication',
            publication: {
              scopeId: options.binding.scopeId,
              generation,
              digest,
              outputSetDigest,
            },
          },
        ] as const;
      });
      const tools =
        options.tools ?? (await discoverProjectTools(options.projectRoot, { inventory }));
      if (command === 'build' && options.delivery !== 'native') {
        for (const [key, value] of projectPluginPrograms(
          records,
          target,
          tools,
          options.projectRoot,
        ).programs) {
          archive.entries.set(key, `\0${exportModule(value.module, value.export)}`);
        }
      }
      projections.set(target, {
        root: options.roots[target],
        definitions,
        programs: [
          ...projectPluginPrograms(records, target, tools, options.projectRoot).programs.keys(),
        ],
      });
      const rootDefinition = records.find(
        (record) => record.definition.guid === options.roots[target],
      )?.definition;
      const rootEvidence = definitions.find(([guid]) => guid === rootDefinition?.guid)?.[1];
      if (rootDefinition && !rootEvidence) throw new TypeError('root publication evidence missing');
      const descriptor =
        rootDefinition && rootEvidence
          ? pluginRootDescriptor({
              ...rootDefinition,
              evidence: rootEvidence,
            })
          : null;
      const source = pluginProgramSource(
        records,
        target,
        definitions,
        tools,
        options.projectRoot,
        options.delivery === 'native' ? undefined : archiveSuffix,
      );
      return `${command === 'serve' ? source.replace(JSON.stringify(nativeEntriesMarker), JSON.stringify(dev?.entries ?? [])) : source}\nexport const root = ${JSON.stringify(options.roots[target] ?? null)};\nexport const rootDescriptor = ${JSON.stringify(descriptor)};`;
    },
    moduleParsed(info) {
      if (command === 'build') archive.preserveParsedModule(this, info.id);
    },
    async buildEnd(error) {
      // One complete walk over the final graph keeps membership exact even if
      // a module's parse facts were refined after its own moduleParsed hook.
      if (!error && command === 'build') archive.preserveModules(this);
      if (!error) archive.prepareGroups(this);
      if (!error && command === 'build' && archive.entries.size) {
        const engineManifest = await this.resolve('@forgeax/engine/package.json', undefined, {
          skipSelf: true,
        });
        if (!engineManifest || engineManifest.external)
          this.error('Engine manifest unavailable from the Vite host');
        engineIdentity = await runtimeProgramIdentity(engineManifest.id);
      }
    },
    renderChunk: {
      order: 'post',
      handler(code, chunk) {
        const output = new MagicString(code);
        if (code.includes(nativeEntriesMarker)) {
          const file = ts.createSourceFile(
            chunk.fileName,
            code,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
          );
          const edits: { start: number; end: number }[] = [];
          const visit = (node: ts.Node) => {
            if (ts.isStringLiteralLike(node) && node.text === nativeEntriesMarker)
              edits.push({ start: node.getStart(file), end: node.end });
            ts.forEachChild(node, visit);
          };
          visit(file);
          const entries = JSON.stringify(archive.entryFiles(this));
          for (const edit of edits) output.overwrite(edit.start, edit.end, entries);
        }
        archive.recordRendered(output.toString(), chunk);
        return output.hasChanged()
          ? { code: output.toString(), map: output.generateMap({ hires: true }) }
          : null;
      },
    },
    outputOptions(output) {
      return options.delivery === 'native' ? output : archive.groupedOutput(output);
    },
    augmentChunkHash(chunk) {
      if (Object.keys(chunk.modules).some((id) => id.startsWith(`\0${modulePrefix}`)))
        return archive.hash(engineIdentity);
      return undefined;
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const inventory = await options.inventory();
        assertPluginProgramGraphInputs(options.projectRoot, inventory, this.getModuleIds(), (id) =>
          this.getModuleInfo(id),
        );
        await assertPluginSourceInputs(inventory, options.projectRoot);
        inventory.sourceSnapshot.releaseResolvers();
        if (archive.entries.size) {
          let data: unknown;
          try {
            data = {
              programs: archive.capture(this, bundle, engineIdentity),
              imports: archive.imports(this, engineIdentity),
            };
          } catch (cause) {
            // Static startup remains valid when a dependency cannot be archived.
            // Export consumers must surface this failure, never an incomplete graph.
            data = { error: cause instanceof Error ? cause.message : JSON.stringify(cause) };
          }
          for (const chunk of Object.values(bundle)) {
            if (
              chunk.type !== 'chunk' ||
              !Object.keys(chunk.modules).some((id) => id.startsWith(`\0${modulePrefix}`))
            )
              continue;
            this.emitFile({
              type: 'asset',
              fileName: `${chunk.fileName}${archiveSuffix}`,
              source: JSON.stringify(
                'error' in (data as object)
                  ? data
                  : {
                      ...(data as object),
                      imports: Object.fromEntries(
                        Object.entries(archive.imports(this, engineIdentity)).map(
                          ([name, entry]) => [
                            name,
                            {
                              ...entry,
                              url: posix.relative(posix.dirname(chunk.fileName), entry.url),
                            },
                          ],
                        ),
                      ),
                      urls: Object.fromEntries(
                        Object.keys(
                          Object.values(
                            (
                              data as {
                                programs: Record<string, { modules: Record<string, string> }>;
                              }
                            ).programs,
                          )[0]?.modules ?? {},
                        ).map((path) => [
                          path,
                          posix.relative(posix.dirname(chunk.fileName), path),
                        ]),
                      ),
                    },
              ),
            });
          }
        }
        // Final bytes belong to the delivery inventory, never to their own program keys.
        const artifacts = Object.values(bundle).map((chunk) => {
          const bytes = chunk.type === 'chunk' ? chunk.code : chunk.source;
          if (chunk.type === 'chunk') {
            // Vite may bundle a browser stub instead of leaving a Node import
            // external. Inspect module identities as well as chunk-level edges.
            for (const id of [
              ...chunk.imports,
              ...chunk.dynamicImports,
              ...Object.keys(chunk.modules),
            ]) {
              if (isBuiltin(id) || id.includes('__vite-browser-external'))
                throw new TypeError(
                  `${chunk.fileName}: Node dependency ${id} leaked into the player`,
                );
            }
            for (const id of Object.keys(chunk.modules)) {
              if (
                /\/packages\/(?:shader-compiler|naga|vfx-compiler|devkit)\/|@forgeax\/engine-(?:shader-compiler|naga|vfx-compiler|devkit)/.test(
                  id,
                )
              ) {
                throw new TypeError(
                  `${chunk.fileName}: build-only dependency ${id} leaked into the player`,
                );
              }
            }
          }
          return {
            path: chunk.fileName,
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          };
        });
        const inputs = await Promise.all(
          [
            ...new Set(
              [...this.getModuleIds()]
                .filter((id) => id.startsWith('/'))
                .map((id) => id.split('?')[0] ?? id),
            ),
          ]
            .sort()
            .map(async (id) => {
              const bytes = await readFile(id);
              return {
                path: relative(options.projectRoot, id).replaceAll('\\', '/'),
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              };
            }),
        );
        for (const path of ['package.json', 'pnpm-lock.yaml', 'bun.lock', 'package-lock.json']) {
          try {
            inputs.push({
              path,
              digest: `sha256:${createHash('sha256')
                .update(await readFile(`${options.projectRoot}/${path}`))
                .digest('hex')}`,
            });
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          }
        }
        this.emitFile({
          type: 'asset',
          fileName: options.namespace
            ? `plugin-program-inventory/${options.namespace}.json`
            : 'plugin-program-inventory.json',
          source: JSON.stringify({
            schemaVersion: 1,
            targets: Object.fromEntries(projections),
            inputs,
            artifacts,
          }),
        });
      },
    },
  };
}
