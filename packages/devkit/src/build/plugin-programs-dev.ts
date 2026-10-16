import { createHash } from 'node:crypto';
import { type PackProgram, preparePackProgram } from '@forgeax/engine-pack/runtime';
import type { ViteDevServer } from 'vite';
import { devProgramResourceMeta } from './dev-program-resources.js';
import { normalizeDevProgramUrl, withDevProgramSession } from './dev-program-url.js';
import { type EngineCapabilityMeta, engineCapabilityMeta } from './execution-workers.js';
import { rewriteModuleSpecifiers } from './module-specifiers.js';

/** Freeze the same final Vite modules consumed by page and plugin imports. */
export async function captureDevPluginPrograms(
  server: ViteDevServer,
  selections: ReadonlyMap<string, string>,
  identity: string,
  session?: string,
) {
  const environment = server.environments.client;
  if (!environment) throw new TypeError('browser plugin capture requires a client environment');
  const base = server.config.base;
  const local = (url: string) => (url.startsWith(base) ? `/${url.slice(base.length)}` : url);
  const responses = new Map<string, string>();
  const files = new Map<string, string>();
  const imports: Record<string, { identity: string; url: string }> = {};
  const modules: Record<string, string> = {};
  const urls: Record<string, string> = {};
  const moduleIds = new Set<string>();
  const capabilities = new Set<string>();
  let unsupported: string | undefined;
  const visit = async (requested: string): Promise<string> => {
    const incoming = normalizeDevProgramUrl(local(requested));
    if (incoming.startsWith('/@vite/')) {
      unsupported ??= `plugin program resource requires a portable producer: ${incoming}`;
      return incoming;
    }
    const request = incoming.startsWith('/@id/')
      ? incoming.slice(5).replace('__x00__', '\0')
      : incoming;
    const known = files.get(request);
    if (known) return known;
    const [url, id, meta] = await environment.moduleGraph.resolveUrl(request);
    const capability = (meta as Record<string, unknown> | undefined)?.[engineCapabilityMeta] as
      | EngineCapabilityMeta
      | undefined;
    if (capability) {
      imports[capability.specifier] = { identity, url: `${base}${url.slice(1)}` };
      capabilities.add(url);
      return capability.specifier;
    }
    const nativeUrl =
      url.includes('\0') || url.startsWith('virtual:')
        ? `/@id/${url.replace('\0', '__x00__')}`
        : url;
    const filename = `modules/${createHash('sha256').update(withDevProgramSession(url, null)).digest('hex')}.js`;
    files.set(request, filename);
    files.set(url, filename);
    moduleIds.add(withDevProgramSession(id, null));
    const delivered = session === undefined ? nativeUrl : withDevProgramSession(nativeUrl, session);
    urls[filename] = `${base}${delivered.slice(1)}`;
    const result = await environment.transformRequest(url);
    if (!result) throw new TypeError(`plugin module unavailable: ${url}`);
    // Read ModuleInfo after transform: Vite 8 does not copy transform metadata
    // into the ModuleNode/resolveUrl metadata snapshot.
    if (
      environment.pluginContainer.getModuleInfo(id)?.meta[devProgramResourceMeta] ||
      /^\/@vite\//.test(url) ||
      id.includes('__vite-browser-external')
    )
      unsupported ??= `plugin program resource requires a portable producer: ${url}`;
    const dependencies: string[] = [];
    rewriteModuleSpecifiers(result.code, url, (specifier) => {
      dependencies.push(specifier);
      return undefined;
    });
    const edges = new Map<string, string>();
    for (const dependency of dependencies) {
      if (!dependency.startsWith('/')) {
        unsupported ??= `plugin program import requires a portable producer: ${dependency}`;
        continue;
      }
      edges.set(dependency, await visit(dependency));
    }
    modules[filename] = rewriteModuleSpecifiers(result.code, url, (specifier) => {
      const target = edges.get(specifier);
      return target?.startsWith('modules/') ? `./${target.slice('modules/'.length)}` : target;
    });
    // JSON and foreign virtual modules are transformed under their original
    // producer IDs. Only final HTTP locators acquire this Host's session tag.
    responses.set(
      delivered,
      rewriteModuleSpecifiers(result.code, url, (specifier) => {
        const target = edges.get(specifier);
        return target?.startsWith('modules/') ? urls[target] : undefined;
      }),
    );
    return filename;
  };
  const entries = new Map<string, string>();
  for (const [key, url] of selections) entries.set(key, await visit(url));
  const protectedIds = new Set<string>();
  const protect = async (url: string): Promise<void> => {
    const incoming = normalizeDevProgramUrl(local(url));
    // Vite's injected client belongs to the Host transport. The authoring
    // visitor above still rejects it as a portable program dependency.
    if (incoming.startsWith('/@vite/')) return;
    const node = await environment.moduleGraph.ensureEntryFromUrl(incoming);
    if (!node.id || protectedIds.has(node.id)) return;
    protectedIds.add(node.id);
    if (moduleIds.has(withDevProgramSession(node.id, null)))
      unsupported ??= `plugin program shares an undeclared Engine dependency: ${node.id}`;
    const transformed = await environment.transformRequest(node.url);
    if (!transformed) throw new TypeError(`Engine capability module unavailable: ${node.url}`);
    // Vite's graph also records new URL() assets. Those bytes belong to their
    // runtime loader, not the ESM graph, and must never be transformed as JS.
    // Follow actual module edges while retaining shared-dependency protection.
    const dependencies: string[] = [];
    rewriteModuleSpecifiers(transformed.code, node.url, (specifier) => {
      dependencies.push(specifier);
      return undefined;
    });
    for (const dependency of dependencies) await protect(dependency);
  };
  for (const url of capabilities) await protect(url);
  const programs: Record<string, PackProgram> = {};
  if (!unsupported)
    for (const [key, entry] of entries)
      programs[key] = preparePackProgram({
        modules,
        entry,
        export: 'default',
        imports: Object.fromEntries(Object.keys(imports).map((name) => [name, identity])),
      }).unwrap();
  return {
    responses,
    moduleIds,
    entries: [...new Set(entries.values())].sort(),
    archive: unsupported ? { error: unsupported } : { programs, imports, urls },
  };
}
