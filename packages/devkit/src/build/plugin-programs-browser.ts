import { posix } from 'node:path';
import { sha256 } from '@forgeax/engine-types';
import { normalizePath, type Rolldown } from 'vite';
import { type EngineCapabilityMeta, engineCapabilityMeta } from './execution-workers.js';
import { rewriteModuleSpecifiers } from './module-specifiers.js';
import { sealPluginProgramGraph } from './plugin-program-artifacts.js';

function assertPortableResources(context: Rolldown.PluginContext, chunk: Rolldown.OutputChunk) {
  // Vite records normal assets/CSS in metadata. Worker and public URLs instead
  // retain producer placeholders in ModuleInfo.code until final chunk rendering.
  const hasResource =
    chunk.viteMetadata?.importedAssets.size ||
    chunk.viteMetadata?.importedCss.size ||
    Object.keys(chunk.modules).some((id) =>
      /__VITE_(?:ASSET|PUBLIC_ASSET|WORKER_ASSET)__/.test(context.getModuleInfo(id)?.code ?? ''),
    );
  if (hasResource)
    throw new TypeError(`plugin program resource requires a portable producer: ${chunk.fileName}`);
}

type ReadModule = Rolldown.PluginContext['getModuleInfo'];

/** Static reachability never crosses an Engine capability boundary. */
function reachableModules(
  read: ReadModule,
  roots: Iterable<string>,
  parsedOnly: boolean,
): Set<string> {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const node = read(id);
    if (!node || node.meta[engineCapabilityMeta] || (parsedOnly && node.code === null)) return;
    seen.add(id);
    for (const dependency of node.importedIds) visit(dependency);
  };
  for (const root of roots) visit(root);
  return seen;
}

/**
 * A lazy import is a load boundary only where its target is not already
 * loaded: drop targets every root running one of their importers reaches.
 */
function pruneLoadedLazyTargets(
  read: ReadModule,
  entries: ReadonlySet<string>,
  lazy: Set<string>,
  graphs: Map<string, Set<string>>,
): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const target of lazy) {
      if (entries.has(target)) continue;
      const importers = read(target)?.dynamicImporters ?? [];
      const loaded = [...graphs].every(
        ([root, graph]) =>
          root === target ||
          !importers.some((importer) => graph.has(importer)) ||
          graph.has(target),
      );
      if (!loaded) continue;
      lazy.delete(target);
      graphs.delete(target);
      changed = true;
    }
  }
}

/** Classify both layout lanes against one set of final module facts. */
function collectGroupRoots(
  read: ReadModule,
  ids: Iterable<string>,
  selections: Iterable<string>,
  program: (id: string) => boolean,
  facades: ReadonlySet<string>,
) {
  const capability = (id: string) => Boolean(read(id)?.meta[engineCapabilityMeta]);
  const programRoots = new Set(selections);
  const programModules: string[] = [];
  const hostEntries = new Set<string>();
  const lazyHost = new Set<string>();
  for (const id of ids) {
    const info = read(id);
    if (!info) continue;
    const programOwned = program(id);
    const hostReachable = !info.meta[engineCapabilityMeta];
    if (info.isEntry && !programOwned) programRoots.add(id);
    if (hostReachable) {
      if (programOwned) programModules.push(id);
      else if (info.isEntry && !facades.has(id)) hostEntries.add(id);
    }
    for (const dependency of info.dynamicallyImportedIds) {
      programRoots.add(dependency);
      if (hostReachable && !program(dependency) && !capability(dependency))
        lazyHost.add(dependency);
    }
  }
  return { programRoots, programModules, hostEntries, lazyHost };
}

function addMembership(memberships: Map<string, string[]>, module: string, root: string): void {
  const roots = memberships.get(module);
  if (roots) roots.push(root);
  else memberships.set(module, [root]);
}

/** Archive the player's own transformed graph, without reevaluating its bootstrap. */
export class BrowserPluginProgramArchive {
  readonly entries = new Map<string, string>();
  /** Emitted entry chunks, keyed by selected export module. */
  private readonly chunks = new Map<string, string>();
  /** Every module of the program graph; group membership decides their output chunks. */
  private readonly modules = new Set<string>();
  private readonly rendered = new Map<string, string>();
  private readonly groups = new Map<string, string>();
  private readonly hostGroups = new Map<string, string>();

  recordRendered(code: string, chunk: Rolldown.RenderedChunk): void {
    if (Object.keys(chunk.modules).some((id) => this.modules.has(id)))
      this.rendered.set(chunk.fileName, code);
  }

  /** Every provider's sidecar includes all selections and the exact Engine identity. */
  hash(engineIdentity: string): string {
    return sha256(
      JSON.stringify([engineIdentity, [...this.rendered].sort(([a], [b]) => a.localeCompare(b))]),
    );
  }

  /** Modules the incremental walk has examined; their parse facts never change. */
  private readonly walked = new Set<string>();
  /** Reachable modules that Rolldown has not parsed yet. */
  private readonly waiting = new Set<string>();
  private readonly parsed = new Set<string>();

  private admit(context: Rolldown.PluginContext, id: string, entries: ReadonlySet<string>): void {
    this.modules.add(id);
    // Only selected exports need a strict, addressable chunk. Interior modules
    // join their reachability group, which keeps shared project modules out of
    // the page bootstrap and gives page, plugins and tool executors one URL.
    if (entries.has(id) && !this.chunks.has(id))
      this.chunks.set(
        id,
        context.emitFile({
          type: 'chunk',
          id,
          name: `program-${sha256(id).slice(0, 16)}`,
          preserveSignature: 'strict',
        }),
      );
  }

  private retainGraph(
    context: Rolldown.PluginContext,
    starts: Iterable<string>,
    visited: Set<string>,
    readModule: (id: string) => ReturnType<Rolldown.PluginContext['getModuleInfo']> | undefined,
  ): void {
    const entries = new Set([...this.entries.values()].map(normalizePath));
    const visit = (input: string) => {
      const id = normalizePath(input);
      if (visited.has(id)) return;
      const info = readModule(id);
      if (info === undefined) return;
      visited.add(id);
      if (!info || info.meta[engineCapabilityMeta]) return;
      this.admit(context, id, entries);
      for (const dependency of [...info.importedIds, ...info.dynamicallyImportedIds])
        visit(dependency);
    };
    for (const id of starts) visit(id);
  }

  /** Examine a module once it is both reachable and parsed. */
  preserveParsedModule(context: Rolldown.PluginContext, parsedId: string): void {
    const parsed = normalizePath(parsedId);
    this.parsed.add(parsed);
    const starts = this.waiting.has(parsed)
      ? [...this.entries.values(), parsed]
      : this.entries.values();
    this.retainGraph(context, starts, this.walked, (id) => {
      const info = this.parsed.has(id) ? context.getModuleInfo(id) : null;
      if (!info) {
        this.waiting.add(id);
        return undefined;
      }
      this.waiting.delete(id);
      return info;
    });
  }

  /** Complete walk of the program graph from every selected export. */
  preserveModules(context: Rolldown.PluginContext): void {
    this.retainGraph(context, this.entries.values(), new Set(), (id) => {
      const info = context.getModuleInfo(id);
      return !info || info.code === null ? null : info;
    });
  }

  /**
   * Coalesce only modules with identical static entry reachability; lazy boundaries survive.
   * Runtime Pack facades are independent entry graphs in the executing task realm.
   * Other emitted facades provide addresses without partitioning host groups.
   */
  prepareGroups(
    context: Rolldown.PluginContext,
    facades: ReadonlySet<string> = new Set(),
    runtimeFacades: ReadonlySet<string> = new Set(),
  ): void {
    const graph = new Map<string, ReturnType<ReadModule>>();
    const read: ReadModule = (id) => {
      if (!graph.has(id)) graph.set(id, context.getModuleInfo(id));
      return graph.get(id) ?? null;
    };
    const program = (id: string) => this.modules.has(normalizePath(id));
    const { programRoots, programModules, hostEntries, lazyHost } = collectGroupRoots(
      read,
      context.getModuleIds(),
      this.entries.values(),
      program,
      facades,
    );
    const programMembership = new Map<string, string[]>();
    for (const root of [...programRoots].sort())
      for (const id of reachableModules(read, [root], false))
        if (program(id)) addMembership(programMembership, id, root);
    this.groups.clear();
    for (const [id, entries] of programMembership)
      this.groups.set(id, `program-group-${sha256(JSON.stringify(entries)).slice(0, 16)}`);

    const reach = (roots: Iterable<string>) => reachableModules(read, roots, true);
    const graphs = new Map(
      [...hostEntries, ...lazyHost, ...runtimeFacades].map((root) => [root, reach([root])]),
    );
    pruneLoadedLazyTargets(read, hostEntries, lazyHost, graphs);
    const shared = reach(programModules);
    // A facade also supplies its implementation to any entry that imports it.
    // Group those modules by the entries that use them. Facade-only modules
    // retain Rolldown's natural groups and stay out of the startup closures.
    const memberships = new Map<string, string[]>();
    for (const [root, graph] of [...graphs].sort(([a], [b]) => a.localeCompare(b)))
      for (const id of graph) {
        if (program(id) || shared.has(id)) continue;
        addMembership(memberships, id, root);
      }
    this.hostGroups.clear();
    for (const [id, roots] of memberships) {
      // Vite may inline the HTML facade into this group. Keep its page name
      // so platform hosts can identify the entry without renaming shared code.
      const page = roots.length === 1 && hostEntries.has(roots[0] ?? '') ? roots[0] : undefined;
      const name = page?.endsWith('.html') ? posix.basename(page, '.html') : 'engine';
      this.hostGroups.set(id, `${name}-${sha256(JSON.stringify(roots)).slice(0, 16)}`);
    }
  }

  groupedOutput(output: Rolldown.OutputOptions): Rolldown.OutputOptions {
    if (
      output.codeSplitting === false ||
      output.inlineDynamicImports ||
      (output.format !== undefined &&
        output.format !== 'es' &&
        output.format !== 'esm' &&
        output.format !== 'module')
    )
      return output;
    const splitting = typeof output.codeSplitting === 'object' ? output.codeSplitting : {};
    return {
      ...output,
      codeSplitting: {
        ...splitting,
        includeDependenciesRecursively: false,
        groups: [
          {
            debugName: 'forgeax-program',
            name: (id) => this.groups.get(id) ?? null,
            priority: 100,
          },
          {
            debugName: 'forgeax-host',
            name: (id) => this.hostGroups.get(id) ?? null,
            priority: 90,
          },
          ...(splitting.groups ?? []),
        ],
      },
    };
  }

  private chunkPath(context: Rolldown.PluginContext, id: string, label = id): string {
    const reference = this.chunks.get(normalizePath(id));
    if (!reference) throw new TypeError(`missing browser plugin export ${label}`);
    return context.getFileName(reference);
  }

  /** A complete delivered graph contains every selected entry, regardless of its active export. */
  entryFiles(context: Rolldown.PluginContext): readonly string[] {
    return [
      ...new Set(Array.from(this.entries.values(), (id) => this.chunkPath(context, id))),
    ].sort();
  }

  private capabilities(context: Rolldown.PluginContext): ReadonlyMap<string, string> {
    const capabilities = new Map<string, string>();
    for (const id of [...context.getModuleIds()].sort()) {
      const capability = context.getModuleInfo(id)?.meta[engineCapabilityMeta] as
        | EngineCapabilityMeta
        | undefined;
      if (!capability?.reference) continue;
      const file = context.getFileName(capability.reference);
      if (!capabilities.has(file)) capabilities.set(file, capability.specifier);
    }
    return capabilities;
  }

  capture(context: Rolldown.PluginContext, bundle: Rolldown.OutputBundle, engineIdentity: string) {
    const capabilities = this.capabilities(context);
    const engineChunks = new Set<string>();
    const protect = (filename: string) => {
      if (engineChunks.has(filename)) return;
      engineChunks.add(filename);
      const chunk = bundle[filename];
      if (chunk?.type === 'chunk')
        for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) protect(dependency);
    };
    for (const filename of capabilities.keys()) protect(filename);

    const modules: Record<string, string> = {};
    const imports: Record<string, string> = {};
    const visit = (filename: string) => {
      if (Object.hasOwn(modules, filename)) return;
      const chunk = bundle[filename];
      if (chunk?.type !== 'chunk')
        throw new TypeError(`plugin program resource requires a portable producer: ${filename}`);
      assertPortableResources(context, chunk);
      if (engineChunks.has(filename))
        throw new TypeError(`plugin program shares an undeclared Engine dependency: ${filename}`);
      // Mark before following edges so cyclic modules retain one shared graph.
      modules[filename] = '';
      modules[filename] = rewriteModuleSpecifiers(chunk.code, filename, (specifier) => {
        const dependency = specifier.startsWith('.')
          ? posix.normalize(posix.join(posix.dirname(filename), specifier))
          : specifier;
        const capability = capabilities.get(dependency);
        if (capability) {
          imports[capability] = engineIdentity;
          return capability;
        }
        visit(dependency);
        return undefined;
      });
    };
    const selections = [...this.entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, id]) => {
        const entry = this.chunkPath(context, id, key);
        visit(entry);
        return [key, entry] as const;
      });
    const sealed = sealPluginProgramGraph(modules, imports, selections);
    return {
      graph: sealed.graph,
      programs: Object.fromEntries(sealed.programs),
      imports: Object.fromEntries(
        [...capabilities].map(([url, name]) => [name, { identity: engineIdentity, url }]),
      ),
    };
  }
}
