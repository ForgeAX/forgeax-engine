import { createIntelligenceRuntime } from '@forgeax/engine/intelligence';
import { createFakeIntelligenceProvider } from '@forgeax/engine/intelligence-fake';
import { defineFeature } from '../../lab/feature';

function runOnce(): string[] {
  const provider = createFakeIntelligenceProvider();
  const runtime = createIntelligenceRuntime(provider, { createSessionId: () => 'fixed-session' });
  runtime.submit({ input: 'hello' });
  const trace: string[] = [];
  for (let step = 0; step < 4; step += 1) {
    provider.advance();
    for (const event of runtime.poll()) {
      trace.push(
        `${step}:${event.type}:${event.type === 'text-delta' ? event.text : event.type === 'completed' ? event.output : ''}`,
      );
    }
  }
  return trace;
}

export default defineFeature({
  title: 'Deterministic fake intelligence provider',
  catalog: 'Deterministic fake provider',
  kind: 'headless',
  summary:
    'createFakeIntelligenceProvider emits exactly one scripted stream event per Activity for each explicit advance() call, so Activity consumers are tested offline without credentials, timers or network.',
  expect:
    'All checks pass: the default script streams "hello:" then "ok" then completes on the third advance, two runs produce identical traces, a scripted failure yields a failed terminal, and close() cancels active work.',
  async run(checks) {
    const trace = runOnce();
    checks.equal('one event per advance, completes on the third', trace, [
      '0:text-delta:hello:',
      '1:text-delta:ok',
      '2:completed:hello:ok',
    ]);
    checks.equal('two independent runs are identical', runOnce(), trace);

    const provider = createFakeIntelligenceProvider({
      id: 'lab.fake',
      script: (submission) =>
        submission.input === 'bad'
          ? { deltas: ['partial'], failure: 'scripted failure' }
          : { deltas: ['a', 'b'] },
    });
    const runtime = createIntelligenceRuntime(provider);
    checks.equal('provider id is configurable', runtime.providerId, 'lab.fake');
    const good = runtime.submit({ input: 'good' });
    const bad = runtime.submit({ input: 'bad' });
    const slow = runtime.submit({ input: 'slow' });
    checks.equal('three activities active before any advance', provider.activeCount, 3);
    checks.equal('nothing streams without advance', runtime.poll().length, 0);
    provider.advance();
    provider.advance();
    provider.advance();
    const events = runtime.poll();
    const terminalOf = (id: string | undefined) =>
      events.find((event) => event.activityId === id && event.type !== 'text-delta');
    const goodDone = terminalOf(good.ok ? good.value.id : undefined);
    checks.ok(
      'output defaults to joined deltas',
      goodDone?.type === 'completed' && goodDone.output === 'ab',
      JSON.stringify(goodDone),
    );
    const badDone = terminalOf(bad.ok ? bad.value.id : undefined);
    checks.ok(
      'scripted failure becomes provider-failed',
      badDone?.type === 'failed' && badDone.error.code === 'intelligence-provider-failed',
      JSON.stringify(badDone),
    );
    const slowDone = terminalOf(slow.ok ? slow.value.id : undefined);
    checks.ok('slow activity completed too', slowDone?.type === 'completed');

    const pending = runtime.submit({ input: 'pending' });
    checks.equal('one active after resubmit', provider.activeCount, 1);
    checks.ok('cancel through runtime ok', pending.ok && runtime.cancel(pending.value.id).ok);
    checks.equal('cancel removes it from the fake', provider.activeCount, 0);
    runtime.submit({ input: 'closing' });
    await runtime.close();
    checks.ok('close closes the provider', provider.closed && provider.activeCount === 0);
  },
});
