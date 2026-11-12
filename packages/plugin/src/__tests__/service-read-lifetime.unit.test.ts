import { Context, EventsService, Service } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';

type FixtureContext = Context & {
  allocationService: { value: number };
  computedRead: number;
  callerService: { caller(): Context };
};

async function reader(root: Context) {
  let context: FixtureContext | undefined;
  const fiber = root.plugin({
    name: 'allocation-reader',
    inject: ['allocationService'],
    apply(ctx) {
      context = ctx as FixtureContext;
    },
  });
  await fiber.await();
  if (context === undefined) throw new Error('Missing active reader');
  const captured = context;
  return { fiber, context: captured, read: () => captured.allocationService.value };
}

it('resolves current native injected state through replacement and retirement', async () => {
  const ctx = new Context();
  const install = (value: number) =>
    ctx.plugin({
      apply(child) {
        child.provide('allocationService', { value });
      },
    });
  let provider = install(1);
  await provider.await();
  const consumer = await reader(ctx);
  const oldRead = consumer.read;
  try {
    expect(oldRead()).toBe(1);
    await provider.dispose();
    expect(oldRead).toThrow(/inactive context/);
    provider = install(2);
    await provider.await();
    await consumer.fiber.await();
    expect(oldRead()).toBe(2);
    await consumer.fiber.dispose();
    expect(oldRead).toThrow(/inactive context/);
  } finally {
    await ctx.fiber.dispose();
  }
});

it('keeps native isolation scopes independent', async () => {
  const ctx = new Context();
  const a = ctx.isolate('allocationService');
  const b = ctx.isolate('allocationService');
  const left = a.plugin({
    apply(child) {
      child.provide('allocationService', { value: 3 });
    },
  });
  const right = b.plugin({
    apply(child) {
      child.provide('allocationService', { value: 7 });
    },
  });
  await Promise.all([left.await(), right.await()]);
  try {
    const l = await reader(a);
    const r = await reader(b);
    expect(l.read()).toBe(3);
    expect(r.read()).toBe(7);
    await left.dispose();
    expect(l.read).toThrow(/inactive context/);
    expect(r.read()).toBe(7);
  } finally {
    await ctx.fiber.dispose();
  }
});

it('observes late interception, veto, removal and fresh diagnostic errors', async () => {
  const ctx = new Context();
  ctx.provide('allocationService', { value: 1 });
  const consumer = await reader(ctx);
  const errors: Error[] = [];
  try {
    expect(consumer.read()).toBe(1);
    const stop = ctx.on('internal/get', (_caller, name, error, next) => {
      if (name !== 'allocationService') return next();
      errors.push(error);
      return { value: 9 };
    });
    expect(consumer.read()).toBe(9);
    expect(consumer.read()).toBe(9);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[1]).not.toBe(errors[0]);
    expect(errors[0]?.stack).toContain('allocationService');
    stop();
    expect(consumer.read()).toBe(1);
    const accessorErrors: Error[] = [];
    ctx.accessor('computedRead', {
      get(_receiver, error) {
        accessorErrors.push(error);
        return 42;
      },
    });
    expect(consumer.context.computedRead).toBe(42);
    expect(consumer.context.computedRead).toBe(42);
    expect(accessorErrors).toHaveLength(2);
    expect(accessorErrors[0]).toBeInstanceOf(Error);
    expect(accessorErrors[1]).not.toBe(accessorErrors[0]);
  } finally {
    await ctx.fiber.dispose();
  }
});

it('keeps caller tracing and custom event accessors on the ordinary route', async () => {
  class CallerService extends Service {
    constructor(ctx: Context) {
      super(ctx, 'callerService');
    }
    caller() {
      return this.ctx;
    }
  }
  const ctx = new Context();
  const provider = ctx.plugin({
    apply(child) {
      new CallerService(child);
      child.provide('allocationService', { value: 5 });
    },
  });
  await provider.await();
  const consumer = await reader(ctx);
  try {
    const nested = consumer.context.plugin({
      inject: ['callerService'],
      apply(child) {
        expect((child as FixtureContext).callerService.caller().fiber).toBe(child.fiber);
      },
    });
    await nested.await();
    let eventReads = 0;
    const extended = consumer.context.extend({
      get events() {
        eventReads++;
        return ctx.events;
      },
    });
    expect(extended.allocationService.value).toBe(5);
    expect(eventReads).toBe(1);
    const custom = new EventsService(ctx);
    let waterfalls = 0;
    const original = custom.waterfall;
    custom.waterfall = function (
      this: EventsService,
      ...args: Parameters<EventsService['waterfall']>
    ) {
      waterfalls++;
      return Reflect.apply(original, this, args);
    } as EventsService['waterfall'];
    const override = consumer.context.extend({ events: custom });
    expect(override.allocationService.value).toBe(5);
    expect(waterfalls).toBe(1);
  } finally {
    await ctx.fiber.dispose();
  }
});
