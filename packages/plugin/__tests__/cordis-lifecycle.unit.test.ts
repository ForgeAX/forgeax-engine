import { describe, expect, it } from 'vitest';

import { Context, type Plugin } from '../src';

declare module '../src' {
  interface EngineContextServices {
    answer?: number;
  }
}

function answerPlugin(value: number): Plugin {
  return {
    name: 'answer',
    provide: 'answer',
    apply(ctx) {
      ctx.provide('answer', value);
    },
  };
}

describe('Cordis lifecycle boundary', () => {
  it('reloads a dependent fiber when its service is removed and restored', async () => {
    const ctx = new Context();
    const events: string[] = [];
    const consumer: Plugin = {
      name: 'consumer',
      inject: ['answer'],
      apply(ctx) {
        const answer = ctx.answer;
        events.push(`load:${answer}`);
        return () => events.push(`unload:${answer}`);
      },
    };

    const consumerFiber = ctx.plugin(consumer);
    await consumerFiber;
    expect(consumerFiber.store).toBeUndefined();

    const firstProvider = await ctx.plugin(answerPlugin(42));
    await consumerFiber.await();
    expect(consumerFiber.store).toBeDefined();
    expect(events).toEqual(['load:42']);

    await firstProvider.dispose();
    await consumerFiber.await();
    expect(consumerFiber.store).toBeUndefined();
    expect(events).toEqual(['load:42', 'unload:42']);

    await ctx.plugin(answerPlugin(7));
    await consumerFiber.await();
    expect(consumerFiber.store).toBeDefined();
    expect(events).toEqual(['load:42', 'unload:42', 'load:7']);

    await ctx.fiber.dispose();
  });
});
