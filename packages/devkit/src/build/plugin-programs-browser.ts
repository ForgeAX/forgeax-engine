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
  private readonly chunks = new Map<string, string>();
  private readonly rendered = new Map<string, string>();

  recordRendered(code: string, chunk: Rolldown.RenderedChunk): void {
    if (Object.keys(chunk.modules).some((id) => this.chunks.has(id)))
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

  preserveModules(context: Rolldown.PluginContext): void {
    const visited = new Set<string>();
    const visit = (input: string) => {
      const id = normalizePath(input);
      if (visited.has(id)) return;
      visited.add(id);
      const info = context.getModuleInfo(id);
      if (!info || info.code === null || info.meta[engineCapabilityMeta]) return;
      // Strict entries keep shared project modules out of the page bootstrap,
      // retaining the same native URL for page, plugins and their tool executors.
      if (!this.chunks.has(id))
        this.chunks.set(
          id,
          context.emitFile({
            type: 'chunk',
            id,
            name: `program-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`,
            preserveSignature: 'strict',
          }),
        );
      for (const dependency of [...info.importedIds, ...info.dynamicallyImportedIds])
        visit(dependency);
    };
    for (const id of this.entries.values()) visit(id);
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
