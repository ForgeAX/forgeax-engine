import { RhiNullAdapter, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { createSsrHistoryOwner, type SsrHistoryResetReason } from '../ssr/history';
import { createSsrTemporalConsumer } from '../ssr/temporal';
import { TemporalFrameCoordinator } from '../temporal/frame-coordinator';

class DeferredQueue extends RhiNullQueue {
  private readonly completion: Promise<undefined>;
  private resolveCompletion!: () => void;

  constructor() {
    super();
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = () => resolve(undefined);
    });
  }

  override onSubmittedWorkDone(): Promise<undefined> {
    return this.completion;
  }

  complete(): void {
    this.resolveCompletion();
  }
}

async function createDevice() {
  return (await new RhiNullAdapter().requestDevice()).unwrap();
}

function phases(stage?: 'build' | 'encode' | 'finish' | 'submit') {
  return {
    build: () => {
      if (stage === 'build') throw { stage };
      return 'built';
    },
    encode: () => {
      if (stage === 'encode') throw { stage };
    },
    finish: () => {
      if (stage === 'finish') throw { stage };
    },
    submit: () => {
      if (stage === 'submit') throw { stage };
    },
  };
}

describe('SSR temporal history owner', () => {
  it('allocates two half-resolution color-depth and confidence history slots', async () => {
    const device = await createDevice();
    const scope = DeviceScope.create(41, 'renderer');
    const owner = createSsrHistoryOwner({ device, scope, width: 5, height: 3 }).unwrap();

    expect(owner.resources).toMatchObject({
      width: 5,
      height: 3,
      halfWidth: 2,
      halfHeight: 1,
      bytes: 48,
      descriptor: { format: 'rgba16float', sampleCount: 1 },
    });
    expect(owner.resources.slots).toHaveLength(2);
    expect(
      new Set(owner.resources.slots.flatMap((slot) => [slot.texture, slot.surfaceTexture])).size,
    ).toBe(4);
    expect(owner.inspect()).toMatchObject({
      state: 'first-frame',
      historyCount: 2,
      activeBytes: 48,
      candidateBytes: 0,
      retiringBytes: 0,
      historyValid: false,
    });
  });

  it('uses the shared coordinator epoch and commits SSR history only after submit', async () => {
    const device = await createDevice();
    const scope = DeviceScope.create(42, 'renderer');
    const owner = createSsrHistoryOwner({ device, scope, width: 5, height: 3 }).unwrap();
    const coordinator = new TemporalFrameCoordinator<string>();
    const consumer = createSsrTemporalConsumer(coordinator, owner);

    const first = consumer.run({ current: 'frame-1', antialias: 'none' }, phases());
    expect(first).toMatchObject({ ok: true, value: { epoch: 1, previous: 'frame-1' } });
    expect(coordinator.inspect()).toMatchObject({
      epoch: 1,
      consumerIds: ['ssr'],
      attempt: 'committed',
    });
    expect(consumer.inspect()).toMatchObject({
      sharedEpoch: 1,
      history: { state: 'stable', historyValid: true, activeBytes: 48, candidateBytes: 0 },
    });

    const second = consumer.run({ current: 'frame-2', antialias: 'none' }, phases());
    expect(second).toMatchObject({ ok: true, value: { epoch: 2, previous: 'frame-2' } });
    expect(owner.inspect().historyValid).toBe(true);
  });

  it.each([
    'build',
    'encode',
    'finish',
    'submit',
  ] as const)('aborts the shared candidate and keeps active history on %s failure', async (stage) => {
    const device = await createDevice();
    const scope = DeviceScope.create(43, `renderer-${stage}`);
    const owner = createSsrHistoryOwner({ device, scope, width: 5, height: 3 }).unwrap();
    const coordinator = new TemporalFrameCoordinator<string>();
    const consumer = createSsrTemporalConsumer(coordinator, owner);

    const failed = consumer.run({ current: 'candidate', antialias: 'none' }, phases(stage));
    expect(failed.ok).toBe(false);
    expect(coordinator.inspect()).toMatchObject({
      epoch: 0,
      previous: undefined,
      attempt: 'aborted',
    });
    expect(owner.inspect()).toMatchObject({
      state: 'aborted',
      historyValid: false,
      candidateBytes: 0,
      lastFailure: stage,
    });
  });

  it.each([
    'first-enable',
    'resize',
    'camera-cut',
    'history-version',
    'coverage-loss',
    'reflection-generation',
    'device-recovery',
  ] as const)('resets SSR history as current-only on %s', async (reason: SsrHistoryResetReason) => {
    const device = await createDevice();
    const scope = DeviceScope.create(44, `renderer-${reason}`);
    const owner = createSsrHistoryOwner({ device, scope, width: 5, height: 3 }).unwrap();
    const coordinator = new TemporalFrameCoordinator<string>();
    const consumer = createSsrTemporalConsumer(coordinator, owner);

    expect(consumer.run({ current: 'stable', antialias: 'none' }, phases()).ok).toBe(true);
    consumer.reset(reason);
    expect(owner.inspect()).toMatchObject({ historyValid: false, resetReason: reason });
    if (reason !== 'first-enable') {
      expect(coordinator.inspect().epoch).toBe(0);
    }
    const afterReset = consumer.begin({ current: 'current-only', antialias: 'none' });
    expect(afterReset.ok).toBe(true);
    if (!afterReset.ok) return;
    expect(afterReset.value.history).toMatchObject({ readSlot: null, historyValid: false });
    consumer.abort(afterReset.value, 'build');
  });

  it('holds the only pending candidate copy across commit, abort, reset, resize and dispose', async () => {
    const device = await createDevice();
    const scope = DeviceScope.create(47, 'renderer');
    const owner = createSsrHistoryOwner({ device, scope, width: 4, height: 4 }).unwrap();
    expect(owner.candidate).toBeUndefined();

    const first = owner.beginFrame().unwrap();
    expect(owner.candidate).toBe(first);
    expect(owner.commitFrame(first).ok).toBe(true);
    expect(owner.candidate).toBeUndefined();

    const aborted = owner.beginFrame().unwrap();
    owner.abortFrame(aborted, 'submit');
    expect(owner.candidate).toBeUndefined();
    expect(owner.commitFrame(aborted).ok).toBe(false);

    owner.beginFrame().unwrap();
    owner.reset('reflection-generation');
    expect(owner.candidate).toBeUndefined();

    owner.beginFrame().unwrap();
    expect(owner.resize(8, 8).ok).toBe(true);
    expect(owner.candidate).toBeUndefined();

    owner.beginFrame().unwrap();
    owner.dispose();
    expect(owner.candidate).toBeUndefined();
  });

  it('retires resized and disabled allocations only after the shared queue fence', async () => {
    const device = await createDevice();
    const scope = DeviceScope.create(45, 'renderer');
    const owner = createSsrHistoryOwner({ device, scope, width: 5, height: 3 }).unwrap();
    const queue = new DeferredQueue();
    const failures: unknown[] = [];

    expect(owner.resize(9, 5).ok).toBe(true);
    expect(owner.inspect()).toMatchObject({
      width: 9,
      height: 5,
      activeBytes: 192,
      retiringBytes: 48,
    });
    owner.retireAfterFence(queue, (cause) => failures.push(cause));
    expect(owner.inspect().retiringBytes).toBe(48);
    queue.complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([]);
    expect(owner.inspect().retiringBytes).toBe(0);

    owner.retireAfterFence(queue, (cause) => failures.push(cause));
    expect(owner.inspect().activeBytes).toBe(192);
    queue.complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.inspect()).toMatchObject({ state: 'retired', activeBytes: 0, retiringBytes: 0 });
    expect(failures).toEqual([]);
  });

  it('does not expose a second queue or epoch through the consumer inspection', async () => {
    const device = await createDevice();
    const scope = DeviceScope.create(46, 'renderer');
    const owner = createSsrHistoryOwner({ device, scope, width: 4, height: 4 }).unwrap();
    const coordinator = new TemporalFrameCoordinator<string>();
    const consumer = createSsrTemporalConsumer(coordinator, owner);
    const inspection = consumer.inspect();

    expect(inspection.sharedEpoch).toBe(0);
    expect(inspection.consumerIds).toEqual([]);
    expect(Object.keys(inspection)).not.toContain('queue');
    expect(Object.keys(inspection)).not.toContain('submitCount');
    expect(Object.keys(inspection)).not.toContain('ssrFrameNumber');
  });
});
