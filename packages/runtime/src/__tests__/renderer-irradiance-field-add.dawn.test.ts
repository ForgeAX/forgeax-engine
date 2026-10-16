import { mkdirSync, writeFileSync } from 'node:fs';
import { MeshRenderer } from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import {
  createIrradianceFieldHarness,
  type FieldImage,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/irradiance-field/dawn';
mkdirSync(directory, { recursive: true });

const meanAbs = (a: FieldImage, b: FieldImage) =>
  a.red.reduce((sum, value, i) => sum + Math.abs(value - (b.red[i] ?? NaN)), 0) / a.red.length;
const max = (image: FieldImage) => image.red.reduce((m, value) => Math.max(m, value), 0);
const average = (images: readonly FieldImage[]): FieldImage => {
  const red = new Float32Array(images[0]?.red.length ?? 0);
  for (const image of images)
    for (let i = 0; i < red.length; i++)
      red[i] = (red[i] ?? 0) + (image.red[i] ?? 0) / images.length;
  const mean = red.reduce((sum, v) => sum + v, 0) / red.length;
  return { bytes: new Uint8Array(), red, mean, center: Number.NaN };
};
/** Probe updates leave per-frame noise; compare 8-frame temporal means. */
const WINDOW = 8;
/** 17^3 Global SDF grid of the probe-global profile. */
const GRID_VOXELS = 17 ** 3;
/** Behind the camera: the emitter reaches the image only as indirect light. */
const B = [-2, -1, 0.5] as const;

/** Frames until the trailing `WINDOW` mean first lies within `tolerance` of the reference. */
function convergence(series: readonly FieldImage[], reference: FieldImage, tolerance: number) {
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

it('adds and rematerializes field sources in place: only their Cards, their SDF box and nearby probes update', {
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
    const start = h.inspection();
    const baseTiles = start.cards?.tiles ?? 0;
    expect(baseTiles).toBeGreaterThan(0);
    // (a) Add an emitter after settle. Its mesh digest and Card program admit
    // asynchronously; the add applies in place on the frame admission completes.
    const slab = await h.slab(1.5, 1.5, 0.25);
    const addStarted = performance.now();
    const emitter = h.spawn(slab, h.emissive, [...B]);
    let addFrames = 0;
    let addCpuMs = Number.NaN;
    for (; addFrames < 60; ) {
      const cpu = await timedDraw(h);
      addFrames++;
      if ((h.inspection().edits?.applied ?? 0) > 0) {
        addCpuMs = cpu;
        break;
      }
    }
    const addWallMs = performance.now() - addStarted;
    const added = h.inspection();
    expect(added.generation).toBe(start.generation);
    const addEdits = added.edits;
    assert(addEdits, `add never applied: ${JSON.stringify(added)}`);
    const emitterTiles = (added.cards?.tiles ?? 0) - baseTiles;
    expect(emitterTiles).toBeGreaterThan(0);
    expect(addEdits).toMatchObject({
      applied: 1,
      addedInstances: 1,
      movedInstances: 0,
      removedInstances: 0,
      rematerializedInstances: 0,
      recapturedTiles: emitterTiles,
    });
    // Ray Query: the new slab mesh builds its one BLAS and the TLAS rebuilds once.
    const rayQuery = start.traversal === 'ray-query';
    const accelerationStart = start.acceleration;
    const accelerationAdded = added.acceleration;
    if (rayQuery) {
      assert(accelerationStart && accelerationAdded);
      expect(accelerationAdded).toMatchObject({
        instances: accelerationStart.instances + 1,
        geometries: accelerationStart.geometries + 1,
        blasBuilt: accelerationStart.blasBuilt + 1,
        tlasBuilt: accelerationStart.tlasBuilt + 1,
      });
    }
    expect(addEdits.composedVoxels).toBeGreaterThan(0);
    expect(addEdits.composedVoxels).toBeLessThan(GRID_VOXELS / 4);
    expect(addEdits.priorityProbes).toBeGreaterThan(0);
    expect(addEdits.priorityProbes).toBeLessThan(start.probes?.count ?? 0);
    const addSeries: FieldImage[] = [];
    for (let i = 0; i < 64; i++) {
      if (i !== 63) {
        addSeries.push(await h.image());
        continue;
      }
      // Preserve the actual final edit frame before a forced rebuild replaces
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
        inspection: h.inspection(),
        width: h.canvas.width,
        height: h.canvas.height,
      };
    }
    expect(h.inspection()).toMatchObject({
      generation: start.generation,
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
    const rebuildStarted = performance.now();
    let rebuildFrames = 0;
    let rebuildCpuMs = 0;
    for (;;) {
      rebuildCpuMs += await timedDraw(h);
      rebuildFrames++;
      const state = h.inspection();
      if (state.state === 'failed') throw new Error(JSON.stringify({ state, errors: h.errors }));
      if (state.state === 'ready' && state.submittedFrames > 0) break;
      if (performance.now() - rebuildStarted > 120_000)
        throw new Error(`rebuild did not settle: ${JSON.stringify(state)}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const rebuildWallMs = performance.now() - rebuildStarted;
    const rebuilt = h.inspection();
    expect(rebuilt.generation).toBeGreaterThan(start.generation);
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
    // The add starts from a settled field; it reaches the reference no later than a rebuild.
    assert(rebuildConvergence.frames !== undefined);
    expect(addConvergence.frames).toBeLessThanOrEqual(rebuildFrames + rebuildConvergence.frames);
    const rebuildTiles = rebuilt.cards?.tiles ?? 0;
    expect(rebuildTiles).toBe(baseTiles + emitterTiles);
    const rebuildProbes = rebuilt.probes?.count ?? 0;
    const cost = {
      edit: {
        tiles: addEdits.recapturedTiles,
        voxels: addEdits.composedVoxels,
        probes: addEdits.priorityProbes,
        cpuMs: addCpuMs,
        framesToApply: addFrames,
        wallMsToApply: addWallMs,
        framesToConverge: addConvergence.frames,
        accelerationBytes:
          (accelerationAdded?.bytesBuilt ?? 0) - (accelerationStart?.bytesBuilt ?? 0),
      },
      rebuild: {
        tiles: rebuildTiles,
        voxels: GRID_VOXELS,
        probes: rebuildProbes,
        cpuMs: rebuildCpuMs,
        framesToReady: rebuildFrames,
        wallMsToReady: rebuildWallMs,
        framesToConverge: rebuildFrames + rebuildConvergence.frames,
        accelerationBytes: rebuilt.acceleration?.bytesBuilt ?? 0,
      },
    };
    expect(cost.edit.tiles).toBeLessThan(cost.rebuild.tiles);
    expect(cost.edit.voxels).toBeLessThan(cost.rebuild.voxels);
    expect(cost.edit.probes).toBeLessThan(cost.rebuild.probes);
    if (rayQuery) expect(cost.edit.accelerationBytes).toBeLessThan(cost.rebuild.accelerationBytes);
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
    const repainted = h.inspection();
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
    expect(h.inspection()).toMatchObject({
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
    const start = h.inspection();
    const tiles = start.cards?.tiles ?? 0;
    expect(start.cards?.captured).toBeLessThan(tiles);
    h.world.despawn(emitter).unwrap();
    await h.draw();
    const removed = h.inspection();
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
    expect(h.inspection()).toMatchObject({
      generation: start.generation,
      cards: { captured: tiles },
      edits: { pendingTiles: 0, pendingPriorityUpdates: 0 },
    });

    // Re-adding the emitter under the same budget lights the field again: the
    // removal left a usable field, and the lit level bounds the ghost check.
    h.spawn(await h.slab(1.5, 1.5, 0.25), h.emissive, [...B]);
    for (let i = 0; i < 60; i++) await h.draw();
    const relit = await h.image();
    expect(h.inspection()).toMatchObject({
      generation: start.generation,
      edits: { applied: 2, addedInstances: 1 },
    });
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
