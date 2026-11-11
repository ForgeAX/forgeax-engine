import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { type PackProgram, preparePackProgram } from '@forgeax/engine-pack/runtime';
import { normalizePath, type Rolldown } from 'vite';
import { type EngineCapabilityMeta, engineCapabilityMeta } from './execution-workers.js';
import { rewriteModuleSpecifiers } from './module-specifiers.js';

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

/** Modules reachable from a root without crossing an engine capability boundary. */
function reachableModules(
  context: Rolldown.PluginContext,
  capability: (id: string) => boolean,
  root: string,
): Set<string> {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || capability(id)) return;
    const info = context.getModuleInfo(id);
    if (!info || info.code === null) return;
    seen.add(id);
    for (const dependency of info.importedIds) visit(dependency);
  };
  visit(root);
  return seen;
}

/** Host entries, lazy import targets, and modules shared by programs. */
function collectHostRoots(
  context: Rolldown.PluginContext,
  facades: ReadonlySet<string>,
  program: (id: string) => boolean,
  capability: (id: string) => boolean,
  reach: (root: string) => Set<string>,
): { entries: Set<string>; lazy: Set<string>; shared: Set<string> } {
  const entries = new Set<string>();
  const lazy = new Set<string>();
  const shared = new Set<string>();
  for (const id of context.getModuleIds()) {
    const info = context.getModuleInfo(id);
    if (!info || capability(id)) continue;
    if (program(id)) for (const member of reach(id)) shared.add(member);
    else if (info.isEntry && !facades.has(id)) entries.add(id);
    for (const dependency of info.dynamicallyImportedIds)
      if (!program(dependency) && !capability(dependency)) lazy.add(dependency);
  }
  return { entries, lazy, shared };
}

/**
 * A lazy import is a load boundary only where its target is not already
 * loaded: drop targets every root running one of their importers reaches.
 */
function pruneLoadedLazyTargets(
  context: Rolldown.PluginContext,
  entries: ReadonlySet<string>,
  lazy: Set<string>,
  graphs: Map<string, Set<string>>,
): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const target of lazy) {
      if (entries.has(target)) continue;
      const importers = context.getModuleInfo(target)?.dynamicImporters ?? [];
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
    return createHash('sha256')
      .update(
        JSON.stringify([engineIdentity, [...this.rendered].sort(([a], [b]) => a.localeCompare(b))]),
      )
      .digest('hex');
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
          name: `program-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`,
          preserveSignature: 'strict',
        }),
      );
  }

  /**
   * moduleParsed form of {@link preserveModules}. A module's parse facts are
   * final once parsed, so each one is examined once, when it is both reachable
   * and parsed, instead of re-walking the whole program graph per parsed module.
   */
  preserveParsedModule(context: Rolldown.PluginContext, parsedId: string): void {
    const parsed = normalizePath(parsedId);
    this.parsed.add(parsed);
    const entries = new Set([...this.entries.values()].map(normalizePath));
    const visit = (input: string) => {
      const id = normalizePath(input);
      if (this.walked.has(id)) return;
      if (!this.parsed.has(id)) {
        this.waiting.add(id);
        return;
      }
      this.waiting.delete(id);
      const info = context.getModuleInfo(id);
      if (!info) {
        this.waiting.add(id);
        return;
      }
      this.walked.add(id);
      if (info.meta[engineCapabilityMeta]) return;
      this.admit(context, id, entries);
      for (const dependency of [...info.importedIds, ...info.dynamicallyImportedIds])
        visit(dependency);
    };
    for (const id of this.entries.values()) visit(id);
    if (this.waiting.has(parsed)) visit(parsed);
  }

  /** Complete walk of the program graph from every selected export. */
  preserveModules(context: Rolldown.PluginContext): void {
    const entries = new Set([...this.entries.values()].map(normalizePath));
    const visited = new Set<string>();
    const visit = (input: string) => {
      const id = normalizePath(input);
      if (visited.has(id)) return;
      visited.add(id);
      const info = context.getModuleInfo(id);
      if (!info || info.code === null || info.meta[engineCapabilityMeta]) return;
      this.admit(context, id, entries);
      for (const dependency of [...info.importedIds, ...info.dynamicallyImportedIds])
        visit(dependency);
    };
    for (const id of this.entries.values()) visit(id);
  }

  /**
   * Coalesce only modules with identical static entry reachability; lazy boundaries survive.
   * `facades` are public Engine facade entries: addresses for programs, not load roots.
   */
  prepareGroups(context: Rolldown.PluginContext, facades: ReadonlySet<string> = new Set()): void {
    this.prepareHostGroups(context, facades);
    const roots = new Set(this.entries.values());
    for (const id of context.getModuleIds()) {
      const info = context.getModuleInfo(id);
      if (!info) continue;
      if (info.isEntry && !this.modules.has(normalizePath(id))) roots.add(id);
      for (const dependency of info.dynamicallyImportedIds) roots.add(dependency);
    }
    const memberships = new Map<string, string[]>();
    for (const root of [...roots].sort()) {
      const seen = new Set<string>();
      const visit = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        const info = context.getModuleInfo(id);
        if (!info || info.meta[engineCapabilityMeta]) return;
        if (this.modules.has(normalizePath(id))) {
          const entries = memberships.get(id) ?? [];
          entries.push(root);
          memberships.set(id, entries);
        }
        for (const dependency of info.importedIds) visit(dependency);
      };
      visit(root);
    }
    this.groups.clear();
    for (const [id, entries] of memberships) {
      if (!entries.length) continue;
      this.groups.set(
        id,
        `program-group-${createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)}`,
      );
    }
  }

  /**
   * Startup loads a few chunks instead of one per facade dependency set: the
   * Engine code behind the public facades shares one chunk, and host-only
   * modules share a chunk per set of host entries and lazy imports that load
   * them. Modules a program reaches keep the program split.
   */
  private prepareHostGroups(context: Rolldown.PluginContext, facades: ReadonlySet<string>): void {
    const program = (id: string) => this.modules.has(normalizePath(id));
    const capability = (id: string) =>
      Boolean(context.getModuleInfo(id)?.meta[engineCapabilityMeta]);
    const reach = (root: string) => reachableModules(context, capability, root);
    const { entries, lazy, shared } = collectHostRoots(
      context,
      facades,
      program,
      capability,
      reach,
    );
    const graphs = new Map([...entries, ...lazy].map((root) => [root, reach(root)] as const));
    pruneLoadedLazyTargets(context, entries, lazy, graphs);
    // Programs load facade code in every realm; host-only code stays apart.
    const facadeReach = new Set<string>();
    for (const facade of facades) for (const id of reach(facade)) facadeReach.add(id);
    const memberships = new Map<string, string[]>();
    for (const id of facadeReach) if (!program(id) && !shared.has(id)) memberships.set(id, []);
    for (const [root, graph] of [...graphs].sort(([a], [b]) => a.localeCompare(b)))
      for (const id of graph) {
        if (program(id) || shared.has(id) || facadeReach.has(id)) continue;
        const roots = memberships.get(id) ?? [];
        roots.push(root);
        memberships.set(id, roots);
      }
    this.hostGroups.clear();
    for (const [id, roots] of memberships)
      this.hostGroups.set(
        id,
        `engine-${createHash('sha256').update(JSON.stringify(roots)).digest('hex').slice(0, 16)}`,
      );
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

  /** A complete delivered graph contains every selected entry, regardless of its active export. */
  entryFiles(context: Rolldown.PluginContext): readonly string[] {
    return [
      ...new Set(
        [...this.entries.values()].map((id) => {
          const reference = this.chunks.get(normalizePath(id));
          if (!reference) throw new TypeError(`missing browser plugin export ${id}`);
          return context.getFileName(reference);
        }),
      ),
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

  /** Delivery locators stay in the current Host, outside exported portable programs. */
  imports(context: Rolldown.PluginContext, engineIdentity: string) {
    return Object.fromEntries(
      [...this.capabilities(context)].map(([url, name]) => [
        name,
        { identity: engineIdentity, url },
      ]),
    );
  }

  capture(
    context: Rolldown.PluginContext,
    bundle: Rolldown.OutputBundle,
    engineIdentity: string,
  ): Readonly<Record<string, PackProgram>> {
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
        const reference = this.chunks.get(normalizePath(id));
        if (!reference) throw new TypeError(`missing browser plugin export ${key}`);
        const entry = context.getFileName(reference);
        visit(entry);
        return [key, entry] as const;
      });
    // Every selection uses the complete graph, including lazy sibling exports.
    // Trimming per selection would split native identity for their shared helpers.
    return Object.fromEntries(
      selections.map(([key, entry]) => [
        key,
        preparePackProgram({ modules, imports, entry, export: 'default' }).unwrap(),
      ]),
    );
  }
}
