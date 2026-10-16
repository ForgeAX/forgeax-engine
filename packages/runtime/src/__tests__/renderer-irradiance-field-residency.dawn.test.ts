import { mkdirSync, writeFileSync } from 'node:fs';
import { Materials } from '@forgeax/engine-render';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { spawnSkinnedCharacter } from './capsule-shadow.fixture';
import {
  createIrradianceFieldHarness,
  type FieldImage,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/irradiance-field/dawn';
mkdirSync(directory, { recursive: true });

type Harness = Awaited<ReturnType<typeof createIrradianceFieldHarness>>;

const finite = (image: FieldImage) => image.red.every(Number.isFinite);
const residency = (h: Harness) => {
  const state = h.inspection();
  assert(state.gather === 'irradiance-field');
  return state;
};
const moveCamera = (h: Harness, pos: readonly [number, number, number]) =>
  h.world.set(h.camera, Transform, { pos: [...pos] }).unwrap();

/** A row of small cubes in front of the wall: more Cards than the atlas holds. */
const LIGHTWEIGHT = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';
const TRIPS = LIGHTWEIGHT ? 2 : 3;
const OBSERVATION_FRAMES = LIGHTWEIGHT ? 32 : 48;
const CUBES = 12;
const cubeX = (i: number) => -3.3 + (6.6 * i) / (CUBES - 1);
const LEFT = [-3, -0.6, -0.4] as const;
const RIGHT = [3, -0.6, -0.4] as const;

it('streams Card residency under a byte ceiling by view priority without leaks or flicker', {
  timeout: 900_000,
}, async () => {
  const h = await createIrradianceFieldHarness({ rhi: webgpu.rhi, manifest });
  const result: Record<string, unknown> = {};
  try {
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    const cube = await h.slab(0.6, 0.6, 0.6);
    for (let i = 0; i < CUBES; i++)
      h.spawn(cube, i % 2 === 0 ? h.emissive : h.white, [cubeX(i), -1, -2]);
    moveCamera(h, LEFT);
    const unbounded = irradianceFieldGi({ hysteresis: 0.8, maxDistance: 0.5, cardBudget: 16 });
    // A ceiling that holds a few instances' tiles: the scene no longer fits.
    const gi = {
      ...unbounded,
      field: {
        ...unbounded.field,
        cards: { ...unbounded.field.cards, maxCaptureBytes: 640 * 1024 },
      },
    } as typeof unbounded;
    h.setGi(gi);
    await h.settle(24);
    const start = residency(h);
    // Both world traversals stream the same residency: Global SDF and Ray Query.
    result.traversal = start.traversal;
    expect(start.error).toBeUndefined();
    expect(start.state).toBe('ready');
    const total = CUBES + 2;
    const counters = start.residency;
    assert(counters, `residency counters missing: ${JSON.stringify(start)}`);
    expect(counters.resident + counters.pending).toBe(total);
    expect(counters.resident).toBeGreaterThan(0);
    expect(counters.resident).toBeLessThan(total);
    expect(counters.evicted).toBe(0);
    const left = await h.image();
    expect(finite(left)).toBe(true);
    expect(left.mean).toBeGreaterThan(0);

    // Streaming: each move evicts the far residents and installs the newly near ones.
    const trips: { resident: number; evicted: number; live: number }[] = [];
    const flicker: number[] = [];
    let minRatio = Number.POSITIVE_INFINITY;
    for (let trip = 0; trip < TRIPS; trip++)
      for (const pos of [RIGHT, LEFT]) {
        moveCamera(h, pos);
        const series: number[] = [];
        for (let i = 0; i < OBSERVATION_FRAMES; i++) series.push((await h.image()).mean);
        const settled = series.slice(-8).reduce((s, v) => s + v, 0) / 8;
        // Skip the teleport frame itself: the view changed, not the lighting.
        for (let i = 2; i < series.length; i++)
          flicker.push(Math.abs((series[i] ?? 0) - (series[i - 1] ?? 0)) / settled);
        minRatio = Math.min(minRatio, ...series.slice(1).map((m) => m / settled));
        const state = residency(h).residency;
        assert(state);
        expect(state.resident + state.pending).toBe(total);
        trips.push({
          resident: state.resident,
          evicted: state.evicted,
          live: h.liveCardBuffers().length,
        });
      }
    const final = residency(h);
    assert(final.residency);
    expect(final.residency.evicted).toBeGreaterThan(0);
    expect(final.generation).toBe(start.generation);
    // Deterministic and leak-free: every visit to the same pose holds the same
    // residents and the same live Card buffers, while evictions keep accumulating.
    const atLeft = trips.filter((_, i) => i % 2 === 1);
    const atRight = trips.filter((_, i) => i % 2 === 0);
    for (const visits of [atLeft, atRight]) {
      expect(new Set(visits.map((v) => v.resident)).size).toBe(1);
      expect(new Set(visits.map((v) => v.live)).size).toBe(1);
    }
    expect(h.createdCardBuffers()).toBeGreaterThan(trips.at(-1)?.live ?? 0);
    // No flicker: pending Cards read as unlit, so probes keep their radiance
    // history and the image never collapses while residents swap.
    const maxFlicker = Math.max(...flicker);
    expect(maxFlicker).toBeLessThan(0.25);
    expect(minRatio).toBeGreaterThan(0.5);
    result.residency = {
      start: counters,
      final: final.residency,
      share: final.share,
      cards: final.cards,
      trips,
      maxFlicker,
      minRatio,
      liveCardBuffers: h.liveCardBuffers().length,
      createdCardBuffers: h.createdCardBuffers(),
    };

    // A ceiling that fits the scene keeps every instance resident and never evicts.
    h.setGi(unbounded);
    await h.settle(24);
    const fits = residency(h);
    expect(fits.generation).toBeGreaterThan(final.generation);
    expect(fits.residency).toEqual({ resident: total, pending: 0, evicted: 0 });
    result.unbounded = fits.residency;
    expect(h.errors).toEqual([]);
  } finally {
    writeFileSync(
      `${directory}/residency-result.json`,
      JSON.stringify({ result, errors: h.errors, inspection: h.renderer.inspect() }, null, 2),
    );
    await h.dispose();
  }
});

it('keeps skinned meshes out of the field: they receive GI without Cards, SDF or edits', {
  timeout: 900_000,
}, async () => {
  const h = await createIrradianceFieldHarness({ rhi: webgpu.rhi, manifest });
  const result: Record<string, unknown> = {};
  try {
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    // Behind the camera: the emitter reaches the character only as indirect light.
    h.spawn(await h.slab(1.5, 1.5, 0.25), h.emissive, [-2, -1, 0.5]);
    const gi = irradianceFieldGi({ hysteresis: 0.8, maxDistance: 0.5 });
    h.setGi(gi);
    await h.settle(24);
    const rigid = residency(h);
    const rigidTiles = rigid.cards?.tiles ?? 0;
    expect(rigidTiles).toBeGreaterThan(0);

    const body = Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 1, specular: 0 });
    const { joint } = spawnSkinnedCharacter(h.world, body, [0, -1.4, -1.6]);
    await h.settle(24);
    const skinned = residency(h);
    // Not a field source: no rebuild, no in-place add, no Cards.
    expect(skinned.state).toBe('ready');
    expect(skinned.generation).toBe(rigid.generation);
    expect(skinned.cards?.tiles).toBe(rigidTiles);
    expect(skinned.edits?.addedInstances ?? 0).toBe(0);
    if (skinned.residency !== undefined)
      expect(skinned.residency.resident + skinned.residency.pending).toBe(3);
    const lit = await h.image();
    expect(finite(lit)).toBe(true);

    // Posing the skeleton is not a field edit either.
    for (let frame = 0; frame < 24; frame++) {
      const angle = 0.4 * Math.sin(frame / 4);
      h.world
        .set(joint, Transform, {
          quat: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
        })
        .unwrap();
      await h.draw();
    }
    const posed = residency(h);
    expect(posed.generation).toBe(rigid.generation);
    expect(posed.edits?.applied ?? 0).toBe(skinned.edits?.applied ?? 0);
    const after = await h.image();
    expect(finite(after)).toBe(true);

    // The character receives GI: with the field off its front is unlit.
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const off = await h.image();
    // Character pixels: the lower center column of the 32x32 image.
    const region = (image: FieldImage) => {
      let sum = 0;
      let n = 0;
      for (let y = 16; y < 28; y++)
        for (let x = 14; x < 18; x++) {
          sum += image.red[y * 32 + x] ?? 0;
          n++;
        }
      return sum / n;
    };
    expect(region(after)).toBeGreaterThan(Math.max(4 * region(off), 1e-3));
    result.skinned = {
      rigidTiles,
      tiles: skinned.cards?.tiles,
      residency: skinned.residency,
      generation: posed.generation,
      edits: posed.edits,
      characterGi: region(after),
      characterOff: region(off),
    };
    expect(h.errors).toEqual([]);
  } finally {
    writeFileSync(
      `${directory}/skinned-result.json`,
      JSON.stringify({ result, errors: h.errors, inspection: h.renderer.inspect() }, null, 2),
    );
    await h.dispose();
  }
});
