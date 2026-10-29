import { mkdirSync, writeFileSync } from 'node:fs';
import { halfFloat } from '@forgeax/engine-math';
import { DirectionalLight } from '@forgeax/engine-render';
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
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import {
  IRRADIANCE_FIELD_RELOCATION,
  IrradianceFieldProbeState,
} from '../../../render/src/raytracing/irradiance-field';
import { planIrradianceField } from '../../../render/src/raytracing/irradiance-field-plan';
import {
  createIrradianceFieldHarness,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/irradiance-field/dawn';
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFileSync(
    `${directory}/${name}`,
    value instanceof Uint8Array ? value : JSON.stringify(value, null, 2),
  );

const PASSES = [
  'irradiance-field.card-surface',
  'irradiance-field.card-lighting',
  'irradiance-field.place-probes',
  'irradiance-field.trace-probes',
  'irradiance-field.update-probes',
  'irradiance-field.radiosity',
  'irradiance-field.gather',
  'irradiance-field.upsample',
  'irradiance-field.composite',
];
const L = 0.5;
/** Card texels per tile at the fixture's `cards.resolution` (16). */
const CARD_TEXELS = 16 * 16;

function fieldInspection(h: Awaited<ReturnType<typeof createIrradianceFieldHarness>>) {
  const state = h.inspection();
  assert('gather' in state && state.gather === 'irradiance-field');
  return state;
}

/** Lattice point, relocated position and classification of every level-0 probe. */
async function probePlacement(h: Awaited<ReturnType<typeof createIrradianceFieldHarness>>) {
  const plan = planIrradianceField(irradianceFieldGi().field).unwrap();
  const state = fieldInspection(h);
  assert(state.probes !== undefined);
  const window = state.probes.clipmap.windows[0] ?? [0, 0, 0];
  const meta = new Uint32Array((await h.read('meta')).buffer);
  const [dx, dy, dz] = plan.dimensions;
  return Array.from({ length: dx * dy * dz }, (_, probe) => {
    const p = [probe % dx, Math.floor(probe / dx) % dy, Math.floor(probe / (dx * dy))];
    const lattice = p.map((v, a) => {
      const d = plan.dimensions[a] ?? 1;
      const w = window[a] ?? 0;
      return (plan.origin[a] ?? 0) + (w + ((((v - w) % d) + d) % d)) * plan.spacing;
    });
    const z = meta[probe * 4 + 2] ?? 0;
    const w = meta[probe * 4 + 3] ?? 0;
    const offset = [
      halfFloat.f16ToF32(z & 0xffff),
      halfFloat.f16ToF32(z >>> 16),
      halfFloat.f16ToF32(w & 0xffff),
    ];
    return {
      lattice,
      offset,
      position: lattice.map((v, a) => v + (offset[a] ?? 0)),
      state: meta[probe * 4 + 1],
    };
  });
}

it('lights, bleeds, blocks, invalidates, converges, replays and recovers in the ordinary Renderer', {
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
    // No light, no environment, no emission: the enabled lane adds exactly zero.
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const dark = await h.image();
    h.setGi(irradianceFieldGi());
    await h.settle();
    const off = await h.image();
    expect(h.errors).toEqual([]);
    expect(off.bytes).toEqual(dark.bytes);
    expect(h.renderer.inspect().perFramePassNames).toEqual(expect.arrayContaining(PASSES));
    expect(fieldInspection(h)).toMatchObject({
      gather: 'irradiance-field',
      probes: {
        dimensions: [8, 8, 8],
        count: 512,
        perFrame: 512,
        raysPerProbe: irradianceFieldGi().field.raysPerProbe,
      },
    });

    // Offscreen emitter behind the camera lights the wall through the field only.
    const emptyGeneration = fieldInspection(h).generation;
    const emitter = h.spawn(h.emitterMesh, h.emissive, [0, 0, 1]);
    await h.settle();
    // Adding a field source is an in-place edit of the prepared field on both
    // lanes; a Ray Query field builds the new mesh's BLAS and rebuilds its TLAS.
    const rayQuery = fieldInspection(h).traversal === 'ray-query';
    expect(fieldInspection(h)).toMatchObject({
      generation: emptyGeneration,
      edits: { addedInstances: 1, pendingTiles: 0 },
    });
    const addedAcceleration = fieldInspection(h).acceleration;
    if (rayQuery) expect(addedAcceleration).toMatchObject({ pending: 0, settled: true });
    const bleed = await h.image();
    expect(bleed.center).toBeGreaterThan(0.05);

    // Thin-wall falsifier: the same emitter behind the 0.25 wall. The field
    // holds its light (probes behind the wall are lit) and none reaches the front.
    h.world.despawn(emitter).unwrap();
    const hidden = h.spawn(h.emitterMesh, h.emissive, [0, 0, -5]);
    await h.settle();
    const blocked = await h.image();
    const lit = (await h.read('irradiance')).reduce((max, value) => Math.max(max, value), 0);
    expect(lit).toBeGreaterThan(0.5);
    expect(blocked.center).toBeLessThan(0.02 * bleed.center);
    const blockedMax = blocked.red.reduce((max, value) => Math.max(max, value), 0);
    expect(blockedMax).toBeLessThan(0.05 * bleed.center);

    // Scene edit: removing the source is an in-place edit (same generation) that
    // relights the Cards and sweeps nearby probes until no lit probe remains.
    const beforeRemoval = fieldInspection(h).generation;
    h.world.despawn(hidden).unwrap();
    await h.settle(24);
    expect(fieldInspection(h)).toMatchObject({
      generation: beforeRemoval,
      // The emitter moved behind the wall as one removal plus one add, then the removal.
      edits: {
        addedInstances: 2,
        removedInstances: 2,
        pendingTiles: 0,
        pendingPriorityUpdates: 0,
      },
    });
    if (rayQuery) {
      // The re-added emitter reuses its mesh's BLAS and each roster change rebuilds
      // the TLAS only; the emitter's final removal releases its BLAS.
      assert(addedAcceleration);
      expect(fieldInspection(h).acceleration).toMatchObject({
        geometries: addedAcceleration.geometries - 1,
        blasBuilt: addedAcceleration.blasBuilt,
        settled: true,
      });
      expect(fieldInspection(h).acceleration?.tlasBuilt).toBeGreaterThan(
        addedAcceleration.tlasBuilt,
      );
    }
    const ghost = (await h.image()).red.reduce((max, value) => Math.max(max, value), 0);
    expect(ghost).toBeLessThan(1e-3 * bleed.center);
    result.emissive = { bleed: bleed.center, blocked: blocked.center, blockedMax, fieldMax: lit };

    // White furnace: albedo-1 wall and floor under a uniform environment.
    // One bounce loses the floor<->wall exchange; radiosity recovers D = L.
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    h.setGi(irradianceFieldGi({ environment: [L, L, L], radiosity: false }));
    await h.settle(16);
    const single = await h.image();
    h.setGi(irradianceFieldGi({ environment: [L, L, L] }));
    await h.settle(0);
    const series: number[] = [];
    for (let i = 0; i < 24; i++) series.push((await h.image()).mean);
    const furnace = await h.image();
    for (let i = 1; i < series.length; i++)
      expect(series[i] ?? NaN).toBeGreaterThan((series[i - 1] ?? NaN) - 0.01 * L);
    expect(furnace.mean).toBeGreaterThan(single.mean + 0.01 * L);
    expect(furnace.mean).toBeLessThan(L * 1.05);
    expect(furnace.mean).toBeGreaterThan(L * 0.9);
    const furnaceMax = furnace.red.reduce((max, value) => Math.max(max, value), 0);
    expect(furnaceMax).toBeLessThan(L * 1.1);
    result.furnace = { L, single: single.mean, mean: furnace.mean, max: furnaceMax, series };

    // Relocation falsifier: a resolvable block (wider than the 0.5 Global SDF
    // voxel) holds eight lattice probes 0.2 inside its faces. They step out or
    // classify inside; no active probe shades from inside it, and probes in open
    // space keep their lattice point.
    const block = h.spawn(await h.slab(1.4, 1.4, 1.4), h.white, [1, 1, 0]);
    await h.settle(16);
    const boxes = [
      { min: [0.3, 0.3, -0.7], max: [1.7, 1.7, 0.7] },
      { min: [-4, -1.625, -6], max: [4, -1.375, 2] },
      { min: [-4, -4, -3.125], max: [4, 4, -2.875] },
    ];
    const gap = (q: readonly number[]) =>
      Math.min(
        ...boxes.map((box) =>
          Math.hypot(...q.map((v, a) => Math.max((box.min[a] ?? 0) - v, 0, v - (box.max[a] ?? 0)))),
        ),
      );
    const inBlock = (q: readonly number[]) =>
      q.every((v, a) => v > (boxes[0]?.min[a] ?? 0) && v < (boxes[0]?.max[a] ?? 0));
    const placement = await probePlacement(h);
    const enclosed = placement.filter((p) => inBlock(p.lattice));
    expect(enclosed.length).toBe(8);
    for (const p of enclosed) {
      expect(p.state, JSON.stringify(p)).not.toBe(IrradianceFieldProbeState.untraced);
      if (p.state === IrradianceFieldProbeState.active)
        expect(inBlock(p.position), JSON.stringify(p)).toBe(false);
    }
    const open = placement.filter((p) => gap(p.lattice) > 0.5);
    expect(open.length).toBeGreaterThan(64);
    for (const p of open) {
      expect(p.state, JSON.stringify(p)).toBe(IrradianceFieldProbeState.active);
      expect(Math.max(...p.offset.map(Math.abs)), JSON.stringify(p)).toBeLessThan(1e-3);
    }
    for (const p of placement)
      expect(Math.max(...p.offset.map(Math.abs))).toBeLessThanOrEqual(
        IRRADIANCE_FIELD_RELOCATION.limit + 1e-3,
      );
    result.placement = {
      enclosed: enclosed.map(({ offset, state }) => ({ offset, state })),
      open: open.length,
      states: Object.fromEntries(
        Object.entries(IrradianceFieldProbeState).map(([name, state]) => [
          name,
          placement.filter((p) => p.state === state).length,
        ]),
      ),
    };

    // Capture the production frame and replay its composite on a fresh device.
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const captured = await h.image();
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await pending).unwrap();
    save('renderer.rhitape', encoded.bytes);
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const composite = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' && shader.entryPoint === 'fs_ray_diffuse_reconstructed',
      ),
    );
    assert(composite, 'frame contains the shared diffuse composite');
    const computeEntries = model.works.flatMap((work) =>
      work.pipeline.shaders.filter((shader) => shader.stage === 'compute').map((s) => s.entryPoint),
    );
    expect(computeEntries).toEqual(
      expect.arrayContaining([
        'placeProbes',
        'traceProbes',
        'updateProbes',
        'deriveProbes',
        'radiateCards',
        'gatherField',
        'upsampleField',
      ]),
    );
    // Static lights and scene: Card direct light is current, so the settled frame
    // re-surfaces and relights nothing; radiosity re-gathers a rotating fraction of tiles
    // (all of them here: one probe sweep fits in a frame, see irradianceFieldRadiosityPeriod).
    expect(computeEntries).not.toContain('cardSurface');
    expect(computeEntries).not.toContain('lightCards');
    const steady = fieldInspection(h);
    assert(steady.cards);
    expect(steady.cards).toMatchObject({ relit: 0, radiated: steady.cards.perFrame });
    const radiate = model.works.find((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'radiateCards'),
    );
    assert(radiate, 'frame contains the radiosity dispatch');
    const groups = radiate.drawCall as { x: number; y: number };
    const radiosityThreads = groups.x * groups.y * 64;
    expect(radiosityThreads).toBeGreaterThanOrEqual(steady.cards.radiated * CARD_TEXELS);
    expect(radiosityThreads).toBeLessThan((steady.cards.radiated + 1) * CARD_TEXELS);
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
      expect(inspected.attachment.bytes).toEqual(captured.bytes);
    } finally {
      (await replay.dispose()).unwrap();
      webgpu._internal_getRawDevice(device)?.destroy();
    }
    result.replay = {
      digest: encoded.digest,
      works: model.works.length,
      exact: true,
      cards: steady.cards,
      radiosityThreads,
    };
    h.world.despawn(block).unwrap();
    await h.settle(24);

    // A rejected submit neither advances the schedule nor counts as a frame.
    const frames = fieldInspection(h).submittedFrames;
    h.rejectNextSubmit();
    expect(h.submit().ok).toBe(false);
    expect(fieldInspection(h).submittedFrames).toBe(frames);
    h.errors.length = 0;
    await h.draw();
    expect(fieldInspection(h).submittedFrames).toBe(frames + 1);

    // Resize keeps the field: only the view gather targets are replaced.
    const beforeResize = fieldInspection(h).generation;
    h.canvas.width = h.canvas.height = 16;
    await h.settle(2);
    expect(fieldInspection(h).pixelCount).toBe(256);
    expect(fieldInspection(h).generation).toBe(beforeResize);
    const small = await h.image();
    expect(Math.abs(small.mean - furnace.mean)).toBeLessThan(0.05 * L);
    h.canvas.width = h.canvas.height = 32;
    await h.settle(2);
    expect(fieldInspection(h).pixelCount).toBe(1024);
    result.resize = { small: small.mean };

    // A light change relights every Card tile in one frame; the next frame is static again.
    h.setSun(1);
    await h.draw();
    const relit = fieldInspection(h);
    assert(relit.cards);
    expect(relit.cards).toMatchObject({ relit: relit.cards.tiles, radiated: relit.cards.tiles });
    await h.draw();
    expect(fieldInspection(h)).toMatchObject({ cards: { relit: 0 } });
    h.setSun(0);
    result.relight = relit.cards;

    // Disable retires every field buffer after its submitted work completes.
    const live = h.liveBuffers();
    expect(live.length).toBeGreaterThan(8);
    h.setGi(undefined);
    await h.draw();
    expect(h.renderer.inspect().diffuseGi).toBeUndefined();
    await expect
      .poll(async () => {
        await h.draw();
        return live.every((buffer) => h.destroyed.has(buffer));
      })
      .toBe(true);
    h.setGi(irradianceFieldGi({ environment: [L, L, L] }));
    await h.settle(24);
    const beforeLoss = await h.image();

    // Device loss rebuilds the field from zero history to the same furnace.
    const old = h.native();
    h.loseDevice();
    await expect.poll(() => h.renderer.state()).toBe('device-lost');
    h.errors.length = 0;
    renderValue(await h.renderer.recover());
    old?.destroy();
    expect(h.native()).not.toBe(old);
    await h.settle(24);
    const recovered = await h.image();
    expect(Math.abs(recovered.mean - beforeLoss.mean)).toBeLessThan(0.03 * L);
    expect(h.errors).toEqual([]);
    result.recovery = { before: beforeLoss.mean, after: recovered.mean };
    save('result.json', result);
  } finally {
    save('latest-state.json', { result, errors: h.errors, inspection: h.renderer.inspect() });
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});

it('stays within a bounded error of the exact one-bounce lane without steady Card recapture', {
  timeout: 900_000,
}, async () => {
  const h = await createIrradianceFieldHarness({
    rhi: webgpu.rhi,
    manifest,
    host: { gpuPassTiming: { maxPassesPerFrame: 96, maxFramesInFlight: 2, retentionFrames: 8 } },
  });
  try {
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    h.setSun(1);
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const direct = await h.image();
    expect(direct.center).toBeGreaterThan(0.1);
    const environment = [0.25, 0.25, 0.25] as const;
    h.setGi({
      gather: 'exact',
      maxBounces: 1,
      maxDistance: 100,
      seed: 47,
      environment,
      reconstruction: 'combined',
    });
    await h.settle(32);
    const exact = await h.image();
    const errorOf = async (resolution: 'full' | 'half') => {
      h.setGi(irradianceFieldGi({ environment, radiosity: false, resolution }));
      await h.settle(16);
      const field = await h.image();
      let sum = 0;
      let reference = 0;
      let max = 0;
      for (let i = 0; i < field.red.length; i++) {
        const a = (field.red[i] ?? 0) - (direct.red[i] ?? 0);
        const b = (exact.red[i] ?? 0) - (direct.red[i] ?? 0);
        sum += Math.abs(a - b);
        reference += b;
        max = Math.max(max, Math.abs(a - b));
      }
      return {
        meanAbsolute: sum / field.red.length,
        meanExact: reference / field.red.length,
        meanRelative: sum / reference,
        max,
      };
    };
    const full = await errorOf('full');
    const half = await errorOf('half');
    expect(full.meanExact).toBeGreaterThan(0.02);
    expect(full.meanRelative).toBeLessThan(0.25);
    expect(half.meanRelative).toBeLessThan(0.25);

    /** Measured irradiance-field pass durations of one drawn frame, or the absence. */
    const frameTimes = async () => {
      const frame = await h.draw();
      const timings = renderValue(
        await h.renderer.observe(frame, { include: ['timings'] }),
      ).timings;
      assert(timings);
      // Timestamp queries are a capability; keep the structured absence.
      if (timings.status !== 'complete' && timings.status !== 'partial') return timings;
      return new Map(
        timings.frame.passes
          .filter((pass) => pass.passName.startsWith('irradiance-field.'))
          .flatMap((pass) =>
            pass.status === 'measured' ? [[pass.passName, pass.durationNanoseconds] as const] : [],
          ),
      );
    };
    const steadyPasses = await h.steadyPasses();
    if (Array.isArray(steadyPasses))
      for (const names of steadyPasses) {
        const cardDirect = ['irradiance-field.card-surface', 'irradiance-field.card-lighting'];
        expect(names).toEqual(
          expect.arrayContaining(PASSES.filter((name) => !cardDirect.includes(name))),
        );
        // Compose/capture is one-shot; Card lighting only runs on changes.
        for (const name of cardDirect) expect(names).not.toContain(name);
        expect(names).not.toContain('irradiance-field.compose');
        expect(names).not.toContain('irradiance-field.card.capture');
      }

    // Progressive Card capture: `cards.budget` tiles per submitted frame into the
    // retained atlas, against the same field captured in one frame.
    const captureRun = async (cardBudget: number) => {
      // An identical profile keeps the prepared field; drop GI for a fresh capture.
      h.setGi(undefined);
      await h.draw();
      h.setGi(irradianceFieldGi({ environment, radiosity: false, cardBudget }));
      const progress: number[] = [];
      const capture: number[] = [];
      for (let i = 0; i < 400; i++) {
        const times = await frameTimes();
        const gi = h.renderer.inspect().diffuseGi;
        const cards =
          gi !== undefined && 'gather' in gi && gi.gather === 'irradiance-field'
            ? gi.cards
            : undefined;
        if (cards === undefined || cards.captured === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          continue;
        }
        const measured =
          times instanceof Map ? times.get('irradiance-field.card.capture') : undefined;
        if (measured !== undefined) capture.push(measured / 1000);
        progress.push(cards.captured);
        if (cards.captured === cards.tiles) break;
      }
      await h.settle(16);
      const gi = fieldInspection(h);
      assert(gi.cards);
      const cards = gi.cards;
      return {
        tiles: cards.tiles,
        perFrame: cards.perFrame,
        progress,
        capture,
        image: await h.image(),
      };
    };
    const whole = await captureRun(4096);
    const sliced = await captureRun(4);
    expect(sliced.tiles).toBeGreaterThan(4);
    expect(whole.progress).toEqual([whole.tiles]);
    expect(sliced.progress).toEqual(
      Array.from({ length: Math.ceil(sliced.tiles / 4) }, (_, i) =>
        Math.min(4 * (i + 1), sliced.tiles),
      ),
    );
    if (Array.isArray(steadyPasses)) {
      expect(whole.capture).toHaveLength(1);
      expect(sliced.capture).toHaveLength(sliced.progress.length);
    }
    expect(Math.abs(sliced.image.mean - whole.image.mean)).toBeLessThan(0.02 * whole.image.mean);
    expect(h.errors).toEqual([]);
    save('comparison.json', {
      backend: 'dawn',
      resolution: [32, 32],
      probes: 512,
      raysPerProbe: irradianceFieldGi().field.raysPerProbe,
      error: { full, half },
      steadyPasses,
      cardCapture: {
        tiles: whole.tiles,
        wholeMicroseconds: whole.capture,
        slicedBudget: 4,
        slicedMicroseconds: sliced.capture,
        progress: sliced.progress,
        meanDifference: Math.abs(sliced.image.mean - whole.image.mean),
      },
    });
  } finally {
    save('comparison-state.json', { errors: h.errors, inspection: h.renderer.inspect() });
    await h.dispose();
  }
});

it('keeps sunlight on a Card behind a thin wall out of the probes in front of it', {
  timeout: 600_000,
}, async () => {
  // One floor Card spans both sides of the wall. Sunlight from behind lights
  // the floor there and leaves the floor, the wall face and every probe in
  // front unlit, so any indirect light in view is a leak. The wall's back face
  // sits just in front of a sunlit 0.5-unit Card texel centre, so a bilinear
  // probe-ray lookup at the front foot blends that texel across the wall.
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
  try {
    h.world.set(h.wall, Transform, { pos: [0, 0, -3.115] }).unwrap();
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    h.world
      .set(h.sun, DirectionalLight, {
        direction: [0, -Math.SQRT1_2, Math.SQRT1_2],
        color: [1, 1, 1],
        intensity: 4,
        castShadow: false,
      })
      .unwrap();
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const direct = await h.image();
    h.setGi(irradianceFieldGi());
    await h.settle(8);
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const field = await h.image();
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await capture).unwrap();
    save('thin-wall-card-leak.rhitape', encoded.bytes);
    // Texel w only marks a received ray; the field maximum is over radiance.
    const lit = (await h.read('irradiance')).reduce(
      (max, value, i) => (i % 4 === 3 ? max : Math.max(max, value)),
      0,
    );
    let sum = 0;
    let max = 0;
    for (let i = 0; i < field.red.length; i++) {
      const indirect = (field.red[i] ?? 0) - (direct.red[i] ?? 0);
      sum += indirect;
      max = Math.max(max, indirect);
    }
    const leak = { mean: sum / field.red.length, max, fieldMax: lit };
    save('thin-wall-card-leak.json', {
      traversal: fieldInspection(h).traversal,
      captureDigest: encoded.digest,
      ...leak,
    });
    expect(h.errors).toEqual([]);
    // The probes behind the wall hold the sunlit floor, so the falsifier has light to leak.
    expect(lit).toBeGreaterThan(0.1);
    // Measured max/fieldMax: bilinear 2.7e-3 (global-sdf), 9.6e-4 (ray-query);
    // point-sampled 6.5e-6 and 1.1e-5.
    expect(leak.max).toBeLessThan(2.5e-4 * lit);
  } finally {
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});
