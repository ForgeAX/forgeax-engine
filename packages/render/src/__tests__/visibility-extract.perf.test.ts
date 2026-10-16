import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { RenderScene } from '../scene/render-scene';

const ENTITY_COUNT = 10_000;
const SAMPLE_COUNT = 101;
const LIGHTWEIGHT_RENDER_SCENE_PERF = process.env.FORGEAX_RENDER_PERF_LIGHTWEIGHT === '1';
// The full 100k scene remains the local/nightly scaling check.  CI keeps the
// same delta/no-change assertions at a bounded 10k population so a standard
// runner does not spend its memory budget constructing a second large graph.
const RENDER_SCENE_ENTITY_COUNT = LIGHTWEIGHT_RENDER_SCENE_PERF ? 10_000 : 100_000;
const RENDER_SCENE_DELTA_COUNT = LIGHTWEIGHT_RENDER_SCENE_PERF ? 1_000 : 10_000;

const sceneMaterial = {} as MaterialSnapshot;

function sceneSnapshot(entityKey: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = entityKey % 1_000;
  return {
    assetHandle: 1,
    transform: { world },
    localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    material: { ...sceneMaterial, materialHandle: entityKey % 1_000 },
    materials: [{ ...sceneMaterial, materialHandle: entityKey % 1_000 }],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
  };
}

function buildWorld(inherited: boolean, withHierarchy: boolean): World {
  const world = new World();
  const parent = withHierarchy
    ? world
        .spawn(
          { component: Transform, data: {} },
          ...(inherited
            ? [{ component: Visibility, data: { state: VisibilityStateValue.visible } }]
            : []),
        )
        .unwrap()
    : undefined;

  for (let index = 0; index < ENTITY_COUNT; index++) {
    world
      .spawn(
        { component: Transform, data: {} },
        ...(parent === undefined ? [] : [{ component: ChildOf, data: { parent } }]),
        ...(inherited
          ? [{ component: Visibility, data: { state: VisibilityStateValue.inherited } }]
          : []),
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  }
  return world;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measureWorldSamples(worlds: readonly World[]): number[][] {
  for (const world of worlds) extractFrames([world], 0);
  const samples = worlds.map(() => [] as number[]);
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const firstWorldIndex = sample % worlds.length;
    for (let offset = 0; offset < worlds.length; offset++) {
      const worldIndex = (firstWorldIndex + offset) % worlds.length;
      const world = worlds[worldIndex];
      if (world === undefined) continue;
      const start = performance.now();
      extractFrames([world], 0);
      samples[worldIndex]?.push(performance.now() - start);
    }
  }
  return samples;
}

function measureWorlds(worlds: readonly World[]): number[] {
  return measureWorldSamples(worlds).map((values) => median(values));
}

describe(`visibility extraction performance (10k + RenderScene ${RENDER_SCENE_ENTITY_COUNT / 1_000}k)`, () => {
  it('keeps inherited hierarchy extraction within the 10 percent budget', () => {
    const flat = buildWorld(false, false);
    const hierarchy = buildWorld(false, true);
    const inherited = buildWorld(true, true);
    const flatMedian = measureWorlds([flat])[0] ?? 0;
    const [hierarchyMedian = 0, inheritedMedian = 0] = measureWorlds([hierarchy, inherited]);
    const overhead = inheritedMedian / Math.max(hierarchyMedian, 0.001) - 1;
    // biome-ignore lint/suspicious/noConsole: retain benchmark profile evidence
    console.info(
      `[m3-b-performance] flat=${flatMedian.toFixed(3)}ms hierarchy=${hierarchyMedian.toFixed(3)}ms inherited=${inheritedMedian.toFixed(3)}ms overhead=${(overhead * 100).toFixed(2)}% samples=${SAMPLE_COUNT}`,
    );

    expect(overhead).toBeLessThanOrEqual(0.1);
  }, 60_000);

  it(`keeps RenderScene delta and no-change evidence on the ${RENDER_SCENE_ENTITY_COUNT / 1_000}k workload`, () => {
    const scene = new RenderScene();
    scene.reset(
      Array.from({ length: RENDER_SCENE_ENTITY_COUNT }, (_, entityKey) => sceneSnapshot(entityKey)),
    );
    const stable = scene.materialize();
    const noChange = scene.apply([]);
    const delta = scene.apply(
      Array.from({ length: RENDER_SCENE_DELTA_COUNT }, (_, entityKey) => {
        const previous = stable[entityKey];
        const world =
          previous === undefined
            ? new Float32Array(16)
            : new Float32Array(previous.transform.world);
        world[12] = (world[12] ?? 0) + 1;
        return { kind: 'update' as const, worldId: 0, entityKey, world };
      }),
    );

    expect(noChange).toMatchObject({ updated: 0, resynced: 0 });
    expect(delta).toMatchObject({ updated: RENDER_SCENE_DELTA_COUNT, resynced: 0 });
    expect(scene.inspect()).toMatchObject({ renderableScans: RENDER_SCENE_DELTA_COUNT });
    // Transform-only updates patch the retained snapshot in place so the
    // unified scene flow does not allocate a second large publication.
    expect(scene.materialize()).toBe(stable);
    expect(stable[0]?.transform.world[12]).toBe(1);
    expect(stable[RENDER_SCENE_DELTA_COUNT - 1]?.transform.world[12]).toBe(1_000);
    expect(scene.querySpatial({ min: [-1, -1, -1], max: [1, 1, 1] }).length).toBeGreaterThan(0);
  }, 60_000);
});
