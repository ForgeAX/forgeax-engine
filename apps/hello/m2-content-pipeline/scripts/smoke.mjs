#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compressZstd } from '@forgeax/engine-codec/encode';
import { decompressZstd } from '@forgeax/engine-codec';
import { reimportReuseMeta } from '@forgeax/engine-image';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { scan } from '@forgeax/engine-pack/scanner';
import { discoverPluginAssets } from '@forgeax/engine-devkit/plugin-build';
import { loadGameProjectSync } from '@forgeax/engine-project';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..', '..', '..', '..');

function fail(message) { throw new Error(`[m2-content] ${message}`); }
function expectOk(result, label) {
  if (!result.ok) fail(`${label}: ${result.error.code}`);
  return result.value;
}

const project = loadGameProjectSync((path) => readFileSync(resolve(root, 'apps/game-capability-lab', path), 'utf8'));
if (!project.ok || project.value.id !== 'game-capability-lab') fail(`project manifest rejected: ${project.ok ? project.value.id : project.error.code}`);
console.log('[m2-content] project manifest: PASS');

const projectRoot = resolve(root, 'apps/game-capability-lab');
const manifestBaseline = readFileSync(resolve(projectRoot, 'forge.json'), 'utf8');
const manifestData = JSON.parse(manifestBaseline);
const definitions = await discoverPluginAssets({ root: projectRoot, assetRoots: ['assets'] });
const baselineRoot = manifestData.roots.engine;
function resolveRoot(raw) {
  const parsed = loadGameProjectSync(() => raw);
  if (!parsed.ok) return parsed;
  const guid = parsed.value.roots.engine;
  const definition = definitions.assets.get(guid);
  return definition ? { ok: true, value: definition.definition }
    : { ok: false, error: { code: 'plugin-definition-unavailable', detail: { guid } } };
}
const baseline = expectOk(resolveRoot(manifestBaseline), 'project root baseline');
if (baseline.asset.kind !== 'plugin' || baseline.guid !== baselineRoot) fail('root is not the declared plugin asset');
const malformed = resolveRoot(JSON.stringify({ ...manifestData, roots: { engine: 'not-a-guid' } }));
if (malformed.ok) fail('malformed root GUID accepted');
const missing = resolveRoot(JSON.stringify({ ...manifestData, roots: { engine: '01900000-0000-7000-8000-000000000999' } }));
if (missing.ok || missing.error.code !== 'plugin-definition-unavailable') fail('missing root accepted');
const repaired = expectOk(resolveRoot(manifestBaseline), 'repaired project root');
if (repaired.guid !== baseline.guid || repaired.asset.program !== baseline.asset.program) fail('repair changed root definition');
console.log(`[m28-project] PASS malformed=${malformed.error.code} missing=${missing.error.code} repaired=${repaired.guid}`);

if (process.argv.includes('--m28-recovery')) process.exit(0);

const roots = [
  resolve(root, 'apps/hello/custom-importer/assets'),
  resolve(root, 'apps/hello/gltf/assets'),
  resolve(root, 'forgeax-engine-assets/learn-opengl/objects/planet'),
  resolve(root, 'forgeax-engine-assets/learn-opengl/textures/pbr/wall'),
  resolve(root, 'forgeax-engine-assets/dejavu-fonts'),
  resolve(root, 'forgeax-engine-assets/vendor/fbx-test'),
];
for (const assetRoot of roots) {
  if (!existsSync(assetRoot)) fail(`asset root missing: ${assetRoot}`);
}
const entries = expectOk(await scan(roots), 'sidecar scan');
const sidecars = entries.map((entry) => JSON.parse(readFileSync(resolve(root, entry), 'utf8')));
const importers = new Set(sidecars.map((entry) => entry.importer).filter((importer) => typeof importer === 'string'));
if (!importers.has('gltf') || !importers.has('reel-game-blob')) fail(`expected gltf + host importer entries, got ${[...importers].join(', ')}`);
const fbxEntries = sidecars.filter((entry) => entry.importer === 'fbx');
const fontPack = sidecars.find((entry) => entry.kind === 'internal-text-package' && entry.assets?.some((asset) => asset.kind === 'font'));
if (fbxEntries.length !== 2 || fontPack === undefined) fail(`expected 2 FBX sidecars + one font pack, got fbx=${fbxEntries.length}, fontPack=${fontPack !== undefined}`);
console.log(`[m2-content] sidecar scan: PASS entries=${entries.length} importers=${[...importers].sort().join(',')}`);

execFileSync('pnpm', ['--filter', '@forgeax/hello-custom-importer', 'smoke'], { cwd: root, stdio: 'inherit' });
console.log('[m2-content] host importer delivery: PASS');

execFileSync('pnpm', ['--filter', '@forgeax/hello-custom-importer', 'smoke:browser'], { cwd: root, stdio: 'inherit' });
console.log('[m2-content] browser HMR delivery: PASS');

execFileSync('pnpm', ['--filter', '@forgeax/hello-m2-content-pipeline', 'smoke:browser-catalog-recovery'], {
  cwd: root,
  stdio: 'inherit',
});
console.log('[m2-content] browser catalog recovery: PASS');

execFileSync('pnpm', ['--filter', '@forgeax/hello-m2-content-pipeline', 'smoke:source-reimport'], {
  cwd: root,
  stdio: 'inherit',
});

execFileSync('node', [resolve(here, 'real-fixtures.mjs')], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@forgeax/hello-text', 'smoke'], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@forgeax/hello-fbx-cube', 'smoke'], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@forgeax/hello-fbx-skin', 'smoke'], { cwd: root, stdio: 'inherit' });
console.log('[m2-content] font + FBX fixture delivery: PASS');

execFileSync('pnpm', ['--filter', '@forgeax/hello-m2-content-pipeline', 'smoke:browser-font'], {
  cwd: root,
  stdio: 'inherit',
});
console.log('[m2-content] browser Worker font bake: PASS');

const fontCliPath = resolve(root, 'packages/font/dist/cli-font.mjs');
const fontSourcePath = resolve(root, 'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.ttf');
const nodeFontOutput = resolve(root, '.forgeax-gauntlet/hello-m2-content-pipeline/node-font-worker');
mkdirSync(nodeFontOutput, { recursive: true });
const invalidFontPath = resolve(nodeFontOutput, 'invalid.woff2');
writeFileSync(invalidFontPath, Buffer.from('wOF2\u0000\u0000\u0000\u0000'));
let invalidFontStderr = '';
try {
  execFileSync('node', [fontCliPath, 'bake', invalidFontPath, nodeFontOutput], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  invalidFontStderr = String(error.stderr ?? '');
}
let invalidFontFailure;
try {
  invalidFontFailure = JSON.parse(invalidFontStderr.trim());
} catch {
  fail(`plain-Node invalid font did not return structured JSON: ${invalidFontStderr}`);
}
if (invalidFontFailure.code !== 'unsupported-font-format' || invalidFontFailure.expected !== 'ttf') {
  fail(`plain-Node invalid font returned ${invalidFontStderr}`);
}
execFileSync('node', [fontCliPath, 'bake', fontSourcePath, nodeFontOutput], {
  cwd: root,
  stdio: 'inherit',
});
const nodeFontAtlas = resolve(nodeFontOutput, 'DejaVuSansMono.atlas.png');
const nodeFontSidecar = resolve(nodeFontOutput, 'DejaVuSansMono.meta.json');
const nodeFontSidecarData = JSON.parse(readFileSync(nodeFontSidecar, 'utf8'));
const nodeFontGlyphs = Object.keys(nodeFontSidecarData.glyphs ?? {});
if (!existsSync(nodeFontAtlas) || readFileSync(nodeFontAtlas)[0] !== 0x89) {
  fail('plain-Node font bake emitted no PNG atlas');
}
if (nodeFontSidecarData.common?.atlasWidth !== 1024 || nodeFontGlyphs.length <= 90) {
  fail(`plain-Node font bake emitted invalid sidecar glyphs=${nodeFontGlyphs.length}`);
}
console.log(`[m2-content] plain Node font bake + structured recovery: PASS glyphs=${nodeFontGlyphs.length}`);

const imageMetaPath = resolve(root, 'forgeax-engine-assets/learn-opengl/objects/planet/mars.png.meta.json');
const imageMeta = JSON.parse(readFileSync(imageMetaPath, 'utf8'));
const stableGuid = imageMeta.subAssets[0]?.guid;
if (typeof stableGuid !== 'string') fail('image sidecar has no stable texture GUID');
const decoded = { bytes: new Uint8Array([137, 80, 78, 71]), width: 1, height: 1, mime: 'image/png', colorSpace: 'srgb', mipmap: true };
const reused = reimportReuseMeta(imageMeta);
if (reused[0]?.guid !== stableGuid) fail(`reimport changed GUID: ${reused[0]?.guid}`);
const parsedGuid = AssetGuid.parse(stableGuid);
if (!parsedGuid.ok) fail(`stable GUID is malformed: ${parsedGuid.error.code}`);
const malformedGuid = AssetGuid.parse('not-a-guid');
if (malformedGuid.ok || malformedGuid.error.code !== 'pack-guid-malformed') fail('malformed GUID did not reject structurally');
console.log(`[m2-content] GUID reimport: PASS stable=${stableGuid} malformed=${malformedGuid.error.code}`);

const original = new Uint8Array(4096).fill(65);
const compressed = expectOk(await compressZstd(original), 'zstd encode');
const restored = expectOk(await decompressZstd(compressed), 'zstd decode');
if (restored.length !== original.length || restored.some((value, index) => value !== original[index])) fail('codec bytes changed after round-trip');
console.log(`[m2-content] codec round-trip: PASS original=${original.length} compressed=${compressed.length}`);

console.log('[m2-content] PASS - M2 partial content pipeline gates GREEN');
