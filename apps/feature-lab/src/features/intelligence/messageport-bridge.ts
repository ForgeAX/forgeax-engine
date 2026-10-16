import type { ActivityEvent } from '@forgeax/engine/intelligence';
import {
  bindIntelligencePort,
  createIntelligencePortClient,
  createIntelligenceRuntime,
} from '@forgeax/engine/intelligence';
import { createFakeIntelligenceProvider } from '@forgeax/engine/intelligence-fake';
import { defineFeature } from '../../lab/feature';

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export default defineFeature({
  title: 'Intelligence MessagePort bridge',
  catalog: 'Intelligence MessagePort bridge',
  kind: 'headless',
  summary:
    'bindIntelligencePort serves a Host-owned IntelligenceRuntime on one MessageChannel port; createIntelligencePortClient gives the realm (Worker or main) the same submit/poll/cancel/close surface without ever awaiting the provider.',
  expect:
    'All checks pass: an Activity submitted through the client streams back ordered events, client-side validation rejects synchronously, Host-side rejection surfaces as a failed event, cancel crosses the port, and close() tears down both sides.',
  async run(checks) {
    const provider = createFakeIntelligenceProvider({ id: 'lab.port' });
    const runtime = createIntelligenceRuntime(provider, { limits: { maxConcurrentActivities: 1 } });
    const channel = new MessageChannel();
    const binding = bindIntelligencePort(channel.port1, runtime);
    const client = createIntelligencePortClient('lab.port', channel.port2);

    const ref = client.submit({ input: 'ping' });
    checks.ok('client submit returns a ref synchronously', ref.ok);
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 12 && !events.some((event) => event.type === 'completed'); i += 1) {
      await nextTask();
      provider.advance();
      events.push(...client.poll());
    }
    checks.equal(
      'ordered stream crosses the port',
      events.map((event) =>
        event.type === 'text-delta'
          ? event.text
          : event.type === 'completed'
            ? `=${event.output}`
            : event.type,
      ),
      ['ping:', 'ok', '=ping:ok'],
    );
    checks.ok(
      'sequences are increasing',
      events.every((event, index) => event.sequence === index + 1),
    );

    checks.equal(
      'client rejects empty input locally',
      client.submit({ input: '' }).ok ? 'ok' : 'rejected',
      'rejected',
    );

    const cancelRef = client.submit({ input: 'long' });
    await nextTask();
    checks.ok('cancel posts across the port', cancelRef.ok && client.cancel(cancelRef.value.id).ok);
    const cancelEvents: ActivityEvent[] = [];
    for (let i = 0; i < 6 && cancelEvents.length === 0; i += 1) {
      await nextTask();
      cancelEvents.push(...client.poll().filter((event) => event.type === 'cancelled'));
    }
    checks.equal('Host cancel reaches the realm as cancelled', cancelEvents.length, 1);

    const hostBusy = runtime.submit({ input: 'host-side' });
    checks.ok('Host-side submission occupies the only slot', hostBusy.ok);
    const rejected = client.submit({ input: 'overflow' });
    const failures: ActivityEvent[] = [];
    for (let i = 0; i < 6 && failures.length === 0; i += 1) {
      await nextTask();
      failures.push(...client.poll().filter((event) => event.type === 'failed'));
    }
    const failure = failures[0];
    checks.ok(
      'Host rejection surfaces as failed capacity-exceeded',
      rejected.ok &&
        failure?.type === 'failed' &&
        failure.activityId === rejected.value.id &&
        failure.error.code === 'intelligence-capacity-exceeded',
      JSON.stringify(failure),
    );

    const closing = client.close();
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 500))]);
    checks.ok('Host provider closed via the port', provider.closed);
    checks.equal(
      'client submit after close is closed',
      client.submit({ input: 'late' }).ok ? 'ok' : 'closed',
      'closed',
    );
    await binding.close();
  },
});
