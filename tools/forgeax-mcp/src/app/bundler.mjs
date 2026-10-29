import { resolve } from 'node:path';
import ts from 'typescript';
import * as vite from 'vite';
const packageRoot = resolve(import.meta.dirname, '../..');
export function createRemoteBundler(allow) {
  const cache = new Map();
  let activeReads = 0;
  const waitingReads = [];
  // Source parsing shares this event loop with connection establishment. Bound
  // reads across builds so a wide import graph cannot starve loopback sockets.
  async function readSource(url) {
    if (activeReads === 4) await new Promise((resolve) => waitingReads.push(resolve));
    else activeReads++;
    try {
      const signal = AbortSignal.timeout(30000);
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(url, {
            headers: { accept: 'text/javascript' },
            signal,
          });
          if (!response.ok)
            throw new Error(`Vite source HTTP ${response.status}: ${url.pathname}`);
          return await response.text();
        } catch (cause) {
          // Vite can close a source connection during startup. Replay only an
          // incomplete GET, once, within the original read deadline and slot.
          if (
            attempt === 0 &&
            !signal.aborted &&
            ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(cause?.cause?.code)
          ) continue;
          throw new Error(`Vite source fetch failed: ${url.origin}${url.pathname}`, { cause });
        }
      }
    } finally {
      const next = waitingReads.shift();
      if (next) next();
      else activeReads--;
    }
  }
  async function bundle(url, kind = 'module', inlineSource) {
    const key = `${kind}:${url}`;
    if (cache.has(key)) return cache.get(key);
    const promise = (async () => {
      const remote = 'fx-remote:';
      const plugins = [
        {
          name: 'forgeax-mcp-remote-source',
          enforce: 'pre',
          resolveId(id, importer) {
            if (id.startsWith(remote)) return id;
            if (/^http:\/\/(127\.0\.0\.1|localhost):/.test(id)) return remote + id;
            if (importer?.startsWith(remote) && id.startsWith('/'))
              return remote + new URL(id, importer.slice(remote.length)).href;
            if (importer?.startsWith(remote) && id.startsWith('.'))
              return remote + new URL(id, importer.slice(remote.length)).href;
          },
          async load(id) {
            if (!id.startsWith(remote)) return;
            const href = id.slice(remote.length);
            const u = allow(href);
            if (
              u.pathname === '/@vite/client' ||
              u.pathname.endsWith('/vite/dist/client/client.mjs')
            )
              return `export const createHotContext=()=>({accept(){},dispose(){},prune(){},invalidate(){},on(){},off(){},send(){},data:{}});export function updateStyle(id,css){let e=document.getElementById('mcp-css-'+id);if(!e){e=document.createElement('style');e.id='mcp-css-'+id;document.head.append(e);}e.textContent=css;}export function removeStyle(id){document.getElementById('mcp-css-'+id)?.remove();}export const injectQuery=(url)=>url;`;
            if (u.pathname.endsWith('/vite/dist/client/env.mjs')) return '';
            if (u.pathname === '/@react-refresh')
              return 'export default {injectIntoGlobalHook(){},register(){},createSignatureFunctionForTransform(){return x=>x;}}';
            let code;
            if (inlineSource !== undefined && href === url) code = inlineSource;
            else code = await readSource(u);
            code = code
              .replace(/import\.meta\.hot\s*=\s*[^;]+;/g, '')
              .replaceAll('import.meta.hot', 'undefined');
            code = code
              .replaceAll('import.meta.env.DEV', 'true')
              .replaceAll('import.meta.env.PROD', 'false')
              .replaceAll('import.meta.url', JSON.stringify(href));
            code = code.replace(
              /\b(?:window\.|globalThis\.)?location\.(search|href|host|protocol|origin|pathname|hash)/g,
              'globalThis.__fxMcpLocation.$1',
            );
            const file = ts.createSourceFile(
              id,
              code,
              ts.ScriptTarget.Latest,
              true,
              ts.ScriptKind.JS,
            );
            const patches = [];
            function visit(node) {
              if (
                ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                node.arguments.length &&
                !ts.isStringLiteral(node.arguments[0])
              )
                patches.push({
                  start: node.getStart(file),
                  end: node.end,
                  text: `globalThis.__fxMcpImport(${node.arguments[0].getText(file)},${JSON.stringify(href)})`,
                });
              ts.forEachChild(node, visit);
            }
            visit(file);
            for (const patch of patches.sort((a, b) => b.start - a.start))
              code = code.slice(0, patch.start) + patch.text + code.slice(patch.end);
            return code;
          },
        },
      ];
      const result = await vite.build({
        configFile: false,
        root: packageRoot,
        logLevel: 'error',
        plugins,
        build: {
          write: false,
          target: 'esnext',
          minify: false,
          sourcemap: false,
          modulePreload: false,
          rolldownOptions: {
            preserveEntrySignatures: 'exports-only',
            input: remote + url,
            output: { format: 'es', codeSplitting: false },
          },
        },
      });
      const values = Array.isArray(result) ? result.flatMap((x) => x.output) : result.output;
      const chunk = values.find((x) => x.type === 'chunk' && x.isEntry);
      if (!chunk) throw new Error('Vite produced no entry');
      return { source: chunk.code };
    })();
    cache.set(key, promise);
    while (cache.size > 32) cache.delete(cache.keys().next().value);
    try {
      return await promise;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }
  return bundle;
}
