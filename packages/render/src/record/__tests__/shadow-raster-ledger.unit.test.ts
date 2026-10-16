import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import type { ShadowViewIdentity } from '../../inspection-types';
import { ShadowRasterLedger } from '../shadow-raster-ledger';

function fakePass(): RhiRenderPassEncoder {
  return {
    draw: vi.fn(),
    drawIndexed: vi.fn(),
    drawIndirect: vi.fn(),
    drawIndexedIndirect: vi.fn(),
    setPipeline: vi.fn(),
  } as unknown as RhiRenderPassEncoder;
}

const directional: ShadowViewIdentity = Object.freeze({ kind: 'directional', index: 0 });
const spot: ShadowViewIdentity = Object.freeze({ kind: 'spot', index: 1 });

describe('ShadowRasterLedger', () => {
  it('publishes per-view decisions and draw counts only after commit', () => {
    const ledger = new ShadowRasterLedger();
    expect(ledger.inspect()).toEqual({ passCount: 0, drawCount: 0, views: [] });

    ledger.begin();
    const missSlot = ledger.evaluate(directional, 'view-changed');
    const hitSlot = ledger.evaluate(spot, undefined);
    const pass = fakePass();
    ledger.encode(missSlot, pass, (counted) => {
      counted.setPipeline({} as never);
      counted.draw(3);
      counted.drawIndexedIndirect({} as never, 0);
    });
    ledger.encode(hitSlot, pass, () => {});
    expect(pass.draw).toHaveBeenCalledWith(3, undefined, undefined, undefined);
    expect(pass.drawIndexedIndirect).toHaveBeenCalledTimes(1);
    expect(ledger.inspect().views).toEqual([]);

    ledger.commit();
    const first = ledger.inspect();
    expect(first).toEqual({
      passCount: 1,
      drawCount: 2,
      views: [
        {
          identity: directional,
          cache: 'miss',
          invalidationReason: 'view-changed',
          drawCount: 2,
          statistics: {
            decisions: 1,
            hits: 0,
            rebuilds: 1,
            drawCount: 2,
            invalidations: { 'view-changed': 1 },
          },
        },
        {
          identity: spot,
          cache: 'hit',
          drawCount: 0,
          statistics: { decisions: 1, hits: 1, rebuilds: 0, drawCount: 0, invalidations: {} },
        },
      ],
    });
    expect(ledger.inspect()).toBe(first);
    expect(Object.isFrozen(first.views)).toBe(true);

    ledger.begin();
    ledger.evaluate(directional, undefined);
    expect(ledger.inspect()).toBe(first);
    ledger.commit();
    expect(first.views[0]?.statistics.decisions).toBe(1);
    expect(ledger.inspect()).toEqual({
      passCount: 0,
      drawCount: 0,
      views: [
        {
          identity: directional,
          cache: 'hit',
          drawCount: 0,
          statistics: {
            decisions: 2,
            hits: 1,
            rebuilds: 1,
            drawCount: 2,
            invalidations: { 'view-changed': 1 },
          },
        },
      ],
    });
  });

  it('keeps the last submitted frame when a staged frame is abandoned', () => {
    const ledger = new ShadowRasterLedger();
    ledger.begin();
    ledger.evaluate(spot, 'first-publication');
    ledger.commit();
    const submitted = ledger.inspect();

    ledger.begin();
    ledger.evaluate(directional, 'content-changed');
    ledger.begin();
    expect(ledger.inspect()).toBe(submitted);
    expect(submitted.views[0]).toMatchObject({
      cache: 'miss',
      invalidationReason: 'first-publication',
      statistics: { decisions: 1, hits: 0, rebuilds: 1, invalidations: { 'first-publication': 1 } },
    });
    ledger.evaluate(spot, undefined);
    ledger.commit();
    expect(ledger.inspect().views[0]?.statistics).toMatchObject({
      decisions: 2,
      hits: 1,
      rebuilds: 1,
    });
  });
});
