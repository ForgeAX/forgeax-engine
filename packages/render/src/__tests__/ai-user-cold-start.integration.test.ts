import { describe, expect, it, vi } from 'vitest';
import type {
  FrameReceipt,
  RenderError,
  Renderer,
  RenderFrameInput,
  RenderInspection,
} from '../index';
import { FogCardinalityError } from '../index';

type PublicRenderer = Pick<Renderer, 'draw' | 'inspect'>;

function drawWithStructuredRetry(
  renderer: PublicRenderer,
  request: RenderFrameInput,
): FrameReceipt {
  const first = renderer.draw(request);
  if (first.ok) return first.value;

  const error: RenderError = first.error;
  renderer.inspect();
  if (error.code === 'environment-source-conflict') {
    expect(error.detail.owners.length).toBeGreaterThan(1);
  } else if (error.code === 'fog-cardinality') {
    expect(error.detail.count).toBeGreaterThan(1);
  } else {
    expect(error.hint).toBeTruthy();
  }
  const retry = renderer.draw(request);
  if (!retry.ok) throw new Error(retry.error.hint);
  return retry.value;
}

describe('public render cold-start recovery route', () => {
  it('uses one public draw request, inspect, structured detail, and same-request retry', () => {
    const request = {} as RenderFrameInput;
    const receipt = {
      frameId: 3,
      deviceGeneration: 1,
      completed: Promise.resolve({ ok: true, value: undefined }),
    } as FrameReceipt;
    const failure: {
      readonly ok: false;
      readonly error: Extract<RenderError, { readonly code: 'fog-cardinality' }>;
    } = {
      ok: false as const,
      error: new FogCardinalityError(2),
    };
    const renderer = {
      draw: vi.fn().mockReturnValueOnce(failure).mockReturnValueOnce({ ok: true, value: receipt }),
      inspect: vi.fn(() => ({ state: 'alive' }) as unknown as RenderInspection),
    } as unknown as PublicRenderer;

    expect(drawWithStructuredRetry(renderer, request)).toBe(receipt);
    expect(renderer.draw).toHaveBeenNthCalledWith(1, request);
    expect(renderer.draw).toHaveBeenNthCalledWith(2, request);
    expect(renderer.inspect).toHaveBeenCalledOnce();
  });
});
