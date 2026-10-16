// @ts-expect-error The Vitest runtime provides Node's fs module; scene package declarations stay browser-safe.
import { readFileSync } from 'node:fs';
import { type EntityHandle, FixedUpdate, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { GlobalTransform, propagateTransforms, Transform } from '../index';
import { registerPropagateTransforms } from '../systems/propagate-transforms';

const COUNTS = [10_000, 100_000] as const;
const MOVERS = [1, 100, 10_000] as const;

function spawnFlatWorld(count: number): { world: World; entities: EntityHandle[] } {
  const world = new World();
  const entities = Array.from({ length: count }, (_, index) =>
    world.spawn({ component: Transform, data: { pos: [index, 0, 0] } }).unwrap(),
  );
  registerPropagateTransforms(world);
  return { world, entities };
}

describe('flat Transform propagation contract', () => {
  it.each(COUNTS)('keeps %s independent rows on the simple lane', (count) => {
    const { world } = spawnFlatWorld(count);
    expect(world.update(0).ok).toBe(true);

    const query = world.query({ read: [Transform, GlobalTransform] }).unwrap();
    const spans = query.spans();
    expect(spans.ok).toBe(true);
    expect([...spans.unwrap()]).toHaveLength(1);
    expect([...query]).toHaveLength(count);
  });

  it.each(MOVERS)('publishes a same-tick world checksum for %s movers', (movers) => {
    const { world, entities } = spawnFlatWorld(10_000);
    const first = entities[0];
    if (first === undefined) throw new Error('expected first flat entity');
    let observed = 0;
    world
      .addSystem(Update, {
        name: `flat-writer-${movers}`,
        queries: [],
        before: ['propagateTransforms'],
        fn: () => {
          for (let index = 0; index < movers; index += 1) {
            const entity = entities[index];
            if (entity !== undefined) world.set(entity, Transform, { pos: [index + 1, 0, 0] });
          }
        },
      })
      .unwrap();
    world
      .addSystem(Update, {
        name: `flat-reader-${movers}`,
        queries: [],
        after: ['propagateTransforms'],
        fn: () => {
          observed = 0;
          for (const row of world.query({ read: [GlobalTransform] }).unwrap()) {
            observed += row.get(GlobalTransform).world[12] ?? 0;
          }
        },
      })
      .unwrap();

    expect(world.update(0).ok).toBe(true);
    expect(observed).toBeGreaterThan(0);
    expect(world.get(first, GlobalTransform).unwrap().world[12]).toBeCloseTo(1);
  });

  it('runs local writers before propagation and world readers after it in FixedUpdate', () => {
    const { world, entities } = spawnFlatWorld(10_000);
    const first = entities[0];
    if (first === undefined) throw new Error('expected first flat entity');
    const trace: string[] = [];
    world
      .addSystem(FixedUpdate, {
        name: 'flat-fixed-writer',
        queries: [],
        before: ['propagateTransformsFixed'],
        fn: () => {
          trace.push('writer');
          world.set(first, Transform, { pos: [9, 0, 0] });
        },
      })
      .unwrap();
    world
      .addSystem(FixedUpdate, {
        name: 'flat-fixed-reader',
        queries: [],
        after: ['propagateTransformsFixed'],
        fn: () => {
          trace.push('reader');
          expect(world.get(first, GlobalTransform).unwrap().world[12]).toBeCloseTo(9);
        },
      })
      .unwrap();

    expect(world.update(1 / 60).ok).toBe(true);
    expect(trace).toEqual(['writer', 'reader']);
  });

  it('does not retain an entity collection or a second lane in the flat owner', async () => {
    const source = readFileSync(
      new URL('../systems/propagate-transforms.ts', import.meta.url),
      'utf8',
    );
    expect(source.slice(0, source.indexOf('function walkChildren('))).not.toMatch(
      /new (Map|Set)|\b(Map|Set)</,
    );
    expect(source).not.toMatch(/PropagationCache/);
    expect(source).toContain('changed: [Transform]');
    expect(source).toContain('composeFlatColumns');
    expect(source).not.toContain('.subarray(');
  });

  it('reuses cached queries after warmup while a dynamic mover changes', () => {
    const { world, entities } = spawnFlatWorld(10_000);
    world.update(0).unwrap();
    const originalQuery = world.query.bind(world);
    let queryCalls = 0;
    world.query = ((descriptor: Parameters<World['query']>[0]) => {
      queryCalls += 1;
      return originalQuery(descriptor);
    }) as World['query'];

    const first = entities[0];
    if (first === undefined) throw new Error('expected first flat entity');
    world.set(first, Transform, { pos: [42, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();

    expect(queryCalls).toBe(0);
    expect(world.get(first, GlobalTransform).unwrap().world[12]).toBeCloseTo(42);
  });
});
