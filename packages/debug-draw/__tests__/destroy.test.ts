// @forgeax/engine-debug-draw -- destroy lifecycle unit tests (w7 + w8)
//
// Tests for:
// - w7: destroy-then-flush returns Result.err with code 'flushed-after-destroy'
// - w8: destroy-then-shape no-op + single warn + staging unchanged + flush still err

import { describe, expect, it, vi } from 'vitest';
import { DebugDraw, DebugDrawErrorCode, INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY } from '../src';

function makeMockDevice() {
  return {
    destroyBuffer: vi.fn(),
    queue: { writeBuffer: vi.fn() },
  } as any;
}

function makeDd(initialCap = INITIAL_VERTEX_CAPACITY) {
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

describe('w7: destroy-then-flush returns Result.err (AC-10)', () => {
  it('flush after destroy returns Result.err with code flushed-after-destroy', () => {
    const dd = makeDd();
    dd.destroy();

    const flushResult = dd.flush(
      {} as any,
      {} as any,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as any,
    );

    expect(flushResult.ok).toBe(false);
    if (!flushResult.ok) {
      const code: DebugDrawErrorCode = flushResult.error.code;
      expect(code).toBe('flushed-after-destroy');
      expect(flushResult.error.hint.length).toBeGreaterThan(0);
    }
  });

  it('flush after destroy does not throw native exception', () => {
    const dd = makeDd();
    dd.destroy();

    expect(() => {
      dd.flush(
        {} as any,
        {} as any,
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as any,
      );
    }).not.toThrow();
  });
});

describe('w8: destroy-then-shape no-op + single warn (AC-11)', () => {
  it('shape calls after destroy do not throw', () => {
    const dd = makeDd();
    dd.destroy();

    expect(() => dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1])).not.toThrow();
    expect(() => dd.sphere([0, 0, 0], 1, [0, 1, 0, 1])).not.toThrow();
    expect(() => dd.aabb([0, 0, 0], [1, 1, 1], [0, 0, 1, 1])).not.toThrow();
    expect(() => dd.frustum([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as any, [1, 1, 0, 1])).not.toThrow();
  });

  it('staging length unchanged after N shape calls post-destroy', () => {
    const dd = makeDd();
    dd.destroy();
    const countBefore = dd._stagingVertexCount;

    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);

    expect(dd._stagingVertexCount).toBe(countBefore);
  });

  it('console.warn captured exactly once across multiple shape calls post-destroy', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dd = makeDd();
    dd.destroy();

    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
    dd.sphere([0, 0, 0], 1, [0, 1, 0, 1]);
    dd.aabb([0, 0, 0], [1, 1, 1], [0, 0, 1, 1]);
    dd.frustum([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as any, [1, 1, 0, 1]);

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('flush after destroy still returns err even after shape calls', () => {
    const dd = makeDd();
    dd.destroy();
    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);

    const flushResult = dd.flush(
      {} as any,
      {} as any,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as any,
    );

    expect(flushResult.ok).toBe(false);
    if (!flushResult.ok) {
      expect(flushResult.error.code).toBe('flushed-after-destroy');
    }
  });
});