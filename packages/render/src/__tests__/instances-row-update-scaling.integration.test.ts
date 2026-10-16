import { describe, expect, it } from 'vitest';
import { createInstanceRowHarness, type InstanceRowWork } from './instances-row-harness';

function difference(after: InstanceRowWork, before: InstanceRowWork): InstanceRowWork {
  return {
    projectionRows: after.projectionRows - before.projectionRows,
    fullProjections: after.fullProjections - before.fullProjections,
    boundsNodeVisits: after.boundsNodeVisits - before.boundsNodeVisits,
    boundsDerives: after.boundsDerives - before.boundsDerives,
    gpuSceneRows: after.gpuSceneRows - before.gpuSceneRows,
    uploadBytes: after.uploadBytes - before.uploadBytes,
  };
}

/** Work of one `setArrayRange` row move after warm-up. */
function measureOneRowMove(count: number): InstanceRowWork {
  const harness = createInstanceRowHarness(count);
  try {
    // Warm-up establishes the projection back buffer, the bounds hierarchy
    // and the GPU Scene resident revision.
    for (let step = 0; step < 4; step += 1) harness.move(7, step);
    const before = harness.work();
    harness.move(count - 3, 42);
    return difference(harness.work(), before);
  } finally {
    harness.dispose();
  }
}

describe('Instances one-row move scaling', () => {
  it('costs the same CPU work and upload bytes at 1k and 64k instances', () => {
    const small = measureOneRowMove(1024);
    const large = measureOneRowMove(65536);
    expect(small.fullProjections).toBe(0);
    expect(small.boundsDerives).toBe(0);
    expect(small.projectionRows).toBeLessThanOrEqual(4);
    expect(small.gpuSceneRows).toBe(1);
    expect(small.uploadBytes).toBeGreaterThan(0);
    // The hierarchy is one level deeper at 64k; every other counter is flat.
    expect(large).toEqual({ ...small, boundsNodeVisits: large.boundsNodeVisits });
    expect(large.boundsNodeVisits).toBeLessThanOrEqual(1 + 16 * 4);
    expect(small.boundsNodeVisits).toBeLessThanOrEqual(1 + 16 * 3);
  });

  it('keeps a whole-column World.set rewrite on the full path', () => {
    const harness = createInstanceRowHarness(1024);
    try {
      harness.move(7, 1);
      const before = harness.work();
      harness.rewrite(9, 5);
      const work = difference(harness.work(), before);
      expect(work.fullProjections).toBe(1);
      expect(work.projectionRows).toBeGreaterThanOrEqual(1024);
      // Unproven row evidence visits every GPU Scene row, uploading only changes.
      expect(work.gpuSceneRows).toBe(1024);
    } finally {
      harness.dispose();
    }
  });
});
