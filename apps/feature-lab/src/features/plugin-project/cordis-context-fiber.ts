import {
  Context,
  inspectPluginFiber,
  type Plugin,
  startNativePlugin,
} from '@forgeax/engine/plugin';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Cordis Context / Fiber lifecycle',
  catalog: 'Cordis Context/Fiber',
  kind: 'headless',
  summary:
    'Plugins bind work through ctx.effect and share services through provide/inject. A consumer activates only once its injected service exists, and Fiber disposal unwinds effects in reverse order.',
  expect:
    'All checks pass: effects run in order and dispose in reverse, the consumer waits for its service, provider disposal also deactivates its dependents, and startNativePlugin reports a throwing apply as plugin-startup-failed.',
  async run(checks) {
    const log: string[] = [];
    const root = new Context();
    const provider: Plugin = {
      name: 'fl-clock-provider',
      provide: 'flClock',
      apply(ctx) {
        ctx.effect(() => {
          log.push('provider:up');
          return () => log.push('provider:down');
        }, 'fl/provider');
        ctx.provide('flClock' as never, { now: () => 42 } as never);
      },
    };
    const consumer: Plugin = {
      name: 'fl-clock-consumer',
      inject: ['flClock'],
      apply(ctx) {
        const clock = ctx.get('flClock') as { now(): number } | undefined;
        log.push(`consumer:read=${clock?.now()}`);
        ctx.effect(() => {
          log.push('consumer:a');
          return () => log.push('consumer:~a');
        }, 'fl/a');
        ctx.effect(() => {
          log.push('consumer:b');
          return () => log.push('consumer:~b');
        }, 'fl/b');
      },
    };
    const consumerFiber = root.plugin(consumer).ctx.fiber;
    await Promise.resolve();
    checks.ok(
      'consumer waits for injected service',
      !log.some((line) => line.startsWith('consumer')),
      log.join(','),
    );
    checks.ok(
      'pending consumer reports the missing service',
      inspectPluginFiber(consumerFiber).missingServices.includes('flClock'),
    );
    const providerFiber = root.plugin(provider).ctx.fiber;
    await providerFiber.await();
    await consumerFiber.await();
    checks.ok(
      'consumer activates after provide and reads it',
      log.includes('consumer:read=42'),
      log.join(','),
    );
    checks.equal(
      'consumer effects run in order',
      log.filter((l) => l === 'consumer:a' || l === 'consumer:b'),
      ['consumer:a', 'consumer:b'],
    );
    checks.equal('consumer inspect state', inspectPluginFiber(consumerFiber).state, 'active');
    log.length = 0;
    await consumerFiber.dispose();
    checks.equal('fiber disposal unwinds in reverse', log, ['consumer:~b', 'consumer:~a']);
    const again = root.plugin(consumer).ctx.fiber;
    await again.await();
    log.length = 0;
    await providerFiber.dispose();
    await Promise.resolve();
    checks.ok(
      'removing the provider also deactivates its dependent',
      log.includes('provider:down') && log.includes('consumer:~a'),
      log.join(','),
    );
    checks.ok(
      'dependent still unwinds b before a',
      log.indexOf('consumer:~b') < log.indexOf('consumer:~a'),
      log.join(','),
    );
    checks.equal('dependent returns to pending', inspectPluginFiber(again).state, 'pending');
    const failing = await startNativePlugin(
      root,
      {
        name: 'fl-throws',
        apply() {
          throw new Error('fl boom');
        },
      },
      undefined,
      { timeoutMs: 2000, cleanupTimeoutMs: 1000 },
    );
    checks.equal(
      'throwing apply -> structured failure',
      failing.ok ? 'ok' : failing.error.code,
      'plugin-startup-failed',
    );
    const good = await startNativePlugin(root, { name: 'fl-ok', apply() {} }, undefined, {
      timeoutMs: 2000,
    });
    checks.ok('startNativePlugin ok for a healthy plugin', good.ok);
    await root.fiber.dispose();
    checks.equal('root disposal disposes descendants', inspectPluginFiber(again).state, 'disposed');
  },
});
