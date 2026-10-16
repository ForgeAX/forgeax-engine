import { resolveBuildInput, buildRevision, digest, panelsEntry } from './build-inputs.mjs';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist/modules');
const packagesRoot = resolve(root, 'packages');
const productIds = [
  'scene',
  'display',
  'content-browser',
  'plugins',
  'inspector',
  'scene-tree',
  'material',
  'mesh',
  'html',
  'texture',
  'asset',
  'viewport',
];
const internalPackages = new Map([
  ['@forgeax/view-components', resolve(packagesRoot, 'view-components')],
  ...productIds.map((id) => [
    `@forgeax/view-plugin-${id}`,
    resolve(packagesRoot, `view-plugin-${id}`),
  ]),
  ['@forgeax/view-viewer', resolve(packagesRoot, 'viewer')],
  ['@forgeax/view-workspace-core', resolve(packagesRoot, 'view-workspace-core')],
]);
const internalSpecifiers = new Map();

for (const [name, directory] of internalPackages) {
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  for (const [subpath, target] of Object.entries(metadata.exports)) {
    internalSpecifiers.set(
      `${name}${subpath === '.' ? '' : subpath.slice(1)}`,
      resolve(directory, target),
    );
  }
}

const entryPoints = {
  product: resolve(root, 'src/plugins/product.ts'),
  'workspace/presentation': resolve(packagesRoot, 'view-plugin-viewport/src/presentation.ts'),
  'pages/scene': resolve(packagesRoot, 'view-plugin-scene/src/frontend.ts'),
  'shell/frontend': resolve(packagesRoot, 'viewer/src/plugins/shell.ts'),
  index: resolve(root, 'src/index.ts'),
  browser: resolve(root, 'src/browser.ts'),
  carrier: resolve(packagesRoot, 'view-plugin-display/src/carrier-adapter.ts'),
  'carrier-contract': resolve(packagesRoot, 'view-plugin-display/src/carrier-contract.ts'),
  backend: resolve(root, 'src/plugins/backend.ts'),
  'extension-bridge': resolve(packagesRoot, 'view-workspace-core/src/extension-bridge.ts'),
  cli: resolve(root, 'src/cli.ts'),
  'start-cli': resolve(root, 'src/start-cli.ts'),
  start: resolve(root, 'src/view-start.ts'),
  page: resolve(root, 'src/page.ts'),
  embedded: resolve(packagesRoot, 'viewer/src/shell/embedded.tsx'),
  'workspace-frontend': resolve(packagesRoot, 'viewer/src/host/workspace-frontend.ts'),
  'frontend-root': resolve(packagesRoot, 'viewer/src/frontend-root.ts'),
  'viewer/application': resolve(packagesRoot, 'viewer/src/application.tsx'),
  'viewer/panels': panelsEntry,
  'workspace/frontend': resolve(packagesRoot, 'view-plugin-viewport/src/workspace-shell.ts'),
  commands: resolve(root, 'src/commands.ts'),
  'command-executor': resolve(root, 'src/command-executor.ts'),
  plugin: resolve(root, 'src/plugin.ts'),
  'cli-contributions': resolve(root, 'src/cli-contributions.ts'),
  viewer: resolve(packagesRoot, 'viewer/src/catalog.ts'),
  'viewer/catalog': resolve(packagesRoot, 'viewer/src/catalog.ts'),
  'viewer/catalog/shared': resolve(packagesRoot, 'viewer/src/catalog-shared.ts'),
  'viewer/catalog/backend': resolve(packagesRoot, 'viewer/src/backend-catalog.ts'),
  'viewer/catalog/frontend': resolve(packagesRoot, 'viewer/src/frontend-catalog.ts'),
  'viewer/cli': resolve(packagesRoot, 'viewer/src/cli/index.ts'),
  'shell/contract': resolve(root, 'src/shell/contract.ts'),
  'shell/layout-zones': resolve(root, 'src/shell/layout-zones.ts'),
  'viewer-host': resolve(packagesRoot, 'viewer/src/host/index.ts'),
  'viewer-host/frontend': resolve(packagesRoot, 'viewer/src/host/frontend.ts'),
  'viewer-host/page-registry': resolve(packagesRoot, 'viewer/src/host/page-registry.ts'),
  'viewer-host/slot-registry': resolve(packagesRoot, 'viewer/src/host/slot-registry.ts'),
};

const workspaceMetadata = JSON.parse(
  await readFile(resolve(packagesRoot, 'view-workspace-core/package.json'), 'utf8'),
);
for (const [subpath, target] of Object.entries(workspaceMetadata.exports)) {
  const name = subpath === '.' ? 'api' : subpath.slice(2);
  entryPoints[`workspace/${name}`] = resolve(packagesRoot, 'view-workspace-core', target);
}

for (const id of productIds) {
  const directory = resolve(packagesRoot, `view-plugin-${id}`);
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  for (const [subpath, target] of Object.entries(metadata.exports)) {
    if (subpath !== '.') entryPoints[`plugins/${id}/${subpath.slice(2)}`] = resolve(directory, target);
  }
}

const cssInjectionPlugin = {
  name: 'forgeax-css-injection',
  setup(buildContext) {
    buildContext.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      const bundled = await build({
        absWorkingDir: root,
        entryPoints: [path],
        bundle: true,
        write: false,
        outfile: 'injected.css',
        plugins: [internalWorkspacePlugin],
      });
      if (bundled.errors.length > 0) return { errors: bundled.errors };
      const css =
        bundled.outputFiles.find((file) => file.path.endsWith('.css'))?.text ??
        bundled.outputFiles[0]?.text;
      if (typeof css !== 'string' || /@import\s+['"]\.\//.test(css)) {
        return {
          errors: [
            {
              text: `CSS injection must inline relative @import rules for ${path}`,
            },
          ],
        };
      }
      const key = (await import('node:crypto')).createHash('sha256').update(css).digest('hex');
      return {
        loader: 'js',
        contents: `
          const css = ${JSON.stringify(css)};
          if (typeof document !== 'undefined' && !document.querySelector('style[data-forgeax-css="${key}"]')) {
            const style = document.createElement('style');
            style.dataset.forgeaxCss = ${JSON.stringify(key)};
            style.textContent = css;
            document.head.append(style);
          }
          export default css;
        `,
      };
    });
  },
};

const internalWorkspacePlugin = {
  name: 'forgeax-internal-workspaces',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^\./ }, ({ path, importer }) => {
      const target = resolveBuildInput(path, importer);
      return target === 'view-build-revision' ? { path: 'revision', namespace: 'view-revision' } : target ? { path: target } : undefined;
    });
    buildContext.onLoad({ filter: /.*/, namespace: 'view-revision' }, () => ({ contents: `export default ${JSON.stringify(buildRevision)}` }));
    buildContext.onResolve({ filter: /^@forgeax\/view-/ }, ({ path }) => {
      const resolved = internalSpecifiers.get(path);
      if (!resolved) {
        return {
          errors: [{ text: `Unknown internal View package export: ${path}` }],
        };
      }
      return { path: resolved };
    });
  },
};

await rm(output, { recursive: true, force: true });
const result = await build({
  metafile: true,
  absWorkingDir: root,
  entryPoints,
  outdir: output,
  entryNames: '[dir]/[name]',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'react',
  outExtension: { '.js': '.mjs' },
  sourcemap: true,
  plugins: [internalWorkspacePlugin, cssInjectionPlugin],
  external: [
    'node:*',
    '@forgeax/engine-*',
    '@forgeax/engine',
    '@forgeax/engine/*',
    'lucide-react',
    'react',
    'react-dom',
    'react-dom/*',
    'playwright',
    'vite',
    'ws',
  ],
});

await writeFile(resolve(root, 'dist/native-build.json'), JSON.stringify(result.metafile, null, 2));
const viewerHash = createHash('sha256');
await digest(resolve(root, 'dist/viewer'), viewerHash);
await writeFile(resolve(root, 'dist/build-revision.json'), JSON.stringify({ codeRevision: buildRevision, viewerDigest: viewerHash.digest('hex') }));
