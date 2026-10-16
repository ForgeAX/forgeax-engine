import {
  createIntelligenceRuntime,
  type IntelligenceService,
  intelligencePlugin,
  type SessionRef,
} from '@forgeax/engine-intelligence';
import { Context } from '@forgeax/engine-plugin';
import { describe, expect, it } from 'vitest';
import { createFakeIntelligenceProvider } from '../index';

interface DialogueView {
  text: string;
  state: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  session?: SessionRef;
}

function updateDialogue(intelligence: IntelligenceService, view: DialogueView): void {
  for (const event of intelligence.poll()) {
    if (event.type === 'text-delta') view.text += event.text;
    else if (event.type === 'completed') {
      view.state = 'completed';
      view.session = event.session;
    } else if (event.type === 'failed') view.state = 'failed';
    else view.state = 'cancelled';
  }
}

describe('deterministic intelligence provider', () => {
  it('drives a stateful NPC dialogue consumer for 300 frames without async frame work', () => {
    const provider = createFakeIntelligenceProvider({
      script: () => ({ deltas: ['Hello', ', ', 'traveler.'], output: 'Hello, traveler.' }),
    });
    const intelligence = createIntelligenceRuntime(provider, {
      createSessionId: () => 'npc-session',
    });
    const view: DialogueView = { text: '', state: 'running' };
    const started = intelligence.submit({ input: 'Talk to the gatekeeper' });
    if (!started.ok) throw started.error;

    for (let frame = 0; frame < 300; frame += 1) {
      provider.advance();
      expect(updateDialogue(intelligence, view)).toBeUndefined();
    }

    expect(view).toEqual({
      text: 'Hello, traveler.',
      state: 'completed',
      session: { providerId: 'forgeax.fake', id: 'npc-session' },
    });
  });

  it('resumes only the opaque SessionRef and supports cancellation', () => {
    const provider = createFakeIntelligenceProvider();
    const intelligence = createIntelligenceRuntime(provider, {
      createSessionId: () => 'persistent-session',
    });
    const first = intelligence.submit({ input: 'first' });
    if (!first.ok) throw first.error;
    expect(intelligence.cancel(first.value.id).ok).toBe(true);
    expect(intelligence.poll()[0]?.type).toBe('cancelled');

    const resumed = intelligence.submit({ input: 'second', session: first.value.session });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.value.session).toEqual(first.value.session);
  });

  it('binds provider disposal to the Cordis Fiber', async () => {
    const provider = createFakeIntelligenceProvider();
    const intelligence = createIntelligenceRuntime(provider);
    const ctx = new Context();
    await ctx.plugin(intelligencePlugin(intelligence));
    expect(ctx.intelligence).toBe(intelligence);
    await ctx.fiber.dispose();
    expect(provider.closed).toBe(true);
  });
});
