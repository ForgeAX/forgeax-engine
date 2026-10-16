import type { FrameReceipt } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

import {
  FORGEAX_FRAME_SUBMITTED_EVENT,
  publishBrowserFrameSubmitted,
} from '../browser-frame-signal';

describe('publishBrowserFrameSubmitted in a browser', () => {
  it('dispatches frame-submitted on a real HTMLCanvasElement', () => {
    const canvas = document.createElement('canvas');
    const received: Event[] = [];
    const receipt = {
      frameId: 11,
      deviceGeneration: 4,
      completed: Promise.resolve({ ok: true as const, value: undefined }),
    } as FrameReceipt;
    canvas.addEventListener(FORGEAX_FRAME_SUBMITTED_EVENT, (event) => received.push(event));

    const submitted = Object.assign({ frameId: 11, deviceGeneration: 4 }, { receipt });
    publishBrowserFrameSubmitted(canvas, submitted);

    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(CustomEvent);
    expect((received[0] as CustomEvent).detail).toEqual({
      frameId: 11,
      deviceGeneration: 4,
      receipt,
    });
    expect((received[0] as CustomEvent).detail.receipt).toBe(receipt);
  });
});
