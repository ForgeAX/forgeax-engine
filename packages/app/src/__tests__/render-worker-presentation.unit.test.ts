import { describe, expect, it, vi } from 'vitest';
import { RenderWorkerPresentation } from '../execution/render-worker-presentation';

function fixture() {
  let nativeTurn: FrameRequestCallback | undefined;
  const clock = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      nativeTurn = callback;
      return 2;
    }),
    cancelAnimationFrame: vi.fn(),
  };
  const owner = new RenderWorkerPresentation(clock);
  owner.setVisible(true);
  return { owner, clock, tick: () => nativeTurn?.(40) };
}

describe('browser Render Worker presentation', () => {
  it('runs one pending draw in its native callback', async () => {
    const { owner, tick } = fixture();
    const draw = vi.fn(() => 'receipt');
    const result = owner.run(draw);
    expect(owner.waiting).toBe(true);
    expect(draw).not.toHaveBeenCalled();
    tick();
    expect(owner.waiting).toBe(false);
    tick();
    await expect(result).resolves.toBe('receipt');
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('drains an admitted draw when hidden and ignores the cancelled callback', async () => {
    const { owner, clock, tick } = fixture();
    const draw = vi.fn(() => 'receipt');
    const result = owner.run(draw);
    owner.setVisible(false);
    await expect(result).resolves.toBe('receipt');
    expect(clock.cancelAnimationFrame).toHaveBeenCalledWith(2);
    tick();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(owner.run(draw)).toBe('receipt');
  });

  it('settles shutdown before the browser supplies a callback', async () => {
    const { owner, tick } = fixture();
    const draw = vi.fn();
    const result = owner.run(draw);
    owner.stop();
    tick();
    await expect(result).resolves.toBeUndefined();
    expect(owner.run(draw)).toBeUndefined();
    expect(draw).not.toHaveBeenCalled();
  });

  it('keeps the message-driven path when the browser has no native provider', async () => {
    const { owner, clock } = fixture();
    clock.requestAnimationFrame.mockImplementationOnce(() => {
      throw new DOMException('No native display provider', 'NotSupportedError');
    });
    const draw = vi.fn(() => 'receipt');
    await expect(owner.run(draw)).resolves.toBe('receipt');
    expect(owner.run(draw)).toBe('receipt');
    expect(clock.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
