// @forgeax/engine-debug-draw -- flush unit tests (w11)
//
// Tests for:
// - w11: flush on empty staging skips GPU pass (requirements sec 8)

import { describe, expect, it, vi } from 'vitest';
import { DebugDraw, MAX_VERTEX_CAPACITY } from '../src';

function makeMockDevice() {
  return {
    destroyBuffer: vi.fn(),
    queue: { writeBuffer: vi.fn() },
  } as any;
}

function makeDd(initialCap = 1024) {
  const device = makeMockDevice();
  return new DebugDraw(
    device,
    {} as any, // pipeline
    {} as any, // vbo
    {} as any, // uniformBuf
    {} as any, // bindGroup
    initialCap,
    MAX_VERTEX_CAPACITY,
  );
}

describe('w11: flush on empty staging skips GPU pass', () => {
  it('staging.length is 0 after construction', () => {
    const dd = makeDd();
    expect(dd._stagingVertexCount).toBe(0);
    expect(dd.hasWork()).toBe(false);
  });

  it('publishes frame work until the staged vertices are encoded', () => {
    const dd = makeDd();
    dd.line([0, 0, 0] as any, [1, 0, 0] as any, [1, 1, 1, 1]);
    expect(dd.hasWork()).toBe(true);

    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
    };
    const encoded = dd.encode(
      pass as any,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as any,
    );

    expect(encoded.ok).toBe(true);
    expect(pass.draw).toHaveBeenCalledWith(2);
    expect(dd.hasWork()).toBe(false);
  });

  it('flush on empty staging returns Result.ok and does not draw', () => {
    const dd = makeDd();
    const flushResult = dd.flush(
      {} as any,
      {} as any,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as any,
    );

    expect(flushResult.ok).toBe(true);
    expect(dd._stagingVertexCount).toBe(0);
  });

  it('flush with viewProj undefined returns viewProj-required', () => {
    const dd = makeDd();
    const flushResult = dd.flush(
      {} as any,
      {} as any,
      undefined as any,
    );

    expect(flushResult.ok).toBe(false);
    if (!flushResult.ok) {
      expect(flushResult.error.code).toBe('viewProj-required');
    }
  });
});
