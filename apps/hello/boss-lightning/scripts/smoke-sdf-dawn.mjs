import { encodePng } from '@forgeax/engine-image/png';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleRuntimePacks, createAssetRuntimeAssembly } from '@forgeax/engine-app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { Camera, CameraView, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  imageStats,
  openReplay,
  readbackImage,
  replayDeviceRequest,
  tapeDigest,
  toRgba8,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { GlobalTransform, scenePlugin, Transform } from '@forgeax/engine-scene';
import {
  createParticleEffectInstance,
  createVfxEffectContract,
  loadVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VFX_PARTICLE_CORE_LAYOUT,
  vfxParticleCoreField,
} from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { teardownDawnInstance } from '../../../../scripts/lib/dawn-teardown.mjs';

import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import cases from '../src/sdf-cases.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const output = resolve(process.env.FORGEAX_VFX_SDF_EVIDENCE ?? resolve(here, '../artifacts/sdf'));
const width = 200,
  height = 150;
const packageId = definePackageId('019fcaf0-0015-7000-8000-000000000001');
const guid = (key) => AssetGuid.format(AssetGuid.derive(packageId, key));
const unwrap = (result) => {
  if (!result.ok) throw result.error;
  return result.value;
};
assert(existsSync(resolve(dist, 'pack-index.json')), 'Build boss-lightning before SDF smoke');
mkdirSync(output, { recursive: true });
const originalFetch = globalThis.fetch;
const originalGpu = globalThis.navigator?.gpu;
globalThis.fetch = async (request) => {
  const url = new URL(typeof request === 'string' ? request : request.url, 'http://127.0.0.1');
  if (url.hostname === '127.0.0.1') {
    const path = resolve(dist, url.pathname.slice(1));
    assert(path.startsWith(`${dist}/`));
    if (existsSync(path)) return new Response(readFileSync(path));
  }
  return originalFetch(request);
};
const manifest = JSON.parse(readFileSync(resolve(dist, 'shaders/manifest.json'), 'utf8'));
const scenario = cases.find((item) => item.id === (process.env.FORGEAX_SDF_CASE ?? 'default'));
assert(scenario, 'Select a declared SDF case');
const diagnostic = process.env.FORGEAX_SDF_DIAGNOSTICS === '1';
const lifecycle = process.env.FORGEAX_SDF_LIFECYCLE;
if (lifecycle === 'world-rebuild')
  assert.equal(scenario.id, 'default', 'World replacement uses the ordinary floor/wall pair');
if (lifecycle !== undefined) {
  assert(
    [
      'player-destroy',
      'source-replace',
      'world-detach',
      'world-rebuild',
      'fixed-ticks',
      'missing-field',
      'multi-view',
      'remove-wall',
      'same-guid-republication',
      'depth-only-falsifier',
    ].includes(lifecycle),
  );
  assert.equal(scenario.id, lifecycle === 'depth-only-falsifier' ? 'off-frustum' : 'default');
  if (lifecycle === 'remove-wall')
    assert(diagnostic, 'Removal negative control records the original bounded sample evidence');
}
const benchmarkCapacity =
  process.env.FORGEAX_SDF_BENCH_CAPACITY === undefined
    ? undefined
    : Number(process.env.FORGEAX_SDF_BENCH_CAPACITY);
if (benchmarkCapacity !== undefined)
  assert([10_000, 100_000, 1_000_000].includes(benchmarkCapacity));
assert(
  !(diagnostic && benchmarkCapacity !== undefined),
  'Performance runs disable particle diagnostics',
);
assert(
  !(lifecycle !== undefined && benchmarkCapacity !== undefined),
  'Lifecycle probes retain the ordinary 1024-particle path',
);
const frameLimit = benchmarkCapacity === undefined ? smokeFrameBudget() : 90;
let prepared;
const preparedSnapshot = (row) => {
  const bytes = readFileSync(resolve(process.env.FORGEAX_SDF_PREPARED, row.file));
  assert.equal(bytes.length, row.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
  return JSON.parse(bytes);
};
if (lifecycle === 'same-guid-republication' || lifecycle === 'depth-only-falsifier') {
  assert(process.env.FORGEAX_SDF_PREPARED, 'Prepare lifecycle snapshots outside the GPU lease');
  prepared = JSON.parse(readFileSync(resolve(process.env.FORGEAX_SDF_PREPARED, 'manifest.json')));
}
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const distribution = (values) => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
function intervals(frame) {
  const values = frame.passes
    .filter((pass) => pass.status === 'measured')
    .map((pass) => ({
      begin: BigInt(pass.beginningTick),
      end: BigInt(pass.endTick),
      name: pass.passName,
    }))
    .sort((a, b) => (a.begin < b.begin ? -1 : a.begin > b.begin ? 1 : 0));
  let sum = 0n,
    union = 0n,
    begin,
    end;
  for (const value of values) {
    sum += value.end - value.begin;
    if (begin === undefined) {
      begin = value.begin;
      end = value.end;
    } else if (value.begin <= end) {
      if (value.end > end) end = value.end;
    } else {
      union += end - begin;
      begin = value.begin;
      end = value.end;
    }
  }
  if (begin !== undefined) union += end - begin;
  const ms = (ticks) => (Number(ticks) * frame.timestampPeriodNanoseconds) / 1e6;
  const envelope =
    values.length === 0
      ? 0n
      : values.reduce((max, value) => (value.end > max ? value.end : max), values[0].end) -
        values[0].begin;
  return {
    sumMs: ms(sum),
    unionMs: ms(union),
    duplicatedOverlapMs: ms(sum - union),
    envelopeMs: ms(envelope),
    nativeOuter: {
      status: 'unavailable',
      reason: 'This host exposes pass timestamps, not an independent native outer timer.',
    },
    phases: frame.passes.reduce(
      (totals, pass) => {
        if (pass.status !== 'measured') return totals;
        const phase = pass.passName.includes('scene-sdf')
          ? 'field'
          : pass.passKind === 'compute' && /^vfx\..*\.tick-\d+\.simulate$/.test(pass.passName)
            ? 'simulation'
            : pass.passKind === 'compute' && /^vfx\..*\.view\./.test(pass.passName)
              ? 'projection'
              : 'other';
        totals[phase] += pass.durationNanoseconds / 1e6;
        return totals;
      },
      { field: 0, simulation: 0, projection: 0, other: 0 },
    ),
  };
}

// Exact analytic distance to this fixture's transformed box or finite plane,
// evaluated only over bounded evidence records after GPU execution.
function geometryDistance(position, transform) {
  const scale = transform.scale ?? [1, 1, 1];
  const matrix = mat4.compose(mat4.create(), transform.pos, transform.quat ?? [0, 0, 0, 1], scale);
  const local = mat4.transformPoint(vec3.create(), mat4.invert(mat4.create(), matrix), position);
  const q = Array.from(
    local,
    (value, axis) =>
      (Math.abs(value) - (axis === 0 && transform.reimported ? 1.2 : 1)) * Math.abs(scale[axis]),
  );
  if (scenario.mesh === 'plane') {
    return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), local[2] * Math.abs(scale[2]));
  }
  return Math.hypot(...q.map((value) => Math.max(value, 0))) + Math.min(Math.max(...q), 0);
}

const isVfxUpdateWork = (work) =>
  work.pipeline?.shaders?.some((shader) =>
    /^forgeax_vfx_update(?:_compact)?_main$/.test(shader.entryPoint ?? ''),
  );
const liveSdfFields = (allocations) =>
  allocations.filter((row) => row.label.startsWith('scene-sdf.') && !row.destroyed);

function shouldCaptureFrame(frame) {
  if (frame === 0 || frame === 24 || frame === frameLimit - 1) return true;
  if (lifecycle === 'fixed-ticks') return frame === 10 || frame === 11;
  return lifecycle === 'multi-view' && (frame === 15 || frame === 30);
}

function fixedTicksForFrame(frame) {
  if (lifecycle !== 'fixed-ticks') return 1;
  if (frame === 10) return 0;
  return frame === 11 ? 2 : 1;
}

function runLabel(collision, depthOnly) {
  if (depthOnly) return 'depth-control';
  return collision ? 'collision' : 'free';
}

function effectGuidFor(label, depthOnly) {
  if (depthOnly) return prepared.depth.guid;
  return guid(
    benchmarkCapacity === undefined
      ? `effect/${label}`
      : `effect/benchmark/${benchmarkCapacity}/${label}`,
  );
}

function recorderRhi(recorder) {
  if (recorder === undefined) return webgpu.rhi;
  return Object.assign(Object.create(recorder.backend.rhi), {
    createShaderModule: recorder.backend.createShaderModule,
    createShaderModuleImmediate: recorder.backend.createShaderModuleImmediate,
  });
}

function rendererHostOptions(host, recorder) {
  return {
    features: [host.feature],
    rhi: recorderRhi(recorder),
    ...(recorder === undefined
      ? { gpuPassTiming: {} }
      : {
          rhiInstrumentation: { resolveSurfaceDevice: recorder.backend.unwrapDeviceForSurface },
        }),
  };
}

function assertEffectCapacity(effect, totalCapacity) {
  assert.equal(
    effect.program.emitters.reduce((sum, emitter) => sum + emitter.capacity, 0),
    totalCapacity,
  );
  assert.equal(
    effect.program.emitters.reduce((sum, emitter) => sum + emitter.renderers[0].capacity, 0),
    totalCapacity,
  );
  assert.equal(
    effect.program.emitters.reduce((sum, emitter) => sum + emitter.schedule.bursts[0].count, 0),
    totalCapacity,
  );
}

function sceneCameraData() {
  return {
    fov: Math.PI / 3,
    aspect: width / height,
    near: 0.1,
    far: 50,
    clearColor: [0.01, 0.02, 0.04, 1],
    tonemap: 0,
  };
}

function spawnPrimaryCamera(world) {
  return world
    .spawn(
      {
        component: Transform,
        data: {
          pos: scenario.camera,
          quat:
            scenario.cameraTarget === undefined
              ? quat.create()
              : quat.fromLookAt(quat.create(), scenario.camera, scenario.cameraTarget, [0, 1, 0]),
        },
      },
      { component: Camera, data: sceneCameraData() },
    )
    .unwrap();
}

function spawnSecondaryView(world, cameraEntity) {
  world
    .addComponent(cameraEntity, {
      component: CameraView,
      data: { viewport: [0, 0, 0.5, 1], order: 0 },
    })
    .unwrap();
  return world
    .spawn(
      { component: Transform, data: { pos: [0, 1, 9] } },
      { component: Camera, data: sceneCameraData() },
      {
        component: CameraView,
        data: { viewport: [0.5, 0, 0.5, 1], order: 1, resolutionScale: 0.5, updateInterval: 4 },
      },
    )
    .unwrap();
}

function applyMultiViewChanges(world, frame, cameraEntity, secondCamera) {
  if (frame === 15) world.set(cameraEntity, CameraView, { order: 2 }).unwrap();
  if (frame === 30) {
    world
      .set(cameraEntity, CameraView, { viewport: [0, 0, 0.6, 1], resolutionScale: 0.75 })
      .unwrap();
    world
      .set(secondCamera, CameraView, { viewport: [0.6, 0, 0.4, 1], updateInterval: 3 })
      .unwrap();
  }
}

function moveWall(world, transforms, obstacles) {
  transforms[1].pos = [2.1, 0.65, 0];
  world.set(obstacles[1], Transform, { pos: transforms[1].pos }).unwrap();
}

function updateWorkEvidence(frame, bytes, expectedUpdates, message) {
  const updates = buildFrameModel(unwrap(decodeTape(bytes))).works.filter(isVfxUpdateWork);
  assert.equal(updates.length, expectedUpdates, message);
  return {
    frame,
    updateWorkIndices: updates.map((work) => work.workIndex),
    tapeDigest: tapeDigest(bytes),
  };
}

function writeFixedTickEvidence(label, captures, frames) {
  const ticks = [10, 11].map((frame) =>
    updateWorkEvidence(frame, captures.get(frame), frame === 10 ? 0 : 2),
  );
  writeFileSync(
    resolve(output, `${label}-fixed-ticks.json`),
    JSON.stringify({ completedFrames: frames, fixedTicks: 60, ticks }, null, 2),
  );
}

function writeMultiViewEvidence(label, renderer, captures, frames) {
  assert.equal(renderer.inspect().views.length, 2);
  const evidence = [...captures].map(([frame, bytes]) =>
    updateWorkEvidence(frame, bytes, 1, 'Two views must share one fixed simulation dispatch'),
  );
  writeFileSync(
    resolve(output, `${label}-view-isolation.json`),
    JSON.stringify(
      {
        completedFrames: frames,
        views: renderer
          .inspect()
          .views.map(({ entityKey, viewport, width, height, renderedFrames }) => ({
            entityKey,
            viewport,
            width,
            height,
            renderedFrames,
          })),
        frames: evidence,
      },
      null,
      2,
    ),
  );
}

function sceneSdfCause(error) {
  while (error?.code !== 'scene-sdf-unavailable' && error?.detail?.cause !== undefined)
    error = error.detail.cause;
  return error;
}

function queuedIntentsOf(inspection, player) {
  return inspection.players.find((row) => row.player === player)?.queuedIntents;
}

async function drawCapturedFrame(renderer, recorder, lease) {
  const capture = recorder.captureFrame();
  unwrap(await recorder.frameBoundary());
  const receipt = unwrap(
    renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
  );
  unwrap(await receipt.completed);
  unwrap(await recorder.frameBoundary());
  return unwrap(await capture).bytes;
}

async function readInitialWorldCore(label, phase, bytes) {
  const initialTape = unwrap(decodeTape(bytes));
  const initialModel = buildFrameModel(initialTape);
  const initialUpdate = initialModel.works.find(isVfxUpdateWork);
  assert(initialUpdate);
  const initialParticle = initialUpdate.bindings.find((binding) => binding.binding === 0)?.resourceId;
  assert(initialParticle);
  const adapter = unwrap(await webgpu.rhi.requestAdapter());
  const device = unwrap(
    await adapter.requestDevice(replayDeviceRequest(initialTape, adapter.features, adapter.limits)),
  );
  let replay;
  try {
    replay = unwrap(
      await openReplay(initialTape, { device, createShaderModule: webgpu.createShaderModule }),
    );
    const read = unwrap(await replay.readResourceAtWork(initialParticle, initialUpdate.workIndex));
    assert.equal(read.bytes.byteLength, 1024 * VFX_PARTICLE_CORE_LAYOUT.stride);
    writeFileSync(resolve(output, `${label}-world-rebuild-initial-${phase}.bin`), read.bytes);
    return {
      core: read.bytes,
      evidence: {
        phase,
        tapeDigest: tapeDigest(bytes),
        updateWorkIndex: initialUpdate.workIndex,
        particle: initialParticle,
        coreBytes: read.bytes.byteLength,
        coreSHA256: createHash('sha256').update(read.bytes).digest('hex'),
      },
    };
  } finally {
    if (replay !== undefined) unwrap(await replay.dispose());
    webgpu._internal_getRawDevice(device)?.destroy();
  }
}

// Compare actual first-tick GPU records, not a CPU particle mirror. Raising
// this floor leaves the authored spawn above contact on the first tick.
async function compareWorldRebuildInitialCores(label, worldRebuildInitialTapes) {
  const cores = [];
  const evidence = [];
  for (const [phase, bytes] of Object.entries(worldRebuildInitialTapes)) {
    const initial = await readInitialWorldCore(label, phase, bytes);
    cores.push(initial.core);
    evidence.push(initial.evidence);
  }
  assert.equal(cores.length, 2);
  assert.deepEqual(
    cores[1],
    cores[0],
    'Fresh World must start the same seeded GPU population rather than reuse old particles',
  );
  writeFileSync(
    resolve(output, `${label}-world-rebuild-initial.json`),
    JSON.stringify(
      {
        completedFramesEach: 60,
        comparedFrame: 0,
        totalCapacity: 1024,
        route:
          'Actual before/after first-tick storage records read from independent fresh-device replays after original device destruction',
        everyParticleCoreByteMatches: true,
        evidence,
      },
      null,
      2,
    ),
  );
}

function isSoftwareAdapter(shim) {
  return (
    shim.isFallbackAdapter === true ||
    /swiftshader|lavapipe|llvmpipe|(?:^|\/)lvp(?:_|\.)/i.test(
      `${JSON.stringify(shim.adapterInfo)} ${process.env.VK_ICD_FILENAMES ?? ''}`,
    )
  );
}

function isCompleteTimingSample(sample) {
  return (
    sample.timing.status === 'complete' &&
    sample.timing.frame.measuredPassCount > 0 &&
    sample.timing.frame.droppedPassCount === 0 &&
    sample.timing.frame.measuredPassCount === sample.timing.frame.executedPassCount &&
    sample.intervals.unionMs > 0
  );
}

function distributionsOf(keys, sampleValue) {
  return Object.fromEntries(keys.map((key) => [key, distribution(sampleValue(key))]));
}

function benchmarkGpu(sampled, complete) {
  if (complete) {
    return distributionsOf(['sumMs', 'unionMs', 'duplicatedOverlapMs', 'envelopeMs'], (key) =>
      sampled.map((sample) => sample.intervals[key]),
    );
  }
  return {
    status: 'blocked',
    statuses: [...new Set(sampled.map((sample) => sample.timing.status))],
    reason:
      'All 60 samples require complete, nonempty, positive timestamps without dropped or unmeasured passes.',
  };
}

function benchmarkPhaseSums(sampled, complete) {
  if (!complete) return null;
  return distributionsOf(['field', 'simulation', 'projection', 'other'], (phase) =>
    sampled.map((sample) => sample.intervals.phases[phase]),
  );
}

function benchmarkVerdict(complete, software, cpu) {
  if (!complete) return 'blocked';
  return software || cpu.frameMs.p95 <= 33.34 ? 'pass' : 'fail';
}

function decodeParticleRecords(bytes) {
  const { stride } = VFX_PARTICLE_CORE_LAYOUT;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = (index, name, lanes) =>
    Array.from({ length: lanes }, (_, lane) =>
      data.getFloat32(index * stride + vfxParticleCoreField(name).offset + lane * 4, true),
    );
  return Array.from({ length: 1024 }, (_, i) => ({
    position: vector(i, 'position', 3),
    velocity: vector(i, 'velocity', 3),
    color: vector(i, 'color', 4),
    alive: data.getUint32(i * stride + vfxParticleCoreField('alive').offset, true),
  }));
}

function sampleHistogram(records) {
  return {
    maximum: Math.max(...records.map((record) => record.color[2])),
    histogram: Object.fromEntries(
      [...new Set(records.map((record) => record.color[2]))]
        .sort((a, b) => a - b)
        .map((count) => [count, records.filter((record) => record.color[2] === count).length]),
    ),
  };
}

function retiredBuffers(model) {
  return model.resources
    .filter((resource) => resource.kind === 'buffer' && resource.destroyEventIndex !== null)
    .map((resource) => ({
      resourceId: resource.resourceId,
      destroyEventIndex: resource.destroyEventIndex,
    }));
}

function worldRebuildReportFields(transforms, frames) {
  if (lifecycle !== 'world-rebuild') return {};
  return {
    lifecycle,
    effectiveObstacles: transforms,
    baselineCompletedFrames: frames,
    rebuiltCompletedFrames: 60,
    totalCompletedFrames: frames + 60,
  };
}

function assertBaselineCore(label, bytes) {
  if (lifecycle !== 'fixed-ticks' && lifecycle !== 'multi-view') return;
  assert(
    process.env.FORGEAX_SDF_BASELINE_EVIDENCE,
    'Run the same-source ordinary baseline before tick/view comparison',
  );
  assert.deepEqual(
    bytes,
    new Uint8Array(
      readFileSync(resolve(process.env.FORGEAX_SDF_BASELINE_EVIDENCE, `${label}-final-core.bin`)),
    ),
    'Tick/view changes must retain every particle-core byte of the 60-tick ordinary baseline',
  );
}

function assertCollisionResponse(collision, green, maxPenetration, report) {
  if (collision) {
    assert(green > 100, `expected contact response, got ${green}`);
    assert(maxPenetration <= 0.0001, `analytic fixture penetration ${maxPenetration}`);
    if (diagnostic) assert(report.samples.maximum <= 88);
  } else assert.equal(green, 0);
}

function assertCoverage(collision, records, red, frames, report) {
  if (!collision || lifecycle !== 'remove-wall') {
    assert.equal(red, 0, 'ordinary scene must not exhaust or leave coverage before evidence tick');
    return;
  }
  const outside = records.filter((record) =>
    record.position.some((coordinate) => coordinate < -4 || coordinate > 4),
  );
  assert.equal(
    red,
    outside.length,
    'Every red removal record must be explicitly outside the unchanged field coverage',
  );
  assert(outside.length > 0, 'Removal negative control must falsify unlimited field coverage');
  assert(outside.every((record) => record.color[0] > 0.9));
  writeFileSync(
    resolve(output, 'remove-wall-coverage.json'),
    JSON.stringify(
      {
        scope:
          'Wall removed at tick24; particles can leave the unchanged [-4,4] range. Outside coverage is observable, not an ordinary in-range pass.',
        completedFrames: frames,
        red,
        outside: outside.length,
        retainedRange: [-4, 4],
        boundedSamples: report.samples.maximum,
        geometry: report.geometry,
      },
      null,
      2,
    ),
  );
}

function assertFieldReplacement(collision, producer, changedUpdate, fieldWriter, model) {
  if (!collision) return;
  if (scenario.moveWall) {
    assert(producer, 'World transform change must produce a replacement field');
    assert(producer.workIndex < changedUpdate.workIndex);
    assert.equal(producer.bindings.find((binding) => binding.binding === 4)?.bufferOffset, 256);
  } else assert.equal(producer, undefined, 'static scene must reuse the accepted field');
  assert.equal(fieldWriter(model), undefined, 'hot unchanged field must skip composition');
}

async function readFinalRasterPixels(replay, model, label) {
  const finalRaster = model.works.findLast((work) => work.kind.startsWith('draw'));
  assert(finalRaster);
  const image = unwrap(await replay.inspectWork(finalRaster.workIndex, ['pixels'])).attachment;
  assert(image, 'Fresh replay must expose the final raster attachment');
  const decoded = unwrap(readbackImage(image));
  assert.equal(imageStats(decoded).nonFinite, 0);
  const rgba = toRgba8(decoded);
  writeFileSync(resolve(output, `${label}.png`), encodePng(decoded.width, decoded.height, rgba));
  return {
    rgba,
    pixels: {
      format: image.format,
      width: decoded.width,
      height: decoded.height,
      resourceId: image.resourceId,
      provenance: image.provenance,
      display: { exposure: 1, range: [0, 1], tonemap: 'clamp' },
    },
  };
}

// The final tape's update work carries particle-core and SDF bindings; the
// frame-24 tape identifies the replacement producer.
function locateCapturedUpdates(tapeBytes, captures, collision, depthOnly) {
  const tape = unwrap(decodeTape(tapeBytes));
  const model = buildFrameModel(tape);
  const update = model.works.find(isVfxUpdateWork);
  assert(update, 'ordinary VFX update must be captured');
  const particle = update.bindings.find((binding) => binding.binding === 0)?.resourceId;
  assert(particle);
  const sdf = update.bindings.find((binding) => binding.binding === 15)?.resourceId;
  assert.equal(sdf !== undefined, collision);
  if (depthOnly) assert(update.bindings.some((binding) => binding.binding === 13));
  const changedModel = buildFrameModel(unwrap(decodeTape(captures.get(24))));
  const changedUpdate = changedModel.works.find(isVfxUpdateWork);
  assert(changedUpdate);
  const changedSdf = changedUpdate.bindings.find((binding) => binding.binding === 15)?.resourceId;
  assert.equal(changedSdf, sdf, 'unchanged field must remain accepted through the final frame');
  const fieldWriter = (current) =>
    current.works.find((work) =>
      work.bindings.some(
        (binding) =>
          binding.resourceId === sdf && binding.binding === 4 && binding.access === 'read-write',
      ),
    );
  const producer = collision ? fieldWriter(changedModel) : undefined;
  assertFieldReplacement(collision, producer, changedUpdate, fieldWriter, model);
  return { tape, model, update, particle, sdf, changedModel, changedUpdate, changedSdf, fieldWriter, producer };
}


async function run(collision, depthOnly = false) {
  const label = runLabel(collision, depthOnly);
  let assetAssembly, runtime, unsubscribe;
  const publicationEvents = [];
  const previousGpu = globalThis.navigator?.gpu;
  const shim = await setupGpuShim({
    width,
    height,
    rerunCmd: 'pnpm --filter @forgeax/hello-boss-lightning smoke:sdf',
  });
  const ownedGpu = navigator.gpu;
  try {
    const recorder = benchmarkCapacity === undefined ? unwrap(attachRecorder(webgpu)) : undefined;
    const host = createVfxRuntimeHost({
      camera: {
        read(currentWorld) {
          const matrix = currentWorld.get(cameraEntity, GlobalTransform).unwrap().world;
          return {
            position: new Float32Array([matrix[12], matrix[13], matrix[14]]),
            right: mat4.getRight(vec3.create(), matrix),
            up: mat4.getUp(vec3.create(), matrix),
            viewProjection: mat4.multiply(
              mat4.create(),
              mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, width / height, 0.1, 50),
              mat4.invert(mat4.create(), matrix),
            ),
          };
        },
      },
      sceneSdf: {
        read: () => ({
          origin: [-4, -4, -4],
          dimensions: [65, 65, 65],
          spacing: 0.125,
          maxDistance: 2,
          maxInstances: 16,
          maxFieldBytes: 1024 * 1024,
        }),
      },
    });
    const assembly = unwrap(
      await constructRuntimeRendererHost(shim.mockCanvas, rendererHostOptions(host, recorder), {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
      }),
    );
    const { renderer } = assembly;
    let assets = assembly.assets;
    let world = new World({ assets });
    let context = await createWorldContext(world, [scenePlugin()]);
    const errors = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    assets.configurePackIndex('/pack-index.json');
    unwrap(await host.attachWorld({ world, assets }));
    async function attachLifecycleRuntime() {
      assetAssembly = unwrap(
        createAssetRuntimeAssembly(assets, {
          catalogSource: createCatalogSource({ url: '/pack-index.json' }),
        }),
      );
      runtime = assembleRuntimePacks(context, assetAssembly, { scopeId: `sdf-lifecycle-${label}` });
      assets.setCatalogSource(runtime.catalog, runtime.fetcher);
      unsubscribe = runtime.catalog.subscribe((delta) =>
        publicationEvents.push(structuredClone(delta)),
      );
      const row = depthOnly ? prepared.depth : prepared.republication.rows[0];
      unwrap(await runtime.producer.restore(preparedSnapshot(row)));
    }
    if (lifecycle === 'same-guid-republication' || depthOnly) await attachLifecycleRuntime();
    const meshGuid =
      lifecycle === 'same-guid-republication'
        ? prepared.republication.guid
        : guid(`mesh/${scenario.mesh}`);
    const totalCapacity = benchmarkCapacity ?? 1024;
    async function loadWorldAssets(owner) {
      const sourceMesh = unwrap(await owner.load(owner.parseGuid(meshGuid), 'mesh'));
      const mesh = owner.read(sourceMesh).unwrap();
      assert.equal(
        mesh.distanceField.policy.kind,
        scenario.mesh === 'plane' ? 'two-sided' : 'signed-solid',
      );
      const material = unwrap(await owner.load(owner.parseGuid(guid('material/obstacle')), 'material'));
      const effectHandle = unwrap(await loadVfxGpuEffect(owner, effectGuidFor(label, depthOnly)));
      const effect = owner.read(effectHandle).unwrap();
      if (depthOnly)
        assert.deepEqual(
          effect.program.emitters[0].reflection.dataInterfaces.map((row) => row.kind),
          ['camera', 'scene-depth'],
        );
      assertEffectCapacity(effect, totalCapacity);
      return { sourceMesh, mesh, material, effectHandle, effect };
    }
    let { sourceMesh, mesh, material, effectHandle, effect } = await loadWorldAssets(assets);
    let transforms = structuredClone(scenario.obstacles);
    function populateWorld(world) {
      const cameraEntity = spawnPrimaryCamera(world);
      const secondCamera = lifecycle === 'multi-view' ? spawnSecondaryView(world, cameraEntity) : undefined;
      const meshHandle = sourceMesh;
      const materialHandle = material;
      const obstacles = transforms.map((transform) =>
        world
          .spawn(
            { component: Transform, data: transform },
            { component: MeshFilter, data: { assetHandle: meshHandle } },
            { component: MeshRenderer, data: { materials: [materialHandle] } },
          )
          .unwrap(),
      );
      const player = world
        .spawn({
          component: ParticleEffectPlayer,
          data: {
            effect: effectHandle,
            playing: true,
            seed: 15,
            timeScale: 1,
          },
        })
        .unwrap();
      world
        .getResource(VFX_GPU_RUNTIME_RESOURCE_KEY)
        .attachInstance(
          player,
          createParticleEffectInstance(
            createVfxEffectContract(effect.program.emitters[0].reflection.layout),
            { initialValues: { ...scenario.parameters, diagnostics: diagnostic ? 1 : 0 } },
          ),
        );
      return { cameraEntity, secondCamera, meshHandle, obstacles, player };
    }
    let { cameraEntity, secondCamera, meshHandle, obstacles, player } = populateWorld(world);
    let lease = unwrap(renderer.attach(world));
    const captures = new Map();
    let worldRebuildInitialTapes;
    const measurements = [];
    const allocations = [];
    let liveBytes = 0,
      peakBytes = 0;
    const raw = shim.sharedDevice;
    const createBuffer = raw.createBuffer.bind(raw);
    const instrumentAllocations = benchmarkCapacity !== undefined || lifecycle !== undefined;
    function trackedCreateBuffer(descriptor) {
      const buffer = createBuffer(descriptor);
      const row = { label: descriptor.label ?? '', size: descriptor.size, destroyed: false };
      allocations.push(row);
      liveBytes += row.size;
      peakBytes = Math.max(peakBytes, liveBytes);
      const destroy = buffer.destroy.bind(buffer);
      buffer.destroy = () => {
        if (!row.destroyed) {
          row.destroyed = true;
          liveBytes -= row.size;
        }
        return destroy();
      };
      return buffer;
    }
    if (instrumentAllocations) raw.createBuffer = trackedCreateBuffer;
    let tapeBytes;
    let frames = 0;

    async function republishSameGuidMesh() {
      const publication = prepared.republication;
      runtime.producer.withdraw(publication.packageId);
      unwrap(await runtime.producer.restore(preparedSnapshot(publication.rows[1])));
      const held = assets.snapshot(sourceMesh).unwrap();
      unwrap(await assets.reload(sourceMesh, {conflict: 'reject'}));
      const current = assets.snapshot(sourceMesh).unwrap();
      const replacement = assets.read(sourceMesh).unwrap();
      assert(current.version(sourceMesh).unwrap() > held.version(sourceMesh).unwrap());
      assert.equal(replacement.aabb[3], Math.fround(1.2));
      assert.equal(replacement.distanceField.artifact.integrity.digest, publication.rows[1].field.integrity.digest);
      for (const entity of obstacles) assert.equal(world.get(entity, MeshFilter).unwrap().assetHandle, sourceMesh);
      held.dispose();
      current.dispose();
      for (const transform of transforms) transform.reimported = true;
      writeFileSync(
        resolve(output, `${label}-republication.json`),
        JSON.stringify(
          {
            scope:
              'Same-GUID validated Runtime Pack withdrawal and republication, not atomic recook',
            ...publication,
            events: publicationEvents,
          },
          null,
          2,
        ),
      );
    }

    async function applyWallChange() {
      if (lifecycle === 'same-guid-republication') {
        await republishSameGuidMesh();
      } else if (lifecycle === 'remove-wall') {
        world.despawn(obstacles[1]).unwrap();
        transforms.splice(1, 1);
      } else {
        moveWall(world, transforms, obstacles);
      }
    }

    async function runFrame(frame) {
      if (frame === 24 && scenario.moveWall) await applyWallChange();
      if (lifecycle === 'multi-view') applyMultiViewChanges(world, frame, cameraEntity, secondCamera);
      const start = performance.now();
      const ticks = fixedTicksForFrame(frame);
      for (let tick = 0; tick < ticks; tick++) world.update(1 / 60).unwrap();
      const updated = performance.now();
      const capture =
        recorder !== undefined && shouldCaptureFrame(frame) ? recorder.captureFrame() : undefined;
      if (capture !== undefined) unwrap(await recorder.frameBoundary());
      const receipt = unwrap(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      const recorded = performance.now();
      unwrap(await receipt.completed);
      const completed = performance.now();
      frames++;
      if (benchmarkCapacity !== undefined) {
        const observation = unwrap(
          await renderer.observe(receipt, { include: ['timings'] }),
        ).timings;
        assert(observation);
        measurements.push({
          frame,
          hostLoad: { loadAverage: loadavg(), freeMemoryBytes: freemem() },
          cpu: {
            updateMs: updated - start,
            prepareRecordMs: recorded - updated,
            completionWaitMs: completed - recorded,
            frameMs: completed - start,
            timingObservationMs: performance.now() - completed,
          },
          timing: observation,
          intervals: observation.status === 'complete' ? intervals(observation.frame) : null,
        });
      }
      if (capture !== undefined) {
        unwrap(await recorder.frameBoundary());
        tapeBytes = unwrap(await capture).bytes;
        captures.set(frame, tapeBytes);
        writeFileSync(resolve(output, `${label}-${frame}.rhitape`), tapeBytes);
        writeFileSync(resolve(output, `${label}.rhitape`), tapeBytes);
      }
    }

    function verifyCompletedRun() {
      const inspected = host.inspect(world);
      writeFileSync(
        resolve(output, `${label}-completed.json`),
        JSON.stringify(
          {
            label,
            scenario,
            diagnostic,
            seed: 15,
            completedFrames: frames,
            adapter: shim.adapterInfo,
            errors,
            captures: [...captures].map(([frame, bytes]) => ({ frame, digest: tapeDigest(bytes) })),
            sourceMesh: {
              guid: guid(`mesh/${scenario.mesh}`),
              artifact: mesh.distanceField.artifact,
              policy: mesh.distanceField.policy,
            },
            host: inspected,
            ...(benchmarkCapacity === undefined
              ? {}
              : { benchmarkCapacity, measurements, memory: { peakBytes, allocations } }),
          },
          null,
          2,
        ),
      );
      assert.equal(frames, frameLimit);
      assert.deepEqual(errors, []);
      assert.deepEqual(inspected.diagnostics, []);
      assert.equal(inspected.players.find((p) => p.player === player)?.queuedIntents, 0);
    }

    function worldStateSnapshot(fields, completedFrames) {
      return structuredClone({
        assetOwner: assets.identity,
        handles: { mesh: sourceMesh, material, effect: effectHandle },
        host: host.inspect(world),
        renderer: renderer.inspect(),
        fields: fields.map((row) => ({ ...row })),
        completedFrames,
      });
    }

    async function retireOriginalWorld() {
      const originalInitialTape = captures.get(0);
      assert(originalInitialTape);
      const oldControl = unwrap(host.acquireControl(world));
      const oldPlayer = player;
      const oldFields = liveSdfFields(allocations);
      const before = worldStateSnapshot(oldFields, frames);
      assert(oldFields.length > 0 || !collision);
      lease.dispose();
      unwrap(await host.detachWorld({ world }));
      assert.equal(
        host.inspect(world),
        undefined,
        'Retired World must leave the host attachment map',
      );
      await context.fiber.dispose();
      await Promise.resolve();
      assert(
        oldFields.every((row) => row.destroyed),
        'Retired World must release every accepted SDF buffer',
      );
      return { originalInitialTape, oldControl, oldPlayer, oldFields, before };
    }

    async function attachFreshWorld(before) {
      assets.dispose();
      assets = new AssetRegistry({ shaderRegistry: assembly.assets.shaderRegistry });
      for (const contribution of defaultAssetDecoderContributions)
        assets.installDecoder(contribution.kind, contribution.decoder);
      assets.configurePackIndex('/pack-index.json');
      world = new World({ assets });
      context = await createWorldContext(world, [scenePlugin()]);
      unwrap(await host.attachWorld({ world, assets }));
      ({ sourceMesh, mesh, material, effectHandle, effect } = await loadWorldAssets(assets));
      assert.notEqual(assets.identity, before.assetOwner);
      for (const handle of Object.values(before.handles))
        assert.equal(assets.validate(handle).ok, false, 'Fresh World rejects retired asset handles');
      // Raise only the floor. The new analytic oracle rejects an old field;
      // the ordinary frame24 wall update and collision-off control remain.
      transforms = structuredClone(scenario.obstacles);
      transforms[0].pos[1] += 1;
      ({ cameraEntity, secondCamera, meshHandle, obstacles, player } = populateWorld(world));
      lease = unwrap(renderer.attach(world));
      captures.clear();
    }

    async function runRebuiltFrames() {
      let rebuiltFrames = 0;
      for (let frame = 0; frame < 60; frame++) {
        if (frame === 24 && scenario.moveWall) moveWall(world, transforms, obstacles);
        world.update(1 / 60).unwrap();
        const capture = [0, 24, 59].includes(frame) ? recorder.captureFrame() : undefined;
        if (capture !== undefined) unwrap(await recorder.frameBoundary());
        const receipt = unwrap(
          renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
        );
        unwrap(await receipt.completed);
        rebuiltFrames++;
        if (capture !== undefined) {
          unwrap(await recorder.frameBoundary());
          tapeBytes = unwrap(await capture).bytes;
          captures.set(frame, tapeBytes);
          writeFileSync(resolve(output, `${label}-world-rebuild-${frame}.rhitape`), tapeBytes);
        }
      }
      return rebuiltFrames;
    }

    function verifyRebuiltWorld(retired, rebuiltFrames) {
      const { before, oldControl, oldPlayer, oldFields } = retired;
      const after = worldStateSnapshot(liveSdfFields(allocations), rebuiltFrames);
      assert.equal(
        after.renderer.frame.deviceGeneration,
        before.renderer.frame.deviceGeneration,
        'World replacement must preserve the Renderer device generation',
      );
      assert(
        after.host.generation > before.host.generation,
        'Fresh World must acquire a new host attachment generation',
      );
      assert.equal(after.host.players.length, 1);
      const retiredReplay = oldControl.replay({ player: oldPlayer });
      assert.equal(retiredReplay.ok, false, 'An old World control must reject after replacement');
      assert.equal(retiredReplay.error.code, 'vfx-host-control-world-detached');
      assert.equal(after.host.players[0].queuedIntents, 0);
      assert(
        collision ? after.fields.length > 0 : after.fields.length === 0,
        'Fresh World allocates SDF buffers only for the reflected consumer',
      );
      assert.equal(after.host.players[0].lastCommitted.tick, 60);
      assert.deepEqual(after.host.diagnostics, []);
      assert.deepEqual(errors, []);
      writeFileSync(
        resolve(output, `${label}-world-rebuild.json`),
        JSON.stringify(
          {
            route:
              'Fresh World, AssetRegistry and Cordis scene context on the same ordinary Renderer/device; no App.execution or driver-reset claim',
            before,
            after,
            raisedFloorWorldUnits: 1,
            oldFieldsRetired: oldFields.every((row) => row.destroyed),
            effectiveObstacles: transforms,
            retiredControlError: retiredReplay.error,
            finalTapeDigest: tapeDigest(tapeBytes),
          },
          null,
          2,
        ),
      );
    }

    async function rebuildWorld() {
      const retired = await retireOriginalWorld();
      await attachFreshWorld(retired.before);
      const rebuiltFrames = await runRebuiltFrames();
      assert.equal(rebuiltFrames, 60);
      worldRebuildInitialTapes = { before: retired.originalInitialTape, after: captures.get(0) };
      assert(worldRebuildInitialTapes.after);
      verifyRebuiltWorld(retired, rebuiltFrames);
    }

    async function verifyMissingFieldRejection() {
      const uncooked = unwrap(await assets.load(assets.parseGuid(guid('mesh/no-field')), 'mesh'));
      assert.equal(assets.read(uncooked).unwrap().distanceField, undefined);
      const invalidHandle = uncooked;
      for (const entity of obstacles)
        world.set(entity, MeshFilter, { assetHandle: invalidHandle }).unwrap();
      world.update(1 / 60).unwrap();
      const beforeRejected = host.inspect(world);
      const rejected = renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
      const completion = rejected.ok ? await rejected.value.completed : undefined;
      const afterRejected = host.inspect(world);
      writeFileSync(
        resolve(output, 'missing-field.json'),
        JSON.stringify(
          {
            meshGuid: guid('mesh/no-field'),
            beforeRejected,
            afterRejected,
            draw: rejected,
            completion,
            errors,
          },
          null,
          2,
        ),
      );
      assert(
        errors.length > 0 &&
          errors.every(
            (error) =>
              sceneSdfCause(error)?.code === 'scene-sdf-unavailable' &&
              sceneSdfCause(error).detail.reason === 'missing-field',
          ),
        'Canonical uncooked mesh must fail through its structured scene producer cause',
      );
      const queued = queuedIntentsOf(beforeRejected, player);
      assert(queued > 0);
      assert.equal(
        queuedIntentsOf(afterRejected, player),
        queued,
        'Rejected preparation must preserve every pending fixed-tick intent',
      );
    }

    async function verifyMissingFieldRestoration() {
      for (const entity of obstacles)
        world.set(entity, MeshFilter, { assetHandle: meshHandle }).unwrap();
      errors.length = 0;
      const restoredTape = await drawCapturedFrame(renderer, recorder, lease);
      writeFileSync(resolve(output, 'missing-field-restored.rhitape'), restoredTape);
      assert.equal(queuedIntentsOf(host.inspect(world), player), 0);
      assert.deepEqual(errors, []);
      writeFileSync(
        resolve(output, 'missing-field-restored.json'),
        JSON.stringify(
          {
            host: host.inspect(world),
            renderer: renderer.inspect(),
            tapeDigest: tapeDigest(restoredTape),
          },
          null,
          2,
        ),
      );
    }

    async function releaseSdfDemand() {
      if (lifecycle === 'player-destroy') {
        world.despawn(player).unwrap();
        return;
      }
      const replacement = unwrap(await loadVfxGpuEffect(assets, guid('effect/free')));
      assert(
        !assets.read(replacement).unwrap().program.emitters[0].reflection.dataInterfaces?.some(
          (row) => row.kind === 'scene-sdf',
        ),
      );
      world
        .set(player, ParticleEffectPlayer, {
          effect: replacement,
        })
        .unwrap();
    }

    async function captureDemandRelease() {
      const capture = recorder.captureFrame();
      unwrap(await recorder.frameBoundary());
      await releaseSdfDemand();
      world.update(1 / 60).unwrap();
      const changed = unwrap(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      unwrap(await changed.completed);
      unwrap(await recorder.frameBoundary());
      const lifecycleTape = unwrap(await capture).bytes;
      writeFileSync(resolve(output, `${lifecycle}.rhitape`), lifecycleTape);
      const updates = buildFrameModel(unwrap(decodeTape(lifecycleTape))).works.filter(isVfxUpdateWork);
      assert.equal(updates.length, lifecycle === 'player-destroy' ? 0 : 1);
      assert(updates.every((work) => work.bindings.every((binding) => binding.binding !== 15)));
      return lifecycleTape;
    }

    async function verifyDemandRelease() {
      const before = liveSdfFields(allocations).map((row) => ({ ...row }));
      assert(before.length > 0, 'Baseline must accept native SDF buffers');
      let lifecycleTape;
      if (lifecycle === 'world-detach') {
        lease.dispose();
        await Promise.resolve();
      } else {
        lifecycleTape = await captureDemandRelease();
      }
      const after = liveSdfFields(allocations).map((row) => ({ ...row }));
      writeFileSync(
        resolve(output, `${lifecycle}.json`),
        JSON.stringify(
          {
            lifecycle,
            baselineFrames: frames,
            additionalCompletedFrames: lifecycle === 'world-detach' ? 0 : 1,
            before,
            after,
            observedAllocations: allocations.filter((row) => row.label.startsWith('scene-sdf.')),
            tapeDigest: lifecycleTape === undefined ? null : tapeDigest(lifecycleTape),
          },
          null,
          2,
        ),
      );
      assert.equal(
        after.length,
        0,
        'Released demand must retire every SDF buffer after completed submissions',
      );
      assert.deepEqual(errors, []);
    }

    async function verifyLifecycleAfterRun() {
      if (lifecycle === 'fixed-ticks') {
        writeFixedTickEvidence(label, captures, frames);
      } else if (lifecycle === 'multi-view') {
        writeMultiViewEvidence(label, renderer, captures, frames);
      } else if (collision && lifecycle === 'missing-field') {
        await verifyMissingFieldRejection();
        await verifyMissingFieldRestoration();
      } else if (
        collision &&
        ['player-destroy', 'source-replace', 'world-detach'].includes(lifecycle)
      ) {
        await verifyDemandRelease();
      }
    }

    async function disposeRun() {
      unsubscribe?.();
      lease.dispose();
      unwrap(await host.detachWorld({ world }));
      await renderer.dispose();
      await context.fiber.dispose();
      assetAssembly?.dispose();
      assets.dispose();
      if (recorder !== undefined) unwrap(await recorder.dispose());
      if (instrumentAllocations) raw.createBuffer = createBuffer;
      shim.sharedDevice?.destroy();
    }

    function writeBenchmarkReport() {
      const sampled = measurements.slice(30);
      assert.equal(sampled.length, 60);
      const core = allocations.filter((row) => /\.particles"\]$/.test(row.label));
      assert.equal(
        core.reduce((sum, row) => sum + row.size, 0),
        totalCapacity * VFX_PARTICLE_CORE_LAYOUT.stride,
      );
      const fields = allocations.filter((row) => row.label === 'scene-sdf.grid-and-voxels');
      assert.equal(fields.length, collision ? (scenario.moveWall ? 2 : 1) : 0);
      const software = isSoftwareAdapter(shim);
      const cpu = distributionsOf(Object.keys(sampled[0].cpu), (key) =>
        sampled.map((sample) => sample.cpu[key]),
      );
      const complete = sampled.every(isCompleteTimingSample);
      const report = {
        label,
        capacity: totalCapacity,
        emitterCapacities: effect.program.emitters.map((emitter) => emitter.capacity),
        seed: 15,
        completedFrames: frames,
        warmupFrames: 30,
        sampleCount: sampled.length,
        adapter: {
          info: shim.adapterInfo,
          requestedBackend: shim.requestedBackend,
          isFallbackAdapter: shim.isFallbackAdapter,
          adapterClass: software ? 'software-reference' : 'hardware',
          virtualized: Boolean(shim.adapterInfo?.runtimeService),
        },
        observer: {
          frameCapture: false,
          particleReadbackBytes: 0,
          framebufferReadbackBytes: 0,
          passTimestampWritesAndReadback: true,
          queryResponseTiming: 'fused with simulation; no exclusive kernel measurement',
        },
        memory: {
          kind: 'observed native buffer descriptors after Renderer assembly; excludes textures and driver overhead',
          coreBytes: core.reduce((sum, row) => sum + row.size, 0),
          peakBytes,
          allocations,
        },
        cpu,
        gpu: benchmarkGpu(sampled, complete),
        hardwareFrameBudgetMs: 33.34,
        hardwareCpuBudgetPassed: software ? null : cpu.frameMs.p95 <= 33.34,
        phases: {
          cold: measurements[0],
          replacement: measurements[24],
          sampledGpuPassSumsMs: benchmarkPhaseSums(sampled, complete),
        },
        measurements,
        verdict: benchmarkVerdict(complete, software, cpu),
      };
      writeFileSync(resolve(output, `${label}-benchmark.json`), JSON.stringify(report, null, 2));
      return { report };
    }

    async function analyzeFinalTape() {
      const located = locateCapturedUpdates(tapeBytes, captures, collision, depthOnly);
      const { tape, model, update, particle, sdf, changedModel, changedUpdate, changedSdf, fieldWriter, producer } = located;
      const replayAdapter = unwrap(await webgpu.rhi.requestAdapter());
      const replayDevice = unwrap(
        await replayAdapter.requestDevice(
          replayDeviceRequest(tape, replayAdapter.features, replayAdapter.limits),
        ),
      );
      const replay = unwrap(
        await openReplay(tape, { device: replayDevice, createShaderModule: webgpu.createShaderModule }),
      );
      try {
        const read = unwrap(await replay.readResourceAtWork(particle, update.workIndex));
        writeFileSync(resolve(output, `${label}-final-core.bin`), read.bytes);
        assertBaselineCore(label, read.bytes);
        const { stride, fingerprint } = VFX_PARTICLE_CORE_LAYOUT;
        assert.equal(effect.program.emitters[0].reflection.layout.core.fingerprint, fingerprint);
        assert.equal(read.bytes.byteLength, 1024 * stride);
        const records = decodeParticleRecords(read.bytes);
        const green = records.filter((record) => record.color[1] > 0.9 && record.color[0] < 0.3).length;
        const red = records.filter((record) => record.color[0] > 0.9).length;
        const radius = scenario.parameters.radius ?? 0.02;
        const gaps = records.map(
          (record) =>
            Math.min(...transforms.map((transform) => geometryDistance(record.position, transform))) -
            radius,
        );
        const maxPenetration = Math.max(0, ...gaps.map((gap) => -gap));
        const report = {
          label,
          scenario,
          ...worldRebuildReportFields(transforms, frames),
          diagnostic,
          completedFrames: frames,
          seed: 15,
          evidenceFrame: frameLimit - 1,
          adapter: shim.adapterInfo,
          tapeDigest: tapeDigest(tapeBytes),
          updateWorkIndex: update.workIndex,
          particle,
          sdf,
          bindings: update.bindings,
          coreLayout: { stride, fingerprint },
          green,
          red,
          geometry: {
            radius,
            maxPenetration,
            minimumGap: Math.min(...gaps),
            meanGap: gaps.reduce((sum, value) => sum + value, 0) / gaps.length,
          },
          samples: diagnostic && collision ? sampleHistogram(records) : null,
          replacement: {
            frame: 24,
            tapeDigest: tapeDigest(captures.get(24)),
            producerWorkIndex: producer?.workIndex,
            consumerWorkIndex: changedUpdate.workIndex,
            resource: changedSdf,
            hotCompositionSkipped: collision ? fieldWriter(model) === undefined : null,
            retiredBuffers: retiredBuffers(changedModel),
          },
          records: records.slice(0, 32),
          originalDestroyedBeforeReplay: true,
        };
        writeFileSync(resolve(output, `${label}.json`), JSON.stringify(report, null, 2));
        const { rgba, pixels } = await readFinalRasterPixels(replay, model, label);
        report.pixels = pixels;
        writeFileSync(resolve(output, `${label}.json`), JSON.stringify(report, null, 2));
        assert(records.every((record) => record.alive === 1 && record.position.every(Number.isFinite)));
        assertCollisionResponse(collision, green, maxPenetration, report);
        assertCoverage(collision, records, red, frames, report);
        return { report, records, rgba, core: read.bytes };
      } finally {
        unwrap(await replay.dispose());
        webgpu._internal_getRawDevice(replayDevice)?.destroy();
      }
    }

    try {
      for (let frame = 0; frame < frameLimit; frame++) await runFrame(frame);
      verifyCompletedRun();
      if (lifecycle === 'world-rebuild') await rebuildWorld();
      await verifyLifecycleAfterRun();
    } finally {
      await disposeRun();
    }
    if (lifecycle === 'world-rebuild')
      await compareWorldRebuildInitialCores(label, worldRebuildInitialTapes);
    if (benchmarkCapacity !== undefined) return writeBenchmarkReport();
    assert(tapeBytes);
    return await analyzeFinalTape();
  } finally {
    await teardownDawnInstance(shim.sharedDevice === undefined ? [] : [shim.sharedDevice], () => {
      if (navigator.gpu !== ownedGpu) return;
      if (previousGpu === undefined) delete navigator.gpu;
      else Object.defineProperty(navigator, 'gpu', { value: previousGpu, configurable: true, writable: true });
    });
  }
}

try {
  const collision = await run(true);
  const free = await run(false);
  if (lifecycle === 'depth-only-falsifier') {
    const depth = await run(false, true);
    assert.deepEqual(
      depth.core,
      free.core,
      'Off-frustum point-depth control must preserve every particle-core byte of free integration',
    );
    writeFileSync(
      resolve(output, 'depth-control-comparison.json'),
      JSON.stringify(
        {
          scope:
            'Same camera, seed, World and 60 ticks; point-depth stop is distinct from geometric swept SDF collision',
          completedFramesEach: frameLimit,
          capacity: 1024,
          fullCoreBytesEqual: true,
          coreBytes: depth.core.byteLength,
          requirements: prepared.depth.requirements,
          sdfBindingAbsent: true,
          depthBindingPresent: true,
          reports: [collision.report, depth.report, free.report],
        },
        null,
        2,
      ),
    );
  }
  if (benchmarkCapacity !== undefined) {
    const complete = collision.report.verdict === 'pass' && free.report.verdict === 'pass';
    const report = {
      capacity: benchmarkCapacity,
      collision: collision.report,
      free: free.report,
      comparison: {
        kind: 'differences between distributions from two complete workload runs',
        runOrder: ['collision', 'free'],
        limitation: 'A single ordered pair does not control thermal or run-order bias.',
        fullFrameGpuUnionDeltaMs:
          collision.report.gpu.unionMs && free.report.gpu.unionMs
            ? Object.fromEntries(
                ['p50', 'p95'].map((q) => [
                  q,
                  collision.report.gpu.unionMs[q] - free.report.gpu.unionMs[q],
                ]),
              )
            : null,
        fullFrameLimitation:
          'Includes field, simulation, projection and raster; trajectories and screen coverage differ.',
        gpuPassSumDeltaMs:
          collision.report.phases.sampledGpuPassSumsMs && free.report.phases.sampledGpuPassSumsMs
            ? Object.fromEntries(
                ['field', 'simulation', 'projection', 'other'].map((phase) => [
                  phase,
                  Object.fromEntries(
                    ['p50', 'p95'].map((q) => [
                      q,
                      collision.report.phases.sampledGpuPassSumsMs[phase][q] -
                        free.report.phases.sampledGpuPassSumsMs[phase][q],
                    ]),
                  ),
                ]),
              )
            : null,
        simulationLimitation:
          'Query/response is fused into update. This phase also includes spawn, scan, compact and event work; no exclusive query time is measured.',
      },
      verdict: complete ? 'pass' : 'not-passed',
    };
    writeFileSync(resolve(output, 'benchmark-pair.json'), JSON.stringify(report, null, 2));
    console.log(
      `[sdf-benchmark] ${report.verdict}: exact total ${benchmarkCapacity}, 30 warm-up + 60 samples each`,
    );
    if (!complete) process.exitCode = 2;
  } else {
    const changed = collision.records.filter((record, index) =>
      record.position.some(
        (coordinate, axis) => Math.abs(coordinate - free.records[index].position[axis]) > 0.1,
      ),
    ).length;
    assert(changed > 100, `collision-off falsifier changed only ${changed} trajectories`);
    assert.equal(collision.rgba.length, free.rgba.length);
    const changedPixels = Array.from(
      { length: collision.rgba.length / 4 },
      (_, index) => index * 4,
    ).filter((offset) =>
      [0, 1, 2].some(
        (lane) => Math.abs(collision.rgba[offset + lane] - free.rgba[offset + lane]) > 12.75,
      ),
    ).length;
    if (scenario.id !== 'off-frustum')
      assert(changedPixels > 20, 'Collision-off must change rendered pixels beyond epsilon 0.05');
    writeFileSync(
      resolve(output, 'pair.json'),
      JSON.stringify(
        {
          changed,
          changedPixels,
          pixelEpsilon: 0.05,
          pixelOracle:
            scenario.id === 'off-frustum'
              ? 'structural only: display camera excludes the scene'
              : 'readback',
          collision: collision.report,
          free: free.report,
        },
        null,
        2,
      ),
    );
    console.log(
      `[sdf] PASS: ${scenario.id}, ordinary Pack/World/Renderer, ${frameLimit} completed frames each, collision-off falsifier changed ${changed}/1024 trajectories`,
    );
    emitSmokeReceipt(
      'hello-boss-lightning/sdf',
      Math.min(collision.report.completedFrames, free.report.completedFrames),
      'smoke:sdf',
    );
  }
} finally {
  globalThis.fetch = originalFetch;
  await teardownDawnInstance([], () => {
    if (originalGpu === undefined) delete globalThis.navigator.gpu;
    else
      Object.defineProperty(globalThis.navigator, 'gpu', {
        value: originalGpu,
        configurable: true,
        writable: true,
      });
  });
}
