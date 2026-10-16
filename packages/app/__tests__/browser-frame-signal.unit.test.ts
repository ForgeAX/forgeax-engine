import { describe, expect, it } from 'vitest';
import { publishBrowserFrameSubmitted } from '../src/browser-frame-signal';

describe('browser frame signal', () => {
  it('does not require a DOM EventTarget on Dawn-node smoke canvases', () => {
    const canvas = { ownerDocument: undefined } as unknown as HTMLCanvasElement;

    expect(() =>
      publishBrowserFrameSubmitted(canvas, { frameId: 1, deviceGeneration: 0 }),
    ).not.toThrow();
  });
});
