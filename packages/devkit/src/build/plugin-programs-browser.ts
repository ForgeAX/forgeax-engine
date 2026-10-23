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

/** Archive the player's own transformed graph, without reevaluating its bootstrap. */
export class BrowserPluginProgramArchive {
  readonly entries = new Map<string, string>();
  /** Emitted entry chunks, keyed by selected export module. */
  private readonly chunks = new Map<string, string>();
  /** Every module of the program graph; group membership decides their output chunks. */
  private readonly modules = new Set<string>();
  private readonly rendered = new Map<string, string>();
  private readonly groups = new Map<string, string>();

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

  /** Coalesce only modules with identical static entry reachability; lazy boundaries survive. */
  prepareGroups(context: Rolldown.PluginContext): void {
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
          { name: (id) => this.groups.get(id) ?? null, priority: 100 },
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
