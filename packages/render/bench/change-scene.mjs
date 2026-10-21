/** Isolated source-owner diagnostic; timings are not rendered/Worker performance evidence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkout = resolve(process.argv[2] ?? '.');
const output = resolve(process.argv[3] ?? '/tmp/forgeax-change-scene.json');
const mode = process.argv[4] ?? 'locality';
assert(['locality', 'retention'].includes(mode), 'Mode must be locality or retention');
if (mode === 'retention') assert.equal(typeof global.gc, 'function', 'Use node --expose-gc for retention');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(realpathSync(join(checkout, 'node_modules/vite/package.json')));
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
const entry = [
  "export { RenderScene } from './packages/render/src/scene/render-scene.ts';",
  "export { MaterialResource } from './packages/render/src/material-resource.ts';",
  "export { defaultMaterialSnapshot } from './packages/render/src/render-system-extract.ts';",
  "export { createBoxGeometry } from '@forgeax/engine-geometry';",
  "export { MaterialFrame } from './packages/render/src/scene/material-dispatch.ts';",
].join('\n');
const built = await build({
  absWorkingDir: checkout,
  stdin: { contents: entry, resolveDir: checkout, sourcefile: 'change-scene-entry.ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: `node${process.versions.node.split('.')[0]}`,
  packages: 'external',
  write: false,
  metafile: true,
});
const sourceInventory = Object.keys(built.metafile.inputs)
  .filter((file) => !file.endsWith('change-scene-entry.ts'))
  .sort()
  .map((file) => ({ path: file, sha256: sha(readFileSync(resolve(checkout, file))) }));
const bundleSha256 = sha(built.outputFiles[0].contents);
// Resolve external workspace packages through the Render owner's installed closure.
const generated = join(checkout, 'packages/render/node_modules/.cache/change-scene', `${bundleSha256}.mjs`);
mkdirSync(dirname(generated), { recursive: true });
writeFileSync(generated, built.outputFiles[0].contents);
const { RenderScene, MaterialResource, defaultMaterialSnapshot, MaterialFrame, createBoxGeometry } = await import(pathToFileURL(generated).href);
const material = new MaterialResource(defaultMaterialSnapshot());
const materials = new MaterialFrame(undefined).with(material);
function source(entityKey, x = 0) {
  return {
    worldId: 0, entityKey, assetHandle: 1, material,
    materials: [material], materialBindingSources: ['engine-default'],
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]) },
  };
}
function distribution(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1), samples };
}
const rows = [];
for (const count of [1000, 10000, 100000]) {
  const scene = new RenderScene();
  const coldStart = performance.now();
  scene.reset(Array.from({ length: count }, (_, entity) => source(entity)));
  scene.materialize();
  const coldMs = performance.now() - coldStart;
  const world = source(0).transform.world;
  const entityKey = Math.floor(count / 2);
  const before = scene.slotsSnapshot();
  const samples = [];
  for (let step = 0; step < 160; step++) {
    world[12] = step + 1;
    const start = performance.now();
    scene.apply([{ kind: 'update', worldId: 0, entityKey, world }]);
    const frame = scene.materialize();
    const elapsed = performance.now() - start;
    assert.equal(frame.at(entityKey)?.transform.world[12], step + 1);
    if (step >= 40) samples.push(elapsed);
  }
  // This intrusive work counter is separate from the timed phase. It detects
  // snapshot expansion even if a future implementation avoids the iterator.
  let captureReads = 0;
  const track = (row) => {
    const snapshot = row.snapshot;
    Object.defineProperty(row, 'snapshot', {
      configurable: true,
      get() { captureReads++; return snapshot; },
    });
  };
  for (const row of scene.slotsSnapshot()) track(row);
  world[12] = 1000;
  scene.apply([{ kind: 'update', worldId: 0, entityKey, world }]);
  track(scene.slot(0, entityKey));
  captureReads = 0;
  scene.materialize();
  const captureSnapshotReads = captureReads;
  const addresses = new Map([...scene.slotsSnapshot()].map((row) => [row.entityKey, [row.slot, row.generation]]));
  scene.apply([{ kind: 'remove', worldId: 0, entityKey }]);
  const removed = scene.slotsSnapshot();
  for (const row of removed) assert.deepEqual([row.slot, row.generation], addresses.get(row.entityKey));
  assert.equal(removed.length, count - 1);
  assert.equal(before.at(entityKey)?.snapshot.transform.world[12], 0);
  const storage = scene.slots;
  rows.push({ count, coldMs, captureSnapshotReads, sparseApplyAndCaptureMs: distribution(samples),
    survivingAddressesUnchanged: removed.length,
    storage: typeof storage.inspect === 'function' ? storage.inspect() : { representation: 'baseline array' } });
}
const turn = () => new Promise((done) => setImmediate(done));
async function collect() {
  for (let attempt = 0; attempt < 5; attempt++) { await turn(); global.gc(); }
  await turn();
}
function retainedView(kind) {
  let scene = new RenderScene();
  scene.setTemporalTracking(true);
  scene.reset(Array.from({ length: 1000 }, (_, entity) => source(entity)));
  scene.commitSubmission(scene.captureSubmission(scene.materialize()));
  scene.apply([{ kind: 'update', worldId: 0, entityKey: 0, world: source(0, 2).transform.world }]);
  const weak = new WeakRef(scene);
  const view = kind === 'raw' ? scene.materialize() : kind === 'temporal'
    ? scene.materializeTemporal({ hits: 0, misses: 0 }, materials) : scene.drawFrame(materials);
  scene = undefined;
  return { weak, view };
}
function disabledOwner() {
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  scene.reset([source(0, 1)]);
  scene.commitSubmission(scene.captureSubmission(scene.materialize()));
  const previous = scene.lastSubmittedSlotByIndex(0).snapshot;
  const weakPrevious = new WeakRef(previous);
  const weakPreviousWorld = new WeakRef(previous.transform.world);
  scene.apply([{ kind: 'update', worldId: 0, entityKey: 0, world: source(0, 2).transform.world }]);
  scene.materializeTemporal({ hits: 0, misses: 0 }, materials).at(0);
  scene.setTemporalTracking(false);
  return { scene, weakPrevious, weakPreviousWorld };
}
function coldBoundsOwner() {
  const scene = new RenderScene();
  scene.reset([source(1)]);
  scene.adoptMesh(0, 1, createBoxGeometry(1, 1, 1).unwrap());
  const weakGeometry = new WeakRef(scene.meshFrame().get(0, 1));
  const bounds = scene.cullingWorldBoundsAt(scene.slot(0, 1), scene.meshFrame(), materials);
  assert.equal(bounds.min[0], -0.5);
  scene.adoptMesh(0, 1, createBoxGeometry(2, 2, 2).unwrap());
  return { scene, weakGeometry };
}
const lifetime = [];
let disabledTemporalPreviousReleased, disabledTemporalWorldReleased, coldBoundsGeometryReleased;
if (mode === 'retention') {
  for (const kind of ['raw', 'temporal', 'draw']) {
    const kept = retainedView(kind);
    await collect();
    const ownerReleased = kept.weak.deref() === undefined;
    const value = kind === 'draw' ? kept.view(0) : kept.view.at(0);
    assert.equal(value?.transform.world[12], 2);
    lifetime.push({ kind, ownerReleased, retainedViewStillReadable: true });
  }
  const coldBounds = coldBoundsOwner();
  await collect();
  coldBoundsGeometryReleased = coldBounds.weakGeometry.deref() === undefined;
  assert.equal(coldBounds.scene.recordCount, 1);
  const disabled = disabledOwner();
  await collect();
  disabledTemporalPreviousReleased = disabled.weakPrevious.deref() === undefined;
  disabledTemporalWorldReleased = disabled.weakPreviousWorld.deref() === undefined;
  assert.equal(disabled.scene.materialize().at(0)?.transform.world[12], 2);
}
const report = {
  kind: 'Source-built RenderScene CPU locality / forced-GC reachability diagnostic',
  scope: 'No World, transport, GPU, natural-GC or net rendered inference. Installed package closure remains external.',
  node: process.version, checkout, mode, bundleSha256, entrySha256: sha(entry),
  runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), sourceInventory,
  rows, lifetime, disabledTemporalPreviousReleased, disabledTemporalWorldReleased, coldBoundsGeometryReleased, finishedAt: new Date().toISOString(),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
// Preserve the failing receipt before rejecting a retirement result.
for (const result of lifetime) assert(result.ownerReleased, `Retained ${result.kind} view pins the mutable owner`);
if (mode === 'retention') {
  assert(coldBoundsGeometryReleased, 'Cold bounds cache pins an obsolete Mesh version');
  assert(disabledTemporalPreviousReleased, 'Disabled owner pins its previous temporal payload');
  assert(disabledTemporalWorldReleased, 'Disabled owner pins its previous matrix backing view');
}
process.stdout.write(`${JSON.stringify({ output, captureReads: rows.map(({ count, captureSnapshotReads }) => ({ count, captureSnapshotReads })), lifetime, disabledTemporalPreviousReleased, disabledTemporalWorldReleased, coldBoundsGeometryReleased })}\n`);
