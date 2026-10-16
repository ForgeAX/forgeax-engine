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
