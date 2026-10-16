import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

const ENTITY_COUNT = 2_000;
const ROUNDS = 3;
const SCALE_CHARACTERIZATION_COUNTS = [10_000, 100_000] as const;

const TrendValue = defineComponent('StorageTrendValue', { value: 'f32' });
const TrendSelected = defineComponent('StorageTrendSelected', {}, { storage: 'sparse' });

function minimumDuration(run: () => number): { duration: number; sum: number } {
  let duration = Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    sum = run();
    duration = Math.min(duration, performance.now() - start);
  }
  return { duration, sum };
}

describe('table, sparse, span, and change-distribution trends', () => {
  it('characterizes fixed-size dense traversal without treating it as a performance verdict', () => {
    const observations = SCALE_CHARACTERIZATION_COUNTS.map((entityCount) => {
      const values = new Float32Array(entityCount);
      for (let index = 0; index < entityCount; index++) values[index] = index + 1;
      const start = performance.now();
      let sum = 0;
      for (const value of values) sum += value;
      return { entityCount, elapsedMs: performance.now() - start, sum };
    });

    expect(observations.map(({ sum }) => sum)).toEqual(
      SCALE_CHARACTERIZATION_COUNTS.map((entityCount) => (entityCount * (entityCount + 1)) / 2),
    );

    // biome-ignore lint/suspicious/noConsole: characterization output is evidence, not a gate
    console.info(`[scale characterization] ${JSON.stringify(observations)}`);
  });

  it('reports equivalent table-row, sparse-row, and dense-span traversal', () => {
    const world = new World();
    for (let index = 0; index < ENTITY_COUNT; index++) {
      const components = [{ component: TrendValue, data: { value: index + 1 } }] as const;
      if (index % 2 === 0) {
        world.spawn(...components, { component: TrendSelected, data: {} }).unwrap();
      } else {
        world.spawn(...components).unwrap();
      }
    }

    const tableRows = world.query({ read: [TrendValue] }).unwrap();
    const sparseRows = world.query({ read: [TrendValue], with: [TrendSelected] }).unwrap();
    const denseSpans = world.query({ read: [TrendValue] }).unwrap();

    const table = minimumDuration(() => {
      let sum = 0;
      for (const row of tableRows) sum += row.get(TrendValue).value;
      return sum;
    });
    const sparse = minimumDuration(() => {
      let sum = 0;
      for (const row of sparseRows) sum += row.get(TrendValue).value;
      return sum;
    });
    const span = minimumDuration(() => {
      let sum = 0;
      for (const range of denseSpans.spans().unwrap()) {
        const values = range.get(TrendValue).value;
        for (let index = 0; index < range.length; index++) sum += values[index] ?? 0;
      }
      return sum;
    });

    expect(table.sum).toBe((ENTITY_COUNT * (ENTITY_COUNT + 1)) / 2);
    expect(sparse.sum).toBe((ENTITY_COUNT / 2) ** 2);
    expect(span.sum).toBe(table.sum);
    expect([...denseSpans.spans().unwrap()]).toHaveLength(1);

    // biome-ignore lint/suspicious/noConsole: trend output is review evidence, not an absolute gate
    console.info(
      `[storage trend] table-row=${table.duration.toFixed(3)}ms sparse-row=${sparse.duration.toFixed(3)}ms span=${span.duration.toFixed(3)}ms entities=${ENTITY_COUNT}`,
    );
  });

  it('observes block and interleaved changes as rows without result fragmentation', () => {
    const world = new World();
    const entities = Array.from({ length: ENTITY_COUNT }, (_, index) =>
      world.spawn({ component: TrendValue, data: { value: index } }).unwrap(),
    );
    const changed = world.query({ changed: [TrendValue] }).unwrap();
    expect([...changed]).toHaveLength(ENTITY_COUNT);

    for (let index = 0; index < ENTITY_COUNT; index += 2) {
      const entity = entities[index];
      if (entity === undefined) throw new Error('interleaved trend entity missing');
      world.set(entity, TrendValue, { value: index + 1 }).unwrap();
    }
    const interleavedStart = performance.now();
    const interleaved = Array.from(changed, (row) => row.entity);
    const interleavedDuration = performance.now() - interleavedStart;

    for (let index = 0; index < ENTITY_COUNT / 2; index++) {
      const entity = entities[index];
      if (entity === undefined) throw new Error('block trend entity missing');
      world.set(entity, TrendValue, { value: index + 2 }).unwrap();
    }
    const blockStart = performance.now();
    const block = Array.from(changed, (row) => row.entity);
    const blockDuration = performance.now() - blockStart;

    expect(interleaved).toHaveLength(ENTITY_COUNT / 2);
    expect(block).toHaveLength(ENTITY_COUNT / 2);
    expect(interleaved.every((entity, index) => entity === entities[index * 2])).toBe(true);
    expect(block.every((entity, index) => entity === entities[index])).toBe(true);

    // biome-ignore lint/suspicious/noConsole: distribution timing is characterization evidence
    console.info(
      `[change trend] interleaved=${interleavedDuration.toFixed(3)}ms block=${blockDuration.toFixed(3)}ms hits=${ENTITY_COUNT / 2}`,
    );
  });
});
