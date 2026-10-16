import { Time, World } from '@forgeax/engine-ecs';
import type { CommandBuffer } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../../../render/src/assembly/factory';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  Camera,
  TONEMAP_ACES_FILMIC,
} from '../../../render/src/components/camera';
import type { FrameReceipt } from '../../../render/src/render-contract';
import { createFrameLoop } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  const { renderLifecycleManifestUrl }: { renderLifecycleManifestUrl(): string } = await import(
    new URL('../../../render/src/__tests__/shader-manifest-fixture.ts', import.meta.url).href
  );
  const losses: ReturnType<typeof deferred<{ reason: 'unknown'; message: string }>>[] = [];
  const host = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    {
      rhi,
      rhiInstrumentation: {
        deviceLost: () => {
          const loss = deferred<{ reason: 'unknown'; message: string }>();
          losses.push(loss);
          return loss.promise;
        },
      },
    },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialization = await host.initialization;
  if (!initialization.ok) throw initialization.error;
  const renderer = exposeRenderer(host);
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_ACES_FILMIC,
          bloom: BLOOM_DISABLED,
        },
      },
    )
    .unwrap();

  const originalSubmit = RhiNullQueue.prototype.submit;
  const originalCompletion = RhiNullQueue.prototype.onSubmittedWorkDone;
  const pending: ReturnType<typeof deferred<undefined>>[] = [];
  let insideSubmit = false;
  let observe = true;
  let submitFailure: RhiError | undefined;
  let accepted = 0;
  const submit = vi.spyOn(RhiNullQueue.prototype, 'submit').mockImplementation(function (
    this: RhiNullQueue,
    commands: readonly CommandBuffer[],
  ) {
    if (submitFailure !== undefined) return err(submitFailure);
    insideSubmit = true;
    try {
      const result = originalSubmit.call(this, commands);
      if (result.ok) accepted += 1;
      return result;
    } finally {
      insideSubmit = false;
    }
  });
  const complete = vi
    .spyOn(RhiNullQueue.prototype, 'onSubmittedWorkDone')
    .mockImplementation(function (this: RhiNullQueue) {
      // Null has a separate structural canvas retirement observer inside submit.
      // Inject at the actual completion Promise consumed by the production Renderer.
      if (insideSubmit || !observe) return originalCompletion.call(this);
      const request = deferred<undefined>();
      pending.push(request);
      return request.promise;
    });
  const receipts: FrameReceipt[] = [];
  const errors: unknown[] = [];
  let next: (() => void) | undefined;
  let now = 1000;
  const loop = createFrameLoop({
    world,
    renderer,
    onSubmitted: (receipt) => receipts.push(receipt),
    onError: (error) => errors.push(error),
    platform: testPlatform({
      now: () => now,
      raf: (callback) => {
        next = () => callback(now);
        return 1;
      },
      caf: () => {
        next = undefined;
      },
    }),
  });
  const input = { leases: [lease], camera: { lease }, environment: { lease } };
  return {
    host,
    renderer,
    world,
    loop,
    receipts,
    pending,
    losses,
    errors,
    input,
    accepted: () => accepted,
    observe: (value: boolean) => {
      observe = value;
    },
    refuseSubmit: (failure: RhiError | undefined) => {
      submitFailure = failure;
    },
    async frame() {
      now += 16;
      const callback = next;
      next = undefined;
      callback?.();
      await Promise.resolve();
    },
    async dispose() {
      observe = false;
      try {
        if (loop.getState() === 'running' || loop.getState() === 'paused') loop.stop().unwrap();
        const disposal = await renderer.dispose();
        if (!disposal.ok) throw disposal.error;
        for (const request of pending) request.resolve(undefined);
        await loop.drainFrameReceipts();
      } finally {
        submit.mockRestore();
        complete.mockRestore();
      }
    },
  };
}

it('faults the submitted generation, preserves the first cause and closes sibling receipts before more App work', async () => {
  const f = await fixture();
  const firstCause = new AggregateError(
    [new WebAssembly.RuntimeError('native poll trapped')],
    'ticket release failed',
  );
  try {
    f.loop.start().unwrap();
    await f.frame();
    await f.frame();
    await f.frame();
    expect(f.accepted()).toBe(2);
    expect(f.loop.inspect().inFlight).toBe(2);
    f.pending[1]?.reject(firstCause);
    await vi.waitFor(() => expect(f.renderer.state()).toBe('faulted'));
    await f.loop.drainFrameReceipts();
    const outcomes = await Promise.all(f.receipts.map((receipt) => receipt.completed));
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Faulted generation completed successfully');
      expect(outcome.error).toMatchObject({ code: 'device-operation-failed' });
      expect(outcome.error.cause).toBe(firstCause);
    }
    expect(f.host.health()).toMatchObject({ reason: 'internal-fault', recoverable: false });
    expect(f.host.inspect().state).toBe('faulted');
    const time = f.world.getResource(Time).elapsed;
    expect(time).toBeGreaterThan(0);
    await f.frame();
    await f.frame();
    expect(f.accepted()).toBe(2);
    expect(f.world.getResource(Time).elapsed).toBe(time);
    expect(f.renderer.draw(f.input).ok).toBe(false);
    expect(f.host.drawFrame(f.input).ok).toBe(false);
    expect((await f.renderer.recover()).ok).toBe(false);
    f.pending[0]?.resolve(undefined);
    await Promise.resolve();
    expect(f.renderer.state()).toBe('faulted');
  } finally {
    await f.dispose();
  }

  const replacement = await fixture();
  try {
    replacement.observe(false);
    replacement.loop.start().unwrap();
    await replacement.frame();
    await replacement.loop.drainFrameReceipts();
    expect(replacement.renderer.state()).toBe('alive');
    expect(replacement.accepted()).toBe(1);
  } finally {
    await replacement.dispose();
  }
});

it('keeps an unaccepted submit validation failure retryable', async () => {
  const f = await fixture();
  try {
    f.observe(false);
    f.refuseSubmit(
      new RhiError({
        code: 'queue-submit-failed',
        expected: 'valid command buffer',
        hint: 'repair commands',
      }),
    );
    f.loop.start().unwrap();
    await f.frame();
    expect(f.accepted()).toBe(0);
    expect(f.renderer.state()).toBe('alive');
    f.refuseSubmit(undefined);
    await f.frame();
    await f.loop.drainFrameReceipts();
    expect(f.accepted()).toBe(1);
    expect(f.renderer.state()).toBe('alive');
  } finally {
    await f.dispose();
  }
});

it('seals the first completion cause before a fault listener disposes the Renderer', async () => {
  const f = await fixture();
  let disposal: ReturnType<typeof f.renderer.dispose> | undefined;
  const unsubscribe = f.renderer.subscribe((event) => {
    if (event.kind === 'state-changed' && event.current === 'faulted') {
      disposal = f.renderer.dispose();
    }
  });
  try {
    f.loop.start().unwrap();
    await f.frame();
    await f.frame();
    const cause = new Error('completion failed before Host disposal');
    f.pending[1]?.reject(cause);
    await vi.waitFor(() => expect(disposal).toBeDefined());
    expect((await disposal)?.ok).toBe(true);
    await f.loop.drainFrameReceipts();
    for (const receipt of f.receipts) {
      const outcome = await receipt.completed;
      if (outcome.ok) throw new Error('Unconfirmed frame completed successfully');
      expect(outcome.error.cause).toBe(cause);
    }
    expect(f.renderer.state()).toBe('disposed');
  } finally {
    unsubscribe();
    await f.dispose();
  }
});

it('does not let an old completion rejection fault a recovered native-loss generation', async () => {
  const f = await fixture();
  try {
    f.loop.start().unwrap();
    await f.frame();
    const oldCompletion = f.pending[0];
    const oldGeneration = f.receipts[0]?.deviceGeneration;
    f.losses[0]?.resolve({ reason: 'unknown', message: 'real native loss notification' });
    await vi.waitFor(() => expect(f.renderer.state()).toBe('device-lost'));
    await f.loop.drainFrameReceipts();
    f.observe(false);
    const recovery = await f.renderer.recover();
    if (!recovery.ok) throw recovery.error;
    expect(f.renderer.state()).toBe('alive');
    expect(f.renderer.inspect().frame.deviceGeneration).not.toBe(oldGeneration);
    oldCompletion?.reject(new Error('old generation timeout'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.renderer.state()).toBe('alive');
    const accepted = f.accepted();
    await f.frame();
    await f.loop.drainFrameReceipts();
    expect(f.accepted()).toBe(accepted + 1);
  } finally {
    await f.dispose();
  }
});

it('ignores late completion failures after disposal', async () => {
  const f = await fixture();
  try {
    f.loop.start().unwrap();
    await f.frame();
    const pending = f.pending[0];
    f.loop.stop().unwrap();
    const disposal = await f.renderer.dispose();
    if (!disposal.ok) throw disposal.error;
    await f.loop.drainFrameReceipts();
    const failures = f.errors.length;
    pending?.reject(new Error('disposed generation timeout'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.renderer.state()).toBe('disposed');
    expect(f.errors).toHaveLength(failures);
  } finally {
    await f.dispose();
  }
});
