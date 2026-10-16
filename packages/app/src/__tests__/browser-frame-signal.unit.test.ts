import type { FrameReceipt } from '@forgeax/engine-render';
import { createBarrelDistortionMapping } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

import {
  FORGEAX_FRAME_SUBMITTED_EVENT,
  publishBrowserFrameSubmitted,
  readBrowserFrameSubmitted,
  resetBrowserFrameSubmitted,
  subscribeBrowserFrameSubmitted,
} from '../browser-frame-signal';

describe('publishBrowserFrameSubmitted', () => {
  it('keeps the current baseline internal and preserves future-only subscriptions', () => {
    const canvas = new EventTarget() as HTMLCanvasElement;
    publishBrowserFrameSubmitted(canvas, { frameId: 1, deviceGeneration: 1, worldIdentity: 'old' });
    const received: unknown[] = [];
    const stop = subscribeBrowserFrameSubmitted(canvas, (value) => received.push(value));
    expect(received).toHaveLength(0);
    expect(readBrowserFrameSubmitted(canvas)?.worldIdentity).toBe('old');
    resetBrowserFrameSubmitted(canvas);
    expect(readBrowserFrameSubmitted(canvas)).toBeUndefined();
    publishBrowserFrameSubmitted(canvas, { frameId: 2, deviceGeneration: 2, worldIdentity: 'new' });
    expect(readBrowserFrameSubmitted(canvas)?.worldIdentity).toBe('new');
    expect(received).toHaveLength(1);
    stop();
  });
  const receipt = {
    frameId: 9,
    deviceGeneration: 3,
    completed: Promise.resolve({ ok: true as const, value: undefined }),
  } as FrameReceipt;

  it('projects Dawn canvas progress without requiring DOM event methods', () => {
    const documentElement = { dataset: {} as DOMStringMap };
    const canvas = { ownerDocument: { documentElement } } as HTMLCanvasElement;

    const submitted = Object.assign({ frameId: 7, deviceGeneration: 2 }, { receipt });
    expect(() => publishBrowserFrameSubmitted(canvas, submitted)).not.toThrow();
    expect(documentElement.dataset.forgeaxFrameSubmitted).toBe('7');
  });

  it('dispatches the browser event when the canvas supports dispatchEvent', () => {
    let dispatchedEvent: Event | undefined;
    const dispatchEvent = (event: Event): boolean => {
      dispatchedEvent = event;
      return true;
    };
    const canvas = { dispatchEvent } as unknown as HTMLCanvasElement;

    const submitted = Object.assign({ frameId: 9, deviceGeneration: 3 }, { receipt });
    publishBrowserFrameSubmitted(canvas, submitted);

    expect(dispatchedEvent).toBeInstanceOf(CustomEvent);
    if (!(dispatchedEvent instanceof CustomEvent))
      throw new Error('frame event was not dispatched');
    expect(dispatchedEvent.type).toBe(FORGEAX_FRAME_SUBMITTED_EVENT);
    expect(dispatchedEvent.detail).toEqual({ frameId: 9, deviceGeneration: 3, receipt });
    expect(dispatchedEvent.detail.receipt).toBe(receipt);
  });

  it('deep-freezes the serialized mapping and removes subscriptions cleanly', () => {
    const listeners: EventListener[] = [];
    const canvas = {
      addEventListener: (_type: string, listener: EventListener) => listeners.push(listener),
      removeEventListener: (_type: string, listener: EventListener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      dispatchEvent: (event: Event) => {
        for (const listener of [...listeners]) listener(event);
        return true;
      },
    } as unknown as HTMLCanvasElement;
    const base = createBarrelDistortionMapping(320, 180, { strength: 0.2 }).unwrap();
    const source = {
      ...base,
      camera: {
        projection: 'perspective' as const,
        far: 100,
        viewMatrix: new Float32Array(16).fill(1),
        projectionMatrix: new Float32Array(16).fill(2),
      },
    };
    const received: import('../browser-frame-signal').BrowserFrameSubmitted[] = [];
    const unsubscribe = subscribeBrowserFrameSubmitted(canvas, (event) => received.push(event));
    publishBrowserFrameSubmitted(canvas, {
      frameId: 10,
      deviceGeneration: 4,
      graphGeneration: 8,
      barrelDistortion: source,
    });

    expect(received).toHaveLength(1);
    const mapping = received[0]?.barrelDistortion;
    expect(mapping).toBeDefined();
    expect(Object.isFrozen(mapping)).toBe(true);
    expect(Object.isFrozen(mapping?.camera)).toBe(true);
    expect(Object.isFrozen(mapping?.camera?.viewMatrix)).toBe(true);
    source.camera.viewMatrix[0] = 9;
    expect(mapping?.camera?.viewMatrix[0]).toBe(1);

    unsubscribe();
    publishBrowserFrameSubmitted(canvas, {
      frameId: 11,
      deviceGeneration: 4,
      graphGeneration: 8,
    });
    expect(received).toHaveLength(1);
  });
});
