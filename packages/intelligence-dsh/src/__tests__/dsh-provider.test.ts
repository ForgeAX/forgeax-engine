import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ActivityEvent,
  createIntelligenceRuntime,
  type IntelligenceService,
  type SessionRef,
} from '@forgeax/engine-intelligence';
import { createFakeIntelligenceProvider } from '@forgeax/engine-intelligence-fake';
import { describe, expect, it } from 'vitest';
import { createDshIntelligenceProvider, type DshHarness, extractDshTextDelta } from '../index';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-dsh-runtime.mjs');

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface DialogueView {
  text: string;
  terminal: boolean;
  session?: SessionRef;
}

function updateDialogue(service: IntelligenceService, view: DialogueView): void {
  for (const event of service.poll()) {
    if (event.type === 'text-delta') view.text += event.text;
    else if (event.type === 'completed') {
      view.terminal = true;
      view.session = event.session;
    } else if (event.type === 'failed' || event.type === 'cancelled') {
      view.terminal = true;
    }
  }
}

async function waitForTerminal(service: IntelligenceService, view: DialogueView): Promise<void> {
  for (let attempt = 0; attempt < 200 && !view.terminal; attempt += 1) {
    updateDialogue(service, view);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(view.terminal).toBe(true);
}

describe('DeepSeek Harness intelligence provider', () => {
  it('projects only text deltas from DSH notifications', () => {
    expect(
      extractDshTextDelta({
        method: 'session.event',
        params: {
          event: {
            type: 'assistant/chunk',
            data: { chunk: { type: 'text-delta', text: 'token' } },
          },
        },
      }),
    ).toBe('token');
    expect(extractDshTextDelta({ method: 'session.status', params: {} })).toBeUndefined();
  });

  it('lets one dialogue consumer swap fake and DSH providers', async () => {
    const fake = createFakeIntelligenceProvider({
      script: () => ({ deltas: ['same'], output: 'same' }),
    });
    const fakeService = createIntelligenceRuntime(fake);
    const fakeView: DialogueView = { text: '', terminal: false };
    fakeService.submit({ input: 'prompt' });
    fake.advance();
    fake.advance();
    updateDialogue(fakeService, fakeView);

    let closeCount = 0;
    const harness: DshHarness = {
      async run(_input, options) {
        options.onNotification({
          method: 'session.event',
          params: {
            event: {
              type: 'assistant/chunk',
              data: { chunk: { type: 'text-delta', text: 'same' } },
            },
          },
        });
        return { finalResponse: 'same' };
      },
      async close() {
        closeCount += 1;
      },
    };
    const dshService = createIntelligenceRuntime(
      createDshIntelligenceProvider({
        launch: { command: 'unused' },
        createHarness: () => harness,
      }),
    );
    const dshView: DialogueView = { text: '', terminal: false };
    dshService.submit({ input: 'prompt' });
    await turn();
    updateDialogue(dshService, dshView);

    expect(fakeView.text).toBe('same');
    expect(dshView.text).toBe('same');
    expect(fakeView.terminal).toBe(true);
    expect(dshView.terminal).toBe(true);
    expect(closeCount).toBeGreaterThan(0);
  });

  it('streams through the real SDK transport and reaps the runtime on completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-intelligence-dsh-'));
    const lifecycle = join(root, 'lifecycle.log');
    const provider = createDshIntelligenceProvider({
      launch: {
        command: process.execPath,
        args: [fixture],
        env: { DSH_FAKE_LIFECYCLE: lifecycle },
        requestTimeoutMs: 2_000,
        shutdownTimeoutMs: 500,
        disposeEofGraceMs: 500,
        disposeGraceMs: 500,
      },
    });
    const service = createIntelligenceRuntime(provider);
    const view: DialogueView = { text: '', terminal: false };
    const started = service.submit({ input: 'complete' });
    if (!started.ok) throw started.error;
    await waitForTerminal(service, view);
    await service.close();

    expect(view.text).toBe('hello');
    expect(view.session).toEqual(started.value.session);
    const lines = (await readFile(lifecycle, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.replace('started:', '')).toBe(lines[1]?.replace('closed:', ''));
  }, 10_000);

  it('cancels one Activity by closing only its owned DSH runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-intelligence-dsh-cancel-'));
    const lifecycle = join(root, 'lifecycle.log');
    const service = createIntelligenceRuntime(
      createDshIntelligenceProvider({
        launch: {
          command: process.execPath,
          args: [fixture],
          env: { DSH_FAKE_LIFECYCLE: lifecycle },
          requestTimeoutMs: 2_000,
          shutdownTimeoutMs: 500,
          disposeEofGraceMs: 500,
          disposeGraceMs: 500,
        },
      }),
    );
    const started = service.submit({ input: 'hang' });
    if (!started.ok) throw started.error;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.cancel(started.value.id).ok).toBe(true);
    const view: DialogueView = { text: '', terminal: false };
    await waitForTerminal(service, view);
    await service.close();

    const lines = (await readFile(lifecycle, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.replace('started:', '')).toBe(lines[1]?.replace('closed:', ''));
  }, 10_000);

  it('contains a refused cancellation close without affecting a sibling', async () => {
    const harnesses: Array<{
      active: boolean;
      closeCalls: number;
      closed: boolean;
      input?: string;
      rejectRun?: (cause: Error) => void;
      resolveClose?: () => void;
      resolveRun?: () => void;
    }> = [];
    const provider = createDshIntelligenceProvider({
      launch: {
        command: process.execPath,
        args: [],
      },
      createHarness: () => {
        const state: (typeof harnesses)[number] = {
          active: false,
          closeCalls: 0,
          closed: false,
        };
        harnesses.push(state);
        return {
          run: (input: string) => {
            state.input = input;
            state.active = true;
            if (input === 'activity-a') {
              return new Promise<never>((_resolve, reject) => {
                state.rejectRun = reject;
              });
            }
            return new Promise((resolve) => {
              state.resolveRun = () => resolve({ finalResponse: 'activity-b-complete' });
            });
          },
          close: async () => {
            state.closeCalls += 1;
            if (state.input === 'activity-a' && state.closeCalls === 1) {
              state.active = false;
              state.rejectRun?.(new Error('activity A close refused'));
              throw new Error('activity A close refused');
            }
            if (state.input === 'activity-a' && state.closeCalls === 2) {
              await new Promise<void>((resolve) => {
                state.resolveClose = () => {
                  state.closed = true;
                  resolve();
                };
              });
              state.active = false;
              return;
            }
            state.active = false;
            state.closed = true;
          },
        } satisfies DshHarness;
      },
    });
    const service = createIntelligenceRuntime(provider);
    const events: ActivityEvent[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };

    const activityA = service.submit({ input: 'activity-a' });
    const activityB = service.submit({ input: 'activity-b' });
    expect(activityA.ok).toBe(true);
    expect(activityB.ok).toBe(true);
    if (!activityA.ok || !activityB.ok) {
      throw new Error('expected both activities to be accepted');
    }

    await turn();
    expect(harnesses).toHaveLength(2);
    expect(harnesses[0]).toMatchObject({ active: true, closeCalls: 0 });
    expect(harnesses[1]).toMatchObject({ active: true, closeCalls: 0 });

    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const cancelled = service.cancel(activityA.value.id);
      expect(cancelled.ok).toBe(true);

      expect(harnesses[1]).toMatchObject({ active: true, closeCalls: 0 });
      harnesses[1]?.resolveRun?.();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        events.push(...service.poll());
        if (
          events.some(
            (event) => event.activityId === activityB.value.id && event.type === 'completed',
          )
        ) {
          break;
        }
        await turn();
      }

      let providerClosed = false;
      const providerCloseTask = provider.close().then(() => {
        providerClosed = true;
      });
      await turn();
      expect(providerClosed).toBe(false);
      harnesses[0]?.resolveClose?.();
      await providerCloseTask;
      events.push(...service.poll());
      await provider.close();
      await service.close();
      await service.close();
      await turn();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    const activityATerminals = events.filter(
      (event) =>
        event.activityId === activityA.value.id &&
        (event.type === 'cancelled' || event.type === 'completed' || event.type === 'failed'),
    );
    const activityBTerminals = events.filter(
      (event) =>
        event.activityId === activityB.value.id &&
        (event.type === 'cancelled' || event.type === 'completed' || event.type === 'failed'),
    );

    expect(activityATerminals).toHaveLength(1);
    expect(activityATerminals[0]?.type).toBe('cancelled');
    expect(activityBTerminals).toEqual([
      expect.objectContaining({
        activityId: activityB.value.id,
        type: 'completed',
        output: 'activity-b-complete',
      }),
    ]);
    expect(unhandledRejections).toEqual([]);
    expect(harnesses).toHaveLength(2);
    expect(harnesses[0]).toMatchObject({
      closeCalls: 2,
      closed: true,
      active: false,
    });
    expect(harnesses[1]).toMatchObject({
      closeCalls: 1,
      closed: true,
      active: false,
    });
  });
});
