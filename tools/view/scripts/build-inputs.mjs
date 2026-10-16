import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const viewRoot = resolve(import.meta.dirname, '..');
export const panelsEntry = resolve(process.env.FORGEAX_VIEW_PANELS_ENTRY ?? resolve(viewRoot, 'packages/viewer/src/panels-entry.tsx'));
export const frontendPluginsEntry = resolve(process.env.FORGEAX_VIEW_FRONTEND_PLUGINS_ENTRY ?? resolve(viewRoot, 'packages/viewer/src/frontend-plugins.ts'));
const fixturePanelsEntry = resolve(viewRoot, 'apps/view-fixture-host/scripts/diagnostic-panels-entry.mjs');
const fixtureMode = panelsEntry === fixturePanelsEntry;
const engineRoot = fixtureMode
 ? resolve(dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json'))), '../..')
 : undefined;
const fixtureStyle = fixtureMode ? await import('../apps/view-fixture-host/scripts/generate-rhi-style.mjs') : undefined;
if (fixtureStyle) await fixtureStyle.generateFixtureRhiStyle();
export function resolveBuildInput(id, importer) {
 if (!id.startsWith('.') || !importer) return undefined;
 const path = resolve(dirname(importer), id).replace(/\.(?:tsx?|mjs)$/, '');
 if (fixtureStyle && resolve(dirname(importer), id) === fixtureStyle.engineRhiStyle) return fixtureStyle.fixtureRhiStyle;
 if (path === resolve(viewRoot, 'packages/viewer/src/panels-entry')) return panelsEntry;
 if (path === resolve(viewRoot, 'packages/viewer/src/frontend-plugins')) return frontendPluginsEntry;
 if (path === resolve(viewRoot, 'packages/viewer/src/build-identity')) return 'view-build-revision';
}
export async function digest(directory, hash, base = directory) {
 for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
  if (entry.name.endsWith('.tsbuildinfo') || ['node_modules', 'dist', '.git', '.forgeax-harness', '.agents', 'storybook-static'].includes(entry.name)) continue;
  const path = resolve(directory, entry.name);
  if (entry.isDirectory()) await digest(path, hash, base);
  else if (entry.isFile()) { hash.update(relative(base, path)); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
 }
}
const hash = createHash('sha256');
hash.update('panels-entry\0');
hash.update(relative(viewRoot, panelsEntry));
hash.update('\0frontend-plugins-entry\0');
hash.update(relative(viewRoot, frontendPluginsEntry));
hash.update('\0');
await digest(resolve(viewRoot, 'src'), hash);
await digest(resolve(viewRoot, 'packages'), hash);
if (fixtureStyle) {
 await digest(resolve(viewRoot, 'apps/view-fixture-host/scripts'), hash);
 hash.update('\0fixture-rhi-style\0');
 hash.update(await readFile(fixtureStyle.fixtureRhiStyle));
}
for (const inputRoot of JSON.parse(process.env.FORGEAX_VIEW_INPUT_ROOTS ?? '[]')) await digest(inputRoot, hash);
export const buildRevision = hash.digest('hex');
const require = createRequire(resolve(viewRoot, 'package.json'));
// Keep the panel dependency closure separate from the resident native Host graph.
// Shared module grouping must not drag unrelated Host factories into served panels.
let panelClosure;
let staticPanelClosure;
export function panelsChunk(id, { getModuleInfo }) {
 if (!panelClosure) {
  const visit = (root, dynamic, seen = new Set()) => {
   if (seen.has(root)) return seen; seen.add(root);
   const info = getModuleInfo(root);
   if (info) for (const imported of [...info.importedIds, ...(dynamic ? info.dynamicallyImportedIds : [])]) visit(imported, dynamic, seen);
   return seen;
  };
  staticPanelClosure = visit(panelsEntry, false);
  panelClosure = visit(panelsEntry, true);
 }
 if (id === panelsEntry) return undefined;
 if (staticPanelClosure.has(id)) return 'panels-ui';
 if (panelClosure.has(id)) return 'panels-lazy';
}
export const revisionPlugin = {
 name: 'view-build-revision',
 enforce: 'pre',
 resolveId(id, importer) {
  if (engineRoot && id === '@forgeax/view-fixture/rhi-debug-ui') return resolve(engineRoot, 'tools/view-plugins/rhi-debug/ui.tsx');
  if (engineRoot && id === '@forgeax/view-fixture/profiler-ui') return resolve(engineRoot, 'tools/view-plugins/profiler/ui.tsx');
  if (!id.startsWith('.') && !id.startsWith('/') && importer && importer.startsWith(dirname(panelsEntry) + '/')) {
   try { return require.resolve(id); } catch {}
  }
  const path = resolveBuildInput(id, importer); return path === 'view-build-revision' ? '\0view-build-revision' : path; },
 load(id) { if (id === '\0view-build-revision') return `export default ${JSON.stringify(buildRevision)}`; },
 generateBundle(_, bundle) {
  const visited = new Set();
  const modules = new Set();
  const visit = id => {
   if (visited.has(id)) return; visited.add(id);
   const info = this.getModuleInfo(id);
   if (!info) return;
   modules.add(graphModuleId(id));
   for (const imported of [...info.importedIds, ...info.dynamicallyImportedIds]) visit(imported);
  };
  visit(panelsEntry);
  const chunks = new Set();
  const chunkModules = new Set();
  const visitChunk = file => {
   if (chunks.has(file)) return; chunks.add(file);
   const chunk = bundle[file];
   if (!chunk || chunk.type !== 'chunk') return;
   for (const id of Object.keys(chunk.modules)) chunkModules.add(graphModuleId(id));
   for (const imported of [...chunk.imports, ...chunk.dynamicImports]) visitChunk(imported);
  };
  visitChunk('panels.js');
  this.emitFile({ type: 'asset', fileName: 'panel-graph.json', source: JSON.stringify({ codeRevision: buildRevision, modules: [...chunkModules].sort(), sourceModules: [...modules].sort() }, null, 2) });
 },
};

// Dependencies may live outside View in the containing Engine workspace.
// Keep their identity, including virtual proxies, without recording runner paths.
function graphModuleId(id) {
 const prefix = id.startsWith('\0') ? '\0' : '';
 const path = id.slice(prefix.length);
 return isAbsolute(path) ? `${prefix}<view>/${relative(viewRoot, path).replaceAll('\\', '/')}` : id;
}
