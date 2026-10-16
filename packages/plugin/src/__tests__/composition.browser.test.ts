import { expect, it } from 'vitest';
import { Context, type Plugin, startNativePlugin } from '../index.js';

it.each([
  false,
  true,
])('holds browser native tree readiness through a late consumer (fail=%s)', async (fail) => {
  const ctx = new Context();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  const provider: Plugin = {
    name: 'browser-provider',
    provide: ['answer'],
    apply(context) {
      context.provide('answer', 42);
    },
  };
  const consumer: Plugin = {
    name: 'browser-consumer',
    inject: ['answer'],
    async apply() {
      started();
      await gate;
      if (fail) throw new Error('late browser child failure');
    },
  };
  const root: Plugin = {
    name: 'browser-readiness',
    apply(ctx) {
      ctx.plugin(consumer);
      ctx.plugin(provider);
    },
  };
  const outcome = startNativePlugin(ctx, root).then((result) => {
    state = result.ok ? 'resolved' : 'rejected';
    return result.ok ? undefined : result.error;
  });
  try {
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state).toBe('pending');
    finish();
    const error = await outcome;
    expect(state).toBe(fail ? 'rejected' : 'resolved');
    if (fail)
      expect(error).toMatchObject({
        code: 'plugin-startup-failed',
        detail: { reason: 'failed' },
      });
  } finally {
    finish();
    await outcome;
    await ctx.fiber.dispose();
  }
});
