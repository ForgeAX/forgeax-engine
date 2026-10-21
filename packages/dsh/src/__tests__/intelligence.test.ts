import { createIntelligenceRuntime } from '@forgeax/engine-intelligence';
import { describe, expect, it, vi } from 'vitest';

import type { DshRealmConnection } from '../engine-host';
import { createDshRealmIntelligenceProvider } from '../intelligence';

describe('AI Native federation consumer', () => {
  it('projects DSH output through the provider-neutral Activity contract', async () => {
    const activity = vi.fn(async (input: string, sessionId: string) => ({
      output: `DSH:${sessionId}:${input}`,
    }));
    const runtime = createIntelligenceRuntime(
      createDshRealmIntelligenceProvider({ activity } as unknown as DshRealmConnection),
      { createSessionId: () => 'session-1' },
    );

    const submitted = runtime.submit({ input: 'hello' });
    expect(submitted.ok).toBe(true);
    await vi.waitFor(() =>
      expect(runtime.poll()).toEqual([
        expect.objectContaining({ type: 'text-delta', text: 'DSH:session-1:hello' }),
        expect.objectContaining({ type: 'completed', output: 'DSH:session-1:hello' }),
      ]),
    );
    expect(activity).toHaveBeenCalledWith('hello', 'session-1', expect.any(AbortSignal));
    await runtime.close();
  });
});

it('keeps concurrent close calls pending until the Activity has retired', async () => {
  let finish!: (value: { output: string }) => void;
  const activity = () =>
    new Promise<{ output: string }>((resolve) => {
      finish = resolve;
    });
  const provider = createDshRealmIntelligenceProvider({
    activity,
  } as unknown as DshRealmConnection);
  const runtime = createIntelligenceRuntime(provider);
  runtime.submit({ input: 'pending' });
  await Promise.resolve();
  const first = provider.close();
  let secondDone = false;
  const second = provider.close().then(() => {
    secondDone = true;
  });
  await Promise.resolve();
  expect(secondDone).toBe(false);
  finish({ output: 'late' });
  await Promise.all([first, second]);
  expect(runtime.poll().map((event) => event.type)).toEqual(['cancelled']);
  await runtime.close();
});
