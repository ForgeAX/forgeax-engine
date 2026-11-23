import { type ESTree, parseAst, Visitor } from 'vite';
import type { SingleHtmlBundleArtifact } from './single-html.js';

export const GENERATED_PREFIX = '__forgeax-bundle/';

export function isImportMetaUrl(
  node: ESTree.Expression | ESTree.SpreadElement | undefined,
): boolean {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'MetaProperty' &&
    node.object.meta.name === 'import' &&
    node.object.property.name === 'meta' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'url'
  );
}

/** Relocate native static ESM specifiers; execution and live bindings remain browser-owned. */
export function linkSingleHtmlModules(
  resources: readonly SingleHtmlBundleArtifact[],
): SingleHtmlBundleArtifact[] {
  const paths = new Set(resources.map((row) => row.path));
  return resources.map((resource) => {
    if (!/\.[cm]?js$/i.test(resource.path)) return resource;
    const code = Buffer.from(resource.bytes).toString('utf8');
    const imports: { kind: 'import' | 'url'; start: number; end: number; path: string }[] = [];
    const link = (node: { start: number; end: number; value?: unknown } | null | undefined) => {
      if (typeof node?.value !== 'string' || !/^(?:\.\/|\.\.\/)/.test(node.value)) return;
      const canonical = resource.path.startsWith(GENERATED_PREFIX)
        ? resource.path.slice(GENERATED_PREFIX.length)
        : resource.path;
      const target = decodeURIComponent(
        new URL(node.value, `https://forgeax.invalid/${canonical}`).pathname,
      ).slice(1);
      const generated = resource.path.startsWith(GENERATED_PREFIX)
        ? `${GENERATED_PREFIX}${target}`
        : target;
      const path = paths.has(generated) ? generated : target;
      if (!paths.has(path))
        throw new Error(
          `Single HTML static dependency is missing: ${resource.path} -> ${node.value}`,
        );
      imports.push({ kind: 'import', start: node.start, end: node.end, path });
    };
    const ast = parseAst(code);
    new Visitor({
      MemberExpression(node) {
        if (isImportMetaUrl(node))
          imports.push({ kind: 'url', start: node.start, end: node.end, path: resource.path });
      },
      ImportDeclaration(node) {
        link(node.source);
      },
      ExportNamedDeclaration(node) {
        link(node.source);
      },
      ExportAllDeclaration(node) {
        link(node.source);
      },
    }).visit(ast);
    return imports.length === 0
      ? resource
      : { ...resource, moduleLinks: imports.sort((a, b) => a.start - b.start) };
  });
}

/** Each realm uses one URL per canonical module, including concurrent imports. */
export function singleHtmlModuleLoaderSource(): string {
  return `((load, createURL) => {
 const urls = new Map();
 const moduleURL = (path, ancestors = []) => {
  if (ancestors.includes(path)) throw new TypeError('forgeax single-html unclosed static module cycle: ' + path);
  let pending = urls.get(path); if (pending !== undefined) return pending;
  pending = (async () => {
   const loaded = await load(path);
   if (loaded.path !== undefined && loaded.path !== path) return moduleURL(loaded.path, ancestors);
   let source = new TextDecoder().decode(loaded.data);
   const links = loaded.moduleLinks || [];
   const dependencies = await Promise.all(links.map(link => link.kind === 'url' ? 'forgeax-resource:///' + link.path : moduleURL(link.path, [...ancestors, path])));
   for (let index = links.length - 1; index >= 0; index--) {
    const link = links[index];
    source = source.slice(0, link.start) + JSON.stringify(dependencies[index]) + source.slice(link.end);
   }
   return createURL(source);
  })();
  urls.set(path, pending);
  pending.catch(() => { if (urls.get(path) === pending) urls.delete(path); });
  return pending;
 };
 return moduleURL;
})`;
}
