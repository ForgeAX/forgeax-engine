// Resource-safe hierarchy performance evidence: the largest default case is
// 10k fully dynamic nodes. Cross-commit AB/BA timing remains an external
// runner concern; this gate records deterministic owner counters and exact
// matrices without claiming a speedup from one local process.
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, GlobalTransform, Transform } from '../index';
import {
  beginTransformPropagationTrace,
  endTransformPropagationTrace,
  propagateTransforms,
  type TransformPropagationTrace,
} from '../systems/propagate-transforms';

type HierarchyShape = 'wide' | 'balanced';

interface Workload {
  readonly shape: HierarchyShape;
  readonly rows: number;
}

interface Receipt {
  readonly shape: HierarchyShape;
  readonly rows: number;
  readonly fullyDynamicRows: number;
  readonly propagationMs: number;
  readonly trace: TransformPropagationTrace;
}

const BRANCHING_FACTOR = 4;
const WARMUP_FRAMES = 2;
const WORKLOADS: readonly Workload[] = [
  { shape: 'wide', rows: 1_000 },
  { shape: 'wide', rows: 4_000 },
  { shape: 'wide', rows: 10_000 },
  { shape: 'balanced', rows: 1_000 },
  { shape: 'balanced', rows: 4_000 },
  { shape: 'balanced', rows: 10_000 },
];

function parentIndex(shape: HierarchyShape, row: number): number {
  if (row === 0) return -1;
  return shape === 'wide' ? 0 : Math.floor((row - 1) / BRANCHING_FACTOR);
}

function spawnNode(world: World, parent: EntityHandle | undefined, localX: number): EntityHandle {
  const transform = { component: Transform, data: { pos: [localX, 0, 0] } } as const;
  if (parent === undefined) return world.spawn(transform).unwrap();
  return world.spawn(transform, { component: ChildOf, data: { parent } }).unwrap();
}

function setDynamicLocals(
  world: World,
  entities: readonly EntityHandle[],
  parents: Int32Array,
  expectedWorldX: Float64Array,
  frame: number,
): void {
  for (let row = 0; row < entities.length; row += 1) {
    const value = ((row * 17 + frame * 31) % 97) + 1;
    const entity = entities[row];
    if (entity === undefined) throw new Error(`missing hierarchy entity ${row}`);
    world.set(entity, Transform, { pos: [value, 0, 0] }).unwrap();
    const parent = parents[row] ?? -1;
    expectedWorldX[row] = parent < 0 ? value : (expectedWorldX[parent] ?? 0) + value;
  }
}

function assertExactTranslationMatrices(
  world: World,
  entities: readonly EntityHandle[],
  expectedWorldX: Float64Array,
): void {
  const expectedIdentity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let row = 0; row < entities.length; row += 1) {
    const entity = entities[row];
    if (entity === undefined) throw new Error(`missing hierarchy entity ${row}`);
    const matrix = world.get(entity, GlobalTransform).unwrap().world;
    const expectedX = expectedWorldX[row] ?? 0;
    for (let index = 0; index < 16; index += 1) {
      const expected = index === 12 ? expectedX : (expectedIdentity[index] ?? 0);
      expect(matrix[index], `matrix[${row}][${index}]`).toBe(expected);
    }
  }
}

function runWorkload(workload: Workload): Receipt {
  const world = new World();
  const entities: EntityHandle[] = [];
  const parents = new Int32Array(workload.rows);
  for (let row = 0; row < workload.rows; row += 1) {
    const parent = parentIndex(workload.shape, row);
    parents[row] = parent;
    const parentEntity = parent < 0 ? undefined : entities[parent];
    entities.push(spawnNode(world, parentEntity, row + 1));
  }

  const expectedWorldX = new Float64Array(workload.rows);
  for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) {
    setDynamicLocals(world, entities, parents, expectedWorldX, frame);
    propagateTransforms(world).unwrap();
  }

  setDynamicLocals(world, entities, parents, expectedWorldX, WARMUP_FRAMES);
  const start = performance.now();
  beginTransformPropagationTrace();
  const result = propagateTransforms(world);
  const propagationMs = Number((performance.now() - start).toFixed(3));
  const trace = endTransformPropagationTrace();
  expect(result.ok).toBe(true);
  assertExactTranslationMatrices(world, entities, expectedWorldX);

  const hierarchyRows = workload.rows - 1;
  expect(trace.hierarchyRowsEvaluated).toBe(hierarchyRows);
  expect(trace.hierarchyEdgesVisited).toBe(hierarchyRows);
  expect(trace.hierarchyEntityLookups).toBeGreaterThan(0);
  expect(trace.hierarchyEntityLookups).toBeLessThanOrEqual(workload.rows * 8);
  expect(trace.hierarchyPublishedRows).toBe(hierarchyRows);
  expect(trace.hierarchyPublishedRuns).toBeGreaterThan(0);
  expect(trace.hierarchyPublishedRuns).toBeLessThanOrEqual(2);
  expect(trace.hierarchyRootCursorAllocations).toBe(0);
  expect(trace.hierarchyResidualParentProbes).toBe(0);

  return {
    shape: workload.shape,
    rows: workload.rows,
    fullyDynamicRows: workload.rows,
    propagationMs,
    trace,
  };
}

describe('dynamic hierarchy propagation counters', () => {
  for (const workload of WORKLOADS) {
    it(`keeps ${workload.shape} ${workload.rows} fully dynamic rows linear`, () => {
      const receipt = runWorkload(workload);
      // biome-ignore lint/suspicious/noConsole: deterministic performance receipt.
      console.info(JSON.stringify({ schemaVersion: 1, workload: receipt }));

      expect(receipt.fullyDynamicRows).toBe(receipt.rows);
      expect(receipt.trace.hierarchyRowsEvaluated).toBe(receipt.rows - 1);
      expect(receipt.trace.hierarchyEdgesVisited).toBe(receipt.rows - 1);
      expect(receipt.trace.hierarchyEntityLookups).toBeLessThanOrEqual(receipt.rows * 8);
      expect(receipt.trace.hierarchyPublishedRows).toBe(receipt.rows - 1);
      expect(receipt.trace.hierarchyPublishedRuns).toBeLessThanOrEqual(2);
      expect(receipt.trace.hierarchyRootCursorAllocations).toBe(0);
    }, 120_000);
  }
});
