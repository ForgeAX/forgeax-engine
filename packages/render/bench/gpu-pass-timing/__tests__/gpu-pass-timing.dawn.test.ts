import { describe, expect, it } from 'vitest';
import { createDawnGpuPassTimingFixture } from '../dawn-fixture.js';
import { requestDawnTimestampQueryAdapter } from '../dawn-timestamp-query.js';

describe('GPU pass timing Dawn Standard Renderer evidence', () => {
  // CI keeps the receipt and pass-shape assertions while bounding repeated
  // submissions on overloaded lavapipe; local/nightly retains 60 frames and
  // the PR profile keeps 12 receipt-bound observations.
  const frameCount = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 12 : 60;

  it('records receipt-bound real GPU facts across the selected frame window', async ({ skip }) => {
    const adapter = await requestDawnTimestampQueryAdapter();
    if (adapter === undefined) {
      skip('Dawn adapter does not support timestamp-query');
    }
    const fixture = await createDawnGpuPassTimingFixture();
    const { renderer, world, lease } = fixture;
    const observations = [];
    try {
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        world.update(1 / 60).unwrap();
        const drawn = renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
        });
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) return;
        const observed = await renderer.observe(drawn.value, { include: ['timings'] });
        expect(observed.ok).toBe(true);
        if (!observed.ok) return;
        expect(observed.value.timings).toBeDefined();
        if (observed.value.timings === undefined) return;
        if (observed.value.timings.status === 'unavailable') {
          throw new Error(JSON.stringify(observed.value.timings));
        }
        expect(observed.value.timings.status).not.toBe('unavailable');
        expect(observed.value.timings.status).not.toBe('failed');
        if (
          observed.value.timings.status === 'complete' ||
          observed.value.timings.status === 'partial'
        ) {
          observations.push({ receipt: drawn.value, frame: observed.value.timings.frame });
        }
      }
    } finally {
      await renderer.dispose();
      await fixture.releaseTargets();
    }

    expect(observations).toHaveLength(frameCount);
    const frames = observations.map((item) => item.frame);
    const passEntries = frames.flatMap((frame) => frame.passes);
    expect(passEntries.length).toBeGreaterThan(0);
    expect(
      passEntries.some((pass) => pass.passKind === 'raster' || pass.passKind === 'compute'),
    ).toBe(true);
    const measured = passEntries.filter((pass) => pass.status === 'measured');
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.some((pass) => pass.durationNanoseconds > 0)).toBe(true);
    expect(
      measured
        .filter((pass) => pass.passKind === 'copy')
        .every((pass) => pass.measurementSource === 'copy-boundary-envelope'),
    ).toBe(true);
    expect(
      measured
        .filter((pass) => pass.passKind !== 'copy')
        .every((pass) => pass.measurementSource === 'pass-boundary'),
    ).toBe(true);
    for (const item of observations) {
      expect(item.frame.frameId).toBe(item.receipt.frameId);
      expect(item.frame.deviceGeneration).toBe(item.receipt.deviceGeneration);
      for (const pass of item.frame.passes) {
        if (pass.status !== 'measured') continue;
        expect(BigInt(pass.endTick)).toBeGreaterThanOrEqual(BigInt(pass.beginningTick));
      }
    }
  });
});
