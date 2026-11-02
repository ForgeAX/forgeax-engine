import { describe, expect, it, vi } from 'vitest';
import {
  type PointsLinesFrameOutcome,
  type PreparedPointsLines,
  StandardPointsLinesOwner,
} from '../../points-lines/standard-owner';
import type { RenderSystemInternals } from '../../record/render-context';
import type { CameraSnapshot } from '../../render-contract';
import type { ExtractedFrame } from '../../render-system-extract';
import { RENDER_CASCADE_FIT_SYSTEM } from '../light-systems';
import {
  POINTS_LINES_COMMIT_SYSTEM,
  POINTS_LINES_SETTLE_SYSTEM,
  registerPointsLinesSystems,
  VIEW_POINTS_LINES_SYSTEM,
} from '../points-lines-systems';
import {
  RenderViewFrameSource,
  RenderViewInput,
  RenderViews,
  recordViewSubmission,
  ViewRecorder,
} from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderCleanup,
  RenderCommit,
  RenderExtract,
  RenderPrepare,
  renderSubmission,
} from '../render-world';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
} from '../view-frame-systems';
import {
  adoptViewPointsLines,
  consumeViewPointsLines,
  preparedPointsLinesSlots,
} from '../view-points-lines';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const camera = {
  entityKey: 1,
  historyVersion: 1,
  view: {
    viewport: new Float32Array([0, 0, 1, 1]),
    order: 0,
    resolutionScale: 1,
    maxRenderShortSide: 0,
    updateInterval: 1,
    enabled: true,
  },
} as unknown as CameraSnapshot;

function setup(removed = false) {
  const world = createRenderWorld();
  const views = new RenderViews(world);
  registerPointsLinesSystems(world);
  if (removed) world.removeSystem(RenderCommit, POINTS_LINES_COMMIT_SYSTEM).unwrap();
  world.insertResource(RenderViewInput, {
    cameras: [camera],
    captures: [],
    primary: false,
    primaryCamera: undefined,
    canvas: { width: 64, height: 64 },
    attachment: () => 'w',
    targetExtent: () => undefined,
  });
  beginRenderFrame(world, 1);
  const entity = views.ordered[0] as NonNullable<(typeof views.ordered)[0]>;
  const calls: string[] = [];
  const owner = adoptViewPointsLines(world, entity, {} as never);
  const fake = owner as unknown as Record<string, unknown>;
  fake.commit = (done: unknown) => calls.push(done === 'fence' ? 'commit:fence' : 'commit');
  fake.discard = () => calls.push('discard');
  return { world, entity, calls, owner: owner as StandardPointsLinesOwner };
}

describe('points-lines systems', () => {
  it('commits an accepted attempt with the frame completion and discards a rejected one', () => {
    for (const [accepted, expected] of [
      [true, 'commit:fence'],
      [false, 'discard'],
    ] as const) {
      const { world, entity, calls } = setup();
      renderSubmission(world).completion = 'fence' as unknown as Promise<void>;
      recordViewSubmission(world, entity, {
        accepted,
        attempt: 1,
        scene: accepted,
        temporal: false,
      });
      endRenderFrame(world);
      expect(calls).toEqual([expected]);
    }
  });

  it('does nothing without the commit system', () => {
    const { world, entity, calls } = setup(true);
    recordViewSubmission(world, entity, {
      accepted: true,
      attempt: 1,
      scene: true,
      temporal: false,
    });
    endRenderFrame(world);
    expect(calls).toEqual([]);
  });
});

describe('view-points-lines system', () => {
  const opts = { cameraOwner: 0, resourceOwner: 0 } as const;

  function stagedSetup(prepare: (owner: StandardPointsLinesOwner) => PointsLinesFrameOutcome) {
    const world = createRenderWorld();
    world.insertResource(
      RenderViewInput,
      new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
    );
    registerPointsLinesSystems(world);
    const recorder = {
      prepareViewFrame: () => ({
        ok: true as const,
        value: { renderables: [] } as unknown as ExtractedFrame,
      }),
    };
    registerViewFrameStub(world, recorder.prepareViewFrame);
    const staged = world.spawn().unwrap();
    const held = world.spawn().unwrap();
    const owners = new Map<unknown, StandardPointsLinesOwner>();
    const capacity = vi.fn();
    for (const entity of [staged, held]) {
      const state = world.allocUniqueRef(
        'ViewRecorder',
        withInertTemporal(
          {},
          {
            internals: {
              device: { caps: { storageBuffer: true } },
              getPipelineState: () => ({ ensurePointsLinesViewCapacity: capacity }),
            },
            scene: { shadowCasterProjection: () => undefined },
          },
        ),
      );
      world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
      const owner = adoptViewPointsLines(world, entity, {} as never);
      vi.spyOn(owner, 'prepareFrame').mockImplementation(() => prepare(owner));
      owners.set(entity, owner);
    }
    world
      .addSystem(RenderExtract, {
        name: RENDER_VIEW_RECORDERS_SYSTEM,
        queries: [],
        fn: (world) => stageViewFrame(world, staged, opts),
      })
      .unwrap();
    return { world, staged, held, owners, capacity };
  }

  it('prepares each staged view once after its frame and leaves held views alone', () => {
    const value = { ok: true, rows: new Map(), slots: 0 } as PointsLinesFrameOutcome;
    const { world, staged, held, owners } = stagedSetup(() => value);
    beginRenderFrame(world, 1);
    expect(owners.get(staged)?.stagedOutcome(1)).toBe(value);
    expect(owners.get(held)?.stagedOutcome(1)).toBeUndefined();
    const system = world
      .scheduleData()
      .find((data) => data.name === 'RenderPrepare')
      ?.systems.find((data) => data.name === VIEW_POINTS_LINES_SYSTEM);
    expect(system?.after).toContain(RENDER_VIEW_FRAME_SYSTEM);
    endRenderFrame(world);
    // The cleanup settle drops the outcome no recording took.
    expect(owners.get(staged)?.stagedOutcome(1)).toBeUndefined();
    expect(
      world
        .scheduleData()
        .find((data) => data.name === 'RenderCleanup')
        ?.systems.some((data) => data.name === POINTS_LINES_SETTLE_SYSTEM),
    ).toBe(true);
  });

  it('grows the view buffer to the prepared slots in RenderPrepare, before recording', () => {
    const rows = new Map([
      ['0:1', { submission: undefined, slot: 0, stale: () => false }],
      ['0:2', { submission: undefined, slot: 1, stale: () => false }],
    ]);
    const { world, capacity } = stagedSetup(() => ({ ok: true, rows, slots: 2 }));
    beginRenderFrame(world, 1);
    expect(capacity).toHaveBeenCalledOnce();
    expect(capacity).toHaveBeenCalledWith(2);
    endRenderFrame(world);
  });

  it('reports a capacity failure as the view outcome instead of throwing', () => {
    const cause = new Error('buffer limit');
    const { world, staged, owners, capacity } = stagedSetup(() => ({
      ok: true,
      rows: new Map(),
      slots: 1,
    }));
    capacity.mockImplementation(() => {
      throw cause;
    });
    beginRenderFrame(world, 1);
    expect(owners.get(staged)?.stagedOutcome(1)).toEqual({ ok: false, cause });
    endRenderFrame(world);
  });

  it('reports the prepared slots for capture views and addresses the prepared slot when consumed', () => {
    const row = { submission: {}, slot: 3, stale: () => false } as unknown as PreparedPointsLines;
    const { world, staged } = stagedSetup(() => ({
      ok: true,
      rows: new Map([['0:1', row]]),
      slots: 4,
    }));
    beginRenderFrame(world, 1);
    expect(preparedPointsLinesSlots(internalsOf(world, staged))).toBe(4);
    const rows = consumeViewPointsLines(internalsOf(world, staged));
    expect(rows?.slot({ source: { worldId: 0, entityKey: 1 } } as never)).toBe(3);
    endRenderFrame(world);
  });

  it('reports zero slots when nothing was prepared or preparation failed', () => {
    const { world, staged } = stagedSetup(() => ({ ok: false, cause: new Error('upload') }));
    expect(preparedPointsLinesSlots(internalsOf(world, staged))).toBe(0);
    beginRenderFrame(world, 1);
    expect(preparedPointsLinesSlots(internalsOf(world, staged))).toBe(0);
    endRenderFrame(world);
  });

  it('declares its view reads, phase order and no writes in the schedule', () => {
    const { world } = stagedSetup(() => ({ ok: true, rows: new Map(), slots: 0 }));
    const phase = (name: string) => world.scheduleData().find((data) => data.name === name);
    const prepare = phase('RenderPrepare')?.systems.find(
      (data) => data.name === VIEW_POINTS_LINES_SYSTEM,
    );
    expect(prepare?.after).toEqual([RENDER_VIEW_FRAME_SYSTEM, RENDER_CASCADE_FIT_SYSTEM]);
    expect(prepare?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame', 'ViewPointsLines']);
    expect(prepare?.queries[0]?.write ?? []).toEqual([]);
    const settle = phase('RenderCleanup')?.systems.find(
      (data) => data.name === POINTS_LINES_SETTLE_SYSTEM,
    );
    expect(settle?.queries[0]?.read).toEqual(['ViewPointsLines']);
    expect(settle?.queries[0]?.write ?? []).toEqual([]);
  });

  it('stages nothing once the system is removed', () => {
    const { world, staged, owners } = stagedSetup(() => ({ ok: true, rows: new Map(), slots: 0 }));
    world.removeSystem(RenderPrepare, VIEW_POINTS_LINES_SYSTEM).unwrap();
    beginRenderFrame(world, 1);
    expect(owners.get(staged)?.stagedOutcome(1)).toBeUndefined();
    endRenderFrame(world);
  });

  it('keeps an unsettled outcome once the settle system is removed', () => {
    const { world, staged, owners } = stagedSetup(() => ({ ok: true, rows: new Map(), slots: 0 }));
    world.removeSystem(RenderCleanup, POINTS_LINES_SETTLE_SYSTEM).unwrap();
    beginRenderFrame(world, 1);
    endRenderFrame(world);
    expect(owners.get(staged)?.stagedOutcome(1)).toBeDefined();
  });

  function internalsOf(world: ReturnType<typeof createRenderWorld>, entity: unknown) {
    return { renderWorld: world, viewEntity: entity } as unknown as RenderSystemInternals;
  }

  it('rethrows a preparation failure inside the recording', () => {
    const cause = new Error('upload');
    const { world, staged } = stagedSetup(() => ({ ok: false, cause }));
    beginRenderFrame(world, 1);
    expect(() => consumeViewPointsLines(internalsOf(world, staged))).toThrow(cause);
    endRenderFrame(world);
  });

  it('rejects the submission when a Feature mutated a row source after RenderPrepare', () => {
    let stale = false;
    const row = { submission: {}, slot: 0, stale: () => stale } as unknown as PreparedPointsLines;
    const { world, staged } = stagedSetup(() => ({
      ok: true,
      rows: new Map([['0:1', row]]),
      slots: 1,
    }));
    beginRenderFrame(world, 1);
    const internals = internalsOf(world, staged);
    expect(consumeViewPointsLines(internals)).toBeDefined();
    stale = true;
    expect(() => consumeViewPointsLines(internals)).toThrow(/frame-submit-rejected|rejected/);
    endRenderFrame(world);
  });

  it('refuses to record rows the system did not prepare', () => {
    const { world, held } = stagedSetup(() => ({ ok: true, rows: new Map(), slots: 0 }));
    beginRenderFrame(world, 1);
    const rows = consumeViewPointsLines(internalsOf(world, held));
    expect(() => rows?.submission({ source: {} } as never)).toThrow(/view-points-lines/);
    endRenderFrame(world);
  });
});

describe('Points/Lines frame preparation set', () => {
  const row = (entityKey: number, extra: object = {}) =>
    ({ worldId: 0, entityKey, pointsLines: {}, ...extra }) as never;

  it('prepares the whole retained set, for every row of the set it is given', () => {
    const owner = new StandardPointsLinesOwner({} as never);
    const prepare = vi.spyOn(owner, 'prepare').mockReturnValue({} as never);
    const rows = [row(1), row(2), row(3)];
    const outcome = owner.prepareFrame(
      rows as never,
      () => ({ assetRevision: () => 1 }) as never,
      true,
    );
    expect(outcome.ok && [...outcome.rows.keys()]).toEqual(['0:1', '0:2', '0:3']);
    expect(outcome.ok && [...outcome.rows.values()].map((prepared) => prepared.slot)).toEqual([
      0, 1, 2,
    ]);
    expect(outcome.ok && outcome.slots).toBe(3);
    expect(prepare).toHaveBeenCalledTimes(3);
  });
});
