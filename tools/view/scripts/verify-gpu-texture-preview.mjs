/** Real Engine/View acceptance. View never owns a separate generator. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startViewLiveIntegration } from './workspace-fixture.mjs';
const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const checkout = resolve(engine, '../..');
const linuxBrowserLaunch = JSON.parse(await readFile(join(checkout, 'scripts/ci/browser-launch.json'), 'utf8'));
const launchOptions = {
 ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? (process.platform === 'darwin' ? 'chrome' : process.platform === 'linux' ? linuxBrowserLaunch.channel : undefined) }),
 headless: process.platform === 'darwin',
 args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-features=MacAppCodeSignClone', ...(process.platform === 'linux' ? [...linuxBrowserLaunch.args, '--use-angle=swiftshader'] : [])],
};
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? join(tmpdir(), 'forgeax-gpu-texture-view-evidence'));
const root = await mkdtemp(join(tmpdir(), 'forgeax-gpu-texture-view-'));
const array = process.env.FORGEAX_GPU_TEXTURE_ARRAY === '1';
const errors = [];
let browser, live, page;
const wait = async (predicate, label) => {
 const deadline = Date.now() + 60_000;
 while (!await predicate()) {
  if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
  await new Promise(resolve => setTimeout(resolve, 100));
 }
};
try {
 await mkdir(output, { recursive: true });
 await mkdir(join(root, 'assets'));
 await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
 await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
 await symlink(view, join(root, 'node_modules/@forgeax/view'));
 await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'gpu-texture-view-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
 await writeFile(join(root, 'forge.json'), JSON.stringify({ id: 'gpu-texture-view-proof', name: 'GPU texture proof', schemaVersion: '3.0.0', roots: {} }));
 await writeFile(join(root, 'assets/paint.wgsl'), `
#define_import_path proof::paint
struct Params { seed: u32, wear: f32, _textureLayer: u32 };
@group(0) @binding(0) var<uniform> params: Params;
struct Paint { @location(0) albedo: vec4<f32>, @location(1) orm: vec4<f32>, @location(2) height: f32 };
@fragment fn paint(@builtin(position) p: vec4<f32>) -> Paint {
 let tile = f32((u32(p.x / 8.0) + u32(p.y / 8.0) + params.seed + params._textureLayer) % 2u);
 var result: Paint;
 result.albedo = vec4<f32>(mix(vec3<f32>(0.02, 0.08, 0.4), vec3<f32>(1.0, 0.4, 0.03), tile) * (1.0 - params.wear), 1.0);
 result.orm = vec4<f32>(1.0, params.wear, 0.2, 1.0);
 result.height = tile; return result;
}`);
 await writeFile(join(root, 'assets/normal.wgsl'), `
#define_import_path proof::normal
@group(0) @binding(0) var height: texture_2d<f32>;
@fragment fn normal(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
 let size = vec2<i32>(textureDimensions(height)); let q = vec2<i32>(p.xy); let v = textureLoad(height, q, 0).r;
 let dx = textureLoad(height, (q + vec2<i32>(1, 0)) % size, 0).r - v;
 let dy = textureLoad(height, (q + vec2<i32>(0, 1)) % size, 0).r - v;
 return vec4<f32>(normalize(vec3<f32>(-dx, -dy, 1.0)) * 0.5 + 0.5, 1.0);
}`);
 await writeFile(join(root, 'assets/paint.pack.ts'), `
import { definePack, definePackageId, gpuTextureOutputs } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('01900000-0000-7000-8000-000000000010'),
 parameters: [{ name: 'seed', type: 'u32', default: 42 }, { name: 'wear', type: 'f32', default: 0.25 }],
 build: ({ packageId, values }) => {
  const shape = ${JSON.stringify(array ? { viewDimension: '2d-array', extent: { width: 64, height: 64, layers: 2 } } : { viewDimension: '2d', extent: { width: 64, height: 64 } })};
  const linear = { shape, format: 'rgba8unorm', colorSpace: 'linear', mips: { kind: 'generate' } };
  return ok(gpuTextureOutputs(packageId, 'paint', { values, inputs: {},
   outputs: { albedo: { ...linear, format: 'rgba8unorm-srgb', colorSpace: 'srgb' }, orm: linear, normal: linear },
   transient: { height: { shape, format: 'r16float' } },
   passes: [
    { kind: 'raster', program: { module: 'proof::paint', fragmentEntry: 'paint' }, reads: {}, writes: ['albedo', 'orm', 'height'] },
    { kind: 'raster', program: { module: 'proof::normal', fragmentEntry: 'normal' }, reads: { height: { kind: 'local', name: 'height' } }, writes: ['normal'] },
   ],
  }));
 },
});`);
 browser = await chromium.launch({ ...launchOptions, chromiumSandbox: true });
 page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
 page.on('pageerror', error => errors.push(error.message));
 page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
 await page.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('forgeax.view.locale', 'en'); });
 live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 120_000 } });
 let workspace = live.pageWorkspace;
 let { assets } = await workspace.listAssets({ projectId: workspace.snapshot().project.id });
 const generator = assets.find(asset => asset.kind === 'texture-generator');
 assert.ok(generator, 'Content Browser must list the generator'); assert.equal(generator.previewable, true);
 let projectId = workspace.snapshot().project.id;
 await workspace.openAsset({ projectId, guid: generator.guid });
 const preview = workspace.snapshot().previews.find(entry => entry.asset?.guid === generator.guid);
 assert.ok(preview?.target, 'Engine must publish its native target');
 const identity = { targetId: preview.target.targetId, targetGeneration: preview.target.generation };
 const get = () => workspace.invoke('preview.texture.get', identity);
 await wait(async () => (await get()).generator?.status === 'ready', 'native GPU readiness');
 const initial = await get();
 assert.equal(initial.storage, 'gpu-generated'); assert.equal(initial.sourceBytes, 0); assert.equal(initial.mipCount, 7);
 assert.deepEqual([...initial.generator.outputs].sort(), ['albedo', 'normal', 'orm']);
 await page.getByRole('combobox', { name: 'Output', exact: true }).waitFor();
 await page.getByRole('status').filter({ hasText: 'Ready · 64' }).waitFor();
 await page.screenshot({ path: join(output, 'generator-albedo.png') });
 if (array) {
  assert.equal(initial.dimension, '2d-array'); assert.equal(initial.depth, 2);
  await page.getByRole('spinbutton', { name: 'Slice', exact: true }).fill('1');
  await wait(async () => (await get()).options.layer === 1, 'GPU array layer selection');
  await page.screenshot({ path: join(output, 'generator-albedo-layer1.png') });
 }
 await page.getByRole('combobox', { name: 'Output', exact: true }).selectOption('normal');
 await wait(async () => (await get()).options.output === 'normal', 'normal selection');
 await page.screenshot({ path: join(output, 'generator-normal.png') });
 await page.getByRole('combobox', { name: 'Mip', exact: true }).selectOption('3');
 await wait(async () => (await get()).options.mip === 3, 'GPU mip selection');
 await page.screenshot({ path: join(output, 'generator-normal-mip3.png') });
 await page.getByRole('combobox', { name: 'Output', exact: true }).selectOption('orm');
 await wait(async () => (await get()).options.output === 'orm', 'ORM selection');
 const last = await get(); assert.equal(last.options.mip, 0);
 await page.screenshot({ path: join(output, 'generator-orm.png') });
 // Drive the existing Pack draft owner; pixels stay on GPU while authored defaults persist.
 const sourcePath = 'assets/paint.pack.ts';
 const draftCall = request => workspace.invoke('asset.source.draft', { projectId, targetId: identity.targetId, previewTargetId: identity.targetId, request });
 let draft = await draftCall({ action: 'open', sourcePath });
 draft = await draftCall({ action: 'edit', draftId: draft.id, field: 'wear', value: 0.75 });
 assert.equal(draft.needsGeneration, true);
 const shaderPath = join(root, 'assets/paint.wgsl');
 const shaderSource = await readFile(shaderPath, 'utf8');
 await writeFile(shaderPath, shaderSource.replace('@fragment fn paint', '@fragment fn INVALID paint'));
 await draftCall({ action: 'generate', draftId: draft.id });
 await wait(async () => {
   draft = await draftCall({ action: 'get', draftId: draft.id });
   return !draft.generating && !!draft.error;
 }, 'invalid shader candidate rejection');
 assert.equal((await get()).storage, 'gpu-generated');
 await page.screenshot({ path: join(output, 'generator-rejected-candidate.png') });
 assert.equal(await page.locator('vite-error-overlay').count(), 0, 'authored WGSL is asset data, not an immutable frontend replacement');
 await writeFile(shaderPath, shaderSource);
 draft = await draftCall({ action: 'generate', draftId: draft.id });
 await wait(async () => {
   draft = await draftCall({ action: 'get', draftId: draft.id });
   if (draft.error) throw new Error(JSON.stringify(draft.error));
   return !draft.generating && !draft.needsGeneration && draft.preview === 'ready';
 }, 'parameter generation');
 draft = await draftCall({ action: 'save', draftId: draft.id });
 assert.equal(draft.unsaved, false);
 const savedSource = await readFile(join(root, sourcePath), 'utf8');
 assert.ok(savedSource.includes('0.75'), 'Save must persist the new parameter default');
 await draftCall({ action: 'close', draftId: draft.id });
 await live.dispose(); await browser.close();
 browser = await chromium.launch({ ...launchOptions, chromiumSandbox: true });
 page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
 page.on('pageerror', error => errors.push(error.message));
 page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
 await page.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('forgeax.view.locale', 'en'); });
 live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 120_000 } });
 workspace = live.pageWorkspace; projectId = workspace.snapshot().project.id;
 ({ assets } = await workspace.listAssets({ projectId }));
 await workspace.openAsset({ projectId, guid: generator.guid });
 const reopened = workspace.snapshot().previews.find(entry => entry.asset?.guid === generator.guid); assert.ok(reopened?.target);
 const reopenedId = { targetId: reopened.target.targetId, targetGeneration: reopened.target.generation };
 const reopenedInfo = () => workspace.invoke('preview.texture.get', reopenedId);
 await wait(async () => (await reopenedInfo()).generator?.status === 'ready', 'saved generator reopening');
 const reopenedDraft = await workspace.invoke('asset.source.draft', { projectId, targetId: reopenedId.targetId, previewTargetId: reopenedId.targetId, request: { action: 'open', sourcePath } });
 assert.equal(reopenedDraft.values.wear, 0.75);
 await page.getByRole('status').filter({ hasText: 'Ready · 64' }).waitFor();
 await page.screenshot({ path: join(output, 'generator-saved-reopened.png') });
 const savedInfo = await reopenedInfo();
 const texture = assets.find(asset => asset.sourceKey === 'gpu-texture/paint/albedo'); assert.ok(texture);
 await workspace.openAsset({ projectId, guid: texture.guid });
 const ordinary = workspace.snapshot().previews.find(entry => entry.asset?.guid === texture.guid); assert.ok(ordinary?.target);
 const ordinaryId = { targetId: ordinary.target.targetId, targetGeneration: ordinary.target.generation };
 await wait(async () => (await workspace.invoke('preview.texture.get', ordinaryId)).generator?.status === 'ready', 'independent GPU result readiness');
 const textureInfo = await workspace.invoke('preview.texture.get', ordinaryId);
 assert.equal(textureInfo.kind, 'gpu-texture');
 assert.equal(textureInfo.storage, 'gpu-generated'); assert.equal(textureInfo.sourceBytes, 0);
 await page.getByRole('status').filter({ hasText: 'Ready · 64' }).waitFor();
 await page.screenshot({ path: join(output, 'gpu-texture-albedo.png') });
 await writeFile(join(output, 'evidence.json'), JSON.stringify({ root, generator: generator.guid, initial, final: last, reopened: savedInfo, savedWear: reopenedDraft.values.wear, ordinary: textureInfo, errors }, null, 2));
 assert.deepEqual(errors, []);
 console.log(JSON.stringify({ ok: true, root, output, generator: generator.guid }));
} catch (error) {
 if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
 await writeFile(join(output, 'failure.json'), JSON.stringify({ message: String(error), errors, root }, null, 2)); throw error;
} finally { await live?.dispose(); await browser?.close(); }
