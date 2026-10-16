import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  bindingReadRequest,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { IrradianceFieldProbeState } from '../../../render/src/raytracing/irradiance-field';
import {
  IRRADIANCE_FIELD_DEPTH_BYTES,
  IRRADIANCE_FIELD_META_BYTES,
  IRRADIANCE_FIELD_PROBE_BYTES,
} from '../../../render/src/raytracing/irradiance-field-plan';
import {
  PROBE_ENTRY_FRESH,
  PROBE_ENTRY_INDEX,
  type ProbeCell,
  probeIndex,
} from '../../../render/src/raytracing/probe-clipmap';
import {
  createIrradianceFieldHarness,
  type FieldImage,
  irradianceFieldGi,
  SIZE,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

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
/** Largest jump between adjacent image rows: a level seam shows as a step. */
const rowSteps = (image: FieldImage) => {
  const rows = Array.from({ length: SIZE }, (_, y) => {
    let sum = 0;
    for (let x = 0; x < SIZE; x++) sum += image.red[y * SIZE + x] ?? 0;
    return sum / SIZE;
  });
  return rows.slice(1).map((value, y) => Math.abs(value - (rows[y] ?? 0)));
};
const WINDOW = 8;
const DIMENSIONS = [6, 6, 6] as const;
const LEVELS = 2;
const PER = DIMENSIONS[0] * DIMENSIONS[1] * DIMENSIONS[2];
const BUDGET = 96;
const plan = {
  origin: [-3.5, -3.5, -5.5] as const,
  spacing: 1,
  dimensions: DIMENSIONS,
  levels: LEVELS,
  follow: true,
  probeCount: LEVELS * PER,
  probeBudget: BUDGET,
  levelBudgets: [64, 32],
};

/** Storage slots a window move hands to newly exposed cells (toroidal). */
const exposedSlots = (before: readonly ProbeCell[], after: readonly ProbeCell[]) => {
  const slots = new Set<number>();
  after.forEach((window, level) => {
    const old = before[level] ?? window;
    for (let z = 0; z < DIMENSIONS[2]; z++)
      for (let y = 0; y < DIMENSIONS[1]; y++)
        for (let x = 0; x < DIMENSIONS[0]; x++) {
          const cell: ProbeCell = [window[0] + x, window[1] + y, window[2] + z];
          const inside = cell.every(
            (v, a) => v >= (old[a] ?? 0) && v < (old[a] ?? 0) + DIMENSIONS[a as 0],
          );
          if (!inside) slots.add(probeIndex(plan, level, cell));
        }
  });
  return slots;
};

/** Relocation discards the old-position history and restarts on the next trace. */
const expectFreshProbe = (updates: number | undefined, state: number | undefined) => {
  expect([
    IrradianceFieldProbeState.active,
    IrradianceFieldProbeState.inside,
    IrradianceFieldProbeState.relocated,
  ]).toContain(state);
  expect(updates).toBe(state === IrradianceFieldProbeState.relocated ? 0 : 1);
};

/** Freeze the actual post-integration field, then replay the unchanged gather
 * with both levels and each endpoint. Independent generations have different
 * relocation and histories; they are accuracy references, not convex endpoints. */
async function sameFieldEnvelope(bytes: Uint8Array) {
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const gather = model.works.find((w) =>
    w.pipeline.shaders.some((s) => s.entryPoint === 'gatherField'),
  );
  assert(gather);
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  try {
    const errors: string[] = [];
    const raw = webgpu._internal_getRawDevice(device);
    assert(raw, 'fresh replay device exposes validation events');
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const backend = { device, createShaderModule: webgpu.createShaderModule };
    const fieldReads = [0, 1, 2, 3].map((b) => bindingReadRequest(gather, 1, b).unwrap());
    const outputRead = bindingReadRequest(gather, 0, 9).unwrap();
    const replay = (await openReplay(tape, backend)).unwrap();
    let snapshots: Uint8Array[];
    try {
      snapshots = (await replay.readAtWorks([...fieldReads, outputRead]))
        .unwrap()
        .map((r) => r.unwrap().bytes);
    } finally {
      (await replay.dispose()).unwrap();
    }
    const field = snapshots[0];
    assert(field);
    const perLevel = new Uint32Array(field.slice().buffer)[13];
    assert(perLevel);
    const producers = new Set(
      model.works
        .filter((w) =>
          w.pipeline.shaders.some((s) =>
            ['placeProbes', 'traceProbes', 'updateProbes', 'deriveProbes'].includes(
              s.entryPoint ?? '',
            ),
          ),
        )
        .map((w) => w.eventIndex),
    );
    const outputs: Float32Array[] = [];
    for (const level of [-1, 0, 1]) {
      const data = snapshots.slice(0, 4).map((b) => b.slice());
      const uniform = data[0];
      assert(uniform);
      const u = new Uint32Array(uniform.buffer);
      const f = new Float32Array(uniform.buffer);
      if (level >= 0) {
        u[7] = perLevel;
        u[12] = 1;
        f[11] = 0;
        if (level === 1) {
          // Project the retained coarse level into the one-level input contract.
          for (const i of [3, 8, 9, 10]) f[i] = (f[i] ?? 0) * 2;
          for (const offset of [16, 32, 48]) u.copyWithin(offset, offset + 4, offset + 8);
          for (const [b, stride] of [
            [1, IRRADIANCE_FIELD_PROBE_BYTES],
            [2, IRRADIANCE_FIELD_DEPTH_BYTES],
            [3, IRRADIANCE_FIELD_META_BYTES],
          ] as const) {
            const buffer = data[b];
            assert(buffer);
            const retained = buffer.slice(perLevel * stride, 2 * perLevel * stride);
            buffer.fill(0);
            buffer.set(retained);
          }
        }
      }
      const blobs = data.map((payload) => ({
        hash: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
        bytes: payload,
        compression: 'none' as const,
      }));
      const variant = {
        ...tape,
        blobs: [...tape.blobs, ...blobs],
        bootstrap: tape.bootstrap.map((resource) => {
          const slot = fieldReads.findIndex((r) => r.resourceId === resource.handleId);
          const blob = blobs[slot];
          return blob === undefined
            ? resource
            : {
                ...resource,
                initialData: [{ hash: blob.hash, byteOffset: 0, byteLength: blob.bytes.length }],
              };
        }),
        events: tape.events.map((event, index) => {
          // Preserve command/work coordinates while freezing only probe writers.
          if (event.kind === 'dispatchWorkgroups' && producers.has(index))
            return { ...event, x: 0 };
          if (event.kind === 'writeBuffer' && event.handleId === fieldReads[0]?.resourceId)
            return { ...event, dataHash: blobs[0]?.hash ?? event.dataHash };
          return event;
        }),
      };
      const endpoint = (await openReplay(variant, backend)).unwrap();
      try {
        const output = (await endpoint.readAtWorks([outputRead])).unwrap()[0];
        assert(output);
        const pixels = new Float32Array(output.unwrap().bytes.slice().buffer);
        outputs.push(pixels);
        writeFileSync(`${directory}/clipmap-same-field-${level}.bin`, pixels);
      } finally {
        (await endpoint.dispose()).unwrap();
      }
    }
    const recordedBytes = snapshots[4];
    assert(recordedBytes);
    const recorded = new Float32Array(recordedBytes.slice().buffer);
    const [mixed, fine, coarse] = outputs;
    assert(mixed && fine && coarse);
    let outside = 0;
    let maximumOutside = 0;
    let replayError = 0;
    let supported = 0;
    for (let i = 0; i < mixed.length; i += 4) {
      if (mixed[i + 3] === 1) {
        const endpoints = [fine, coarse].filter((p) => p[i + 3] === 1);
        assert(endpoints.length > 0, 'a valid blend requires a supported endpoint');
        supported++;
        for (let c = 0; c < 3; c++) {
          const values = endpoints.map((p) => p[i + c] ?? NaN);
          const value = mixed[i + c] ?? NaN;
          const error = Math.max(0, Math.min(...values) - value, value - Math.max(...values));
          outside += error;
          maximumOutside = Math.max(maximumOutside, error);
        }
      }
      for (let c = 0; c < 4; c++)
        replayError = Math.max(
          replayError,
          Math.abs((mixed[i + c] ?? NaN) - (recorded[i + c] ?? NaN)),
        );
    }
    expect(replayError).toBeLessThanOrEqual(2e-6);
    expect(maximumOutside).toBeLessThanOrEqual(2e-6);
    expect(supported).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    return { outside: outside / (3 * supported), maximumOutside, replayError, supported, errors };
  } finally {
    webgpu._internal_getRawDevice(device)?.destroy();
  }
}

it('scrolls camera-following probe clipmaps: only exposed slabs restart, no seams, pops or leaks', {
  timeout: 1_500_000,
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
  const clipmapGi = irradianceFieldGi({
    hysteresis: 0.8,
    probeBudget: BUDGET,
    clipmap: { levels: LEVELS, dimensions: [...DIMENSIONS] },
  });
  let probeStates: number[] = [];
  const readMeta = async () => {
    const words = new Uint32Array((await h.read('meta')).buffer);
    probeStates = Array.from({ length: plan.probeCount }, (_, probe) => words[probe * 4 + 1] ?? 0);
    return Array.from({ length: plan.probeCount }, (_, probe) => words[probe * 4] ?? 0);
  };
  const clipmap = () => {
    const inspection = h.inspection();
    assert('gather' in inspection && inspection.gather === 'irradiance-field');
    const state = inspection.probes?.clipmap;
    assert(state, 'the field exposes its clipmap scheduler');
    return state;
  };
  const converge = async (reference: FieldImage, tolerance: number, limit: number) => {
    const series: number[] = [];
    const recent: FieldImage[] = [];
    for (let frame = 1; frame <= limit; frame++) {
      recent.push(await h.image());
      if (recent.length > WINDOW) recent.shift();
      if (recent.length < WINDOW) continue;
      const error = meanAbs(average(recent), reference) / reference.mean;
      series.push(error);
      if (error < tolerance) return { frames: frame, series };
    }
    return { frames: undefined, series };
  };
  const look = (x: number) => h.world.set(h.camera, Transform, { pos: [x, 0, 0] }).unwrap();
  // Capture the final measured frame, without adding a draw to the comparison window.
  const measuredWindow = async (name: string) => {
    const images: FieldImage[] = [];
    for (let i = 0; i < WINDOW; i++) {
      const capture = i === WINDOW - 1 ? recorder.captureFrame() : undefined;
      if (capture) (await recorder.frameBoundary()).unwrap();
      images.push(await h.image());
      if (capture) {
        (await recorder.frameBoundary()).unwrap();
        writeFileSync(`${directory}/clipmap-${name}.rhitape`, (await capture).unwrap().bytes);
      }
    }
    const image = average(images);
    result[name] = {
      mean: image.mean,
      red: Array.from(image.red),
      inspection: h.inspection(),
    };
    return image;
  };
  try {
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    const emitter = h.spawn(await h.slab(1.5, 1.5, 0.25), h.emissive, [-1.5, -0.5, -1.5]);
    h.setGi(clipmapGi);
    await h.settle(60);
    expect(clipmap()).toMatchObject({ levels: LEVELS, levelBudgets: [64, 32] });
    const still: FieldImage[] = [];
    for (let i = 0; i < 2 * WINDOW; i++) still.push(await h.image());
    const start = average(still.slice(0, WINDOW));
    const noise = meanAbs(average(still.slice(WINDOW)), start) / start.mean;
    expect(start.mean).toBeGreaterThan(0.02);
    // Per-frame temporal noise at a still camera: the floor any pop must be compared against.
    const stillDeltas = still
      .slice(1)
      .map((image, i) => meanAbs(image, still[i] ?? image) / start.mean);

    // Fly-through along +x: crossings at x = 0.5 (both levels) and 1.5 (level 0).
    const steps: {
      x: number;
      exposed: number;
      restarted: number;
      expected: number;
      delta: number;
      ms: number;
    }[] = [];
    let previous = still.at(-1) ?? start;
    let meta = await readMeta();
    let capture: Promise<unknown> | undefined;
    let captured: { x: number; windows: readonly ProbeCell[]; slots: Set<number> } | undefined;
    for (let step = 1; step <= 12; step++) {
      const x = step * 0.125;
      const before = clipmap();
      look(x);
      const scrolls = before.scrolls.reduce((n, v) => n + v, 0);
      const crossing = x === 0.5;
      if (crossing) capture = recorder.captureFrame();
      if (crossing) (await recorder.frameBoundary()).unwrap();
      const t0 = performance.now();
      const image = await h.image();
      const ms = performance.now() - t0;
      if (crossing) (await recorder.frameBoundary()).unwrap();
      const after = clipmap();
      const next = await readMeta();
      // Preserve the real failing scroll frame before any restart assertion.
      if (crossing && capture !== undefined) {
        const encoded = (await capture) as Awaited<ReturnType<typeof recorder.captureFrame>>;
        writeFileSync(`${directory}/clipmap-scroll.rhitape`, encoded.unwrap().bytes);
      }
      // A restarted probe has discarded its previous cell history; relocation keeps zero.
      const restarted = new Set(
        next.flatMap((count, probe) => (count < (meta[probe] ?? 0) ? [probe] : [])),
      );
      const slots = exposedSlots(before.windows, after.windows);
      result.restart = {
        x,
        exposed: [...slots],
        restarted: [...restarted],
        before: meta,
        after: next,
        states: probeStates,
      };
      expect([...restarted].sort((a, b) => a - b)).toEqual([...slots].sort((a, b) => a - b));
      for (const probe of slots) expectFreshProbe(next[probe], probeStates[probe]);
      expect(after.exposedProbes - before.exposedProbes).toBe(slots.size);
      expect(after.pendingExposedProbes).toBe(0);
      if (after.scrolls.reduce((n, v) => n + v, 0) > scrolls)
        expect(slots.size % (DIMENSIONS[1] * DIMENSIONS[2])).toBe(0);
      if (crossing) captured = { x, windows: after.windows, slots };
      steps.push({
        x,
        exposed: after.exposedProbes - before.exposedProbes,
        restarted: restarted.size,
        expected: slots.size,
        delta: meanAbs(image, previous) / start.mean,
        ms,
      });
      previous = image;
      meta = next;
    }
    const scrollSteps = steps.filter((s) => s.exposed > 0);
    expect(scrollSteps.map((s) => s.exposed)).toEqual([2 * 36, 36]);
    // No popping: a scroll frame changes the image no more than the same sub-cell
    // camera move one step before or after it (the first moves also settle view-
    // dependent history, so only adjacent non-scroll steps are a fair reference).
    const pops = steps.flatMap((s, i) => {
      if (s.exposed === 0) return [];
      const neighbours = [steps[i - 1], steps[i + 1]].filter(
        (n): n is (typeof steps)[number] => n !== undefined && n.exposed === 0,
      );
      return [{ x: s.x, delta: s.delta, reference: Math.max(...neighbours.map((n) => n.delta)) }];
    });
    result.flyThrough = { steps, pops, stillDeltas, noise };
    for (const pop of pops) expect(pop.delta).toBeLessThan(1.5 * pop.reference + 2 * noise);

    // RHI Debug: the captured scroll frame's update dispatch reads the toroidal list.
    assert(capture && captured);
    const encoded = (await capture) as Awaited<ReturnType<typeof recorder.captureFrame>>;
    const tape = decodeTape(encoded.unwrap().bytes).unwrap();
    writeFileSync(`${directory}/clipmap-scroll.rhitape`, encoded.unwrap().bytes);
    const model = buildFrameModel(tape);
    const work = (entry: string) =>
      model.works.find((w) => w.pipeline.shaders.some((s) => s.entryPoint === entry));
    const update = work('updateProbes');
    const trace = work('traceProbes');
    assert(update && trace, 'scroll frame traces and integrates probes');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const timed = adapter.features.has('timestamp-query');
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const list = bindingReadRequest(update, 0, 6);
      const metaRead = bindingReadRequest(update, 0, 3);
      const frameRead = bindingReadRequest(update, 0, 5);
      assert(list.ok && metaRead.ok && frameRead.ok);
      const [listRow, metaRow, frameRow] = (
        await replay.readAtWorks([list.value, metaRead.value, frameRead.value])
      ).unwrap();
      assert(listRow?.ok && metaRow?.ok && frameRow?.ok);
      const scheduled = new Uint32Array(frameRow.value.bytes.slice().buffer)[1];
      assert(scheduled !== undefined && scheduled > 0 && scheduled <= BUDGET);
      const entries = new Uint32Array(listRow.value.bytes.slice().buffer).subarray(0, scheduled);
      const replayMeta = new Uint32Array(metaRow.value.bytes.slice().buffer);
      const fresh = [...entries].filter((e) => (e & PROBE_ENTRY_FRESH) !== 0);
      const freshSlots = fresh.map((e) => e & PROBE_ENTRY_INDEX).sort((a, b) => a - b);
      expect(freshSlots).toEqual([...captured.slots].sort((a, b) => a - b));
      for (const slot of freshSlots)
        expectFreshProbe(replayMeta[slot * 4], replayMeta[slot * 4 + 1]);
      // Every slot is listed once: no two workgroups integrate the same probe.
      const indices = [...entries].map((e) => e & PROBE_ENTRY_INDEX);
      expect(new Set(indices).size).toBe(scheduled);
      const timing = timed ? (await replay.timePasses()).unwrap() : undefined;
      const passes = timing?.passes
        .filter((p) => p.label?.startsWith('irradiance-field.'))
        .map((p) => ({ label: p.label, ms: (p.gpuNanoseconds ?? 0) / 1e6 }));
      result.capture = {
        works: model.works.length,
        fresh: fresh.length,
        windows: captured.windows,
        passes: passes ?? 'timestamp-query unavailable on the replay adapter',
        totalMs: timing === undefined ? null : timing.totalGpuNanoseconds / 1e6,
      };
    } finally {
      (await replay.dispose()).unwrap();
      webgpu._internal_getRawDevice(device)?.destroy();
    }

    // Seams: the converged clipmap at the new view against a single fixed lattice.
    for (let i = 0; i < 40; i++) await h.draw();
    const clipImage = await measuredWindow('comparison');
    const envelope = await sameFieldEnvelope(
      new Uint8Array(readFileSync(`${directory}/clipmap-comparison.rhitape`)),
    );
    result.sameFieldEnvelope = envelope;
    // Before: without toroidal scrolling the moved window is rebuilt and re-converges
    // (same plan; only the Card budget differs, which forces a new generation).
    const rebuildStart = performance.now();
    h.setGi(
      irradianceFieldGi({
        hysteresis: 0.8,
        probeBudget: BUDGET,
        cardBudget: 4095,
        clipmap: { levels: LEVELS, dimensions: [...DIMENSIONS] },
      }),
    );
    await h.settle(0);
    const rebuild = await converge(clipImage, Math.max(0.1, 3 * noise), 160);
    const rebuildMs = performance.now() - rebuildStart;
    // Seam reference: one fixed lattice spanning the region at the same view.
    h.setGi(irradianceFieldGi({ hysteresis: 0.8, probeBudget: BUDGET }));
    await h.settle(60);
    const fixedImage = await measuredWindow('fixed-reference');
    // Independent coarse generation: an accuracy reference, with its own history
    // and relocation. Convexity is checked above on the captured field's endpoints.
    const coarseGi = irradianceFieldGi({ hysteresis: 0.8, probeBudget: BUDGET });
    h.setGi({ ...coarseGi, field: { ...coarseGi.field, probeSpacing: 2 * plan.spacing } });
    await h.settle(60);
    const coarseImage = await measuredWindow('coarse-reference');
    const clipSteps = rowSteps(clipImage);
    const fixedSteps = rowSteps(fixedImage);
    const seam = Math.max(...clipSteps.map((s, y) => s - (fixedSteps[y] ?? 0))) / start.mean;
    const outside =
      clipImage.red.reduce((sum, v, i) => {
        const a = fixedImage.red[i] ?? 0;
        const b = coarseImage.red[i] ?? 0;
        return sum + Math.max(0, Math.min(a, b) - v, v - Math.max(a, b));
      }, 0) /
      clipImage.red.length /
      fixedImage.mean;
    const levelError = meanAbs(clipImage, fixedImage) / fixedImage.mean;
    const coarseError = meanAbs(coarseImage, fixedImage) / fixedImage.mean;
    result.seam = {
      seam,
      outside,
      levelError,
      coarseError,
      clipMean: clipImage.mean,
      fixedMean: fixedImage.mean,
      coarseMean: coarseImage.mean,
      clipSteps,
      fixedSteps,
    };
    result.rebuild = {
      fresh: plan.probeCount,
      frames: rebuild.frames ?? null,
      series: rebuild.series,
      ms: rebuildMs,
    };

    // Leak: an emitter behind the wall must not light the visible front.
    h.setGi(clipmapGi);
    h.world.despawn(emitter).unwrap();
    await h.settle(40);
    const dark = await h.image();
    const hidden = h.spawn(await h.slab(1.5, 1.5, 0.25), h.emissive, [1.5, 0, -4.5]);
    for (let i = 0; i < 40; i++) await h.draw();
    const leaked = max(await measuredWindow('hidden-emitter'));
    // Independent cold generations keep both public field controls comparable.
    // Disabling radiosity is a diagnostic, never a replacement for the original
    // multi-bounce acceptance measurement above. The same 40-frame warmup and
    // eight-frame capture window apply to all four controls.
    const hiddenField: Record<string, { max: number; mean: number }> = {};
    for (const radiosity of [false, true]) {
      for (const resolution of ['half', 'full'] as const) {
        h.setGi(undefined);
        await h.draw();
        h.setGi(
          irradianceFieldGi({
            hysteresis: 0.8,
            probeBudget: BUDGET,
            clipmap: { levels: LEVELS, dimensions: [...DIMENSIONS] },
            radiosity,
            resolution,
          }),
        );
        await h.settle(40);
        const name = `hidden-field-${radiosity ? 'feedback' : 'direct'}-${resolution}`;
        const image = await measuredWindow(name);
        hiddenField[name] = { max: max(image), mean: image.mean };
      }
    }
    // Exact transport controls distinguish cache leakage from light reaching the
    // visible floor around the finite wall. Keep the original field bounds below.
    const exactHidden: Record<number, { max: number; mean: number }> = {};
    for (const maxBounces of [1, 3]) {
      h.setGi({ gather: 'exact', maxBounces, maxDistance: 100, seed: 47, environment: [0, 0, 0] });
      await h.settle(0);
      const reference = await measuredWindow(`hidden-exact-${maxBounces}`);
      exactHidden[maxBounces] = { max: max(reference), mean: reference.mean };
    }
    result.leak = { leaked, dark: max(dark), lit: max(start), hiddenField, exactHidden };
    h.world.despawn(hidden).unwrap();
    expect.soft(seam).toBeLessThan(0.25);
    expect.soft(envelope.outside / fixedImage.mean).toBeLessThan(Math.max(0.02, 2 * noise));
    // The finer level only adds accuracy over the coarse lattice alone.
    expect.soft(levelError).toBeLessThan(coarseError);
    const leakBound = Math.max(max(dark), 0.02 * max(start));
    expect.soft(leaked).toBeLessThan(leakBound);
    for (const [name, control] of Object.entries(hiddenField))
      expect.soft(control.max, name).toBeLessThan(leakBound);
    expect(h.errors).toEqual([]);
  } finally {
    writeFileSync(
      `${directory}/clipmap-result.json`,
      JSON.stringify({ result, errors: h.errors, inspection: h.renderer.inspect() }, null, 2),
    );
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});
