import { componentSchema } from '@forgeax/engine-ecs/internal';
import { ChildOf } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  type Level,
  LevelError,
  type LevelService,
  type LevelStatus,
  type LevelTarget,
} from '../levels/level-service';
import { RuntimeStreamingScene } from '../streaming/streaming-scene';
import { RuntimeStreamingIndex, type StreamingCell } from '../streaming/world-index';
import { createWorldStreaming, type WorldStreaming } from '../streaming/world-streaming';

const guid = (id: number) => `db645548-be32-462e-87c1-${String(id).padStart(12, '0')}`;
const bounds = (x: number) => ({ minX: x, maxX: x + 8, minZ: -2, maxZ: 2 });
const grid = { cellSize: 10, pageSize: 1 };
const cell = (
  id: number,
  x: number,
  role: StreamingCell['role'],
  replacement?: StreamingCell['replacement'],
): StreamingCell => ({
  key: String(id),
  scene: guid(id),
  bounds: bounds(x),
  role,
  ...(replacement === undefined ? {} : { layer: 'scenery', replacement }),
});

function drained<T>(work: Generator<void, T>): T {
  for (;;) {
    const step = work.next();
    if (step.done) return step.value;
  }
}

it('leaves queries pending until the whole required page is visible, and indexes cross-bucket Cells once', () => {
  const index = new RuntimeStreamingIndex(
    [cell(1, -2, 'collision'), cell(2, 80, 'collision')],
    grid,
  );
  expect(drained(index.query(0, 0, 1))).toBeUndefined();
  while (index.inspect().pages < 1) index.advance(1);
  expect(index.inspect().pendingPages).toBeGreaterThan(0);
  expect(drained(index.query(84, 0, 1))).toBeUndefined();
  index.advance(256);
  expect([...(drained(index.query(0, 0, 8))?.keys() ?? [])]).toEqual(['1']);
  expect([...(drained(index.query(84, 0, 1))?.keys() ?? [])]).toEqual(['2']);
  expect(drained(index.query(500, 0, 1))?.size).toBe(0);
});

class FakeLevel implements Level {
  private phase: LevelTarget = 'unloaded';
  constructor(
    private readonly input: StreamingCell,
    private readonly deferred: Set<string>,
  ) {}
  request(target: LevelTarget) {
    if (target === 'prepared' && this.deferred.has(this.input.key)) {
      return ok({ done: new Promise<Result<LevelStatus, LevelError>>(() => {}) });
    }
    this.phase = target;
    return ok({ done: Promise.resolve(ok(this.inspect())) });
  }
  inspect(): LevelStatus {
    return {
      scene: this.input.scene,
      target: this.phase,
      phase: this.phase,
      current: true,
      members: 1,
      renderAccepted: this.phase === 'active',
      sourceAccepted: this.phase === 'active',
      collisionAccepted: this.phase === 'active' && this.input.role !== 'visual',
    };
  }
}

function controlled(content: readonly StreamingCell[], deferred = new Set<string>()) {
  const opened = new Map<string, FakeLevel>();
  let finish: ((accept: boolean) => void) | undefined;
  const service = {
    create({ scene }) {
      const row = content.find((entry) => entry.scene === scene);
      if (!row) throw Error('missing fixture Cell');
      const level = new FakeLevel(row, deferred);
      opened.set(row.key, level);
      return ok(level);
    },
    exchangeVisual(input) {
      return ok(
        new Promise<Result<void, LevelError>>((resolve) => {
          finish = (accept) => {
            finish = undefined;
            if (!accept)
              resolve(
                err(
                  new LevelError('level-participation-failed', {
                    scene: 'exchange',
                    target: 'active',
                    phase: 'prepared',
                  }),
                ),
              );
            else {
              for (const level of input.show) level.request('active');
              for (const level of input.hide) level.request('prepared');
              resolve(ok(undefined));
            }
          };
        }),
      );
    },
  } satisfies LevelService;
  return {
    service,
    opened,
    get finish() {
      return finish;
    },
  };
}

async function advance(stream: WorldStreaming, ticks = 12) {
  for (let i = 0; i < ticks; i++) {
    stream.step().unwrap();
    await Promise.resolve();
  }
}

function source(x: number) {
  return { x, z: 0, activeRadius: 2, prepareRadius: 10, hysteresis: 2 };
}

it('merges overlap without a duplicate instance and rechecks collision against the latest destination', async () => {
  const content = [cell(1, 0, 'collision'), cell(2, 100, 'collision')];
  const f = controlled(content);
  const stream = createWorldStreaming(f.service, { cells: content, grid }).unwrap();
  stream.setSource('player', source(4)).unwrap();
  stream.setSource('shared', source(4)).unwrap();
  await advance(stream);
  expect(stream.inspect()).toMatchObject({ started: 1, retired: 0 });
  expect(stream.inspectEntry('player')).toEqual({ state: 'ready' });
  stream.setSource('player', undefined).unwrap();
  await advance(stream);
  expect(stream.inspect()).toMatchObject({ started: 1, retired: 0 });
  stream.setSource('destination', source(104)).unwrap();
  expect(stream.inspectEntry('destination')).toEqual({ state: 'pending' });
  await advance(stream);
  expect(stream.inspectEntry('destination')).toEqual({ state: 'ready' });
  stream.setSource('destination', source(200)).unwrap();
  expect(stream.inspectEntry('destination')).toEqual({ state: 'pending' });
  await advance(stream);
  expect(stream.inspectEntry('destination')).toEqual({
    state: 'unavailable',
    reason: 'missing-collision',
  });
  expect(stream.inspect()).toMatchObject({ retired: 1 });
});

it('retains the proxy until both details are prepared and a shared exchange succeeds', async () => {
  const content = [
    cell(1, 15, 'visual', { group: 'one', role: 'proxy' }),
    cell(2, 15, 'visual', { group: 'one', role: 'detail' }),
    cell(3, 15, 'visual', { group: 'one', role: 'detail' }),
  ];
  const f = controlled(content);
  const stream = createWorldStreaming(f.service, { cells: content, grid }).unwrap();
  stream
    .setSource('player', { ...source(0), activeRadius: 20, detailRadius: 4, prepareRadius: 30 })
    .unwrap();
  await advance(stream);
  expect(stream.inspectCell('1')?.phase).toBe('active');
  expect(stream.inspectCell('2')?.phase).toBe('prepared');
  stream
    .setSource('player', { ...source(18), activeRadius: 20, detailRadius: 4, prepareRadius: 30 })
    .unwrap();
  await advance(stream);
  expect(f.finish).toBeDefined();
  expect(stream.inspectCell('1')?.phase).toBe('active');
  f.finish?.(false);
  await Promise.resolve();
  expect(stream.inspectCell('1')?.phase).toBe('active');
  expect(stream.inspectCell('2')?.phase).toBe('prepared');
  await advance(stream);
  f.finish?.(true);
  await Promise.resolve();
  expect(content.map(({ key }) => stream.inspectCell(key)?.phase)).toEqual([
    'prepared',
    'active',
    'active',
  ]);
  stream.setLayer('scenery', false);
  await advance(stream);
  expect(stream.inspect()).toMatchObject({ active: [], retired: 3 });
});

it('derives one lazy Scene for hard references crossing a grid boundary, reusing the Pack producer', async () => {
  const admit = vi.fn(async () => ok({}));
  const withdraw = vi.fn();
  const runtime = new RuntimeStreamingScene({
    namespace: guid(12),
    revision: 'source-3',
    packOptions: { sceneComponents: [{ name: ChildOf.name, fields: componentSchema(ChildOf) }] },
    scene: {
      kind: 'scene',
      entities: {
        root: { components: {} },
        child: { components: { ChildOf: { parent: 'root' } } },
      },
    },
    placements: [
      { key: 'child', bounds: bounds(25), role: 'visual' },
      { key: 'root', bounds: bounds(0), role: 'visual' },
    ],
    // The pure partitioner only calls these two producer methods.
    producer: {
      admit: admit as unknown as ConstructorParameters<
        typeof RuntimeStreamingScene
      >[0]['producer']['admit'],
      withdraw,
    },
  });
  const cells = [...runtime.cells(grid)].filter(
    (value): value is StreamingCell => value !== undefined,
  );
  expect(cells).toHaveLength(1);
  expect(cells[0]?.bounds).toEqual({ minX: 0, minZ: -2, maxX: 33, maxZ: 2 });
  expect(admit).not.toHaveBeenCalled();
  const selected = cells[0];
  if (selected === undefined) throw Error('missing derived Scene');
  await runtime.publish(selected.scene, new AbortController().signal);
  expect(admit).toHaveBeenCalledOnce();
  runtime.withdraw(selected.scene);
  expect(withdraw).toHaveBeenCalledOnce();
});

it('retains the earlier selection across an unread page and a superseded destination', async () => {
  const content = [
    cell(1, 0, 'collision'),
    ...Array.from({ length: 18 }, (_, i) => cell(i + 2, 300 + i * 25, 'collision')),
  ];
  const f = controlled(content);
  const stream = createWorldStreaming(f.service, {
    cells: content,
    grid,
    buildUnitsPerStep: 1,
  }).unwrap();
  stream.setSource('player', source(4)).unwrap();
  for (let i = 0; i < 256 && stream.inspectEntry('player').state !== 'ready'; i++)
    await advance(stream, 1);
  expect(stream.inspectEntry('player')).toEqual({ state: 'ready' });
  expect(stream.inspect().index.pendingPages).toBeGreaterThan(0);
  stream.setSource('player', source(729)).unwrap();
  await advance(stream, 1);
  expect(stream.inspectEntry('player')).toEqual({ state: 'pending' });
  expect(stream.inspectCell('1')?.phase).toBe('active');
  stream.setSource('player', source(4)).unwrap();
  await advance(stream, 2);
  expect(stream.inspectEntry('player')).toEqual({ state: 'ready' });
  expect(stream.inspect().started).toBe(1);
});

it('keeps the proxy visible while the last prepared detail is still pending', async () => {
  const content = [
    cell(1, 15, 'visual', { group: 'one', role: 'proxy' }),
    cell(2, 15, 'visual', { group: 'one', role: 'detail' }),
    cell(3, 15, 'visual', { group: 'one', role: 'detail' }),
  ];
  const f = controlled(content, new Set(['3']));
  const stream = createWorldStreaming(f.service, { cells: content, grid }).unwrap();
  stream
    .setSource('player', { ...source(18), activeRadius: 20, detailRadius: 4, prepareRadius: 30 })
    .unwrap();
  await advance(stream, 50);
  expect(stream.inspectCell('1')?.phase).toBe('active');
  expect(stream.inspectCell('2')?.phase).toBe('prepared');
  expect(f.finish).toBeUndefined();
});
