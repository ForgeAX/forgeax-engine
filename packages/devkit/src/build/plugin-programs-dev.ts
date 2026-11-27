import { sha256 } from '@forgeax/engine-types';
import type { Plugin, ViteDevServer } from 'vite';
import { type EngineCapabilityMeta, engineCapabilityMeta } from './execution-workers.js';
import { projectModuleSpecifiers, readModuleSpecifiers } from './module-specifiers.js';
import { packProgramImportIdentities, sealPluginProgramGraph } from './plugin-program-artifacts.js';

/** Freeze the same final Vite modules consumed by page and plugin imports. */
export async function captureDevPluginPrograms(
  server: ViteDevServer,
  selections: ReadonlyMap<string, string>,
  identity: string,
  session?: string,
) {
  const environment = server.environments.client;
  if (!environment) throw new TypeError('browser plugin capture requires a client environment');
  // init starts the native scan without awaiting it. Freeze only after that
  // scan discovers the shared dependency graph and its optimized module URLs.
  await environment.depsOptimizer?.init();
  await environment.depsOptimizer?.scanProcessing;
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
    const filename = `modules/${sha256(withDevProgramSession(url, null))}.js`;
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
    const source = projectModuleSpecifiers(result.code, url);
    const edges = new Map<string, string>();
    for (const { specifier: dependency } of source.edges) {
      if (!dependency.startsWith('/')) {
        unsupported ??= `plugin program import requires a portable producer: ${dependency}`;
        continue;
      }
      edges.set(dependency, await visit(dependency));
    }
    modules[filename] = source.rewrite((specifier) => {
      const target = edges.get(specifier);
      return target?.startsWith('modules/') ? `./${target.slice('modules/'.length)}` : target;
    });
    // JSON and foreign virtual modules are transformed under their original
    // producer IDs. Only final HTTP locators acquire this Host's session tag.
    responses.set(
      delivered,
      source.rewrite((specifier) => {
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
    for (const { specifier } of readModuleSpecifiers(transformed.code, node.url))
      await protect(specifier);
  };
  for (const url of capabilities) await protect(url);
  const sealed = unsupported
    ? undefined
    : sealPluginProgramGraph(modules, packProgramImportIdentities(imports), entries);
  return {
    responses,
    moduleIds,
    entries: [...new Set(entries.values())].sort(),
    archive: sealed
      ? { graph: sealed.graph, programs: Object.fromEntries(sealed.programs), imports, urls }
      : { error: unsupported },
  };
}

function editProgramQuery(url: string, keep: (part: string) => boolean, append?: string): string {
  const split = url.indexOf('?');
  if (split < 0) return append === undefined ? url : `${url}?${append}`;
  const query = url
    .slice(split + 1)
    .split('&')
    .filter(keep);
  if (append !== undefined) query.push(append);
  return url.slice(0, split) + (query.length ? `?${query.join('&')}` : '');
}

const isSemanticProgramQuery = (part: string) =>
  !/^t=\d+$/.test(part) && part !== 'import' && part !== 'import=';

/** Strip only Vite transport cache hints; semantic module queries stay intact. */
export function normalizeDevProgramUrl(url: string): string {
  return editProgramQuery(url, isSemanticProgramQuery);
}

export const devProgramSessionQuery = 'forgeax-program-session';

export function devProgramSession(url: string): string | null {
  if (!url.includes('?')) return null;
  return new URLSearchParams(url.slice(url.indexOf('?') + 1)).get(devProgramSessionQuery);
}

/** Session locators belong to this Host, never to the portable program graph. */
export function withDevProgramSession(url: string, session: string | null): string {
  const append =
    session === null ? undefined : `${devProgramSessionQuery}=${encodeURIComponent(session)}`;
  return editProgramQuery(
    url,
    (part) => !new URLSearchParams(part).has(devProgramSessionQuery),
    append,
  );
}

export const devProgramResourceMeta = 'forgeax.programResource';

/** Vite 8 producer evidence; preserve its code, filters and hook ordering. */
export function markDevProgramResources(plugins: readonly Plugin[]): void {
  for (const name of ['vite:asset', 'vite:worker', 'vite:wasm-helper']) {
    const plugin = plugins.find((plugin) => plugin.name === name);
    const hook = plugin?.load;
    if (!plugin || !hook) throw new TypeError(`Vite resource producer unavailable: ${name}`);
    const handler = typeof hook === 'function' ? hook : hook.handler;
    const wrapped: typeof handler = async function (...args) {
      const result = await handler.apply(this, args);
      if (
        result == null ||
        (name === 'vite:asset' && new URLSearchParams(args[0].split('?')[1]).has('raw'))
      )
        return result;
      return typeof result === 'string'
        ? { code: result, meta: { [devProgramResourceMeta]: name } }
        : { ...result, meta: { ...result.meta, [devProgramResourceMeta]: name } };
    };
    plugin.load = typeof hook === 'function' ? wrapped : { ...hook, handler: wrapped };
  }
  for (const name of ['vite:asset-import-meta-url', 'vite:worker-import-meta-url', 'vite:css']) {
    const plugin = plugins.find((plugin) => plugin.name === name);
    const hook = plugin?.transform;
    if (!plugin || !hook) throw new TypeError(`Vite resource producer unavailable: ${name}`);
    const handler = typeof hook === 'function' ? hook : hook.handler;
    const wrapped: typeof handler = async function (...args) {
      const result = await handler.apply(this, args);
      if (result == null) return result;
      return typeof result === 'string'
        ? { code: result, meta: { [devProgramResourceMeta]: name } }
        : { ...result, meta: { ...result.meta, [devProgramResourceMeta]: name } };
    };
    plugin.transform = typeof hook === 'function' ? wrapped : { ...hook, handler: wrapped };
  }
}
