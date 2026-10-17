import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RendererHostImplementation } from '../assembly/host-contract';
import { exposeRenderer } from '../assembly/renderer-facade';
import { RendererContractFailureError } from '../errors/render';
import type { PublishedRenderFrameInput } from '../publication/contract';
import type { FrameReceipt, RenderFrameInput } from '../render-contract';

const receipt: FrameReceipt = {
  frameId: 1,
  deviceGeneration: 0,
  presentation: 'ready',
  completed: Promise.resolve(ok(undefined)),
};
function fixture() {
  let rawDisposed = false;
  const legacyWorldDraw = vi.fn(() =>
    rawDisposed
      ? err(new RendererContractFailureError('draw', 'the renderer is still alive'))
      : ok(receipt),
  );
  const host = {
    inspect: () => ({ state: 'alive' }),
    subscribeHostEvents: () => () => undefined,
    drawFrame: vi.fn(() => legacyWorldDraw()),
    dispose: vi.fn(() => {
      rawDisposed = true;
      return ok(undefined);
    }),
  };
  const renderer = exposeRenderer(host as unknown as RendererHostImplementation);
  return { renderer, host, legacyWorldDraw };
}
const worldInput = { leases: [], camera: null, environment: null } as RenderFrameInput;
const publicationInput = { publication: {} } as PublishedRenderFrameInput;

it.each([
  ['publication', publicationInput],
  ['World lease', worldInput],
] as const)('closes %s admission in the same stack as idle disposal', async (_name, input) => {
  const f = fixture();
  const disposal = f.renderer.dispose();
  try {
    expect(f.renderer.draw(input).ok).toBe(false);
    expect(f.host.drawFrame).not.toHaveBeenCalled();
    expect(f.host.dispose).toHaveBeenCalledOnce();
    // Legacy World[] clients bypass the facade; their existing raw latch must
    // already be closed, too, without waiting for a Promise microtask.
    expect(f.legacyWorldDraw().ok).toBe(false);
  } finally {
    expect((await disposal).ok).toBe(true);
  }
});

it('waits only for an already-admitted synchronous World draw before reentrant disposal', async () => {
  const f = fixture();
  let disposal: ReturnType<typeof f.renderer.dispose> | undefined;
  const order: string[] = [];
  f.host.drawFrame.mockImplementation(() => {
    order.push('draw-enter');
    disposal = f.renderer.dispose();
    expect(f.host.dispose).not.toHaveBeenCalled();
    expect(f.renderer.draw(worldInput).ok).toBe(false);
    order.push('draw-leave');
    return ok(receipt);
  });
  expect(f.renderer.draw(worldInput).ok).toBe(true);
  expect(f.host.drawFrame).toHaveBeenCalledOnce();
  expect(disposal).toBeDefined();
  expect((await disposal)?.ok).toBe(true);
  expect(order).toEqual(['draw-enter', 'draw-leave']);
  expect(f.host.dispose).toHaveBeenCalledOnce();
  expect(f.legacyWorldDraw().ok).toBe(false);
});
