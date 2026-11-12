import { renderGraphCompileCount } from '@forgeax/engine-render-graph';
import { describe, expect, it, vi } from 'vitest';
import {
  getRenderFeaturePlanExecutionProjection,
  hasNativeRenderFeatureExecutionSignature,
} from '../../features/host';
import * as sharedGraphs from '../feature-graph-systems';
import { recordDispatches, sharedNativeFixture } from './shared-frame-native-fixture';

describe('shared native frame commands', () => {
  it('keeps the complete fullscreen registration beside current native shared commands', async () => {
    const f = await sharedNativeFixture();
    try {
      f.state.fullscreen = true;
      const before = renderGraphCompileCount();
      const first = f.prepare(2);
      if (first.receipt.kind !== 'compiled') throw new Error('Missing active graph');
      const registration = first.receipt.plans.find(
        (plan) => plan.featureIdentity === 'shared-test-outline',
      );
      if (registration === undefined) throw new Error('Fullscreen registration was omitted');
      expect(hasNativeRenderFeatureExecutionSignature(registration)).toBe(false);
      expect(getRenderFeaturePlanExecutionProjection(registration)?.passes).toEqual([]);
      expect(first.receipt.plans).toBe(first.sealed.batch.frame.plans);
      expect(first.sealed.batch.frame.fullscreenEffects.has('fullscreen.shared-test-outline')).toBe(
        true,
      );
      expect(
        first.sealed.batch.views
          .get('main')
          ?.fullscreenEffects.has('fullscreen.shared-test-outline'),
      ).toBe(true);
      expect(sharedGraphs.inspectSharedFeatureGraphs(f.world)?.last.route).toBe('native-shell');
      const calls = recordDispatches(first.encoder);
      expect(f.encode(first.encoder).ok).toBe(true);
      expect(calls.groups).toEqual([
        [1, 1, 1],
        [2, 1, 1],
        [1, 1, 1],
        [2, 1, 1],
      ]);
      expect(calls.copies).toHaveBeenCalledTimes(2);
      f.finish();

      const empty = f.prepare(0);
      expect(empty.receipt.kind).toBe('empty');
      expect(
        empty.receipt.plans.some((plan) => plan.featureIdentity === 'shared-test-outline'),
      ).toBe(true);
      expect(f.encode(empty.encoder).ok).toBe(true);
      f.finish();

      f.state.groups = 5;
      const next = f.prepare(1);
      if (next.receipt.kind !== 'compiled') throw new Error('Missing current graph');
      expect(next.receipt.graph).toBe(first.receipt.graph);
      const current = recordDispatches(next.encoder);
      expect(f.encode(next.encoder).ok).toBe(true);
      expect(current.groups).toEqual([
        [5, 1, 1],
        [6, 1, 1],
      ]);
      f.finish();
      expect(renderGraphCompileCount() - before).toBe(1);
      expect(sharedGraphs.inspectSharedFeatureGraphs(f.world)).toMatchObject({
        nativeFrames: 2,
        emptyFrames: 1,
        fallbackFrames: 0,
        shellBuilds: 1,
        shellReuses: 1,
      });
    } finally {
      await f.dispose();
    }
  });

  it('reuses one shell across empty, many, few and empty current submissions', async () => {
    const f = await sharedNativeFixture();
    try {
      const before = renderGraphCompileCount();
      const empty = f.prepare(0);
      expect(empty.receipt.kind).toBe('empty');
      expect(f.encode(empty.encoder).ok).toBe(true);
      f.finish();

      const many = f.prepare(3);
      if (many.receipt.kind !== 'compiled') throw new Error('Missing active graph');
      const acknowledged = f.submitted.mock.calls.length;
      const recorded = recordDispatches(many.encoder);
      expect(f.encode(many.encoder).ok).toBe(true);
      expect(recorded.groups).toEqual([
        [1, 1, 1],
        [2, 1, 1],
        [1, 1, 1],
        [2, 1, 1],
        [1, 1, 1],
        [2, 1, 1],
      ]);
      expect(recorded.copies).toHaveBeenCalledTimes(3);
      expect(f.submitted).toHaveBeenCalledTimes(acknowledged);
      f.finish();
      expect(f.submitted).toHaveBeenCalledTimes(acknowledged + 1);
      const heldInspection = sharedGraphs.inspectSharedFeatureGraphs?.(f.world);

      f.state.groups = 7;
      const few = f.prepare(1);
      if (few.receipt.kind !== 'compiled') throw new Error('Missing current graph');
      expect(few.receipt.graph).toBe(many.receipt.graph);
      const current = recordDispatches(few.encoder);
      expect(f.encode(few.encoder).ok).toBe(true);
      expect(current.groups).toEqual([
        [7, 1, 1],
        [8, 1, 1],
      ]);
      expect(current.copies).toHaveBeenCalledTimes(1);
      expect(few.receipt.plans).toBe(few.sealed.batch.frame.plans);
      expect(few.receipt.plans).not.toBe(many.receipt.plans);
      f.finish();
      expect(heldInspection).toMatchObject({ nativeFrames: 1, shellReuses: 0 });

      const last = f.prepare(0);
      expect(last.receipt.kind).toBe('empty');
      expect(f.encode(last.encoder).ok).toBe(true);
      f.finish();
      expect(renderGraphCompileCount() - before).toBe(1);
      expect(sharedGraphs.inspectSharedFeatureGraphs(f.world)).toMatchObject({
        nativeFrames: 2,
        emptyFrames: 2,
        shellBuilds: 1,
        shellReuses: 1,
        last: { route: 'empty', encoded: true },
      });
    } finally {
      await f.dispose();
    }
  });

  it('uses current physical buffers and copy offsets without retaining the prior frame', async () => {
    const f = await sharedNativeFixture();
    try {
      const first = f.prepare();
      if (first.receipt.kind !== 'compiled') throw new Error('Missing first graph');
      const firstCopies = vi.spyOn(first.encoder, 'copyBufferToBuffer');
      const oldSource = f.source();
      expect(f.encode(first.encoder).ok).toBe(true);
      expect(firstCopies).toHaveBeenCalledWith(oldSource, 0, f.target(), 4, 4);
      f.finish();

      f.replaceBuffer();
      f.state.offset = 12;
      const next = f.prepare();
      if (next.receipt.kind !== 'compiled') throw new Error('Missing replacement graph');
      expect(next.receipt.graph).toBe(first.receipt.graph);
      const nextCopies = vi.spyOn(next.encoder, 'copyBufferToBuffer');
      expect(f.encode(next.encoder).ok).toBe(true);
      expect(f.source()).not.toBe(oldSource);
      expect(nextCopies).toHaveBeenCalledWith(f.source(), 12, f.target(), 16, 4);
      f.finish();
    } finally {
      await f.dispose();
    }
  });

  it('rechecks physical usage aliases, zero dispatches and disabled passes each frame', async () => {
    const f = await sharedNativeFixture();
    try {
      f.state.copies = false;
      f.state.groups = 0;
      const separate = f.prepare();
      const separateCalls = recordDispatches(separate.encoder);
      expect(f.encode(separate.encoder).ok).toBe(true);
      expect(separateCalls.compute).toHaveBeenCalledTimes(1);
      // Host preparation omits zero-sized dispatches, retaining their access scope.
      expect(separateCalls.groups).toEqual([[1, 1, 1]]);
      f.finish();

      f.alias(true);
      const aliased = f.prepare();
      const aliasCalls = recordDispatches(aliased.encoder);
      expect(f.encode(aliased.encoder).ok).toBe(true);
      // The same physical buffer changes from storage-write to storage-read.
      expect(aliasCalls.compute).toHaveBeenCalledTimes(2);
      expect(aliasCalls.groups).toEqual([[1, 1, 1]]);
      f.finish();

      f.state.disabled = true;
      const disabled = f.prepare(2);
      const disabledCalls = recordDispatches(disabled.encoder);
      expect(f.encode(disabled.encoder).ok).toBe(true);
      expect(disabledCalls.compute).not.toHaveBeenCalled();
      expect(disabledCalls.groups).toEqual([]);
      f.finish();
    } finally {
      await f.dispose();
    }
  });

  it('does not acknowledge a failed encode and can encode the next current frame', async () => {
    const f = await sharedNativeFixture();
    try {
      const failed = f.prepare();
      if (failed.receipt.kind !== 'compiled') throw new Error('Missing graph');
      vi.spyOn(failed.encoder, 'copyBufferToBuffer').mockImplementation(() => {
        throw new Error('copy rejected');
      });
      expect(f.encode(failed.encoder).ok).toBe(false);
      expect(sharedGraphs.sharedFeatureGraphEncodeError(f.world)).toMatchObject({
        detail: {
          cause: { code: 'pass-encode-failed', detail: { passName: 'copy-0', passKind: 'copy' } },
        },
      });
      f.finish(false);
      expect(f.submitted).not.toHaveBeenCalled();
      expect(f.aborted).toHaveBeenCalledTimes(1);
      expect(sharedGraphs.inspectSharedFeatureGraphs(f.world)).toMatchObject({ encodeFailures: 1 });

      const next = f.prepare(2);
      if (next.receipt.kind !== 'compiled') throw new Error('Missing retry graph');
      expect(next.receipt.graph).toBe(failed.receipt.graph);
      const calls = recordDispatches(next.encoder);
      expect(f.encode(next.encoder).ok).toBe(true);
      expect(calls.copies).toHaveBeenCalledTimes(2);
      f.finish();
      expect(f.submitted).toHaveBeenCalledTimes(1);
    } finally {
      await f.dispose();
    }
  });

  it('keeps a mixed native and raw batch wholly on the original graph route', async () => {
    const f = await sharedNativeFixture();
    try {
      f.state.mixed = true;
      f.state.fullscreen = true;
      const mixed = f.prepare();
      if (mixed.receipt.kind !== 'compiled') throw new Error('Missing fallback graph');
      const calls = recordDispatches(mixed.encoder);
      expect(f.encode(mixed.encoder).ok).toBe(true);
      expect(calls.groups).toEqual([
        [1, 1, 1],
        [2, 1, 1],
        [1, 1, 1],
        [2, 1, 1],
      ]);
      expect(calls.copies).toHaveBeenCalledTimes(2);
      expect(sharedGraphs.inspectSharedFeatureGraphs(f.world)).toMatchObject({
        nativeFrames: 0,
        fallbackFrames: 1,
        shellBuilds: 0,
        last: { route: 'compiled-graph', encoded: true },
      });
      f.finish();
    } finally {
      await f.dispose();
    }
  });

  it('preserves cross-Feature order and physical write/read scopes without coalescing them', async () => {
    const f = await sharedNativeFixture();
    try {
      f.state.copies = false;
      f.state.secondNative = true;
      f.alias(true);
      const current = f.prepare();
      expect(current.receipt.plans.map((plan) => plan.featureIdentity)).toEqual([
        'native-shared',
        'second-native-shared',
      ]);
      const calls = recordDispatches(current.encoder);
      expect(f.encode(current.encoder).ok).toBe(true);
      expect(calls.groups).toEqual([
        [1, 1, 1],
        [2, 1, 1],
        [9, 1, 1],
        [10, 1, 1],
      ]);
      expect(calls.compute).toHaveBeenCalledTimes(4);
      expect(calls.compute.mock.calls.map(([descriptor]) => descriptor?.label)).toEqual([
        'write-0',
        'read-0',
        'second-write-0',
        'second-read-0',
      ]);
      f.finish();
      expect(sharedGraphs.inspectSharedFeatureGraphs(f.world)).toMatchObject({
        nativeFrames: 1,
        fallbackFrames: 0,
      });
    } finally {
      await f.dispose();
    }
  });

  it('retains the original compile rejection for conflicting roles on one physical buffer', async () => {
    const f = await sharedNativeFixture();
    try {
      f.state.copies = false;
      f.state.conflict = true;
      f.alias(true);
      const current = f.stage();
      expect(current.outcome).toMatchObject({
        ok: false,
        error: { detail: { cause: { code: 'access-conflict' } } },
      });
      expect(f.encode(current.encoder).ok).toBe(false);
      f.finish(false);
      expect(f.submitted).not.toHaveBeenCalled();
      expect(f.aborted).toHaveBeenCalledTimes(1);
      expect(sharedGraphs.inspectSharedFeatureGraphs(f.world)).toMatchObject({
        nativeFrames: 0,
        fallbackFrames: 1,
        shellBuilds: 0,
        last: { route: 'failed' },
      });
    } finally {
      await f.dispose();
    }
  });

  it('keeps a disabled copy declaration as a barrier while omitting only its command', async () => {
    const f = await sharedNativeFixture();
    try {
      f.state.copyEnabled = false;
      const current = f.prepare();
      const calls = recordDispatches(current.encoder);
      expect(f.encode(current.encoder).ok).toBe(true);
      expect(calls.copies).not.toHaveBeenCalled();
      expect(calls.groups).toEqual([
        [1, 1, 1],
        [2, 1, 1],
      ]);
      expect(calls.compute).toHaveBeenCalledTimes(2);
      f.finish();
    } finally {
      await f.dispose();
    }
  });

  it('does not retire the shell on held or failed frames, but retires it with the device scope', async () => {
    const f = await sharedNativeFixture();
    try {
      const held = f.prepare();
      if (held.receipt.kind !== 'compiled') throw new Error('Missing held graph');
      const retired = vi.spyOn(held.receipt.graph, 'retire');
      f.finish(false);
      expect(f.submitted).not.toHaveBeenCalled();
      expect(retired).not.toHaveBeenCalled();

      const active = f.prepare();
      if (active.receipt.kind !== 'compiled') throw new Error('Missing active graph');
      expect(active.receipt.graph).toBe(held.receipt.graph);
      expect(f.encode(active.encoder).ok).toBe(true);
      const release = vi.spyOn(f.host, 'retirePreparedGraphics');
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      f.finish(true, completion);
      expect(release).not.toHaveBeenCalled();
      expect(retired).not.toHaveBeenCalled();
      complete();
      await completion;
      await Promise.resolve();
      expect(release).toHaveBeenCalledTimes(1);
      expect(retired).not.toHaveBeenCalled();

      await f.replaceDevice();
      expect(retired).toHaveBeenCalledTimes(1);
      const replacement = f.prepare();
      if (replacement.receipt.kind !== 'compiled') throw new Error('Missing new generation graph');
      expect(replacement.receipt.graph).not.toBe(active.receipt.graph);
      const newRetire = vi.spyOn(replacement.receipt.graph, 'retire');
      expect(f.encode(replacement.encoder).ok).toBe(true);
      f.finish();
      f.scope().dispose();
      expect(newRetire).toHaveBeenCalledTimes(1);
      expect(sharedGraphs.inspectSharedFeatureGraphs(f.world)).toMatchObject({ shellBuilds: 2 });
    } finally {
      await f.dispose();
    }
  });
});
