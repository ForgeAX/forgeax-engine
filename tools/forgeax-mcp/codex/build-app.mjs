import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build as viteBuild } from 'vite';
import { build as bundle, transform } from 'esbuild';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { APP_VERSION, VIEW_TITLE, MCP_NATIVE_IMPORT_SOURCE } from '../src/contract.ts';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist');
const require = createRequire(import.meta.url);
const engineFacadeRoot = resolve(require.resolve('@forgeax/engine/package.json'), '../dist/facades');
const viewRequire = createRequire(require.resolve('@forgeax/view/viewer/application'));
await mkdir(out, { recursive: true });
const escape = (source) => source.replaceAll('</script', '<\\/script');
async function frontend(entry) {
  const result = await viteBuild({
    configFile: false,
    root,
    logLevel: 'warn',
    resolve: {
      alias: {
        react: resolve(viewRequire.resolve('react/package.json'), '..'),
        'react-dom': resolve(viewRequire.resolve('react-dom/package.json'), '..'),
      },
      dedupe: ['react', 'react-dom', '@forgeax/engine'],
    },
    plugins: [{
      name: 'forgeax-public-engine',
      async resolveId(id, importer) {
        // The public facade alone resolves physical owners. Its own re-exports
        // retain native package resolution rather than redirecting to themselves.
        if (!id.startsWith('@forgeax/engine-') || importer?.startsWith(engineFacadeRoot)) return;
        return this.resolve(`@forgeax/engine/${id.slice('@forgeax/engine-'.length)}`, resolve(root, entry), { skipSelf: true });
      },
    }],
    build: {
      write: false,
      target: 'esnext',
      minify: false,
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: 1_000_000,
      modulePreload: false,
      rolldownOptions: {
        preserveEntrySignatures: 'exports-only',
        input: resolve(root, entry),
        output: { format: 'es', codeSplitting: false },
      },
    },
  });
  const files = Array.isArray(result) ? result.flatMap((value) => value.output) : result.output;
  const code = files.find((value) => value.type === 'chunk' && value.isEntry)?.code;
  if (!code) throw new Error('Vite produced no platform entry');
  const css = files
    .filter((value) => value.type === 'asset' && value.fileName.endsWith('.css'))
    .map((value) => String(value.source))
    .join('\n');
  const optimized = await transform(code, {
    target: 'esnext',
    format: 'esm',
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    treeShaking: true,
    pure: ['console.debug'],
  });
  return { code: optimized.code, css };
}
const preview = await frontend('src/app/preview-runtime.ts');
const previewModule = {
  specifier: pathToFileURL(resolve(out, 'preview-runtime.mjs')).href,
  prepare: 'preparePlatform',
};
// DevKit seals this product module before running either frontend export.
for (const selected of ['default', previewModule.prepare])
  preparePackProgram({
    entry: 'program-0.mjs',
    export: selected,
    modules: { 'program-0.mjs': preview.code },
  }).unwrap();
await writeFile(resolve(out, 'preview-runtime.mjs'), preview.code);
await writeFile(
  resolve(out, 'preview-manifest.mjs'),
  `export default ${JSON.stringify({
    root: {
      program: 'forgeax.mcp.preview',
      codeRevision: createHash('sha256').update(preview.code).digest('hex'),
    },
    module: previewModule,
  })};\n`,
);
let viewBytes = 0;
for (const [entry, name] of [
  ['src/app/view-entry.tsx', 'full-view.html'],
  ['src/codex-view-entry.tsx', 'codex-view.html'],
]) {
  const view = await frontend(entry);
  viewBytes = Buffer.byteLength(view.code);
  await writeFile(
    resolve(out, name),
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}</style><style>${view.css}</style></head><body><script>${MCP_NATIVE_IMPORT_SOURCE}</script><div id="root"></div><script id="fx-config" type="application/json">__FX_VIEW_CONFIG__</script><script type="module">${escape(view.code)}</script></body></html>`,
  );
}
const carrier = await bundle({
  absWorkingDir: root,
  entryPoints: ['src/app/carrier.ts'],
  write: false,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  pure: ['console.debug'],
  minifyWhitespace: true,
  minifySyntax: true,
  logLevel: 'silent',
});
await writeFile(
  resolve(out, 'carrier.html'),
  `<!doctype html><html data-forgeax-app-version="${APP_VERSION}"><head><meta charset="utf-8"><title>${VIEW_TITLE}</title><style>html,body{height:100%;margin:0;overflow:hidden}html[data-forgeax-inline=true],html[data-forgeax-inline=true] body{height:auto}body{display:flex;flex-direction:column;background:Canvas;color:CanvasText;font:13px system-ui}iframe{border:0;width:100%;height:100%;flex:1;min-height:0}iframe[hidden]{display:none}#resource-card{padding:8px;box-sizing:border-box;flex:none;min-width:0}#resource-card nav{display:flex;flex-wrap:wrap;gap:6px}#resource-card button{font:inherit;line-height:18px;min-height:32px;max-width:100%;overflow-wrap:anywhere;padding:6px 10px;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;cursor:pointer}#resource-card button[aria-pressed=true]{border-color:Highlight;background:Highlight;color:HighlightText}#resource-card p{margin:6px 0 0;overflow-wrap:anywhere}#resource-card p[hidden]{display:none}#resource-card[hidden]{display:none}#carrier-error{padding:12px;overflow-wrap:anywhere}</style></head><body><script id="fx-entry-scope" type="application/json">__FX_VIEW_ENTRY_SCOPE__</script><script id="fx-entry-kind" type="application/json">__FX_VIEW_ENTRY_KIND__</script><iframe id="view" title="${VIEW_TITLE}" sandbox="allow-scripts" allow="clipboard-write *"></iframe><script>${escape(carrier.outputFiles[0].text)}</script></body></html>`,
);
console.log(
  JSON.stringify({
    output: out,
    version: APP_VERSION,
    viewBytes,
    previewBytes: Buffer.byteLength(preview.code),
  }),
);
