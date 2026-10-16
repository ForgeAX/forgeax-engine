import { expectTypeOf } from 'vitest';

import { Context, type Fiber, type Plugin } from '../src';

declare module '../src' {
  interface EngineContextServices {
    answer?: number;
  }
}

const plugin: Plugin = {
  name: 'typed',
  provide: 'answer',
  apply(ctx) {
    ctx.provide('answer', 42);
  },
};

const ctx = new Context();
expectTypeOf(ctx.answer).toEqualTypeOf<number | undefined>();
expectTypeOf(ctx.plugin(plugin)).toMatchTypeOf<Fiber & PromiseLike<Fiber>>();
