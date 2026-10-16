// @forgeax/engine-debug-draw -- capacity unit tests (w9 + w10)
//
// Tests for:
// - w9: capacity resize triggers warn + doubles buffer (AC-08)
// - w10: hard-capacity truncate + warn (AC-09)

import { describe, expect, it, vi } from 'vitest';
import { createDebugDraw, DebugDraw, INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY } from '../src';

function makeMockDevice() {
  // createBuffer returns a fresh Result.ok buffer each call so ensureCapacity's
  // GPU vbo realloc (Bug B fix) can grow the buffer alongside the CPU staging.
  let bufSeq = 0;
  return {
    createBuffer: vi.fn(() => {
      bufSeq += 1;
      return { ok: true, value: { __mockBuffer: bufSeq } };
    }),
    destroyBuffer: vi.fn(),
    queue: { writeBuffer: vi.fn() },
  } as any;
}

function makeDd(initialCap = INITIAL_VERTEX_CAPACITY, maxCap = MAX_VERTEX_CAPACITY) {
  const device = makeMockDevice();
  const dd = new DebugDraw(
    device,
    {} as any, // pipeline
    {} as any, // vbo
    {} as any, // uniformBuf
    {} as any, // bindGroup
    initialCap,
    maxCap,
  );
  return { dd, device };
}

function makeEncoder(drawCounts: number[]) {
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    draw: vi.fn((vertexCount: number) => drawCounts.push(vertexCount)),
    end: vi.fn(),
  };
  return {
    beginRenderPass: vi.fn(() => pass),
  } as any;
}

const IDENTITY_VIEW_PROJ = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as any;

describe('w9: capacity resize triggers warn + doubles buffer (AC-08)', () => {
  it('INITIAL_VERTEX_CAPACITY is imported and matches constant', () => {
    expect(INITIAL_VERTEX_CAPACITY).toBe(1024);
  });

  it('buffer capacity doubles to 2048 when exceeding INITIAL_VERTEX_CAPACITY', () => {
    const { dd, device } = makeDd();

    // Push exactly INITIAL_VERTEX_CAPACITY vertices (512 lines of 2 vertices each)
    for (let i = 0; i < INITIAL_VERTEX_CAPACITY / 2; i++) {
      dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
    }

    expect(dd._stagingVertexCount).toBe(INITIAL_VERTEX_CAPACITY);

    // One more line (2 vertices) should trigger resize
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);

    expect(dd._capacity).toBe(INITIAL_VERTEX_CAPACITY * 2); // 2048
    expect(dd._stagingVertexCount).toBe(INITIAL_VERTEX_CAPACITY + 2);
    expect(warnSpy).toHaveBeenCalled();

    // Bug B regression (feat-20260626 m6-4): the GPU vertex buffer must be
    // reallocated at the new size on growth (not only the CPU staging), or
    // flush() binds a buffer too small for the staged vertex count and the
    // backend rejects the draw. The realloc creates a new buffer + destroys the
    // old one.
    expect(device.createBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ size: INITIAL_VERTEX_CAPACITY * 2 * 16, usage: 8 | 32 }),
    );
    expect(device.destroyBuffer).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe('w10: hard-capacity truncate + warn (AC-09)', () => {
  it('MAX_VERTEX_CAPACITY is imported and matches constant', () => {
    expect(MAX_VERTEX_CAPACITY).toBe(1_000_000);
  });

  it('vertices are capped at MAX_VERTEX_CAPACITY; excess discarded with warning', () => {
    // Create with capacity = MAX to test truncation at the hard cap
    const { dd } = makeDd(MAX_VERTEX_CAPACITY);

    // Fill staging to MAX_VERTEX_CAPACITY
    for (let i = 0; i < MAX_VERTEX_CAPACITY / 2; i++) {
      dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
    }

    // Try to add more vertices
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);

    // Staging should be capped at MAX
    expect(dd._stagingVertexCount).toBeLessThanOrEqual(MAX_VERTEX_CAPACITY);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('warns once per overflowing frame and starts the next frame empty', () => {
    const { dd, device } = makeDd(10, 10);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstFrameDraws: number[] = [];

    for (let i = 0; i < 5; i++) {
      dd.line([0, 0, 0], [1, 0, 0], [1, 0, 0, 1]);
    }
    dd.line([0, 1, 0], [1, 1, 0], [1, 0, 0, 1]);
    dd.aabb([-1, -1, -1], [1, 1, 1], [0, 1, 0, 1]);

    expect(dd._stagingVertexCount).toBe(10);
    expect(dd._getVertexPosition(0)).toEqual([0, 0, 0]);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const firstFlush = dd.flush(makeEncoder(firstFrameDraws), {} as any, IDENTITY_VIEW_PROJ);
    expect(firstFlush.ok).toBe(true);
    expect(firstFrameDraws).toEqual([10]);
    expect(firstFrameDraws[0]).toBeLessThanOrEqual(10);
    expect(dd._stagingVertexCount).toBe(0);

    const secondFrameDraws: number[] = [];
    dd.line([0, 0, 2], [1, 0, 2], [0, 0, 1, 1]);
    const secondFlush = dd.flush(makeEncoder(secondFrameDraws), {} as any, IDENTITY_VIEW_PROJ);
    expect(secondFlush.ok).toBe(true);
    expect(secondFrameDraws).toEqual([2]);
    expect(dd._stagingVertexCount).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    dd.destroy();
    dd.destroy();
    expect(device.destroyBuffer).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('does not allocate an initial GPU buffer above the configured hard cap', async () => {
    const device = {
      createBuffer: vi.fn(() => ({ ok: true, value: { __mockBuffer: 1 } })),
      destroyBuffer: vi.fn(),
      createBindGroupLayout: vi.fn(() => ({ ok: true, value: {} })),
      createPipelineLayout: vi.fn(() => ({ ok: true, value: {} })),
      createRenderPipeline: vi.fn(() => ({ ok: true, value: {} })),
      createBindGroup: vi.fn(() => ({ ok: true, value: {} })),
      queue: { writeBuffer: vi.fn() },
    } as any;
    const result = await createDebugDraw({
      device,
      queue: device.queue,
      createShaderModule: vi.fn(async () => ({ ok: true, value: {} })) as any,
      initialVertexCapacity: 1024,
      maxVertexCapacity: 10,
    });

    expect(result.ok).toBe(true);
    expect(device.createBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ size: 10 * 16 }),
    );
    if (result.ok) {
      expect(result.value._capacity).toBe(10);
      result.value.destroy();
    }
  });
});
