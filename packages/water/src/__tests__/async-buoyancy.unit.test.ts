import type { PhysicsSolverOutput } from '@forgeax/engine-physics';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { WaterAsyncOutputTimeline } from '../async-buoyancy.js';

const output = (taskId: number, outputTimestampSeconds: number): PhysicsSolverOutput => ({
  taskId,
  entity: 1,
  entityGeneration: 1,
  sourceStep: taskId - 1,
  solveStep: taskId,
  completedStep: taskId,
  inputReleased: true,
  referenceTimeSeconds: 100 + taskId,
  snapshotHash: `hash-${taskId}`,
  outputTimestampSeconds,
  result: ok(new Uint8Array([taskId])),
});

describe('Water async results timeline', () => {
  it('retains a future before the first current sample and consumes every crossed output once', () => {
    const timeline = new WaterAsyncOutputTimeline();
    const a = output(1, 0.1),
      b = output(2, 0.2),
      c = output(3, 0.3);
    expect(timeline.admit(c)).toBe(true);
    expect(timeline.admit(a)).toBe(true);
    expect(timeline.admit(b)).toBe(true);
    expect(timeline.select(0)).toEqual({ next: a, alpha: 0, consumed: [] });
    const first = timeline.select(0.15);
    expect(first).toMatchObject({ current: a, next: b, consumed: [a] });
    expect(first.alpha).toBeCloseTo(0.5);
    expect(timeline.select(0.16).consumed).toEqual([]);
    expect(timeline.select(0.31)).toEqual({ current: c, alpha: 0, consumed: [b, c] });
    expect(timeline.select(0.32).consumed).toEqual([]);
    expect(timeline.admit(b)).toBe(false);
  });

  it('clears current and future together on a source lifetime change and bounds pending retention', () => {
    const timeline = new WaterAsyncOutputTimeline(2);
    expect(timeline.admit(output(1, 0.1))).toBe(true);
    expect(timeline.admit(output(2, 0.2))).toBe(true);
    expect(timeline.admit(output(2, 0.2))).toBe(false);
    expect(timeline.admit(output(3, 0.3))).toBe(false);
    timeline.select(0.1);
    expect(timeline.admit(output(3, 0.3))).toBe(true);
    timeline.clear();
    expect(timeline.select(1)).toEqual({ alpha: 0, consumed: [] });
    expect(timeline.admit(output(1, 0.1))).toBe(true);
  });

  it('retains Current and future outputs when varying frame deltas and zero continuations move the Water cutoff backward', () => {
    const timeline = new WaterAsyncOutputTimeline();
    const a = output(1, 0.1),
      b = output(2, 0.15),
      c = output(3, 0.2);
    for (const value of [a, b, c]) expect(timeline.admit(value)).toBe(true);
    const frames = [
      { physicsResultsTime: 0.08, frameDelta: 0.05, current: a, next: b, consumed: [a] },
      { physicsResultsTime: 0.09, frameDelta: 0, current: a, next: b, consumed: [] },
      { physicsResultsTime: 0.1, frameDelta: 0.03, current: a, next: b, consumed: [] },
      { physicsResultsTime: 0.12, frameDelta: 0.04, current: b, next: c, consumed: [b] },
      { physicsResultsTime: 0.13, frameDelta: 0, current: b, next: c, consumed: [] },
      { physicsResultsTime: 0.16, frameDelta: 0.05, current: c, consumed: [c] },
    ];
    const delivered: number[] = [];
    for (const frame of frames) {
      const selected = timeline.select(frame.physicsResultsTime + frame.frameDelta);
      expect(selected.current).toBe(frame.current);
      expect(selected.next).toBe('next' in frame ? frame.next : undefined);
      expect(selected.consumed).toEqual(frame.consumed);
      delivered.push(...selected.consumed.map((value) => value.taskId));
    }
    expect(delivered).toEqual([1, 2, 3]);
  });
});
