import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { assert, describe, expect, it, vi } from 'vitest';
import {
  type FrameRecording,
  recordFrameTransaction,
  submitFrameRecordings,
} from '../assembly/frame-recording';
import { ResidencyLifetime } from '../device/residency-lifetime';

describe('physical submission residency', () => {
  it('tracks every view before publication and drains after a tracking observer throws', async () => {
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const destroyed = [vi.fn(), vi.fn()];
    const lifetimes = destroyed.map((destroy) => new ResidencyLifetime(destroy));
    const tracked: number[] = [],
      committed: number[] = [];
    const encoder = { finish: () => ({ ok: true, value: {} }) } as unknown as RhiCommandEncoder;
    const onSubmittedWorkDone = vi.fn(() => done);
    const device = {
      queue: { submit: () => ({ ok: true, value: undefined }), onSubmittedWorkDone },
    } as unknown as RhiDevice;
    function* record(index: number): FrameRecording {
      const lifetime = lifetimes[index];
      assert(lifetime);
      const result = yield* recordFrameTransaction(
        {
          build: () => ({ ok: true, value: undefined }),
          execute: () => ({ ok: true, value: undefined }),
          finish: () => ({ ok: true, value: undefined }),
          commit: () => {
            expect(tracked).toEqual([0, 1]);
            committed.push(index);
            lifetime.retire();
          },
        },
        {
          encoder,
          device,
          reportError: () => undefined,
          onSubmittedWork: (completed) => {
            lifetime.track(completed);
            tracked.push(index);
            if (index === 0) throw new Error('observer failed');
          },
        },
      );
      return result.ok;
    }
    expect(() => submitFrameRecordings([record(0), record(1)])).toThrow('observer failed');
    expect(committed).toEqual([0, 1]);
    expect(onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    for (const destroy of destroyed) expect(destroy).not.toHaveBeenCalled();
    complete();
    await done;
    for (const destroy of destroyed) expect(destroy).toHaveBeenCalledTimes(1);
  });
  it.each([
    'resolve',
    'reject',
  ] as const)('tracks submitted storage through completion %s after a publication fence rejects it', async (outcome) => {
    let generation = 1;
    let complete!: () => void;
    const completion = new Promise<void>((resolve, reject) => {
      complete = outcome === 'resolve' ? resolve : () => reject(new Error('device lost'));
    });
    const destroy = vi.fn();
    const lifetime = new ResidencyLifetime(destroy);
    const commit = vi.fn();
    const encoder = { finish: () => ({ ok: true, value: {} }) } as unknown as RhiCommandEncoder;
    const device = {
      queue: {
        submit: () => {
          generation++;
          return { ok: true, value: undefined };
        },
        onSubmittedWorkDone: () => completion,
      },
    } as unknown as RhiDevice;
    function* record(): FrameRecording {
      const result = yield* recordFrameTransaction(
        {
          build: () => ({ ok: true, value: undefined }),
          execute: () => ({ ok: true, value: undefined }),
          finish: () => ({ ok: true, value: undefined }),
          generationFence: { capturedGeneration: 1, currentGeneration: () => generation },
          commit,
          abort: () => lifetime.retire(),
        },
        {
          encoder,
          device,
          reportError: () => undefined,
          onSubmittedWork: (done: Promise<void>) => lifetime.track(done),
        },
      );
      return result.ok;
    }
    expect(submitFrameRecordings([record()])).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    complete();
    await completion.catch(() => undefined);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
