import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { quat } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import { terrainDerivedClosureValid } from '@forgeax/engine-terrain';
import { derive, projectMaterialParameterSchema } from '@forgeax/engine-types';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { materialTerrainGuid } from '../src/identity.ts';
import { writeReferencePng, readReferencePng } from '../../../shared/png-codec.mjs';
import { terrainHarness } from './harness.mjs';

const mode = process.argv[2] ?? 'effects';
assert(['effects', 'perf'].includes(mode));
const dir = resolve(
  import.meta.dirname,
  process.env.TERRAIN_ID_ARTIFACT_DIR ?? '../.forgeax-debug/material-id',
);
mkdirSync(dir, { recursive: true });
const percentile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)];
const stats = (xs) => ({
  median: percentile(xs, 0.5),
  p95: percentile(xs, 0.95),
  peak: Math.max(...xs),
  samples: xs,
});
const difference = (a, b) => {
  assert.equal(a.length, b.length);
  let peak = 0,
    sum = 0,
    changed = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    peak = Math.max(peak, delta);
    sum += delta;
    if (delta > 2) changed++;
  }
  return {
    peakByteDifference: peak,
    meanByteDifference: sum / a.length,
    channelsOutsideTwoBytes: changed,
  };
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const camera = (h, moving = false, frame = 59) => {
  const eye = moving
    ? [20 + 8 * Math.sin(frame * 0.05), 30, 135 + 5 * Math.cos(frame * 0.05)]
    : [20, 30, 135];
  h.app.world
    .set(h.subjects.camera, Transform, {
      pos: eye,
      quat: quat.fromLookAt(quat.create(), eye, [62, 0, 60], [0, 1, 0]),
    })
    .unwrap();
};
function inventory(h, encoding) {
  const root = h.app.world.sharedRefs
    .resolve(h.app.world.get(h.subjects.terrain, Terrain).unwrap().asset)
    .unwrap();
  const rootGuid = AssetGuid.format(materialTerrainGuid(encoding));
  assert.equal(
    h.app.assets.lookup(rootGuid),
    root,
    'loaded root identity must equal the selected production GUID',
  );
  assert.equal(root.materialEncoding.kind, encoding);
  const sourceDescriptor = {
    columns: root.columns,
    rows: root.rows,
    spacing: root.spacing,
    subsectionVertices: root.subsectionVertices,
    layers: root.layers,
  };
  const authorHeightSha256 = hash(
    new Uint8Array(root.heights.buffer, root.heights.byteOffset, root.heights.byteLength),
  );
  const authorWeightSha256 = hash(
    new Uint8Array(root.weights.buffer, root.weights.byteOffset, root.weights.byteLength),
  );
  const sourceSha256 = hash(
    JSON.stringify({ ...sourceDescriptor, authorHeightSha256, authorWeightSha256 }),
  );
  const queue = [
    ...root.grids,
    ...root.layers.map((l) => l.material),
    ...root.sections.flatMap((s) => [s.heightTexture, s.weightTexture, s.material]),
  ];
  const closure = new Map();
  while (queue.length) {
    const guid = queue.pop();
    if (closure.has(guid)) continue;
    const asset = h.app.assets.lookup(guid);
    assert(asset, `missing actual closure ${guid}`);
    closure.set(guid, asset);
    for (const ref of h.app.assets.assetCatalog.get(guid)?.refs ?? []) queue.push(ref.guid);
  }
  assert(
    terrainDerivedClosureValid(root, closure),
    'loaded full production closure must retain author byte invariants',
  );
  const arrays = [...closure].filter(
    ([, a]) => a.kind === 'texture' && a.shape.viewDimension === '2d-array',
  );
  const controls = root.sections.map((s) => h.app.assets.lookup(s.weightTexture));
  const heights = root.sections.map((s) => h.app.assets.lookup(s.heightTexture));
  const authors = Object.fromEntries(
    [...closure].filter(
      ([guid]) =>
        root.layers.some((l) => l.material === guid) ||
        root.layers.some((l) =>
          (h.app.assets.assetCatalog.get(l.material)?.refs ?? []).some((r) => r.guid === guid),
        ),
    ),
  );
  const cooking = [],
    admission = [];
  for (let i = 0; i < 6; i++) {
    let start = performance.now();
    const built = buildTerrainAssets(root, (key) => key, authors, root.materialEncoding).unwrap();
    const cookMs = performance.now() - start;
    start = performance.now();
    assert(
      terrainDerivedClosureValid(built.terrain, new Map(Object.entries({ ...authors, ...built }))),
    );
    if (i > 0) {
      cooking.push(cookMs);
      admission.push(performance.now() - start);
    }
  }
  return {
    root,
    closure,
    report: {
      rootGuid,
      encoding: root.materialEncoding,
      sourceDescriptor,
      authorHeightSha256,
      sourceSha256,
      authorHeightBytes: root.heights.byteLength,
      authorWeightBytes: root.weights.byteLength,
      authorDataSha256: hash(
        new Uint8Array(root.weights.buffer, root.weights.byteOffset, root.weights.byteLength),
      ),
      authorLayerCount: root.layers.length,
      sectionCount: root.sections.length,
      arrayCount: arrays.length,
      arrayBytes: arrays.reduce((s, [, a]) => s + a.data.byteLength, 0),
      controlBytes: controls.reduce((s, a) => s + a.data.byteLength, 0),
      heightBytes: heights.reduce((s, a) => s + a.data.byteLength, 0),
      controlMips: controls.map((a) => a.mips),
      cookMs: stats(cooking),
      admissionMs: stats(admission),
    },
  };
}
async function capture(h, recorder, encoding, renderPath, root, caseName) {
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  await h.frame();
  (await recorder.frameBoundary()).unwrap();
  const artifact = (await pending).unwrap();
  const name = caseName ?? `${renderPath}-${encoding}-auto`;
  writeFileSync(resolve(dir, `${name}.rhitape`), artifact.bytes);
  const live = await h.pixels();
  writeFileSync(resolve(dir, `${name}-capture.png`), writeReferencePng(live, 960, 540));
  const tape = decodeTape(artifact.bytes).unwrap(),
    model = buildFrameModel(tape);
  const blobs = new Map(tape.blobs.map((b) => [b.hash, b.bytes]));
  const resource = (id) => {
    const r = tape.bootstrap.find((r) => r.handleId === id);
    assert(r, `missing captured resource ${id}`);
    return r;
  };
  const sourceBytes = (row) => {
    const chunks = (row.initialData ?? []).map((d) => blobs.get(d.hash).subarray(0, d.byteLength));
    return Buffer.concat(chunks);
  };
  const material = h.app.assets.lookup(root.sections[0].material);
  const abi = derive(
    projectMaterialParameterSchema(
      material.parameters,
      root.sections[0].material,
      'runtime',
    ).unwrap(),
  );
  const bindings = new Map(abi.resourceBindings.map((b) => [b.name, b.binding]));
  const fields = new Map(abi.uboLayout.entries.map((f) => [f.name, f.offset]));
  const rows = [],
    arrayIds = new Set(),
    levels = new Set(),
    colorSections = new Set();
  for (const work of model.works.filter((w) =>
    w.pipeline.shaders.some((s) => s.source?.includes('fn terrainDecodeHeight')),
  )) {
    const bound = (name) => {
      const binding = work.bindings.find(
        (b) => b.groupIndex === 1 && b.binding === bindings.get(name),
      );
      assert(binding, name);
      return resource(resource(binding.resourceId).create.sourceHandleId);
    };
    const control = bound('terrainWeightTexture');
    const controlBytes = sourceBytes(control);

    assert.equal(control.create.desc.mipLevelCount, encoding === 'ids' ? 1 : 7);
    const uniform = work.bindings.find((b) => b.groupIndex === 1 && b.binding === 0);
    const uniformRow = resource(uniform.resourceId),
      bytes = new Uint8Array(uniformRow.create.desc.size);
    for (const d of uniformRow.initialData ?? [])
      bytes.set(blobs.get(d.hash).subarray(0, d.byteLength), d.byteOffset);
    for (const event of tape.events.slice(0, work.eventIndex + 1))
      if (event.kind === 'writeBuffer' && event.handleId === uniform.resourceId)
        bytes.set(blobs.get(event.dataHash).subarray(0, event.size), event.bufferOffset);
    const base = (uniform.bufferOffset ?? 0) + (uniform.dynamicOffset ?? 0);
    const field = (name) => Array.from(new Float32Array(bytes.buffer, base + fields.get(name), 4));
    const lod = field('terrainLod'),
      section = field('terrainSection'),
      neighbors = field('terrainNeighbors');
    const sectionIndex = root.sections.findIndex((s) => s.x === section[0] && s.z === section[1]);
    assert(sectionIndex >= 0, 'actual uniform must identify a canonical section');
    assert(
      Buffer.from(h.app.assets.lookup(root.sections[sectionIndex].weightTexture).data).equals(
        controlBytes,
      ),
      'captured control must equal its own admitted section payload',
    );
    const color = work.pipeline.shaders.some(
      (s) =>
        s.stage === 'fragment' &&
        (renderPath === 'forward'
          ? ['fs_main', 'fs_opaque'].includes(s.entryPoint)
          : s.entryPoint === 'fs_gbuffer'),
    );
    if (color) {
      colorSections.add(sectionIndex);
      levels.add(lod[0]);
    }
    const arrays = [
      'terrainColorLayers',
      'terrainNormalHeightLayers',
      'terrainOrmLayers',
      'terrainEmissionLayers',
    ].map((name) => bound(name));
    arrays.forEach((a) => arrayIds.add(a.handleId));
    if (encoding === 'ids' && color)
      assert(
        work.pipeline.shaders.some(
          (s) =>
            s.stage === 'fragment' &&
            s.source?.includes('pairWeights') &&
            s.source.includes('textureLoad(terrainWeightTexture'),
        ),
        'actual compact fragment program must execute',
      );
    rows.push({
      workIndex: work.workIndex,
      sectionIndex,
      color,
      section,
      lod,
      neighbors,
      controlResource: control.handleId,
      controlSha256: hash(controlBytes),
      arrayResources: arrays.map((a) => a.handleId),
    });
  }
  assert.equal(
    colorSections.size,
    root.sections.length,
    'each canonical section must appear in the actual color path; shadow draws do not count',
  );
  if (encoding === 'ids')
    assert.equal(arrayIds.size, 4, 'all section draws must bind exactly one shared array set');
  const adapter = (await backend.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  let replay;
  let comparison;
  try {
    replay = (await openReplay(tape, { device, createShaderModule: backend.createShaderModule })).unwrap();
    const read = (await replay.inspectWork(model.works.at(-1).workIndex, ['pixels'])).unwrap()
      .attachment;
    assert(read?.bytes && read.width === 960 && read.height === 540);
    const pixels = read.bytes.slice();
    if (read.format.startsWith('bgra'))
      for (let i = 0; i < pixels.length; i += 4)
        [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
    comparison = difference(live, pixels);
    writeFileSync(resolve(dir, `${name}-replay.png`), writeReferencePng(pixels, 960, 540));
    assert(
      comparison.peakByteDifference <= 2,
      'fresh unmodified replay must reproduce actual live output',
    );
  } finally {
    try {
      if (replay !== undefined) (await replay.dispose()).unwrap();
    } finally {
      device.nativeDevice().unwrap().destroy();
    }
  }
  const report = {
    digest: artifact.digest,
    byteLength: artifact.byteLength,
    unseededResources: model.unseededResources,
    replayComparison: comparison,
    distinctArrayResources: arrayIds.size,
    colorSections: [...colorSections],
    geometryLods: [...levels],
    rows,
  };
  writeFileSync(resolve(dir, `${name}-inspection.json`), JSON.stringify(report, null, 2));
  return report;
}
const report = {
  schemaVersion: 1,
  mode,
  resolution: [960, 540],
  backend: 'Dawn Metal',
  warmupFrames: mode === 'perf' ? 60 : 0,
  measuredFrames: 60,
  nativeOuterGpuTiming: {
    status: 'unavailable',
    reason:
      'Native outer interval is not exposed; pass coverage and observed frame completion remain separate.',
  },
  budgets: { gpuIntervalUnionP95Ms: 16.67, cpuDrawP95Ms: 8, frameToCompletedP95Ms: 33.34 },
  cases: [],
  comparisons: [],
};
try {
  for (const renderPath of ['forward', 'deferred']) {
    const sequence =
      mode === 'effects'
        ? ['weights', 'ids']
        : Array.from({ length: 3 }, () => ['weights', 'ids', 'ids', 'weights']).flat();
    for (const [run, encoding] of sequence.entries()) {
      const recorder = mode === 'effects' ? attachRecorder(backend).unwrap() : undefined;
      const start = performance.now();
      const h = await terrainHarness({
        width: 960,
        height: 540,
        backendArgs: ['backend=metal'],
        rootGuid: materialTerrainGuid(encoding),
        appOptions: {
          standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath },
          ...(recorder ? { rhi: recorder.backend.rhi } : {}),
        },
      });
      const startupMs = performance.now() - start;
      try {
        h.app.world.set(h.subjects.terrain, Terrain, { lod0Diameter: 2 }).unwrap();
        const inv = mode === 'effects' ? inventory(h, encoding) : undefined;
        const scenarios =
          mode === 'effects'
            ? [
                { lod: 0, moving: false },
                { lod: -1, moving: false },
                { lod: 2, moving: false },
                { lod: -1, moving: true },
              ]
            : [{ lod: -1, moving: true }];
        for (const scenario of scenarios) {
          h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: scenario.lod }).unwrap();
          const cpu = [],
            completion = [],
            gpuSum = [],
            gpuUnion = [],
            gpuOverlap = [],
            gpuEnvelope = [],
            rawTimings = [],
            drawDiagnostics = [];
          let receipt;
          const count = mode === 'effects' ? 60 : 120;
          for (let frame = 0; frame < count; frame++) {
            camera(h, scenario.moving, frame % 60);
            const r = await h.frame();
            receipt = r.receipt;
            if (mode === 'perf' && frame >= 60) {
              cpu.push(r.cpuMs);
              completion.push(r.frameToCompletedMs);
              if (r.drawDiagnostics) drawDiagnostics.push(r.drawDiagnostics);
              const observed = (
                await h.app.renderer.observe(receipt, { include: ['timings'] })
              ).unwrap().timings;
              assert.equal(observed.status, 'complete');
              const timing = observed.frame;
              assert.equal(timing.frameId, receipt.frameId);
              assert.equal(timing.droppedPassCount, 0);
              assert.equal(timing.measuredPassCount, timing.executedPassCount);
              const coverage = summarizeGpuPassTimingIntervals(
                timing.passes,
                timing.timestampPeriodNanoseconds,
              ).unwrap();
              gpuSum.push(coverage.sumNanoseconds / 1e6);
              gpuUnion.push(coverage.unionNanoseconds / 1e6);
              gpuOverlap.push(coverage.overlapNanoseconds / 1e6);
              const intervals = timing.passes.filter((p) => p.status === 'measured');
              assert(intervals.length > 0);
              const ticks = intervals.flatMap((p) => [BigInt(p.beginningTick), BigInt(p.endTick)]);
              gpuEnvelope.push(
                (Number(
                  ticks.reduce((a, b) => (a > b ? a : b)) - ticks.reduce((a, b) => (a < b ? a : b)),
                ) *
                  timing.timestampPeriodNanoseconds) /
                  1e6,
              );
              rawTimings.push(timing);
            }
          }
          const name = `${renderPath}-${encoding}-${scenario.moving ? 'moving' : 'static'}-${scenario.lod < 0 ? 'auto' : `lod${scenario.lod}`}`;
          const pixels = await h.pixels(),
            verified = await h.verify(receipt);
          writeFileSync(
            resolve(dir, `${name}${mode === 'perf' ? `-${run}` : ''}.png`),
            writeReferencePng(pixels, 960, 540),
          );
          const entry = {
            renderPath,
            encoding,
            run,
            ...scenario,
            startupMs,
            adapter: h.shim.adapterInfo,
            completedFrames: count,
            verification: verified,
            ...(inv ? { inventory: inv.report } : {}),
            ...(mode === 'perf'
              ? {
                  cpuDrawMs: stats(cpu),
                  frameToCompletedMs: stats(completion),
                  gpuPassSumMs: stats(gpuSum),
                  gpuIntervalUnionMs: stats(gpuUnion),
                  gpuDuplicatedOverlapMs: stats(gpuOverlap),
                  gpuMeasuredEnvelopeMs: stats(gpuEnvelope),
                  rawTimings,
                  ...(drawDiagnostics.length ? { drawDiagnostics } : {}),
                }
              : {}),
          };
          if (recorder && !scenario.moving && (scenario.lod === -1 || scenario.lod === 0))
            entry.capture = await capture(
              h,
              recorder,
              encoding,
              renderPath,
              inv.root,
              `${name}-proof`,
            );
          if (mode === 'effects' && encoding === 'ids') {
            const ref = readReferencePng(resolve(dir, name.replace('-ids-', '-weights-') + '.png'));
            const baseline = report.cases.find(
              (c) =>
                c.renderPath === renderPath &&
                c.encoding === 'weights' &&
                c.lod === scenario.lod &&
                c.moving === scenario.moving,
            );
            assert.equal(
              inv.report.sourceSha256,
              baseline.inventory.sourceSha256,
              'paired images must have the same complete loaded author source',
            );
            const comparison = difference(ref.pixels, pixels);
            report.comparisons.push({ name, ...comparison });
            const diff = Uint8Array.from(pixels, (_, i) =>
              i % 4 === 3 ? 255 : Math.min(255, Math.abs(pixels[i] - ref.pixels[i]) * 32),
            );
            writeFileSync(resolve(dir, `${name}-diff-x32.png`), writeReferencePng(diff, 960, 540));
            if (comparison.peakByteDifference > 2 && recorder) {
              entry.capture = await capture(
                h,
                recorder,
                encoding,
                renderPath,
                inv.root,
                `${name}-failed`,
              );
              report.cases.push(entry);
            }
            assert(
              comparison.peakByteDifference <= 2,
              'paired material specialization must meet the existing two-byte visual tolerance',
            );
          }
          report.cases.push(entry);
          writeFileSync(resolve(dir, `${mode}-report.json`), JSON.stringify(report, null, 2));
          console.log(
            JSON.stringify({
              mode,
              name,
              run,
              ...(mode === 'perf'
                ? {
                    cpuP95: entry.cpuDrawMs.p95,
                    gpuUnionP95: entry.gpuIntervalUnionMs.p95,
                    completionP95: entry.frameToCompletedMs.p95,
                  }
                : { capture: entry.capture?.digest }),
            }),
          );
        }
      } finally {
        await h.dispose();
        if (recorder) (await recorder.dispose()).unwrap();
      }
    }
  }
  report.failures =
    mode === 'perf'
      ? report.cases.flatMap((c) => [
          ...(c.cpuDrawMs.p95 > 8 ? [`${c.renderPath}/${c.encoding}/${c.run}: CPU draw`] : []),
          ...(c.gpuIntervalUnionMs.p95 > 16.67
            ? [`${c.renderPath}/${c.encoding}/${c.run}: GPU union`]
            : []),
          ...(c.frameToCompletedMs.p95 > 33.34
            ? [`${c.renderPath}/${c.encoding}/${c.run}: frame completion`]
            : []),
        ])
      : [];
  report.status = report.failures.length ? 'FAIL' : 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  writeFileSync(resolve(dir, `${mode}-report.json`), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.failures, [], 'original performance budgets remain mandatory');
process.exit(0);
