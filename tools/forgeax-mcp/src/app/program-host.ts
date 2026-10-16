import type { PackProgramHostFactory } from '@forgeax/engine/devkit';
import { packProgramModuleIdentity } from '@forgeax/engine/pack/runtime';
import { PROGRAM_IMPORTS_SLOT } from '../contract.ts';
const SLOT = Symbol.for(PROGRAM_IMPORTS_SLOT);

/** Borrow actual realm imports; compiled program URLs and namespace leases retire with the platform. */
export function createMcpProgramHosts(global: any, invoke: any, bytes: any) {
  const registry: Map<string, Map<string, Readonly<Record<string, unknown>>>> = global[SLOT] ??= new Map();
  const owned = new Set<string>();
  const urls = new Map<string, string>();
  let publishedBytes = 0;
  const lifetime = new AbortController();
  const create: PackProgramHostFactory = (imports, loadImport) => {
    lifetime.signal.throwIfAborted();
    if (owned.size >= 16) throw new Error('MCP program host bound exceeded');
    const bindingId = crypto.randomUUID();
    const namespaces = new Map<string, Readonly<Record<string, unknown>>>();
    registry.set(bindingId, namespaces);
    owned.add(bindingId);
    const modules = new Map<string, Promise<string>>();
    lifetime.signal.addEventListener('abort', () => modules.clear(), { once: true });
    return {
      async publish(program, bindings) {
        lifetime.signal.throwIfAborted();
        const identity = packProgramModuleIdentity(program, bindings).unwrap();
        if (program.export === '__esModule') throw new Error('Native program export __esModule is reserved');
        let pending = modules.get(identity);
        if (!pending) {
          if (modules.size >= 128) throw new Error('MCP program graph bound exceeded');
          pending = (async () => {
            const names = Object.keys(program.imports ?? {});
            await Promise.all(names.map(async name => {
              if (bindings[name]?.identity !== imports[name]?.identity || bindings[name]?.url !== imports[name]?.url)
                throw new Error(`Program import differs from the executing Engine: ${name}`);
              if (!namespaces.has(name)) namespaces.set(name, await loadImport(name));
            }));
            lifetime.signal.throwIfAborted();
            const ref = await invoke({ action: 'program', program, imports: bindings, bindingId,
              exports: Object.fromEntries(names.map(name => [name, Object.keys(namespaces.get(name)!).sort()])) },
              { signal: lifetime.signal });
            const source = await bytes(ref, { signal: lifetime.signal });
            lifetime.signal.throwIfAborted();
            if (urls.size >= 128 || publishedBytes + source.byteLength > 64 * 1024 * 1024)
              throw new Error('MCP program module bound exceeded');
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            urls.set(url, bindingId);
            publishedBytes += source.byteLength;
            return url;
          })();
          modules.set(identity, pending);
          void pending.catch(() => { if (modules.get(identity) === pending) modules.delete(identity); });
        }
        return `${await pending}#${encodeURIComponent(program.entry)}`;
      },
      async importModule(url) {
        lifetime.signal.throwIfAborted();
        const entryUrl = new URL(url);
        const entry = decodeURIComponent(entryUrl.hash.slice(1));
        entryUrl.hash = '';
        if (urls.get(entryUrl.href) !== bindingId) throw new Error('Module outside this MCP program host');
        const driver = (await import(/* @vite-ignore */ entryUrl.href)).default;
        return Object.freeze(driver.load(entry));
      },
    };
  };
  return { create, dispose() {
    lifetime.abort(new Error('MCP program host retired'));
    for (const url of urls.keys()) URL.revokeObjectURL(url);
    urls.clear();
    publishedBytes = 0;
    for (const id of owned) registry.delete(id);
    owned.clear();
    if (registry.size === 0 && global[SLOT] === registry) delete global[SLOT];
  } };
}
