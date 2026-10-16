import { describe, expect, it } from 'vitest';
import {
  DynamicResolutionController,
  gpuPassFrameMilliseconds,
} from '../pipeline/dynamic-resolution';
import { createGpuPassTimingFrame } from '../record/gpu-pass-timing/contract';

const parameters = { targetGpuMs: 16, minScale: 0.5, maxScale: 1 };
const owner = {};
const configure = (
  controller: DynamicResolutionController,
  overrides = {},
  camera = 1,
  width = 960,
  generation = 1,
) => {
  const extent = controller.configure(
    { ...parameters, ...overrides },
    owner,
    camera,
    width,
    540,
    generation,
    true,
  );
  if (extent === undefined) throw new Error('missing DRS extent');
  return extent;
};
async function sample(controller: DynamicResolutionController, ms: number | undefined) {
  controller.observe(Promise.resolve(ms));
  await Promise.resolve();
  await Promise.resolve();
}

describe('adaptive DRS feedback', () => {
  it('converges under a pixel-bound GPU load and slowly restores quality after recovery', async () => {
    const controller = new DynamicResolutionController();
    let extent = configure(controller);
    for (let frame = 0; frame < 96; frame++) {
      controller.commit(extent, 0);
      await sample(controller, 30 * extent.scale ** 2 + 1);
      extent = configure(controller);
    }
    expect(extent.scale).toBeLessThan(0.8);
    expect(30 * extent.scale ** 2 + 1).toBeLessThan(16.8);
    expect(extent.outputWidth).toBe(960);
    const low = extent.scale;
    for (let frame = 0; frame < 160; frame++) {
      await sample(controller, 5);
      extent = configure(controller);
    }
    expect(extent.scale).toBe(1);
    expect(low).toBeGreaterThanOrEqual(0.5);
  });

  it('holds the last feasible scale across a nonlinear cost boundary and restores quality after actual headroom', async () => {
    const controller = new DynamicResolutionController();
    let extent = configure(controller);
    const steady = [];
    for (let frame = 0; frame < 240; frame++) {
      // A native workload can have a sharp tile/cache/work boundary. The last
      // accepted smaller scale fits; repeatedly probing the next one does not.
      const gpuMs = extent.scale > 0.71875 ? 24 : 10 * (extent.scale / 0.71875) ** 2;
      await sample(controller, gpuMs);
      extent = configure(controller);
      if (frame >= 160) steady.push(extent.scale);
    }
    expect(Math.max(...steady) - Math.min(...steady)).toBe(0);
    expect(extent.scale).toBe(0.71875);
    for (let frame = 0; frame < 160; frame++) {
      await sample(controller, 4);
      extent = configure(controller);
    }
    expect(extent.scale).toBe(1);
  });

  it('lowers a rejected quality boundary when the preceding scale also overloads', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 10 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, frames = 8) => {
      for (let i = 0; i < frames; i++) {
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    while (extent.scale > 0.5625) await drive(14);
    await drive(5);
    expect(extent.scale).toBe(0.59375);
    await drive(14);
    expect(extent.scale).toBe(0.5625);
    // The previously feasible extent is now also over budget. Its cheaper
    // replacement is the new boundary, not evidence of a workload recovery.
    await drive(14);
    expect(extent.scale).toBe(0.5);
    for (let frame = 0; frame < 128; frame++) {
      await sample(controller, extent.scale < 0.5625 ? 4 : 5);
      extent = configure(controller, settings);
      expect(extent.scale).toBe(0.5);
    }
    expect(extent.scale).toBe(0.5);
    await drive(2, 160);
    expect(extent.scale).toBe(1);
  });

  it('does not mistake a settling resize tail for new workload headroom', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 10 };
    let extent = configure(controller, settings);
    const drive = async (values: number[]) => {
      for (const value of values) {
        await sample(controller, value);
        extent = configure(controller, settings);
      }
    };
    while (extent.scale > 0.5625) await drive(Array(8).fill(14));
    // Actual GPU samples rise before a failed quality probe, then retain two
    // costly frames after rollback before returning to the same steady load.
    await drive([6.357, 6.291, 7.209, 5.767, 6.554, 6.816, 7.406, 9.11]);
    expect(extent.scale).toBe(0.59375);
    await drive(Array(8).fill(14));
    expect(extent.scale).toBe(0.5625);
    await drive([14.746, 14.418, 4.915, 4.456, 4.522, 4.915, 4.522, 4.981]);
    for (let frame = 0; frame < 128; frame++) {
      await drive([5]);
      expect(extent.scale).toBe(0.5625);
    }
    await drive(Array(160).fill(3));
    expect(extent.scale).toBe(1);
  });

  it("establishes a fresh cost baseline when returning to a rejected probe's preceding extent", async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 8.978432 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, frames = 8) => {
      for (let frame = 0; frame < frames; frame++) {
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    while (extent.scale > 0.5625) await drive(14.876672);
    await drive(6.291456);
    expect(extent.scale).toBe(0.59375);
    await drive(14.876672);
    expect(extent.scale).toBe(0.5625);
    // A graph rebuilt at the same preceding extent initially costs less.
    // Actual Metal rollback intervals cannot prove the scene became cheaper.
    for (const ms of [
      5.57056, 5.439488, 5.046272, 5.177344, 4.718592, 5.24288, 4.849664, 5.24288,
    ]) {
      await drive(ms, 1);
    }
    expect(extent.scale).toBe(0.5625);
    await drive(5.24288, 128);
    expect(extent.scale).toBe(0.5625);
    await drive(3.145728, 160);
    expect(extent.scale).toBe(1);
  });

  it('waits for a rising quality-probe cost to settle before admitting another increase', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 8.978432 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, frames = 8) => {
      for (let frame = 0; frame < frames; frame++) {
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    while (extent.scale > 0.5) await drive(14.876672);
    await drive(4.849664);
    expect(extent.scale).toBe(0.53125);
    // A fitting window whose minimum is still rising cannot validate a
    // second quality increase. Stable work can advance on the next window.
    await drive(6.291456);
    expect(extent.scale).toBe(0.53125);
    await drive(6.291456);
    expect(extent.scale).toBe(0.5625);
    await drive(3.145728, 160);
    expect(extent.scale).toBe(1);
  });

  it('remeasures maximum quality after an increased authored GPU budget using eight fresh samples', async () => {
    const controller = new DynamicResolutionController();
    let settings = { targetGpuMs: 1 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, frames: number) => {
      for (let frame = 0; frame < frames; frame++) {
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    await drive(14, 64);
    expect(extent.scale).toBe(0.5);
    settings = { targetGpuMs: 100 };
    extent = configure(controller, settings);
    await drive(6, 7);
    expect(extent.scale).toBe(0.5);
    await drive(6, 1);
    expect(extent.scale).toBe(1);
    await drive(14, 32);
    expect(extent.scale).toBe(1);
  });

  it('rejects an over-budget maximum-quality trial after a budget increase', async () => {
    const controller = new DynamicResolutionController();
    let settings = { targetGpuMs: 1 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, frames: number) => {
      for (let frame = 0; frame < frames; frame++) {
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    await drive(14, 64);
    settings = { targetGpuMs: 8 };
    extent = configure(controller, settings);
    await drive(6, 8);
    expect(extent.scale).toBe(1);
    await drive(14, 8);
    expect(extent.scale).toBe(0.5);
    await drive(6, 64);
    expect(extent.scale).toBe(0.5);
  });

  it('remeasures native quality after a submitted visible-raster reduction', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 8.617984 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, rows: number, frames = 8) => {
      for (let frame = 0; frame < frames; frame++) {
        controller.commit(extent, rows);
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    await drive(14.09024, 37, 64);
    expect(extent.scale).toBe(0.5);
    await drive(7.929856, 37, 16);
    expect(extent.scale).toBe(0.5);
    // A sparse reduced view can cost more than its measured native control.
    // The actual submitted roster decreases; GPU feedback validates the trial.
    await drive(7.929856, 36);
    expect(extent.scale).toBe(1);
    await drive(3.145728, 36, 32);
    expect(extent.scale).toBe(1);
  });

  it('rolls back an expensive native trial and does not repeat it for an unchanged roster', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 8.617984 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, rows: number, frames = 8) => {
      for (let frame = 0; frame < frames; frame++) {
        controller.commit(extent, rows);
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    await drive(14.09024, 37, 64);
    await drive(7.929856, 36);
    expect(extent.scale).toBe(1);
    await drive(14.09024, 36);
    expect(extent.scale).toBe(0.5);
    await drive(7.929856, 36, 128);
    expect(extent.scale).toBe(0.5);
  });

  it('rejects an old in-flight result after a submitted roster reduction and waits for complete GPU evidence', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 8.617984 };
    let extent = configure(controller, settings);
    for (let frame = 0; frame < 64; frame++) {
      controller.commit(extent, 37);
      await sample(controller, 14.09024);
      extent = configure(controller, settings);
    }
    let complete!: (ms: number) => void;
    controller.observe(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    controller.commit(extent, 36);
    expect(controller.needsSample).toBe(false);
    complete(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.inspect()?.gpuMs).toBeUndefined();
    expect(configure(controller, settings).scale).toBe(0.5);
    await sample(controller, undefined);
    for (let frame = 0; frame < 7; frame++) await sample(controller, 7.929856);
    expect(configure(controller, settings).scale).toBe(0.5);
    await sample(controller, 7.929856);
    expect(configure(controller, settings).scale).toBe(1);
  });

  it('rolls back a quality probe whose overload arrives after one budget-fitting window', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 8.3 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, frames = 8) => {
      for (let frame = 0; frame < frames; frame++) {
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    while (extent.scale > 0.5) await drive(14);
    await drive(6);
    expect(extent.scale).toBe(0.53125);
    await drive(7.8);
    expect(extent.scale).toBe(0.53125);
    await drive(12);
    expect(extent.scale).toBe(0.5);
    await drive(6, 128);
    expect(extent.scale).toBe(0.5);
    await drive(3, 160);
    expect(extent.scale).toBe(1);
  });

  it('detects real recovery at a smaller held scale without confusing resize savings with recovery', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 10 };
    let extent = configure(controller, settings);
    const drive = async (ms: number, frames = 8) => {
      for (let frame = 0; frame < frames; frame++) {
        await sample(controller, ms);
        extent = configure(controller, settings);
      }
    };
    while (extent.scale > 0.5625) await drive(14);
    await drive(5);
    await drive(14);
    await drive(14);
    expect(extent.scale).toBe(0.5);
    // A completed unchanged-scale window establishes the new baseline.
    await drive(9.5, 16);
    expect(extent.scale).toBe(0.5);
    for (let frame = 0; frame < 160; frame++) {
      await sample(controller, extent.scale === 0.5 ? 3 : 4.5);
      extent = configure(controller, settings);
    }
    expect(extent.scale).toBe(1);
  });

  it('holds near the budget and ignores isolated spikes, invalid timings and absent samples', async () => {
    const controller = new DynamicResolutionController();
    configure(controller);
    for (let frame = 0; frame < 80; frame++) await sample(controller, frame === 1 ? 28 : 16);
    expect(configure(controller).scale).toBe(1);
    for (const ms of [undefined, 0, NaN, Infinity, -1]) await sample(controller, ms);
    expect(configure(controller).scale).toBe(1);
    expect(controller.inspect()?.status).toBe('warming');
    // A CPU stall contributes no GPU sample and cannot lower resolution.
    for (let frame = 0; frame < 60; frame++) expect(configure(controller).scale).toBe(1);
  });

  it('reduces quality when most actual intervals miss the budget despite a cheap window ending', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 9.868950588235293 };
    configure(controller, settings);
    // Actual same-extent Metal intervals: five are above the 105% bound.
    // The range midpoint and end-of-window EMA both falsely fit the budget.
    for (const ms of [
      10.616832, 10.747904, 10.616832, 14.286848, 14.680064, 5.57056, 5.308416, 5.505024,
    ]) {
      await sample(controller, ms);
    }
    expect(configure(controller, settings).scale).toBe(0.9375);
  });

  it('retains balanced near-budget noise rather than treating it as a majority overrun', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 9.868950588235293 };
    configure(controller, settings);
    for (const ms of [
      14.680064, 5.505024, 14.286848, 5.308416, 14.680064, 5.505024, 14.286848, 5.308416,
    ]) {
      await sample(controller, ms);
    }
    expect(configure(controller, settings).scale).toBe(1);
  });

  it('responds to repeated GPU tails even when the end of the feedback window is cheap', async () => {
    const controller = new DynamicResolutionController();
    const settings = { targetGpuMs: 9.240576 };
    configure(controller, settings);
    // Eight actual complete-frame intervals from the 32-light Metal carrier.
    // Its two expensive frames decay out of the EMA before the window closes.
    for (const ms of [
      15.663104, 17.03936, 6.094848, 6.356992, 6.160384, 5.963776, 5.57056, 5.89824,
    ]) {
      await sample(controller, ms);
    }
    expect(configure(controller, settings).scale).toBeLessThan(1);
  });

  it.each([
    'camera',
    'resize',
    'device',
    'parameters',
    'disable',
    'detach',
  ] as const)('rejects a delayed sample after %s and bounds in-flight feedback', async (change) => {
    const controller = new DynamicResolutionController();
    configure(controller);
    let complete!: (ms: number) => void;
    controller.observe(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    expect(controller.needsSample).toBe(false);
    if (change === 'camera') configure(controller, {}, 2);
    if (change === 'resize') configure(controller, {}, 1, 640);
    if (change === 'device') configure(controller, {}, 1, 960, 2);
    if (change === 'parameters') configure(controller, { targetGpuMs: 8 });
    if (change === 'disable') controller.configure(undefined, owner, 1, 960, 540, 1, true);
    if (change === 'detach') controller.reset();
    expect(controller.needsSample).toBe(false);
    complete(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.inspect()?.gpuMs).toBeUndefined();
    expect(configure(controller).scale).toBe(1);
  });

  it('preserves fixed scaling, explicit unsupported fallback and accepted extent isolation', async () => {
    const controller = new DynamicResolutionController();
    const fixed = configure(controller, { minScale: 0.75, maxScale: 0.75 });
    controller.commit(fixed, 0);
    expect(controller.inspect()).toMatchObject({ status: 'fixed', extent: { scale: 0.75 } });
    expect(controller.needsSample).toBe(false);
    const fallback = controller.configure(parameters, owner, 1, 960, 540, 1, false);
    expect(fallback?.scale).toBe(1);
    expect(controller.inspect()).toMatchObject({ status: 'unavailable', extent: { scale: 0.75 } });
    expect(controller.needsSample).toBe(false);
    configure(controller);
    controller.commit(configure(controller), 0);
    for (let frame = 0; frame < 8; frame++) await sample(controller, 100);
    expect(configure(controller).scale).toBeLessThan(1);
    expect(controller.inspect()?.extent?.scale).toBe(1);
  });

  it('keeps non-grid authored bounds and tiny output dimensions valid', async () => {
    const controller = new DynamicResolutionController();
    const bounds = { minScale: 0.67, maxScale: 0.9 };
    configure(controller, bounds);
    for (let i = 0; i < 100; i++) await sample(controller, 100);
    expect(configure(controller, bounds).scale).toBeGreaterThanOrEqual(0.67);
    for (let i = 0; i < 100; i++) await sample(controller, 1);
    expect(configure(controller, bounds).scale).toBeLessThanOrEqual(0.9);
    const tiny = controller.configure(parameters, owner, 1, 3, 2, 2, true);
    if (tiny === undefined) throw new Error('missing tiny extent');
    expect([tiny.internalWidth, tiny.internalHeight]).toEqual([3, 2]);
  });

  it('isolates noisy feedback and delayed results between two views', async () => {
    const heavy = new DynamicResolutionController();
    const light = new DynamicResolutionController();
    configure(heavy, {}, 1);
    configure(light, {}, 2);
    for (let frame = 0; frame < 96; frame++) {
      await sample(heavy, frame % 2 === 0 ? 28 : 32);
      await sample(light, frame % 2 === 0 ? 15 : 17);
      expect(configure(heavy, {}, 1).scale).toBeGreaterThanOrEqual(0.5);
      expect(configure(light, {}, 2).scale).toBe(1);
    }
    expect(configure(heavy, {}, 1).scale).toBe(0.5);
    let complete!: (ms: number) => void;
    heavy.observe(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    configure(heavy, {}, 3);
    await sample(light, 16);
    complete(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(configure(heavy, {}, 3).scale).toBe(1);
    expect(configure(light, {}, 2).scale).toBe(1);
  });

  it('uses elapsed GPU ticks including inter-pass gaps and refuses partial frames', () => {
    const frame = createGpuPassTimingFrame({
      frameId: 1,
      deviceGeneration: 1,
      graphGeneration: 1,
      backendKind: 'webgpu',
      timestampPeriodNanoseconds: 2,
      passCapacity: 2,
      passes: [0, 1].map((index) => ({
        passName: `p${index}`,
        passKind: 'raster',
        executionIndex: index,
        status: 'measured',
        measurementSource: 'pass-boundary',
        beginningTick: String(100 + index * 10_000_000),
        endTick: String(1_000_100 + index * 10_000_000),
        durationNanoseconds: 2_000_000,
      })),
    });
    expect(gpuPassFrameMilliseconds(frame)).toBe(22);
    expect(gpuPassFrameMilliseconds({ ...frame, droppedPassCount: 1 })).toBeUndefined();
    expect(gpuPassFrameMilliseconds({ ...frame, passes: [] })).toBeUndefined();
  });
});
