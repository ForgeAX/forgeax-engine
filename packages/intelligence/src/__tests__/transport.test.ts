import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createIntelligenceRuntime } from '../runtime';
import {
  bindIntelligencePort,
  createIntelligencePortClient,
  type IntelligenceHostCommand,
  type IntelligenceMessagePort,
  type IntelligenceRealmMessage,
} from '../transport';
import { type ActivitySink, activityId, type IntelligenceProvider } from '../types';

describe('intelligence MessagePort boundary', () => {
  it('moves only structured-cloneable POD across a Worker-style channel', async () => {
    const sinks: ActivitySink[] = [];
    let providerClosed = false;
    const provider: IntelligenceProvider = {
      id: 'port.provider',
      start(_submission, sink) {
        sinks.push(sink);
        return ok(undefined);
      },
      cancel() {
        sinks[0]?.cancelled();
        return ok(undefined);
      },
      async close() {
        providerClosed = true;
      },
    };
    const runtime = createIntelligenceRuntime(provider);
    const channel = new MessageChannel();
    const host = bindIntelligencePort(channel.port1 as unknown as IntelligenceMessagePort, runtime);
    const client = createIntelligencePortClient(
      'port.provider',
      channel.port2 as unknown as IntelligenceMessagePort,
      {
        createActivityId: () => activityId('worker-activity'),
        createSessionId: () => 'worker-session',
      },
    );

    const started = client.submit({ input: 'hello worker' });
    expect(started.ok).toBe(true);
    for (let attempt = 0; attempt < 10 && sinks.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sinks).toHaveLength(1);
    sinks[0]?.text('hello ');
    sinks[0]?.complete('hello worker');
    const received = [] as ReturnType<typeof client.poll>[number][];
    for (let attempt = 0; attempt < 10 && received.length === 0; attempt += 1) {
      received.push(...client.poll());
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(structuredClone(received)).toEqual([
      {
        type: 'text-delta',
        activityId: 'worker-activity',
        sequence: 1,
        text: 'hello ',
      },
      {
        type: 'completed',
        activityId: 'worker-activity',
        sequence: 2,
        session: { providerId: 'port.provider', id: 'worker-session' },
        output: 'hello worker',
      },
    ]);

    await client.close();
    expect(providerClosed).toBe(true);
    await host.close();
  });

  it('bounds realm submissions and releases capacity after a terminal event', async () => {
    const sinks = new Map<string, ActivitySink>();
    const provider: IntelligenceProvider = {
      id: 'bounded.provider',
      start(submission, sink) {
        sinks.set(submission.id, sink);
        return ok(undefined);
      },
      cancel(id) {
        sinks.get(id)?.cancelled();
        sinks.delete(id);
        return ok(undefined);
      },
      async close() {},
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 1 },
    });
    const channel = new MessageChannel();
    const host = bindIntelligencePort(channel.port1 as unknown as IntelligenceMessagePort, runtime);
    let identity = 0;
    const client = createIntelligencePortClient(
      'bounded.provider',
      channel.port2 as unknown as IntelligenceMessagePort,
      {
        limits: { maxConcurrentActivities: 1 },
        createActivityId: () => {
          identity += 1;
          return activityId(`bounded-${identity}`);
        },
      },
    );

    const first = client.submit({ input: 'first' });
    expect(first.ok).toBe(true);
    const second = client.submit({ input: 'second' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('intelligence-capacity-exceeded');

    client.poll();
    client.poll();
    for (let attempt = 0; attempt < 10 && sinks.size === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!first.ok) return;
    sinks.get(first.value.id)?.complete('done');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      client.poll();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(client.submit({ input: 'after terminal' }).ok).toBe(true);

    await client.close();
    await host.close();
  });

  it('recovers optimistic capacity after an asynchronous Host rejection', async () => {
    const sinks = new Map<string, ActivitySink>();
    const starts: string[] = [];
    const provider: IntelligenceProvider = {
      id: 'host.limit.drift.provider',
      start(submission, sink) {
        starts.push(submission.input);
        sinks.set(String(submission.id), sink);
        return ok(undefined);
      },
      cancel(id) {
        sinks.get(String(id))?.cancelled();
        sinks.delete(String(id));
        return ok(undefined);
      },
      async close() {},
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 1 },
    });
    const channel = new MessageChannel();
    const host = bindIntelligencePort(channel.port1 as unknown as IntelligenceMessagePort, runtime);
    let identity = 0;
    const client = createIntelligencePortClient(
      provider.id,
      channel.port2 as unknown as IntelligenceMessagePort,
      {
        limits: { maxConcurrentActivities: 2 },
        createActivityId: () => {
          identity += 1;
          return activityId(`host-limit-drift-${identity}`);
        },
        createSessionId: () => 'host-limit-drift-session',
      },
    );

    try {
      const first = client.submit({ input: 'keep-live' });
      const rejected = client.submit({ input: 'host-reject' });
      expect(first.ok).toBe(true);
      expect(rejected.ok).toBe(true);
      if (!first.ok || !rejected.ok) return;

      const rejectionEvents: ReturnType<typeof client.poll>[number][] = [];
      for (let attempt = 0; attempt < 40 && rejectionEvents.length === 0; attempt += 1) {
        rejectionEvents.push(
          ...client.poll().filter((event) => event.activityId === rejected.value.id),
        );
        if (rejectionEvents.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(starts).toEqual(['keep-live']);
      expect(rejectionEvents).toHaveLength(1);
      expect(rejectionEvents[0]).toEqual({
        type: 'failed',
        activityId: rejected.value.id,
        sequence: 1,
        error: expect.objectContaining({
          code: 'intelligence-capacity-exceeded',
          detail: { limit: 1 },
        }),
      });
      const cancelRejected = client.cancel(rejected.value.id);
      expect(cancelRejected.ok).toBe(false);
      if (!cancelRejected.ok)
        expect(cancelRejected.error.code).toBe('intelligence-activity-not-found');

      sinks.get(String(first.value.id))?.complete('keep-live-ok');
      let firstEvent: ReturnType<typeof client.poll>[number] | undefined;
      for (let attempt = 0; attempt < 40 && firstEvent === undefined; attempt += 1) {
        firstEvent = client.poll().find((event) => event.activityId === first.value.id);
        if (firstEvent === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(firstEvent).toEqual(
        expect.objectContaining({
          type: 'completed',
          activityId: first.value.id,
          output: 'keep-live-ok',
        }),
      );

      const retry = client.submit({ input: 'retry', session: rejected.value.session });
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.value.session).toEqual(rejected.value.session);

      for (let attempt = 0; attempt < 40 && !starts.includes('retry'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(starts).toEqual(['keep-live', 'retry']);
      sinks.get(String(retry.value.id))?.complete('retry-ok');

      let retryEvent: ReturnType<typeof client.poll>[number] | undefined;
      for (let attempt = 0; attempt < 40 && retryEvent === undefined; attempt += 1) {
        retryEvent = client.poll().find((event) => event.activityId === retry.value.id);
        if (retryEvent === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(retryEvent).toEqual(
        expect.objectContaining({
          type: 'completed',
          activityId: retry.value.id,
          session: rejected.value.session,
          output: 'retry-ok',
        }),
      );
    } finally {
      await client.close();
      await host.close();
    }
  });

  it('rejects a cross-provider SessionRef before transport or identity side effects', async () => {
    const createProvider = (id: string) => {
      const sinks = new Map<string, ActivitySink>();
      const starts: string[] = [];
      let closeCalls = 0;
      let closed = false;
      const provider: IntelligenceProvider = {
        id,
        start(submission, sink) {
          starts.push(submission.input);
          sinks.set(String(submission.id), sink);
          return ok(undefined);
        },
        cancel(activity) {
          sinks.get(String(activity))?.cancelled();
          sinks.delete(String(activity));
          return ok(undefined);
        },
        async close() {
          closeCalls += 1;
          closed = true;
          sinks.clear();
        },
      };
      return {
        provider,
        sinks,
        starts,
        get closeCalls() {
          return closeCalls;
        },
        get closed() {
          return closed;
        },
      };
    };
    const providerA = createProvider('transport.provider.a');
    const providerB = createProvider('transport.provider.b');
    const channelA = new MessageChannel();
    const channelB = new MessageChannel();
    const submittedA: string[] = [];
    const submittedB: string[] = [];
    const observeSubmissions = (port: MessagePort, target: string[]): void => {
      port.addEventListener('message', (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (typeof message !== 'object' || message === null) return;
        const value = message as {
          readonly kind?: unknown;
          readonly submission?: { readonly input?: unknown };
        };
        if (value.kind === 'intelligence-submit' && typeof value.submission?.input === 'string') {
          target.push(value.submission.input);
        }
      });
      port.start();
    };
    observeSubmissions(channelA.port1, submittedA);
    observeSubmissions(channelB.port1, submittedB);
    const hostA = bindIntelligencePort(
      channelA.port1 as unknown as IntelligenceMessagePort,
      createIntelligenceRuntime(providerA.provider, { limits: { maxConcurrentActivities: 1 } }),
    );
    const hostB = bindIntelligencePort(
      channelB.port1 as unknown as IntelligenceMessagePort,
      createIntelligenceRuntime(providerB.provider, { limits: { maxConcurrentActivities: 1 } }),
    );
    let activityCallsA = 0;
    let sessionCallsA = 0;
    let activityCallsB = 0;
    let sessionCallsB = 0;
    const clientA = createIntelligencePortClient(
      providerA.provider.id,
      channelA.port2 as unknown as IntelligenceMessagePort,
      {
        createActivityId: () => activityId(`transport-a-${++activityCallsA}`),
        createSessionId: () => `transport-a-session-${++sessionCallsA}`,
      },
    );
    const clientB = createIntelligencePortClient(
      providerB.provider.id,
      channelB.port2 as unknown as IntelligenceMessagePort,
      {
        limits: { maxConcurrentActivities: 1 },
        createActivityId: () => activityId(`transport-b-${++activityCallsB}`),
        createSessionId: () => `transport-b-session-${++sessionCallsB}`,
      },
    );
    const waitForEvent = async (
      client: typeof clientA,
      predicate: (event: ReturnType<typeof clientA.poll>[number]) => boolean,
    ): Promise<ReturnType<typeof clientA.poll>[number] | undefined> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const event = client.poll().find(predicate);
        if (event !== undefined) return event;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return undefined;
    };

    try {
      const first = clientA.submit({ input: 'a-first' });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      for (let attempt = 0; attempt < 40 && providerA.starts.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(providerA.starts).toEqual(['a-first']);
      providerA.sinks.get(String(first.value.id))?.complete('a-first-ok');
      expect(
        (await waitForEvent(clientA, (event) => event.activityId === first.value.id))?.type,
      ).toBe('completed');

      const mismatch = clientB.submit({ input: 'b-mismatch', session: first.value.session });
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) {
        expect(mismatch.error.code).toBe('intelligence-session-provider-mismatch');
        expect(mismatch.error.detail).toEqual({
          expectedProviderId: providerB.provider.id,
          receivedProviderId: providerA.provider.id,
        });
      }
      expect(activityCallsB).toBe(0);
      expect(sessionCallsB).toBe(0);
      expect(submittedB).toEqual([]);
      expect(providerB.starts).toEqual([]);

      const validB = clientB.submit({ input: 'b-valid' });
      expect(validB.ok).toBe(true);
      if (!validB.ok) return;
      for (let attempt = 0; attempt < 40 && providerB.starts.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(providerB.starts).toEqual(['b-valid']);
      providerB.sinks.get(String(validB.value.id))?.complete('b-valid-ok');
      expect(
        (await waitForEvent(clientB, (event) => event.activityId === validB.value.id))?.type,
      ).toBe('completed');

      const retryA = clientA.submit({ input: 'a-retry', session: first.value.session });
      expect(retryA.ok).toBe(true);
      if (!retryA.ok) return;
      expect(retryA.value.session).toEqual(first.value.session);
      for (let attempt = 0; attempt < 40 && providerA.starts.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(providerA.starts).toEqual(['a-first', 'a-retry']);
      providerA.sinks.get(String(retryA.value.id))?.complete('a-retry-ok');
      expect(
        (await waitForEvent(clientA, (event) => event.activityId === retryA.value.id))?.type,
      ).toBe('completed');

      expect(activityCallsA).toBe(2);
      expect(sessionCallsA).toBe(1);
      expect(activityCallsB).toBe(1);
      expect(sessionCallsB).toBe(1);
      expect(submittedA).toEqual(['a-first', 'a-retry']);
      expect(submittedB).toEqual(['b-valid']);
    } finally {
      await Promise.all([clientA.close(), clientB.close()]);
      await Promise.all([hostA.close(), hostB.close()]);
    }

    expect(providerA.closeCalls).toBe(1);
    expect(providerB.closeCalls).toBe(1);
    expect(providerA.sinks).toHaveLength(0);
    expect(providerB.sinks).toHaveLength(0);
    expect(providerA.closed).toBe(true);
    expect(providerB.closed).toBe(true);
  });

  it('drains an interleaved backlog with one poll credit and releases terminal capacity', async () => {
    const sinks = new Map<string, ActivitySink>();
    const starts: string[] = [];
    const provider: IntelligenceProvider = {
      id: 'port.poll.credit.provider',
      start(submission, sink) {
        starts.push(submission.input);
        sinks.set(String(submission.id), sink);
        return ok(undefined);
      },
      cancel(id) {
        sinks.get(String(id))?.cancelled();
        return ok(undefined);
      },
      async close() {},
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 2, maxPollEvents: 1 },
    });
    const channel = new MessageChannel();
    const rawHostPort = channel.port1;
    let pollRequests = 0;
    let pollResponses = 0;
    let pollOutstanding = 0;
    let maxPollOutstanding = 0;
    rawHostPort.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (typeof message !== 'object' || message === null) return;
      if ((message as { readonly kind?: unknown }).kind !== 'intelligence-poll') return;
      pollRequests += 1;
      pollOutstanding += 1;
      maxPollOutstanding = Math.max(maxPollOutstanding, pollOutstanding);
    });
    const hostPort: IntelligenceMessagePort = {
      postMessage(message) {
        if (message.kind === 'intelligence-events') {
          pollResponses += 1;
          pollOutstanding -= 1;
        }
        rawHostPort.postMessage(message);
      },
      addEventListener(type, listener) {
        rawHostPort.addEventListener(type, listener as EventListener);
      },
      removeEventListener(type, listener) {
        rawHostPort.removeEventListener(type, listener as EventListener);
      },
      start() {
        rawHostPort.start();
      },
      close() {
        rawHostPort.close();
      },
    };
    const host = bindIntelligencePort(hostPort, runtime);
    const client = createIntelligencePortClient(
      provider.id,
      channel.port2 as unknown as IntelligenceMessagePort,
      {
        limits: { maxConcurrentActivities: 2, maxPollEvents: 1 },
        createActivityId: (() => {
          let identity = 0;
          return () => activityId(`poll-credit-${++identity}`);
        })(),
      },
    );

    try {
      const first = client.submit({ input: 'first' });
      const second = client.submit({ input: 'second' });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      for (let attempt = 0; attempt < 40 && sinks.size < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(starts).toEqual(['first', 'second']);
      const firstSink = sinks.get(String(first.value.id));
      const secondSink = sinks.get(String(second.value.id));
      expect(firstSink).toBeDefined();
      expect(secondSink).toBeDefined();
      if (firstSink === undefined || secondSink === undefined) return;

      const emitted: string[] = [];
      emitted.push('first:text-1');
      firstSink.text('first-1');
      emitted.push('second:text-1');
      secondSink.text('second-1');
      emitted.push('first:text-2');
      firstSink.text('first-2');
      emitted.push('second:text-2');
      secondSink.text('second-2');
      emitted.push('first:terminal');
      firstSink.complete('first-ok');
      emitted.push('second:terminal');
      secondSink.complete('second-ok');
      expect(emitted).toEqual([
        'first:text-1',
        'second:text-1',
        'first:text-2',
        'second:text-2',
        'first:terminal',
        'second:terminal',
      ]);

      client.poll();
      client.poll();
      for (let attempt = 0; attempt < 40 && pollRequests < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(pollRequests).toBe(1);
      expect(maxPollOutstanding).toBe(1);

      const received: ReturnType<typeof client.poll>[number][] = [];
      for (let attempt = 0; attempt < 200 && received.length < 6; attempt += 1) {
        received.push(...client.poll());
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(received).toHaveLength(6);
      for (const id of [first.value.id, second.value.id]) {
        const activityEvents = received.filter((event) => event.activityId === id);
        expect(activityEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
        expect(activityEvents.at(-1)?.type).toBe('completed');
      }
      expect(new Set(received.map((event) => String(event.activityId)))).toEqual(
        new Set([String(first.value.id), String(second.value.id)]),
      );
      for (let attempt = 0; attempt < 40 && pollOutstanding !== 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(pollOutstanding).toBe(0);
      expect(pollResponses).toBe(pollRequests);
      expect(maxPollOutstanding).toBe(1);

      const requestsBeforeRecovery = pollRequests;
      const after = client.submit({ input: 'after terminal' });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      for (let attempt = 0; attempt < 40 && !starts.includes('after terminal'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(starts).toEqual(['first', 'second', 'after terminal']);
      sinks.get(String(after.value.id))?.complete('after-ok');

      const afterEvents: ReturnType<typeof client.poll>[number][] = [];
      for (let attempt = 0; attempt < 100 && afterEvents.length === 0; attempt += 1) {
        afterEvents.push(...client.poll());
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(afterEvents).toEqual([
        expect.objectContaining({
          type: 'completed',
          activityId: after.value.id,
          sequence: 1,
          output: 'after-ok',
        }),
      ]);
      for (let attempt = 0; attempt < 40 && pollOutstanding !== 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(pollOutstanding).toBe(0);
      expect(pollRequests - requestsBeforeRecovery).toBe(2);
      expect(maxPollOutstanding).toBe(1);
    } finally {
      await client.close();
      await host.close();
    }
  });

  it('rejects invalid input synchronously before identity, capacity, port dispatch, or provider start', async () => {
    const sinks = new Map<string, ActivitySink>();
    const submittedInputs: string[] = [];
    let activityIdentityCalls = 0;
    let sessionIdentityCalls = 0;
    let providerStarts = 0;
    const provider: IntelligenceProvider = {
      id: 'port.input.boundary.provider',
      start(submission, sink) {
        providerStarts += 1;
        sinks.set(submission.id, sink);
        return ok(undefined);
      },
      cancel() {
        return ok(undefined);
      },
      async close() {},
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxInputChars: 4, maxConcurrentActivities: 1 },
    });
    const channel = new MessageChannel();
    channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (typeof message !== 'object' || message === null) return;
      const value = message as {
        readonly kind?: unknown;
        readonly submission?: { readonly input?: unknown };
      };
      if (value.kind === 'intelligence-submit' && typeof value.submission?.input === 'string') {
        submittedInputs.push(value.submission.input);
      }
    });
    const host = bindIntelligencePort(channel.port1 as unknown as IntelligenceMessagePort, runtime);
    const client = createIntelligencePortClient(
      'port.input.boundary.provider',
      channel.port2 as unknown as IntelligenceMessagePort,
      {
        limits: { maxInputChars: 4, maxConcurrentActivities: 1 },
        createActivityId: () => {
          activityIdentityCalls += 1;
          return activityId('port-input-boundary-activity');
        },
        createSessionId: () => {
          sessionIdentityCalls += 1;
          return 'port-input-boundary-session';
        },
      },
    );

    const exact = client.submit({ input: 'abcd' });
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(activityIdentityCalls).toBe(1);
    expect(sessionIdentityCalls).toBe(1);
    expect(providerStarts).toBe(0);

    const empty = client.submit({ input: '' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe('intelligence-invalid-request');
      expect(empty.error.detail).toEqual({ field: 'input', reason: 'input is empty' });
    }

    const overLimit = client.submit({ input: 'abcde' });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.error.code).toBe('intelligence-invalid-request');
      expect(overLimit.error.detail).toEqual({
        field: 'input',
        reason: 'input exceeds 4 characters',
      });
    }

    expect(activityIdentityCalls).toBe(1);
    expect(sessionIdentityCalls).toBe(1);
    expect(providerStarts).toBe(0);

    for (let attempt = 0; attempt < 10 && providerStarts === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(providerStarts).toBe(1);
    expect(submittedInputs).toEqual(['abcd']);
    sinks.get(exact.value.id)?.complete('done');

    let received: readonly ReturnType<typeof client.poll>[number][] = [];
    for (let attempt = 0; attempt < 10 && received.length === 0; attempt += 1) {
      received = client.poll();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(received).toEqual([
      {
        type: 'completed',
        activityId: exact.value.id,
        sequence: 1,
        session: exact.value.session,
        output: 'done',
      },
    ]);

    await client.close();
    await host.close();
  });

  it('settles client close after a rejecting Host provider and permits a fresh binding', async () => {
    let closeCalls = 0;
    let starts = 0;
    const provider: IntelligenceProvider = {
      id: 'port.close.rejection.provider',
      start(_submission, sink) {
        starts += 1;
        sink.complete('closed-run');
        return ok(undefined);
      },
      cancel() {
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
        throw new Error('sentinel Host close rejection');
      },
    };
    const runtime = createIntelligenceRuntime(provider);
    const channel = new MessageChannel();
    const host = bindIntelligencePort(channel.port1 as unknown as IntelligenceMessagePort, runtime);
    const client = createIntelligencePortClient(
      'port.close.rejection.provider',
      channel.port2 as unknown as IntelligenceMessagePort,
    );

    try {
      expect(client.submit({ input: 'first binding' }).ok).toBe(true);
      for (let attempt = 0; attempt < 20 && starts === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(starts).toBe(1);

      const closeSettled = await Promise.race([
        client.close().then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(closeSettled).toBe(true);
      expect(closeCalls).toBe(1);

      const freshChannel = new MessageChannel();
      const freshProvider: IntelligenceProvider = {
        id: 'port.close.recovery.provider',
        start(_submission, sink) {
          sink.complete('fresh-run');
          return ok(undefined);
        },
        cancel() {
          return ok(undefined);
        },
        async close() {},
      };
      const freshHost = bindIntelligencePort(
        freshChannel.port1 as unknown as IntelligenceMessagePort,
        createIntelligenceRuntime(freshProvider),
      );
      const freshClient = createIntelligencePortClient(
        'port.close.recovery.provider',
        freshChannel.port2 as unknown as IntelligenceMessagePort,
      );
      try {
        const freshStarted = freshClient.submit({ input: 'fresh binding' });
        expect(freshStarted.ok).toBe(true);
        let freshEvents: readonly ReturnType<typeof freshClient.poll>[number][] = [];
        for (let attempt = 0; attempt < 20 && freshEvents.length === 0; attempt += 1) {
          freshEvents = freshClient.poll();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(freshEvents).toEqual([
          expect.objectContaining({ type: 'completed', output: 'fresh-run' }),
        ]);
        await freshClient.close();
      } finally {
        await freshHost.close().catch(() => undefined);
      }
    } finally {
      await host.close().catch(() => undefined);
    }
  });

  it('contains a synchronous Worker client close command failure and releases local transport', async () => {
    let starts = 0;
    let closeCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'port.client-close-command.provider',
      start() {
        starts += 1;
        return ok(undefined);
      },
      cancel() {
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
      },
    };
    const runtime = createIntelligenceRuntime(provider);
    const channel = new MessageChannel();
    const rawClientPort = channel.port2;
    const commandKinds: string[] = [];
    let removeListenerCalls = 0;
    let clientPortCloseCalls = 0;
    const clientPort: IntelligenceMessagePort = {
      postMessage(message) {
        commandKinds.push(message.kind);
        if (message.kind === 'intelligence-close') {
          throw new Error('sentinel Worker client close command failure');
        }
        rawClientPort.postMessage(message);
      },
      addEventListener(type, listener) {
        rawClientPort.addEventListener(type, listener as EventListener);
      },
      removeEventListener(type, listener) {
        removeListenerCalls += 1;
        rawClientPort.removeEventListener(type, listener as EventListener);
      },
      start() {
        rawClientPort.start();
      },
      close() {
        clientPortCloseCalls += 1;
        rawClientPort.close();
      },
    };
    const host = bindIntelligencePort(channel.port1 as unknown as IntelligenceMessagePort, runtime);
    const client = createIntelligencePortClient(provider.id, clientPort, {
      createActivityId: () => activityId('client-close-command-activity'),
      createSessionId: () => 'client-close-command-session',
    });

    try {
      const started = client.submit({ input: 'live close' });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      for (let attempt = 0; attempt < 20 && starts === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(starts).toBe(1);

      client.poll();
      const closeTask = client.close();
      expect(client.close()).toBe(closeTask);
      await expect(closeTask).resolves.toBeUndefined();

      expect(commandKinds).toEqual([
        'intelligence-submit',
        'intelligence-poll',
        'intelligence-close',
      ]);
      expect(removeListenerCalls).toBe(1);
      expect(clientPortCloseCalls).toBe(1);
      expect(closeCalls).toBe(0);

      const afterCloseSubmit = client.submit({ input: 'after close' });
      expect(afterCloseSubmit.ok).toBe(false);
      if (!afterCloseSubmit.ok) expect(afterCloseSubmit.error.code).toBe('intelligence-closed');
      const afterCloseCancel = client.cancel(started.value.id);
      expect(afterCloseCancel.ok).toBe(false);
      if (!afterCloseCancel.ok) expect(afterCloseCancel.error.code).toBe('intelligence-closed');
      expect(client.poll()).toEqual([]);

      await expect(host.close()).resolves.toBeUndefined();
      expect(closeCalls).toBe(1);
    } finally {
      rawClientPort.close();
      await host.close().catch(() => undefined);
    }
  });

  it('contains a synchronous Worker client submit command failure and clears local state', async () => {
    const sinks = new Map<string, ActivitySink>();
    const starts: string[] = [];
    let closeCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'port.client-submit-command.provider',
      start(submission, sink) {
        starts.push(submission.input);
        sinks.set(String(submission.id), sink);
        if (submission.input === 'live') sink.text('pending');
        return ok(undefined);
      },
      cancel(id) {
        sinks.get(String(id))?.cancelled();
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
      },
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 1 },
    });
    const channel = new MessageChannel();
    const rawClientPort = channel.port2;
    const commandKinds: string[] = [];
    let removeListenerCalls = 0;
    let clientPortCloseCalls = 0;
    const clientPort: IntelligenceMessagePort = {
      postMessage(message) {
        commandKinds.push(message.kind);
        if (message.kind === 'intelligence-submit' && message.submission.input === 'submit-fault') {
          throw new Error('sentinel Worker client submit command failure');
        }
        rawClientPort.postMessage(message);
      },
      addEventListener(type, listener) {
        rawClientPort.addEventListener(type, listener as EventListener);
      },
      removeEventListener(type, listener) {
        removeListenerCalls += 1;
        rawClientPort.removeEventListener(type, listener as EventListener);
      },
      start() {
        rawClientPort.start();
      },
      close() {
        clientPortCloseCalls += 1;
        rawClientPort.close();
      },
    };
    const host = bindIntelligencePort(channel.port1 as unknown as IntelligenceMessagePort, runtime);
    const client = createIntelligencePortClient(provider.id, clientPort, {
      limits: { maxConcurrentActivities: 2 },
      createActivityId: (() => {
        let identity = 0;
        return () => activityId(`client-submit-command-${++identity}`);
      })(),
      createSessionId: () => 'client-submit-command-session',
    });

    try {
      const live = client.submit({ input: 'live' });
      expect(live.ok).toBe(true);
      const hostRejected = client.submit({ input: 'host-reject' });
      expect(hostRejected.ok).toBe(true);
      if (!live.ok || !hostRejected.ok) return;

      let rejectionObserved = false;
      const rejectionListener = (event: MessageEvent<unknown>): void => {
        const value = event.data as { readonly kind?: unknown; readonly activityId?: unknown };
        if (value.kind === 'intelligence-rejected' && value.activityId === hostRejected.value.id) {
          rejectionObserved = true;
        }
      };
      rawClientPort.addEventListener('message', rejectionListener);
      rawClientPort.start();
      for (let attempt = 0; attempt < 40 && !rejectionObserved; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      rawClientPort.removeEventListener('message', rejectionListener);
      expect(rejectionObserved).toBe(true);

      client.poll();
      for (
        let attempt = 0;
        attempt < 40 && !commandKinds.includes('intelligence-poll');
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const failed = client.submit({ input: 'submit-fault' });
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.code).toBe('intelligence-closed');

      const commandCountAfterFailure = commandKinds.length;
      expect(client.poll()).toEqual([]);
      const afterFailure = client.submit({ input: 'after-failure' });
      expect(afterFailure.ok).toBe(false);
      if (!afterFailure.ok) expect(afterFailure.error.code).toBe('intelligence-closed');
      const cancelAfterFailure = client.cancel(live.value.id);
      expect(cancelAfterFailure.ok).toBe(false);
      if (!cancelAfterFailure.ok) expect(cancelAfterFailure.error.code).toBe('intelligence-closed');
      expect(commandKinds).toHaveLength(commandCountAfterFailure);
      expect(starts).toEqual(['live']);
      expect(removeListenerCalls).toBe(1);
      expect(clientPortCloseCalls).toBe(1);

      const closeTask = client.close();
      expect(client.close()).toBe(closeTask);
      await expect(closeTask).resolves.toBeUndefined();
      await expect(host.close()).resolves.toBeUndefined();
      expect(closeCalls).toBe(1);
      sinks.get(String(live.value.id))?.complete('late');
      expect(runtime.poll()).toEqual([]);
    } finally {
      rawClientPort.close();
      await host.close().catch(() => undefined);
    }
  });

  it('contains a synchronous Worker client cancel command failure and releases local transport', async () => {
    const sinks = new Map<string, ActivitySink>();
    let starts = 0;
    let cancelCalls = 0;
    let closeCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'port.client-cancel-command.provider',
      start(submission, sink) {
        starts += 1;
        sinks.set(String(submission.id), sink);
        sink.text('staged-before-cancel-fault');
        return ok(undefined);
      },
      cancel(id) {
        cancelCalls += 1;
        sinks.get(String(id))?.cancelled();
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
      },
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 1, maxPollEvents: 1 },
    });
    const channel = new MessageChannel();
    const rawHostPort = channel.port1;
    const rawClientPort = channel.port2;
    const clientCommands: string[] = [];
    const hostCommands: string[] = [];
    let stagedEventObserved = false;
    let removeListenerCalls = 0;
    let clientPortCloseCalls = 0;
    rawHostPort.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data as { readonly kind?: unknown };
      if (typeof message.kind === 'string') hostCommands.push(message.kind);
    });
    rawHostPort.start();
    rawClientPort.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data as {
        readonly kind?: unknown;
        readonly events?: readonly unknown[];
      };
      if (message.kind === 'intelligence-events' && (message.events?.length ?? 0) > 0) {
        stagedEventObserved = true;
      }
    });
    rawClientPort.start();
    const clientPort: IntelligenceMessagePort = {
      postMessage(message) {
        clientCommands.push(message.kind);
        if (message.kind === 'intelligence-cancel') {
          throw new Error('sentinel Worker client cancel command failure');
        }
        rawClientPort.postMessage(message);
      },
      addEventListener(type, listener) {
        rawClientPort.addEventListener(type, listener as EventListener);
      },
      removeEventListener(type, listener) {
        removeListenerCalls += 1;
        rawClientPort.removeEventListener(type, listener as EventListener);
      },
      start() {
        rawClientPort.start();
      },
      close() {
        clientPortCloseCalls += 1;
        rawClientPort.close();
      },
    };
    const host = bindIntelligencePort(rawHostPort as unknown as IntelligenceMessagePort, runtime);
    let activityIdentityCalls = 0;
    let sessionIdentityCalls = 0;
    const client = createIntelligencePortClient(provider.id, clientPort, {
      limits: { maxConcurrentActivities: 1, maxPollEvents: 1 },
      createActivityId: () => activityId(`client-cancel-command-${++activityIdentityCalls}`),
      createSessionId: () => `client-cancel-command-session-${++sessionIdentityCalls}`,
    });

    try {
      const started = client.submit({ input: 'live-cancel' });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      for (let attempt = 0; attempt < 40 && starts === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(starts).toBe(1);

      expect(client.poll()).toEqual([]);
      for (let attempt = 0; attempt < 40 && !stagedEventObserved; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(stagedEventObserved).toBe(true);

      let cancellation: ReturnType<typeof client.cancel> | undefined;
      let thrown: unknown;
      try {
        cancellation = client.cancel(started.value.id);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeUndefined();
      expect(cancellation?.ok).toBe(false);
      if (cancellation !== undefined && !cancellation.ok) {
        expect(cancellation.error.code).toBe('intelligence-closed');
      }
      expect(clientCommands).toEqual([
        'intelligence-submit',
        'intelligence-poll',
        'intelligence-cancel',
      ]);
      expect(hostCommands).toEqual(['intelligence-submit', 'intelligence-poll']);
      expect(cancelCalls).toBe(0);
      expect(removeListenerCalls).toBe(1);
      expect(clientPortCloseCalls).toBe(1);

      const commandCountAfterFault = clientCommands.length;
      expect(client.submit({ input: 'after-cancel-fault' }).ok).toBe(false);
      expect(client.cancel(started.value.id).ok).toBe(false);
      expect(client.poll()).toEqual([]);
      expect(clientCommands).toHaveLength(commandCountAfterFault);
      expect(activityIdentityCalls).toBe(1);
      expect(sessionIdentityCalls).toBe(1);

      await expect(host.close()).resolves.toBeUndefined();
      expect(closeCalls).toBe(1);
      sinks.get(String(started.value.id))?.text('late');
      sinks.get(String(started.value.id))?.complete('late');
      expect(client.poll()).toEqual([]);
    } finally {
      rawClientPort.close();
      await host.close().catch(() => undefined);
    }
  });

  it('contains a synchronous Worker client poll command failure and discards staged events', async () => {
    const sinks = new Map<string, ActivitySink>();
    const starts: string[] = [];
    let closeCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'port.client-poll-command.provider',
      start(submission, sink) {
        starts.push(submission.input);
        sinks.set(String(submission.id), sink);
        sink.text('staged-before-poll-fault');
        return ok(undefined);
      },
      cancel(id) {
        sinks.get(String(id))?.cancelled();
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
      },
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 1, maxPollEvents: 1 },
    });
    const channel = new MessageChannel();
    const rawHostPort = channel.port1;
    const rawClientPort = channel.port2;
    const commandKinds: string[] = [];
    let pollRequests = 0;
    let normalPollResponses = 0;
    let stagedEventObserved = false;
    let throwNextPoll = false;
    let pollFaultThrows = 0;
    let removeListenerCalls = 0;
    let clientPortCloseCalls = 0;
    rawHostPort.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data as { readonly kind?: unknown };
      if (message.kind === 'intelligence-poll') pollRequests += 1;
    });
    rawHostPort.start();
    rawClientPort.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data as {
        readonly kind?: unknown;
        readonly events?: readonly unknown[];
      };
      if (message.kind === 'intelligence-events') {
        normalPollResponses += 1;
        if ((message.events?.length ?? 0) > 0) {
          stagedEventObserved = true;
          throwNextPoll = true;
        }
      }
    });
    rawClientPort.start();
    const clientPort: IntelligenceMessagePort = {
      postMessage(message) {
        commandKinds.push(message.kind);
        if (message.kind === 'intelligence-poll' && throwNextPoll) {
          throwNextPoll = false;
          pollFaultThrows += 1;
          throw new Error('sentinel Worker client poll command failure');
        }
        rawClientPort.postMessage(message);
      },
      addEventListener(type, listener) {
        rawClientPort.addEventListener(type, listener as EventListener);
      },
      removeEventListener(type, listener) {
        removeListenerCalls += 1;
        rawClientPort.removeEventListener(type, listener as EventListener);
      },
      start() {
        rawClientPort.start();
      },
      close() {
        clientPortCloseCalls += 1;
        rawClientPort.close();
      },
    };
    const host = bindIntelligencePort(rawHostPort as unknown as IntelligenceMessagePort, runtime);
    const client = createIntelligencePortClient(provider.id, clientPort, {
      limits: { maxConcurrentActivities: 1, maxPollEvents: 1 },
      createActivityId: (() => {
        let identity = 0;
        return () => activityId(`client-poll-command-${++identity}`);
      })(),
      createSessionId: () => 'client-poll-command-session',
    });

    try {
      const started = client.submit({ input: 'live' });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      for (let attempt = 0; attempt < 40 && starts.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(starts).toEqual(['live']);

      expect(client.poll()).toEqual([]);
      for (let attempt = 0; attempt < 40 && !stagedEventObserved; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(normalPollResponses).toBe(1);
      expect(stagedEventObserved).toBe(true);
      expect(pollRequests).toBe(1);

      const failedPoll = client.poll();
      expect(failedPoll).toEqual([]);
      expect(pollFaultThrows).toBe(1);
      expect(commandKinds).toEqual([
        'intelligence-submit',
        'intelligence-poll',
        'intelligence-poll',
      ]);
      expect(pollRequests).toBe(1);

      expect(client.poll()).toEqual([]);
      const afterFailure = client.submit({ input: 'after-failure' });
      expect(afterFailure.ok).toBe(false);
      if (!afterFailure.ok) expect(afterFailure.error.code).toBe('intelligence-closed');
      const cancelAfterFailure = client.cancel(started.value.id);
      expect(cancelAfterFailure.ok).toBe(false);
      if (!cancelAfterFailure.ok) expect(cancelAfterFailure.error.code).toBe('intelligence-closed');
      expect(commandKinds).toHaveLength(3);
      expect(starts).toEqual(['live']);
      expect(removeListenerCalls).toBe(1);
      expect(clientPortCloseCalls).toBe(1);

      const closeTask = client.close();
      expect(client.close()).toBe(closeTask);
      await expect(closeTask).resolves.toBeUndefined();
      await expect(host.close()).resolves.toBeUndefined();
      expect(closeCalls).toBe(1);
      sinks.get(String(started.value.id))?.complete('late');
      expect(runtime.poll()).toEqual([]);
    } finally {
      rawClientPort.close();
      await host.close().catch(() => undefined);
    }
  });

  it('contains a synchronous Host close notification failure and releases for a fresh binding', async () => {
    let sink: ActivitySink | undefined;
    let startCalls = 0;
    let closeCalls = 0;
    let portCloseCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'port.close.notification-failure.provider',
      start(_submission, nextSink) {
        startCalls += 1;
        sink = nextSink;
        return ok(undefined);
      },
      cancel() {
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
      },
    };
    const runtime = createIntelligenceRuntime(provider);
    const channel = new MessageChannel();
    const rawHostPort = channel.port1;
    const rawClientPort = channel.port2;
    const hostPort: IntelligenceMessagePort = {
      postMessage(message) {
        if (message.kind === 'intelligence-closed') {
          throw new Error('sentinel Host close notification failure');
        }
        rawHostPort.postMessage(message);
      },
      addEventListener(type, listener) {
        rawHostPort.addEventListener(type, listener as EventListener);
      },
      removeEventListener(type, listener) {
        rawHostPort.removeEventListener(type, listener as EventListener);
      },
      start() {
        rawHostPort.start();
      },
      close() {
        portCloseCalls += 1;
        rawHostPort.close();
      },
    };
    const host = bindIntelligencePort(hostPort, runtime);
    const client = createIntelligencePortClient(
      provider.id,
      rawClientPort as unknown as IntelligenceMessagePort,
    );

    try {
      const started = client.submit({ input: 'live close' });
      expect(started.ok).toBe(true);
      client.poll();
      for (let attempt = 0; attempt < 20 && startCalls === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(startCalls).toBe(1);

      await expect(host.close()).resolves.toBeUndefined();
      expect(closeCalls).toBe(1);
      expect(portCloseCalls).toBe(1);

      sink?.text('late');
      sink?.complete('late');
      expect(runtime.poll()).toEqual([]);

      const freshChannel = new MessageChannel();
      let freshCloseCalls = 0;
      const freshProvider: IntelligenceProvider = {
        id: 'port.close.notification-failure.recovery-provider',
        start(_submission, nextSink) {
          nextSink.complete('fresh-run');
          return ok(undefined);
        },
        cancel() {
          return ok(undefined);
        },
        async close() {
          freshCloseCalls += 1;
        },
      };
      const freshHost = bindIntelligencePort(
        freshChannel.port1 as unknown as IntelligenceMessagePort,
        createIntelligenceRuntime(freshProvider),
      );
      const freshClient = createIntelligencePortClient(
        freshProvider.id,
        freshChannel.port2 as unknown as IntelligenceMessagePort,
      );
      try {
        expect(freshClient.submit({ input: 'fresh binding' }).ok).toBe(true);
        let freshEvents: readonly ReturnType<typeof freshClient.poll>[number][] = [];
        for (let attempt = 0; attempt < 20 && freshEvents.length === 0; attempt += 1) {
          freshEvents = freshClient.poll();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(freshEvents).toEqual([
          expect.objectContaining({ type: 'completed', output: 'fresh-run' }),
        ]);
        await freshClient.close();
        await freshHost.close();
        expect(freshCloseCalls).toBe(1);
      } finally {
        await freshHost.close().catch(() => undefined);
        freshChannel.port2.close();
      }
    } finally {
      rawClientPort.close();
      await host.close().catch(() => undefined);
    }
  });

  it('contains a synchronous Host poll response failure after the runtime has drained events', async () => {
    let sink: ActivitySink | undefined;
    let closeCalls = 0;
    let removeListenerCalls = 0;
    let portCloseCalls = 0;
    let hostListener:
      | ((event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>) => void)
      | undefined;
    const posted: string[] = [];
    const provider: IntelligenceProvider = {
      id: 'port.host-poll-response-failure.provider',
      start(_submission, nextSink) {
        sink = nextSink;
        return ok(undefined);
      },
      cancel() {
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
      },
    };
    const runtime = createIntelligenceRuntime(provider, { limits: { maxPollEvents: 1 } });
    const hostPort: IntelligenceMessagePort = {
      postMessage(message) {
        posted.push(message.kind);
        if (message.kind === 'intelligence-events') {
          throw new Error('sentinel Host poll response publication failure');
        }
      },
      addEventListener(_type, listener) {
        hostListener = listener;
      },
      removeEventListener(_type, listener) {
        removeListenerCalls += Number(listener === hostListener);
        hostListener = undefined;
      },
      start() {},
      close() {
        portCloseCalls += 1;
      },
    };
    const host = bindIntelligencePort(hostPort, runtime);
    const activity = {
      id: activityId('host-poll-response-failure-activity'),
      session: {
        providerId: provider.id,
        id: 'host-poll-response-failure-session',
      },
      input: 'live poll response failure',
    } as const;

    try {
      expect(runtime.accept(activity).ok).toBe(true);
      sink?.text('staged-before-host-response-fault');
      expect(hostListener).toBeDefined();
      expect(() =>
        hostListener?.({
          data: { kind: 'intelligence-poll', maxEvents: 1 },
        } as MessageEvent<IntelligenceHostCommand>),
      ).not.toThrow();

      const closeTask = host.close();
      expect(host.close()).toBe(closeTask);
      await expect(closeTask).resolves.toBeUndefined();
      expect(posted).toEqual(['intelligence-events', 'intelligence-closed']);
      expect(closeCalls).toBe(1);
      expect(removeListenerCalls).toBe(1);
      expect(portCloseCalls).toBe(1);
      expect(runtime.poll()).toEqual([]);
    } finally {
      await host.close().catch(() => undefined);
    }
  });

  it('propagates direct Host binding close to a live realm client', async () => {
    let sink: ActivitySink | undefined;
    let starts = 0;
    let closeCalls = 0;
    const provider: IntelligenceProvider = {
      id: 'port.host-close.provider',
      start(_submission, nextSink) {
        starts += 1;
        sink = nextSink;
        return ok(undefined);
      },
      cancel() {
        return ok(undefined);
      },
      async close() {
        closeCalls += 1;
      },
    };
    const runtime = createIntelligenceRuntime(provider, {
      limits: { maxConcurrentActivities: 1 },
    });
    const channel = new MessageChannel();
    const rawClientPort = channel.port2;
    let closedMessageObserved = false;
    rawClientPort.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (typeof message === 'object' && message !== null && 'kind' in message) {
        if ((message as { readonly kind?: unknown }).kind === 'intelligence-closed') {
          closedMessageObserved = true;
        }
      }
    });
    rawClientPort.start();
    const clientCommands: string[] = [];
    const clientPort: IntelligenceMessagePort = {
      postMessage(message) {
        if (
          message.kind === 'intelligence-submit' ||
          message.kind === 'intelligence-poll' ||
          message.kind === 'intelligence-cancel' ||
          message.kind === 'intelligence-close'
        ) {
          clientCommands.push(message.kind);
        }
        rawClientPort.postMessage(message);
      },
      addEventListener(type, listener) {
        rawClientPort.addEventListener(type, listener as EventListener);
      },
      removeEventListener(type, listener) {
        rawClientPort.removeEventListener(type, listener as EventListener);
      },
      start() {
        rawClientPort.start();
      },
      close() {
        rawClientPort.close();
      },
    };
    const host = bindIntelligencePort(channel.port1 as unknown as IntelligenceMessagePort, runtime);
    let activityIdentityCalls = 0;
    let sessionIdentityCalls = 0;
    const client = createIntelligencePortClient(provider.id, clientPort, {
      limits: { maxConcurrentActivities: 1 },
      createActivityId: () => {
        activityIdentityCalls += 1;
        return activityId(`host-close-${activityIdentityCalls}`);
      },
      createSessionId: () => {
        sessionIdentityCalls += 1;
        return `host-close-session-${sessionIdentityCalls}`;
      },
    });

    try {
      const started = client.submit({ input: 'live' });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      for (let attempt = 0; attempt < 20 && starts === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(starts).toBe(1);
      client.poll();

      await host.close();
      for (let attempt = 0; attempt < 20 && !closedMessageObserved; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(closedMessageObserved).toBe(true);

      const afterClose = client.submit({ input: 'after-close' });
      expect(afterClose.ok).toBe(false);
      if (!afterClose.ok) expect(afterClose.error.code).toBe('intelligence-closed');
      const cancelled = client.cancel(started.value.id);
      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok) expect(cancelled.error.code).toBe('intelligence-closed');
      expect(client.poll()).toEqual([]);
      expect(activityIdentityCalls).toBe(1);
      expect(sessionIdentityCalls).toBe(1);
      expect(starts).toBe(1);
      expect(closeCalls).toBe(1);
      expect(clientCommands).toEqual(['intelligence-submit', 'intelligence-poll']);

      const closeSettled = await Promise.race([
        client.close().then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(closeSettled).toBe(true);

      sink?.text('late');
      sink?.complete('late');
      expect(client.poll()).toEqual([]);
    } finally {
      await host.close();
      clientPort.close();
    }
  });
});
