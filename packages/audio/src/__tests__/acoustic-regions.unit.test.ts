import { World } from '@forgeax/engine-ecs';
import { GlobalTransform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import * as audio from '../index';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

it('releases its automatic layer when the World projection is reset', () => {
  const world = new World();
  const intents: audio.AudioIntent[] = [];
  const backend = audio.createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
  world
    .spawn(
      { component: audio.AcousticRegion, data: { sourceBus: 'room', listenerWetBus: 'room' } },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  const clip = world.allocSharedRef('AudioClipAsset', {
    kind: 'audio',
    sourceKey: 'reset',
    bytes: Uint8Array.of(1),
  });
  world
    .spawn(
      { component: audio.AudioSource, data: { clip, playing: true } },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  world
    .spawn(
      { component: audio.AudioListener, data: {} },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  const projection = audio.createAcousticRegionSystem();
  projection.update(world, backend).unwrap();
  intents.length = 0;
  projection.reset(backend);
  expect(intents).toMatchObject([
    { kind: 'set-acoustic-routes', routes: { fallback: 1, buses: [] } },
    { kind: 'set-acoustic-environment', environment: [] },
  ]);
  intents.length = 0;
  projection.reset(backend);
  expect(intents).toHaveLength(0);
});

it('routes a source through a saved region and restores the latest base bus after removal', () => {
  expect(audio).toHaveProperty('AcousticRegion');
  const world = new World();
  const intents: audio.AudioIntent[] = [];
  const backend = audio.createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
  const clip = world.allocSharedRef('AudioClipAsset', {
    kind: 'audio',
    sourceKey: 'region',
    bytes: Uint8Array.of(1),
  });
  const region = world
    .spawn(
      { component: audio.AcousticRegion, data: { sourceBus: 'room', blendDistance: 1 } },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  const source = world
    .spawn(
      { component: audio.AudioSource, data: { clip, playing: true } },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  audio.audioTickSystem(world, backend);
  const tick = audio.createAcousticRegionSystem();
  expect(tick.update(world, backend).ok).toBe(true);
  expect(intents.at(-1)).toMatchObject({
    kind: 'set-acoustic-routes',
    entityId: source,
    routes: { fallback: 0, buses: [{ bus: 'room', gain: 1 }] },
  });
  const count = intents.length;
  tick.update(world, backend);
  expect(intents).toHaveLength(count);
  world.set(source, audio.AudioSource, { bus: 'music' }).unwrap();
  audio.audioTickSystem(world, backend);
  world.despawn(region).unwrap();
  tick.update(world, backend);
  expect(intents.at(-1)).toMatchObject({
    kind: 'set-acoustic-routes',
    routes: { fallback: 1, buses: [] },
  });
});

// Independent double-precision Gauss-Jordan oracle, not the production inverse/query.
function localPoint(matrix: Float32Array, point: number[]): number[] {
  const rows = Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 5 }, (_, c) =>
      c < 4 ? (matrix[c * 4 + r] ?? 0) : ([...point, 1][r] ?? 0),
    ),
  );
  for (let c = 0; c < 4; c++) {
    const pivotRow = rows[c];
    if (!pivotRow) throw new Error('oracle pivot row missing');
    const pivot = pivotRow[c] ?? 0;
    if (Math.abs(pivot) < 1e-12) throw new Error('oracle singular pivot');
    for (let k = c; k < 5; k++) pivotRow[k] = (pivotRow[k] ?? 0) / pivot;
    for (let r = 0; r < 4; r++)
      if (r !== c) {
        const row = rows[r];
        if (!row) throw new Error('oracle row missing');
        const factor = row[c] ?? 0;
        for (let k = c; k < 5; k++) row[k] = (row[k] ?? 0) - (pivotRow[k] ?? 0) * factor;
      }
  }
  return rows.map((r) => r[4] ?? 0).slice(0, 3);
}

it('matches an independent geometric oracle for rotated, sheared and scaled boxes/spheres', () => {
  const world = new World();
  const intents: audio.AudioIntent[] = [];
  const backend = audio.createAudioIntentBackend({ emit: (i) => intents.push(i) });
  const clip = world.allocSharedRef('AudioClipAsset', {
    kind: 'audio',
    sourceKey: 'geometry',
    bytes: Uint8Array.of(1),
  });
  const source = world
    .spawn(
      { component: audio.AudioSource, data: { clip, playing: true } },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  const matrix = new Float32Array([1.6, 1.2, 0, 0, -0.3, 0.8, 0, 0, 0.1, 0.2, 2, 0, 3, -2, 1, 1]);
  const region = world
    .spawn(
      { component: audio.AcousticRegion, data: { sourceBus: 'room', blendDistance: 0.4 } },
      { component: GlobalTransform, data: { world: matrix } },
    )
    .unwrap();
  const tick = audio.createAcousticRegionSystem();
  let seed = 2207;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (const shape of [audio.AcousticShapeValue.box, audio.AcousticShapeValue.sphere]) {
    world.set(region, audio.AcousticRegion, { shape }).unwrap();
    for (let i = 0; i < 240; i++) {
      const point = [3 + (random() - 0.5) * 5, -2 + (random() - 0.5) * 4, 1 + (random() - 0.5) * 5];
      const m = identity();
      m[12] = point[0] ?? 0;
      m[13] = point[1] ?? 0;
      m[14] = point[2] ?? 0;
      world.set(source, GlobalTransform, { world: m }).unwrap();
      tick.update(world, backend).unwrap();
      const local = localPoint(matrix, [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0]);
      const depth =
        shape === audio.AcousticShapeValue.sphere
          ? 1 - Math.hypot(...local)
          : Math.min(...local.map((v) => 1 - Math.abs(v)));
      const expected = Math.max(0, Math.min(1, depth / Math.fround(0.4)));
      const current = [...intents].reverse().find((i) => i.kind === 'set-acoustic-routes');
      const actual =
        current?.kind === 'set-acoustic-routes' ? (current.routes.buses[0]?.gain ?? 0) : 0;
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2e-5);
    }
  }
});

it('normalizes equal-priority overlap deterministically and separates source and listener selection', () => {
  const world = new World();
  const intents: audio.AudioIntent[] = [];
  const backend = audio.createAudioIntentBackend({ emit: (i) => intents.push(i) });
  const clip = world.allocSharedRef('AudioClipAsset', {
    kind: 'audio',
    sourceKey: 'overlap',
    bytes: Uint8Array.of(1),
  });
  world
    .spawn(
      { component: audio.AudioSource, data: { clip, playing: true } },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  const listenerMatrix = identity();
  listenerMatrix[12] = 10;
  const listener = world
    .spawn(
      { component: audio.AudioListener, data: {} },
      { component: GlobalTransform, data: { world: listenerMatrix } },
    )
    .unwrap();
  for (const bus of ['b', 'a'])
    world
      .spawn(
        { component: audio.AcousticRegion, data: { sourceBus: bus, priority: 2 } },
        { component: GlobalTransform, data: { world: identity() } },
      )
      .unwrap();
  const higher = world
    .spawn(
      { component: audio.AcousticRegion, data: { sourceBus: 'c', priority: 1 } },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  world
    .spawn(
      { component: audio.AcousticRegion, data: { listenerWetBus: 'room', wet: 0.7 } },
      { component: GlobalTransform, data: { world: listenerMatrix } },
    )
    .unwrap();
  const tick = audio.createAcousticRegionSystem();
  tick.update(world, backend).unwrap();
  expect(intents[0]).toMatchObject({
    kind: 'set-acoustic-routes',
    routes: {
      fallback: 0,
      buses: [
        { bus: 'a', gain: 0.5 },
        { bus: 'b', gain: 0.5 },
      ],
    },
  });
  expect(intents[1]).toMatchObject({
    kind: 'set-acoustic-environment',
    environment: [{ bus: 'room', wet: { weight: 1, value: expect.closeTo(0.7) } }],
  });
  world.set(higher, audio.AcousticRegion, { priority: 3 }).unwrap();
  tick.update(world, backend).unwrap();
  expect(intents[2]).toMatchObject({ routes: { buses: [{ bus: 'c', gain: 1 }] } });
  world.despawn(listener).unwrap();
  tick.update(world, backend).unwrap();
  expect(intents.at(-1)).toEqual({ kind: 'set-acoustic-environment', environment: [] });
});

it('rejects invalid transforms and capacity atomically, and recovers after fixing the authored region', () => {
  const world = new World();
  const intents: audio.AudioIntent[] = [];
  const backend = audio.createAudioIntentBackend({ emit: (i) => intents.push(i) });
  const region = world
    .spawn(
      { component: audio.AcousticRegion, data: { sourceBus: 'room' } },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  const tick = audio.createAcousticRegionSystem();
  tick.update(world, backend).unwrap();
  const singular = identity();
  singular[0] = 0;
  world.set(region, GlobalTransform, { world: singular }).unwrap();
  expect(tick.update(world, backend)).toMatchObject({
    ok: false,
    error: { code: 'control-failed' },
  });
  expect(intents).toHaveLength(0);
  const unrepresentableInverse = identity();
  unrepresentableInverse[0] = 1e-39;
  unrepresentableInverse[5] = 1e30;
  unrepresentableInverse[10] = 1e30;
  world.set(region, GlobalTransform, { world: unrepresentableInverse }).unwrap();
  expect(tick.update(world, backend)).toMatchObject({
    ok: false,
    error: { code: 'control-failed' },
  });
  expect(intents).toHaveLength(0);
  world.set(region, GlobalTransform, { world: identity() }).unwrap();
  for (let i = 0; i < 128; i++)
    world
      .spawn(
        { component: audio.AcousticRegion, data: {} },
        { component: GlobalTransform, data: { world: identity() } },
      )
      .unwrap();
  expect(tick.update(world, backend)).toMatchObject({
    ok: false,
    error: { detail: { reason: 'at most 128 enabled regions per World' } },
  });
  world.despawn(region).unwrap();
  expect(tick.update(world, backend).ok).toBe(true);
});

it('rejects an oversized derived listener batch before any spatial publication and recovers', () => {
  const world = new World();
  const intents: audio.AudioIntent[] = [];
  const backend = audio.createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
  world
    .spawn(
      { component: audio.AudioListener, data: {} },
      { component: GlobalTransform, data: { world: identity() } },
    )
    .unwrap();
  const regions = Array.from({ length: 65 }, (_, i) =>
    world
      .spawn(
        { component: audio.AcousticRegion, data: { listenerWetBus: `wet-${i}` } },
        { component: GlobalTransform, data: { world: identity() } },
      )
      .unwrap(),
  );
  const projection = audio.createAcousticRegionSystem();
  expect(projection.update(world, backend)).toMatchObject({
    ok: false,
    error: { code: 'control-failed' },
  });
  expect(intents).toHaveLength(0);
  const last = regions.at(-1);
  if (last === undefined) throw new Error('last region missing');
  world.despawn(last).unwrap();
  projection.update(world, backend).unwrap();
  expect(intents).toMatchObject([
    { kind: 'set-acoustic-environment', environment: expect.any(Array) },
  ]);
});
