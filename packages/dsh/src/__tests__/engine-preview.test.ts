import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';

import { enginePreviewPlugin } from '../engine-preview';
import { FEDERATION_PROTOCOL_VERSION } from '../protocol';

describe('DSH to Engine preview effect', () => {
  it('adds and removes the tick/message contributions as one Fiber scope', async () => {
    const windowTarget = new EventTarget();
    const postMessage = vi.fn();
    const world = new World();
    const context = await createWorldContext(world, [
      enginePreviewPlugin({ window: windowTarget as unknown as Window }),
    ]);
    world.update(1 / 60).unwrap();

    windowTarget.dispatchEvent(
      messageEvent(
        { protocol: FEDERATION_PROTOCOL_VERSION, kind: 'forgeax-engine-poll' },
        { postMessage },
      ),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ready: true, frameId: 1, tick: 1 }),
      { targetOrigin: 'http://dsh.local' },
    );

    windowTarget.dispatchEvent(
      messageEvent(
        {
          protocol: FEDERATION_PROTOCOL_VERSION,
          kind: 'forgeax-engine-control',
          action: 'toggle',
        },
        { postMessage },
      ),
    );
    await Promise.resolve();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ state: 1 }), {
      targetOrigin: 'http://dsh.local',
    });

    await context.fiber.dispose();
    expect(
      world.inspect().systems.some((system) => system.name === 'dsh-engine-preview-tick'),
    ).toBe(false);
    const calls = postMessage.mock.calls.length;
    windowTarget.dispatchEvent(
      messageEvent(
        { protocol: FEDERATION_PROTOCOL_VERSION, kind: 'forgeax-engine-poll' },
        { postMessage },
      ),
    );
    expect(postMessage).toHaveBeenCalledTimes(calls);
  });
});

function messageEvent(data: unknown, source: { postMessage: ReturnType<typeof vi.fn> }): Event {
  const event = new Event('message');
  Object.defineProperties(event, {
    data: { value: data },
    origin: { value: 'http://dsh.local' },
    source: { value: source },
  });
  return event;
}
