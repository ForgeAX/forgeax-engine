import { mkdirSync, writeFileSync } from 'node:fs';
import { MeshRenderer } from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import {
  createIrradianceFieldHarness,
  expectFieldTopologyRebuild,
  type FieldImage,
  fieldInspection,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderTemplateManifest());
const directory = 'artifacts/irradiance-field/dawn';
mkdirSync(directory, { recursive: true });

type Energy = Pick<FieldImage, 'red'>;
const meanAbs = (a: Energy, b: Energy) =>
  a.red.reduce((sum, value, i) => sum + Math.abs(value - (b.red[i] ?? NaN)), 0) / a.red.length;
const max = (image: Energy) => image.red.reduce((m, value) => Math.max(m, value), 0);
const average = (images: readonly FieldImage[]) => {
  const red = new Float32Array(images[0]?.red.length ?? 0);
  for (const image of images)
    for (let i = 0; i < red.length; i++)
      red[i] = (red[i] ?? 0) + (image.red[i] ?? 0) / images.length;
  const mean = red.reduce((sum, v) => sum + v, 0) / red.length;
  return { red, mean };
};
/** Probe updates leave per-frame noise; compare 8-frame temporal means. */
const WINDOW = 8;
/** 17^3 Global SDF grid of the probe-global profile. */
const GRID_VOXELS = 17 ** 3;
/** Behind the camera: the emitter reaches the image only as indirect light. */
const B = [-2, -1, 0.5] as const;

/** Frames until the trailing `WINDOW` mean first lies within `tolerance` of the reference. */
function convergence(
  series: readonly FieldImage[],
  reference: Energy & { readonly mean: number },
  tolerance: number,
) {
  const errors: number[] = [];
  let frames: number | undefined;
  for (let end = WINDOW; end <= series.length; end++) {
    const error = meanAbs(average(series.slice(end - WINDOW, end)), reference) / reference.mean;
    errors.push(error);
    if (frames === undefined && error < tolerance) frames = end;
  }
  return { frames, errors };
}

type Harness = Awaited<ReturnType<typeof createIrradianceFieldHarness>>;

/** One frame whose synchronous CPU cost (World update + Renderer submission) is timed. */
async function timedDraw(h: Harness) {
  h.world.update(1 / 60).unwrap();
  propagateTransforms(h.world).unwrap();
  const start = performance.now();
  const result = h.submit();
  const cpuMs = performance.now() - start;
  assert(result.ok, JSON.stringify({ result, errors: h.errors }));
  renderValue(await result.value.completed);
  return cpuMs;
}

/** Bound addition by its original 60 frames and explicit rebuild by its
 * original 120 seconds. Completion belongs to a new, submitted generation. */
async function measureRebuild(h: Harness, generation: number, frameLimit = Infinity) {
  const started = performance.now();
  let frames = 0;
  let cpuMs = 0;
  for (;;) {
    cpuMs += await timedDraw(h);
    frames++;
    const state = fieldInspection(h);
    if (state.state === 'failed') throw new Error(JSON.stringify({ state, errors: h.errors }));
    if (
      state.state === 'ready' &&
      state.generation > generation &&
      state.submittedFrames > 0 &&
      state.acceleration?.settled !== false
    )
      return { frames, cpuMs, wallMs: performance.now() - started, state };
    if (frames >= frameLimit || performance.now() - started > 120_000)
      throw new Error(`rebuild did not settle: ${JSON.stringify({ state, frames, frameLimit })}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

it('rebuilds added field sources and rematerializes only their Cards in place', {
  timeout: 900_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    instrumentation: {
      onDeviceLost: () => recorder.deviceLost(),
      resolveSurfaceDevice: (
        device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
      ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  const result: Record<string, unknown> = {};
  try {
    // This compares edit/rebuild convergence speed; retain the original
    // sample count so extra sampling noise cannot shift that temporal oracle.
    const gi = irradianceFieldGi({ hysteresis: 0.8, maxDistance: 0.5, raysPerProbe: 64 });
    h.setGi(gi);
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    await h.settle(0);
    const dark = await h.image();
    const start = fieldInspection(h);
    const baseTiles = start.cards?.tiles ?? 0;
    expect(baseTiles).toBeGreaterThan(0);
    // (a) A new identity replaces the canonical pool before any row is published.
    // Preserve the original 60-frame admission bound and record the full rebuild.
    const slab = await h.slab(1.5, 1.5, 0.25);
    const emitter = h.spawn(slab, h.emissive, [...B]);
    const addition = await measureRebuild(h, start.generation, 60);
    const added = addition.state;
    expectFieldTopologyRebuild(start, added, 1, 1);
    const addEdits = added.edits;
    assert(addEdits, `add never rebuilt: ${JSON.stringify(added)}`);
    const emitterTiles = (added.cards?.tiles ?? 0) - baseTiles;
    expect(emitterTiles).toBeGreaterThan(0);
    expect(addEdits).toMatchObject({
      applied: 0,
      addedInstances: 0,
      movedInstances: 0,
      removedInstances: 0,
      rematerializedInstances: 0,
      recapturedTiles: 0,
    });
    // The new pool owns every Mesh/BLAS, including the added slab. Counters are
    // generation-local: no old BLAS/TLAS cost may masquerade as an in-place add.
    const rayQuery = start.traversal === 'ray-query';
    const accelerationStart = start.acceleration;
    const accelerationAdded = added.acceleration;
    if (rayQuery) {
      assert(accelerationStart && accelerationAdded);
      expect(accelerationAdded).toMatchObject({
        instances: accelerationStart.instances + 1,
        geometries: accelerationStart.geometries + 1,
        blasBuilt: accelerationAdded.geometries,
        tlasBuilt: 1,
      });
    }
    expect(addEdits.composedVoxels).toBe(0);
    expect(addEdits.priorityProbes).toBe(0);
    const addSeries: FieldImage[] = [];
    for (let i = 0; i < 64; i++) {
      if (i !== 63) {
        addSeries.push(await h.image());
        continue;
      }
      // Preserve the actual final added scene before a forced rebuild replaces
      // its field. A failed convergence assertion must retain that GPU state.
      const capture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const image = await h.image();
      addSeries.push(image);
      (await recorder.frameBoundary()).unwrap();
      const tape = (await capture).unwrap();
      writeFileSync(`${directory}/add-final-frame.rhitape`, tape.bytes);
      writeFileSync(`${directory}/add-final-red.f32`, new Uint8Array(image.red.buffer));
      writeFileSync(
        `${directory}/add-final-meta.f32`,
        new Uint8Array((await h.read('meta')).buffer),
      );
      result.addFrame = {
        digest: tape.digest,
        inspection: fieldInspection(h),
        width: h.canvas.width,
        height: h.canvas.height,
      };
    }
    expect(fieldInspection(h)).toMatchObject({
      generation: added.generation,
      edits: { pendingTiles: 0, pendingPriorityUpdates: 0 },
    });

    // (d) Forced rebuild of the same scene: the from-scratch reference and the
    // cost baseline. Only the Card byte budget changes, which keys a new field.
    const rebuildGi = {
      ...gi,
      field: {
        ...gi.field,
        cards: { ...gi.field.cards, maxCaptureBytes: gi.field.cards.maxCaptureBytes + 65_536 },
      },
    } as typeof gi;
    h.setGi(rebuildGi);
    const explicitRebuild = await measureRebuild(h, added.generation);
    const rebuilt = explicitRebuild.state;
    expectFieldTopologyRebuild(added, rebuilt, 0, 0);
    const rebuildSeries: FieldImage[] = [];
    for (let i = 0; i < 96; i++) rebuildSeries.push(await h.image());
    const reference = average(rebuildSeries.slice(-WINDOW));
    const noise =
      meanAbs(average(rebuildSeries.slice(-2 * WINDOW, -WINDOW)), reference) / reference.mean;
    expect(reference.mean).toBeGreaterThan(0.02);
    const tolerance = Math.max(0.05, 2 * noise);
    const addConvergence = convergence(addSeries, reference, tolerance);
    const rebuildConvergence = convergence(rebuildSeries, reference, tolerance);
    result.convergence = {
      noise,
      tolerance,
      add: addConvergence,
      rebuild: rebuildConvergence,
      addMeans: addSeries.map((image) => image.mean),
      rebuildMeans: rebuildSeries.map((image) => image.mean),
      referenceMean: reference.mean,
    };
    writeFileSync(`${directory}/add-reference-red.f32`, new Uint8Array(reference.red.buffer));
    assert(
      addConvergence.frames !== undefined,
      `add never converged: ${JSON.stringify({ noise, errors: addConvergence.errors })}`,
    );
    expect(addConvergence.errors.at(-1)).toBeLessThan(tolerance);
    // Both paths rebuild the same added scene at the original quality and bounds.
    assert(rebuildConvergence.frames !== undefined);
    expect(addConvergence.frames).toBeLessThanOrEqual(
      explicitRebuild.frames + rebuildConvergence.frames,
    );
    const rebuildTiles = rebuilt.cards?.tiles ?? 0;
    expect(rebuildTiles).toBe(baseTiles + emitterTiles);
    const rebuildProbes = rebuilt.probes?.count ?? 0;
    // Nominal complete-pool capacities and actual Native acceleration counters,
    // not measured voxel dispatches, pass timing or an in-place speedup claim.
    const cost = {
      additionRebuild: {
        atlasTiles: added.cards?.tiles ?? 0,
        voxelCapacity: GRID_VOXELS,
        probeCount: added.probes?.count ?? 0,
        cpuMs: addition.cpuMs,
        framesToReady: addition.frames,
        wallMsToReady: addition.wallMs,
        framesToConverge: addConvergence.frames,
        accelerationBytes: accelerationAdded?.bytesBuilt ?? 0,
      },
      rebuild: {
        atlasTiles: rebuildTiles,
        voxelCapacity: GRID_VOXELS,
        probeCount: rebuildProbes,
        cpuMs: explicitRebuild.cpuMs,
        framesToReady: explicitRebuild.frames,
        wallMsToReady: explicitRebuild.wallMs,
        framesToConverge: explicitRebuild.frames + rebuildConvergence.frames,
        accelerationBytes: rebuilt.acceleration?.bytesBuilt ?? 0,
      },
    };
    expect(cost.additionRebuild.atlasTiles).toBe(cost.rebuild.atlasTiles);
    expect(cost.additionRebuild.voxelCapacity).toBe(cost.rebuild.voxelCapacity);
    expect(cost.additionRebuild.probeCount).toBe(cost.rebuild.probeCount);
    if (rayQuery)
      expect(cost.additionRebuild.accelerationBytes).toBe(cost.rebuild.accelerationBytes);
    result.add = {
      edits: addEdits,
      emitterTiles,
      noise,
      tolerance,
      series: addConvergence.errors,
      rebuildSeries: rebuildConvergence.errors,
    };
    result.cost = cost;

    // (b) Material-only change on the rebuilt field: recapture the emitter's
    // Cards in place, no Global SDF recompose. Captured and inspected via RHI Debug.
    h.world.set(emitter, MeshRenderer, { materials: [h.white] }).unwrap();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const materialCpuMs = await timedDraw(h);
    (await recorder.frameBoundary()).unwrap();
    const repainted = fieldInspection(h);
    expect(repainted.generation).toBe(rebuilt.generation);
    const materialEdits = repainted.edits;
    assert(materialEdits);
    expect(materialEdits).toMatchObject({
      applied: 1,
      rematerializedInstances: 1,
      addedInstances: 0,
      removedInstances: 0,
      movedInstances: 0,
      recapturedTiles: emitterTiles,
      composedVoxels: 0,
    });
    expect(repainted.cards?.tiles).toBe(rebuildTiles);
    // A material edit carries no acceleration work: no BLAS, no TLAS build.
    if (rayQuery) {
      assert(rebuilt.acceleration && repainted.acceleration);
      expect(repainted.acceleration).toMatchObject({
        blasBuilt: rebuilt.acceleration.blasBuilt,
        tlasBuilt: rebuilt.acceleration.tlasBuilt,
        bytesBuilt: rebuilt.acceleration.bytesBuilt,
        settled: true,
      });
    }

    const encoded = (await pending).unwrap();
    writeFileSync(`${directory}/material-edit-frame.rhitape`, encoded.bytes);
    const model = buildFrameModel(decodeTape(encoded.bytes).unwrap());
    // Tapes keep descriptors without labels: shader entry points identify the work.
    const runs = (work: (typeof model.works)[number], entryPoint: string) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === entryPoint);
    const viewport = (work: (typeof model.works)[number]) => {
      for (let i = work.commandIndex; i >= 0; i--) {
        const command = model.commands[i];
        if (command === undefined || command.passIndex !== work.passIndex) break;
        if (command.kind === 'setViewport') {
          const { x, y } = command.params as { x: number; y: number };
          return `${x},${y}`;
        }
      }
      return 'none';
    };
    const cardDraws = model.works.filter((work) => runs(work, 'fs_card'));
    const clearDraws = model.works.filter((work) => runs(work, 'fs_clear'));
    // One Card pipeline per instance section: the emitter's single section only.
    expect(new Set(cardDraws.map((work) => work.pipeline.pipelineHandleId)).size).toBe(1);
    // Card draws and tile clears touch exactly the emitter's tiles.
    expect(new Set(cardDraws.map(viewport)).size).toBe(emitterTiles);
    expect(new Set(clearDraws.map(viewport)).size).toBe(emitterTiles);
    expect(cardDraws.length).toBe(emitterTiles);
    // Global SDF composition is the compute kernel `main`; the field kernels still run.
    expect(model.works.filter((work) => runs(work, 'main'))).toEqual([]);
    expect(model.works.some((work) => runs(work, 'traceProbes'))).toBe(true);
    result.material = {
      edits: materialEdits,
      cpuMs: materialCpuMs,
      tape: {
        digest: encoded.digest,
        works: model.works.length,
        cardDraws: cardDraws.length,
        cardTiles: new Set(cardDraws.map(viewport)).size,
        composeDispatches: 0,
      },
    };

    // No ghost light: with the emitter white nothing emits once its tiles relight.
    for (let i = 0; i < 40; i++) await h.draw();
    const ghostCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const unlit = await h.image();
    (await recorder.frameBoundary()).unwrap();
    const ghostTape = (await ghostCapture).unwrap();
    expect(fieldInspection(h)).toMatchObject({
      generation: rebuilt.generation,
      edits: { pendingTiles: 0, pendingPriorityUpdates: 0 },
    });
    result.ghost = {
      max: max(unlit),
      dark: max(dark),
      reference: max(reference),
      tape: ghostTape.digest,
    };
    if (max(unlit) >= Math.max(max(dark), 1e-3 * max(reference))) {
      writeFileSync(`${directory}/material-ghost-frame.rhitape`, ghostTape.bytes);
      result.ghostMeta = [...new Uint32Array((await h.read('meta')).buffer)];
    }
    expect(max(unlit)).toBeLessThan(Math.max(max(dark), 1e-3 * max(reference)));
    expect(h.errors).toEqual([]);
  } finally {
    writeFileSync(
      `${directory}/add-result.json`,
      JSON.stringify({ result, errors: h.errors, inspection: h.renderer.inspect() }, null, 2),
    );
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});

it('removes a field source in place while Card capture is still progressive', {
  timeout: 900_000,
}, async () => {
  const h = await createIrradianceFieldHarness({ rhi: webgpu.rhi, manifest });
  try {
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    const emitter = h.spawn(await h.slab(1.5, 1.5, 0.25), h.emissive, [...B]);
    h.setGi(irradianceFieldGi({ hysteresis: 0.8, maxDistance: 0.5, cardBudget: 4 }));
    await h.settle(0);
    const start = fieldInspection(h);
    const tiles = start.cards?.tiles ?? 0;
    expect(start.cards?.captured).toBeLessThan(tiles);
    h.world.despawn(emitter).unwrap();
    await h.draw();
    const removed = fieldInspection(h);
    expect(removed.generation).toBe(start.generation);
    expect(removed.edits).toMatchObject({ applied: 1, removedInstances: 1 });
    if (start.traversal === 'ray-query') {
      assert(start.acceleration && removed.acceleration);
      expect(removed.acceleration).toMatchObject({
        instances: start.acceleration.instances - 1,
        blasBuilt: start.acceleration.blasBuilt,
        tlasBuilt: start.acceleration.tlasBuilt + 1,
      });
    }
    // The freed tiles stay inside the allocated atlas; progressive capture finishes.
    expect(removed.cards?.tiles).toBe(tiles);
    for (let i = 0; i < 40; i++) await h.draw();
    const dark = await h.image();
    expect(fieldInspection(h)).toMatchObject({
      generation: start.generation,
      cards: { captured: tiles },
      edits: { pendingTiles: 0, pendingPriorityUpdates: 0 },
    });

    // Re-adding the emitter under the same budget lights the field again: the
    // removal left a usable field, and the lit level bounds the ghost check.
    h.spawn(await h.slab(1.5, 1.5, 0.25), h.emissive, [...B]);
    for (let i = 0; i < 60; i++) await h.draw();
    const relit = await h.image();
    // The tombstone belongs to the old pool. Re-entry is a cold pool with the
    // original three active sources, not reuse of a retired row's identity.
    expectFieldTopologyRebuild(start, fieldInspection(h), 0, 0);
    expect(max(relit)).toBeGreaterThan(0.05);
    expect(max(dark)).toBeLessThan(1e-3 * max(relit));
    writeFileSync(
      `${directory}/add-progressive-result.json`,
      JSON.stringify(
        { tiles, dark: max(dark), relit: max(relit), inspection: h.renderer.inspect() },
        null,
        2,
      ),
    );
    expect(h.errors).toEqual([]);
  } finally {
    await h.dispose();
  }
});
