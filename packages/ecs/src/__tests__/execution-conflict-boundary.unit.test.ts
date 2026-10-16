import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import {
  defineSharedKernel,
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelExecutor,
} from '../execution/shared-kernel';
import { createStateProjection } from '../projection/state-projection';
import type { QuerySpan } from '../query/query';
import { Update } from '../schedule-token';
import { World } from '../world';

const Position = defineComponent('ExecutionConflictBoundaryPosition', { x: 'f32' });
const StructuralMarker = defineComponent('ExecutionConflictBoundaryMarker', {});

function readPosition(spans: readonly QuerySpan[]): void {
  for (const span of spans) void span.get(Position).x[0];
}

function incrementPosition(spans: readonly QuerySpan[]): void {
  for (const span of spans) {
    const values = span.mut(Position).x;
    for (let index = 0; index < span.length; index += 1) values[index] = (values[index] ?? 0) + 1;
  }
}

function doublePosition(spans: readonly QuerySpan[]): void {
  for (const span of spans) {
    const values = span.mut(Position).x;
    for (let index = 0; index < span.length; index += 1) values[index] = (values[index] ?? 0) * 2;
  }
}

type ConflictCase = 'read-read' | 'read-write' | 'write-write' | 'structure';

function runCase(
  kind: ConflictCase,
  shared: boolean,
): { readonly x: number; readonly trace: string[] } {
  const world = new World();
  const trace: string[] = [];
  let dispatchActive = false;
  if (shared) {
    const executor: SharedKernelExecutor = {
      execute(kernel, spans) {
        expect(dispatchActive).toBe(false);
        dispatchActive = true;
        trace.push(kernel.name);
        kernel.run(spans.map(({ span }) => span));
        dispatchActive = false;
        return {
          mode: 'shared',
          dispatched: spans.length,
          completed: spans.length,
          waitMs: 0,
        };
      },
    };
    world.insertResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, executor);
  }
  world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const projection = createStateProjection(world, [Position]);
  projection.read().accept();

  const first = defineSharedKernel(import.meta.url, {
    name: `${kind}-first`,
    minimumRows: 1,
    queries: [
      kind === 'read-read' || kind === 'read-write' ? { read: [Position] } : { write: [Position] },
    ],
    run: kind === 'read-read' || kind === 'read-write' ? readPosition : incrementPosition,
    before: kind === 'structure' ? ['structure'] : [`${kind}-second`],
  });
  const second = defineSharedKernel(import.meta.url, {
    name: `${kind}-second`,
    minimumRows: 1,
    queries: [kind === 'read-read' ? { read: [Position] } : { write: [Position] }],
    run:
      kind === 'read-read'
        ? readPosition
        : kind === 'read-write'
          ? incrementPosition
          : doublePosition,
    ...(kind === 'structure' ? { after: ['structure'] } : {}),
  });
  world.addSystem(Update, first).unwrap();
  if (kind === 'structure') {
    world
      .addSystem(Update, {
        name: 'structure',
        queries: [],
        before: [second.name],
        fn: (_world, _queries, commands) => {
          trace.push('structure');
          commands.spawn({ component: StructuralMarker, data: {} });
        },
      })
      .unwrap();
  }
  world.addSystem(Update, second).unwrap();

  world.update(0).unwrap();
  expect(projection.read().indices).toEqual(kind === 'read-read' ? [] : [0]);
  const [row] = world.query({ read: [Position] }).unwrap();
  return { x: row?.get(Position).x ?? Number.NaN, trace };
}

describe('SharedKernel conflict boundaries', () => {
  it.each<ConflictCase>([
    'read-read',
    'read-write',
    'write-write',
    'structure',
  ])('keeps %s deterministic and serial-equivalent', (kind) => {
    const serial = runCase(kind, false);
    const shared = runCase(kind, true);

    expect(shared.x).toBe(serial.x);
    expect(shared.trace.filter((entry) => entry !== 'structure')).toEqual([
      `${kind}-first`,
      `${kind}-second`,
    ]);
    if (kind === 'structure') {
      expect(shared.trace).toEqual(['structure-first', 'structure', 'structure-second']);
    }
  });
});
