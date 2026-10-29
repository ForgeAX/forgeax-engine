import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { filesUnder } from './sdk-lib.mjs';

export const VIEW_TOOL_FILES = Object.freeze([
  'dist',
  'host.pack.json',
  'skills',
  'README.md',
  'LICENSE',
  'scripts/browser-proof-workload.mjs',
  'scripts/runtime-content-import.mjs',
  'scripts/verify-runtime-content-engine.mjs',
  'scripts/verify-game3d-workspace.mjs',
  'scripts/preview-rhi-evidence.mjs',
]);

/** Embed the built View tool in the SDK without contributor workspace dependencies. */
export async function stageViewToolPackage(viewRoot, packageRoot, version) {
  await mkdir(packageRoot, { recursive: true });
  const files = VIEW_TOOL_FILES;
  for (const file of files)
    await cp(resolve(viewRoot, file), resolve(packageRoot, file), { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(viewRoot, 'package.json'), 'utf8'));
  manifest.private = true;
  manifest.version = version;
  for (const field of ['devDependencies', 'forgeax', 'bin', 'scripts']) delete manifest[field];
  delete manifest.exports['./build'];
  manifest.files = files;
  const graph = JSON.parse(await readFile(resolve(viewRoot, 'dist/native-build.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies))
    if (name.startsWith('@forgeax/view-')) delete manifest.dependencies[name];
  for (const output of Object.values(graph.outputs))
    for (const item of output.imports) {
      if (!item.external) continue;
      if (item.path.startsWith('@forgeax/view-'))
        throw new Error(`sdk-view-unbundled-workspace-package: ${item.path}`);
      if (item.path.startsWith('@forgeax/engine'))
        manifest.dependencies['@forgeax/engine'] = version;
    }
  for (const name of Object.keys(manifest.dependencies))
    if (name.startsWith('@forgeax/engine-')) delete manifest.dependencies[name];
  manifest.dependencies['@forgeax/engine'] = version;
  // Contributor tools use physical workspace owners. Their published modules
  // consume the same public Engine subpaths as ordinary external projects.
  for (const path of await filesUnder(packageRoot)) {
    if (!/\.(?:mjs|cjs|js|ts|json)$/.test(path)) continue;
    const source = await readFile(path, 'utf8');
    const projected = source.replaceAll(
      /@forgeax\/engine-([a-z][a-z0-9-]*)/g,
      '@forgeax/engine/$1',
    );
    if (projected !== source) await writeFile(path, projected);
  }
  await rm(resolve(packageRoot, 'dist/native-build.json'));
  await rm(resolve(packageRoot, 'dist/viewer/panel-graph.json'), { force: true });
  await writeFile(resolve(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2));
}
