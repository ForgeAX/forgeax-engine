import type { FrameReceipt } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

import {
  FORGEAX_FRAME_COMPLETED_EVENT,
  FORGEAX_FRAME_SUBMITTED_EVENT,
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
  resetBrowserFrameProgress,
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

  it('keeps documentElement attributes unchanged while dispatching frame progress', () => {
    const canvas = document.createElement('canvas');
    const received: Event[] = [];
    const rootMutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => rootMutations.push(...records));
    observer.observe(document.documentElement, { attributes: true });
    canvas.addEventListener(FORGEAX_FRAME_SUBMITTED_EVENT, (event) => received.push(event));
    canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, (event) => received.push(event));

    publishBrowserFrameSubmitted(canvas, { frameId: 12, deviceGeneration: 4 });
    publishBrowserFrameCompleted(canvas, {
      frameId: 12,
      deviceGeneration: 4,
      presentation: 'ready',
    });
    resetBrowserFrameProgress(canvas);
    expect(canvas.forgeaxFrameProgress).toBeUndefined();

    rootMutations.push(...observer.takeRecords());
    observer.disconnect();

    expect(rootMutations).toHaveLength(0);
    expect(received.map((event) => event.type)).toEqual([
      FORGEAX_FRAME_SUBMITTED_EVENT,
      FORGEAX_FRAME_COMPLETED_EVENT,
    ]);
  });
});
