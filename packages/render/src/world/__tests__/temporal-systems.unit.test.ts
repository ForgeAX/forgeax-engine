import type { EntityHandle } from '@forgeax/engine-ecs';
import { expect, it, vi } from 'vitest';
import { TemporalViewHistory } from '../../temporal/frame';
import { adoptViewRecordHistory, viewRecordHistory } from '../record-history';
import { ViewRecorder, ViewSubmission } from '../render-views';
import { beginRenderFrame, createRenderWorld, endRenderFrame, RenderCommit } from '../render-world';
import {
  RENDER_CLOUD_HISTORY_COMMIT_SYSTEM,
  RENDER_STANDARD_OUTPUT_COMMIT_SYSTEM,
  RENDER_TEMPORAL_DISCARD_SYSTEM,
  RENDER_TEMPORAL_FRAME_COMMIT_SYSTEM,
  RENDER_TEMPORAL_GPU_COMMIT_SYSTEM,
  RENDER_TEMPORAL_VIEW_COMMIT_SYSTEM,
} from '../temporal-systems';

const standardOutput = vi.hoisted(() => ({
  commit: vi.fn(),
  discard: vi.fn(),
  retire: vi.fn(),
}));
vi.mock('../../pipeline/standard-output/resources', () => ({
  commitStandardOutputSubmission: standardOutput.commit,
  discardStandardOutputStates: standardOutput.discard,
  retirePendingStandardOutputGpu: standardOutput.retire,
}));

function fixture() {
  const world = createRenderWorld();
  let stagedFrame = false;
  const transaction = {
    inspect: () => ({ staged: stagedFrame }),
    commit: vi.fn(({ accepted }: { accepted: boolean }) => {
      stagedFrame = false;
      return { ok: true as const, accepted };
    }),
  };
  const gpu = {
    pendingIndex: undefined as number | undefined,
    readIndex: 0,
    valid: false,
    committed: false,
    childScope: { retire: vi.fn() },
  };
  const frameState = {
    temporalFrameTransaction: transaction,
    temporalView: new TemporalViewHistory(),
    temporalGpuState: undefined as typeof gpu | undefined,
    activeTemporalGpuState: undefined as typeof gpu | undefined,
    retiringTemporalGpuStates: new Set(),
    cloudHistoryActive: false,
    pendingCloudHistoryActive: undefined as boolean | undefined,
  };
  const internals = { device: { queue: {} }, errorRegistry: { fire: vi.fn() } };
  const view = world
    .spawn(
      {
        component: ViewSubmission,
        data: { accepted: false, attempt: 0, scene: false, temporal: false },
      },
      {
        component: ViewRecorder,
        data: {
          state: world.allocUniqueRef('ViewRecorder', {
            owner: {
              frameState,
              internals,
              skin: { trackSubmittedWork: () => undefined, complete: () => [] },
            },
          }),
        },
      },
    )
    .unwrap();
  adoptViewRecordHistory(world, view);
  /** One frame: the view stages every temporal candidate, then its submission settles. */
  const frame = (
    number: number,
    submission: {
      accepted: boolean;
      attempt?: number;
      scene?: boolean;
      presentation?: 'pending' | 'ready';
    },
  ) => {
    beginRenderFrame(world, number);
    const { presentation = 'ready', ...facts } = submission;
    const history = viewRecordHistory(world, view);
    if (history === undefined) throw new Error('missing record history');
    history.presentation = presentation;
    stagedFrame = true;
    gpu.pendingIndex = 1;
    frameState.temporalGpuState = gpu;
    frameState.pendingCloudHistoryActive = true;
    frameState.temporalView.stage({ kind: 'off', view: {} as never });
    world
      .set(view as EntityHandle, ViewSubmission, {
        scene: true,
        temporal: false,
        attempt: number,
        ...facts,
      })
      .unwrap();
    endRenderFrame(world);
  };
  return { world, frameState, transaction, gpu, frame };
}

it('schedules the temporal commits after record-commit in dependency order, and one discard', () => {
  const data = createRenderWorld().scheduleData();
  const commit = data.find((schedule) => schedule.name === 'RenderCommit');
  const cleanup = data.find((schedule) => schedule.name === 'RenderCleanup');
  const chain = [
    RENDER_TEMPORAL_FRAME_COMMIT_SYSTEM,
    RENDER_STANDARD_OUTPUT_COMMIT_SYSTEM,
    RENDER_TEMPORAL_GPU_COMMIT_SYSTEM,
    RENDER_CLOUD_HISTORY_COMMIT_SYSTEM,
    RENDER_TEMPORAL_VIEW_COMMIT_SYSTEM,
  ];
  for (const name of chain) {
    const system = commit?.systems.find((entry) => entry.name === name);
    expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewSubmission']);
    expect(system?.queries[0]?.write ?? []).toEqual([]);
  }
  for (const [before, after] of chain.slice(0, -1).map((name, i) => [name, chain[i + 1]]))
    expect(commit?.dependencies).toContainEqual([before, after]);
  expect(cleanup?.systems.map((system) => system.name)).toContain(RENDER_TEMPORAL_DISCARD_SYSTEM);
});

it('an accepted submission of this frame advances every temporal history', () => {
  const { frameState, transaction, gpu, frame } = fixture();
  frame(1, { accepted: true });
  expect(transaction.commit).toHaveBeenCalledWith({ accepted: true });
  expect(frameState.activeTemporalGpuState).toBe(gpu);
  expect(gpu.committed).toBe(true);
  expect(frameState.cloudHistoryActive).toBe(true);
  expect(frameState.pendingCloudHistoryActive).toBeUndefined();
  expect(frameState.temporalView.accepted).toBeDefined();
  expect(standardOutput.commit).toHaveBeenCalledTimes(1);
});

it.each([
  ['a rejected submit', { accepted: false }],
  ['a stale attempt', { accepted: true, attempt: 0 }],
])('%s never advances history and discards the staged candidates', (_name, submission) => {
  standardOutput.commit.mockClear();
  standardOutput.discard.mockClear();
  const { frameState, transaction, gpu, frame } = fixture();
  frame(1, submission);
  expect(transaction.commit).toHaveBeenCalledTimes(1);
  expect(transaction.commit).toHaveBeenCalledWith({ accepted: false });
  expect(frameState.activeTemporalGpuState).toBeUndefined();
  expect(gpu.committed).toBe(false);
  expect(gpu.pendingIndex).toBeUndefined();
  expect(frameState.temporalGpuState).toBeUndefined();
  expect(frameState.cloudHistoryActive).toBe(false);
  expect(frameState.pendingCloudHistoryActive).toBeUndefined();
  expect(standardOutput.commit).not.toHaveBeenCalled();
  expect(standardOutput.discard).toHaveBeenCalled();
  expect(standardOutput.retire).toHaveBeenCalled();
});

it('an accepted preparation-only attempt (no scene picture) never advances history', () => {
  standardOutput.commit.mockClear();
  standardOutput.discard.mockClear();
  standardOutput.retire.mockClear();
  const { frameState, transaction, gpu, frame } = fixture();
  frame(1, { accepted: true, scene: false });
  expect(transaction.commit).not.toHaveBeenCalledWith({ accepted: true });
  expect(frameState.temporalView.accepted).toBeUndefined();
  expect(frameState.activeTemporalGpuState).toBeUndefined();
  expect(gpu.committed).toBe(false);
  expect(frameState.cloudHistoryActive).toBe(false);
  expect(standardOutput.commit).not.toHaveBeenCalled();
  expect(standardOutput.discard).toHaveBeenCalled();
  // No Standard output pass ran: its staged GPU resources stay pending for the
  // next scene attempt instead of being reallocated by every preparation barrier.
  expect(standardOutput.retire).not.toHaveBeenCalled();
});

it('a submitted but pending picture discards every temporal candidate', () => {
  const { frameState, transaction, gpu, frame } = fixture();
  frame(1, { accepted: true, presentation: 'pending' });
  expect(transaction.commit.mock.calls.every(([arg]) => arg.accepted === false)).toBe(true);
  expect(frameState.temporalView.accepted).toBeUndefined();
  expect(gpu.valid).toBe(false);
  expect(frameState.cloudHistoryActive).toBe(false);
});

it('a view that never reached its submission is discarded, not committed, at cleanup', () => {
  const { frameState, transaction, frame } = fixture();
  frame(1, { accepted: false });
  frame(2, { accepted: true, attempt: 1 });
  expect(transaction.commit.mock.calls.every(([arg]) => arg.accepted === false)).toBe(true);
  expect(frameState.cloudHistoryActive).toBe(false);
});

it('without the commit systems an accepted submission leaves history unadvanced', () => {
  const { world, frameState, transaction, frame } = fixture();
  for (const name of [
    RENDER_TEMPORAL_VIEW_COMMIT_SYSTEM,
    RENDER_CLOUD_HISTORY_COMMIT_SYSTEM,
    RENDER_TEMPORAL_GPU_COMMIT_SYSTEM,
    RENDER_STANDARD_OUTPUT_COMMIT_SYSTEM,
    RENDER_TEMPORAL_FRAME_COMMIT_SYSTEM,
  ])
    world.removeSystem(RenderCommit, name).unwrap();
  frame(1, { accepted: true });
  expect(transaction.commit).not.toHaveBeenCalledWith({ accepted: true });
  expect(frameState.activeTemporalGpuState).toBeUndefined();
  expect(frameState.cloudHistoryActive).toBe(false);
});
