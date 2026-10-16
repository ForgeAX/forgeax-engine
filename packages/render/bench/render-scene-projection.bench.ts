import { bench, describe } from 'vitest';
import { RenderScene } from '../src/scene/render-scene';
import type { MaterialSnapshot, RenderableSnapshot } from '../src/render-system-extract';

const RIGID_COUNT = 100_000;
const MATERIAL_COUNT = 1_000;
const VIEW_COUNT = 4;
const DELTA_COUNT = 10_000;
const fast = process.env.FORGEAX_BENCH === 'fast';
const options = fast ? { time: 100, warmupTime: 30, warmupIterations: 2 } : {};

const materials = Array.from(
  { length: MATERIAL_COUNT },
  (_, materialHandle) => ({ materialHandle } as MaterialSnapshot),
);

function snapshot(entityKey: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = entityKey % 1_000;
  const material = materials[entityKey % MATERIAL_COUNT] ?? materials[0];
  return {
    assetHandle: 1,
    transform: { world },
    localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
  };
}

describe('RenderScene 100k rigid / 1k material / 4 views / 10k delta', () => {
  const scene = new RenderScene();
  scene.reset(
    Array.from({ length: RIGID_COUNT }, (_, entityKey) => snapshot(entityKey)),
  );
  const stableMaterialization = scene.materialize();
  const dirty = Array.from({ length: DELTA_COUNT }, (_, entityKey) => {
    const previous = stableMaterialization[entityKey];
    const world =
      previous === undefined ? new Float32Array(16) : new Float32Array(previous.transform.world);
    world[12] = (entityKey % 1_000) + 1;
    return { kind: 'update-transform' as const, worldId: 0, entityKey, world };
  });
  const views = Array.from({ length: VIEW_COUNT }, (_, view) => ({
    min: [view * 250 - 1, -2, -2] as [number, number, number],
    max: [view * 250 + 251, 2, 2] as [number, number, number],
  }));
  let sink = 0;

  bench(
    'no-change O(1) and zero renderable scan',
    () => {
      const result = scene.apply([]);
      sink ^= result.updated;
    },
    options,
  );

  bench(
    '10k transform delta O(D + I)',
    () => {
      sink ^= scene.apply(dirty).updated;
    },
    options,
  );

  bench(
    '1k material reverse lookup O(S)',
    () => {
      sink ^= scene.slotsForMaterial(17).length;
    },
    options,
  );

  bench(
    '4 visible queries O(Q + V)',
    () => {
      for (const view of views) sink ^= scene.querySpatial(view).length;
    },
    options,
  );

  bench(
    'stable generation lookup and zero upload bytes',
    () => {
      const slot = scene.slot(0, 50_000);
      sink ^= (slot?.generation ?? -1) + (scene.materialize() === stableMaterialization ? 0 : 1);
    },
    options,
  );

  bench.skip('__sink_keep_alive', () => {
    sink ^= scene.inspect().records.length;
  });
});
