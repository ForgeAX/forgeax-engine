import { mkdirSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import {
  createIrradianceFieldHarness,
  expectFieldTopologyRebuild,
  type FieldImage,
  fieldInspection,
  irradianceFieldGi,
  SIZE,
} from './renderer-irradiance-field.fixture';
import { persistFieldEditMoveEvidence } from './renderer-irradiance-field-edit-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

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

it('moves and removes a field source in place: only its Cards, its SDF box and nearby probes update', {
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
  const A = [-2, 1, 0.5] as const,
    B = [-2, -1, 0.5] as const;
  try {
    // Preserve the original signal/noise ratio for the three-times-noise
    // movement falsifier, including the native Ray Query traversal.
    const gi = irradianceFieldGi({ hysteresis: 0.8, maxDistance: 0.5, raysPerProbe: 64 });
    h.setGi(gi);
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    await h.settle(0);
    const dark = await h.image();
    const beforeAdd = fieldInspection(h);
    const emitter = h.spawn(await h.slab(1.5, 1.5, 0.25), h.emissive, [...B]);
    await h.settle(40);
    const rebuilt = fieldInspection(h);
    expectFieldTopologyRebuild(beforeAdd, rebuilt, 1, 1);
    // The new pool contains the emitter at B. Its independent dark/energy
    // controls and two temporal windows remain the from-scratch reference.
    const frames: FieldImage[] = [];
    for (let i = 0; i < 2 * WINDOW; i++) frames.push(await h.image());
    const reference = average(frames.slice(0, WINDOW));
    // Temporal noise floor: the next window of the unedited field against the reference.
    const noise = meanAbs(average(frames.slice(WINDOW)), reference) / reference.mean;
    expect(reference.mean).toBeGreaterThan(0.02);
    const start = fieldInspection(h);
    const tiles = start.cards?.tiles ?? 0;
    expect(tiles).toBeGreaterThan(0);
    // Move B -> A, captured as the edit frame and replayed on a fresh device.
    h.world.set(emitter, Transform, { pos: [...A] }).unwrap();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const editFrame = await h.image();
    (await recorder.frameBoundary()).unwrap();
    const moved = fieldInspection(h);
    const encoded = (await pending).unwrap();
    result.move = {
      tiles,
      edits: moved.edits,
      editFrame: editFrame.mean,
      reference: reference.mean,
      noise,
    };
    result.moveEvidence = persistFieldEditMoveEvidence({
      directory,
      size: SIZE,
      encoded,
      dark,
      frames,
      reference,
      edit: editFrame,
      metadata: {
        start,
        moved,
        positions: { A, B },
        window: WINDOW,
        noise,
        workflowGithubSha: process.env.GITHUB_SHA ?? null,
      },
    });
    expect(moved.generation).toBe(start.generation);
    if (start.traversal === 'ray-query') {
      // The edit rebuilds only the TLAS. The next frame retires the old transform.
      assert(start.acceleration && moved.acceleration);
      expect(moved.acceleration).toMatchObject({
        blasBuilt: start.acceleration.blasBuilt,
        tlasBuilt: start.acceleration.tlasBuilt + 1,
        instances: start.acceleration.instances,
        settled: false,
      });
      result.acceleration = { start: start.acceleration, moved: moved.acceleration };
    }
    const edits = moved.edits;
    assert(edits);
    // Adding the emitter rebuilt the pool; only the subsequent move is an edit.
    const added = start.edits;
    assert(added);
    expect(added).toMatchObject({ applied: 0, addedInstances: 0, movedInstances: 0 });
    expect(edits).toMatchObject({
      applied: 1,
      addedInstances: 0,
      movedInstances: 1,
      removedInstances: 0,
    });
    // Three equal slabs: each edit recaptures exactly the emitter's third of the atlas.
    expect(added.recapturedTiles).toBe(0);
    expect((edits.recapturedTiles - added.recapturedTiles) * 3).toBe(tiles);
    expect(edits.composedVoxels).toBeGreaterThan(0);
    expect(edits.composedVoxels).toBeLessThan(17 ** 3 / 4);
    expect(edits.priorityProbes).toBeGreaterThan(0);
    expect(edits.priorityProbes).toBeLessThan(512);
    // Retain the original continuity gate. Its failure alone does not prove that
    // the cache was cleared; the captured inputs above survive either verdict.
    expect(editFrame.mean).toBeGreaterThan(0.5 * reference.mean);
    expect(editFrame.mean).toBeLessThan(4 * reference.mean);
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const entries = model.works.flatMap((work) => work.pipeline.shaders.map((s) => s.entryPoint));
    expect(entries).toEqual(expect.arrayContaining(['fs_clear']));
    const composite = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' &&
          shader.entryPoint === 'fs_ray_diffuse_reconstructed_replace',
      ),
    );
    assert(composite, 'edit frame contains the shared diffuse composite');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const inspected = (await replay.inspectWork(composite.workIndex, ['pixels'])).unwrap();
      assert(inspected.attachment);
      expect(equalBytes(inspected.attachment.bytes, editFrame.bytes)).toBe(true);
    } finally {
      (await replay.dispose()).unwrap();
      webgpu._internal_getRawDevice(device)?.destroy();
    }
    result.replay = { digest: encoded.digest, works: model.works.length, exact: true };

    await h.draw();
    if (moved.traversal === 'ray-query') {
      assert(moved.acceleration);
      expect(fieldInspection(h).acceleration).toMatchObject({
        blasBuilt: moved.acceleration.blasBuilt,
        tlasBuilt: moved.acceleration.tlasBuilt,
        instances: moved.acceleration.instances,
        settled: true,
      });
    }
    for (let i = 1; i < 40; i++) await h.draw();
    const atA: FieldImage[] = [];
    for (let i = 0; i < WINDOW; i++) atA.push(await h.image());
    const movedError = meanAbs(average(atA), reference) / reference.mean;
    expect(movedError).toBeGreaterThan(3 * noise);

    // Move back A -> B: converge to the from-scratch field within tolerance.
    h.world.set(emitter, Transform, { pos: [...B] }).unwrap();
    const series: number[] = [];
    const recent: FieldImage[] = [];
    let converged: number | undefined;
    const tolerance = Math.max(0.05, 2 * noise);
    for (let frame = 1; frame <= 64; frame++) {
      recent.push(await h.image());
      if (recent.length > WINDOW) recent.shift();
      if (recent.length < WINDOW) continue;
      const error = meanAbs(average(recent), reference) / reference.mean;
      series.push(error);
      if (converged === undefined && error < tolerance) converged = frame;
    }
    assert(converged !== undefined, `no convergence: ${JSON.stringify({ noise, series })}`);
    expect(series.at(-1)).toBeLessThan(tolerance);
    expect(fieldInspection(h).generation).toBe(start.generation);
    expect(fieldInspection(h).edits).toMatchObject({ applied: 2, pendingTiles: 0 });
    result.converge = { frames: converged, window: WINDOW, noise, movedError, tolerance, series };

    // Removal: no ghost light remains once the priority sweep finishes.
    h.world.despawn(emitter).unwrap();
    for (let i = 0; i < 40; i++) await h.draw();
    const removed = await h.image();
    expect(fieldInspection(h)).toMatchObject({
      generation: start.generation,
      edits: { applied: 3, removedInstances: 1, pendingTiles: 0, pendingPriorityUpdates: 0 },
    });
    expect(max(removed)).toBeLessThan(Math.max(max(dark), 1e-3 * max(reference)));
    result.remove = { max: max(removed), dark: max(dark), reference: max(reference) };
    expect(h.errors).toEqual([]);
  } finally {
    writeFileSync(
      `${directory}/edit-result.json`,
      JSON.stringify({ result, errors: h.errors, inspection: h.renderer.inspect() }, null, 2),
    );
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});
