import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { measureDisplayCycle } from '../../apps/hello/ssr/scripts/measure-display-cycle.mjs';

function fixture(frameCount = 9) {
  const state = (frameIndex: number) => ({
    frameIndex,
    epoch: frameIndex + 10,
    historyValid: true,
    viewIdentity: 'camera',
    deviceGeneration: 0,
  });
  return {
    receipts: Array.from({ length: frameCount }, (_, i) => ({
      before: state(128 + i),
      after: state(129 + i),
    })),
    images: Array.from({ length: frameCount }, () => ({
      width: 4,
      height: 4,
      pixels: new Uint8Array(64),
    })),
    regions: { scene: [0, 0, 1, 1] },
  };
}

describe('submitted display cycle measurement', () => {
  it.each([
    '159',
    '4097',
    'NaN',
    '160.5',
  ])('refuses an invalid post-motion hold before starting the renderer: %s', (holdFrames) => {
    const result = spawnSync(process.execPath, ['apps/hello/ssr/scripts/smoke-dawn.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, SMOKE_DISPLAY_HOLD_FRAMES: holdFrames },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SMOKE_DISPLAY_HOLD_FRAMES must be an integer');
  });

  it.each([
    '8',
    '10',
    'NaN',
    '258',
  ])('refuses incomplete or unbounded display frame counts: %s', (frameCount) => {
    const result = spawnSync(process.execPath, ['apps/hello/ssr/scripts/smoke-dawn.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, SMOKE_DISPLAY_FRAMES: frameCount },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SMOKE_DISPLAY_FRAMES must cover complete eight-phase cycles');
  });

  it.each([
    { SSR_FIXTURE: 'tiles' },
    { SMOKE_DISPLAY_CAMERA_STEP: '0.05' },
    { SMOKE_OBJECT_OFFSET: '0.5' },
  ])('refuses ambiguous object motion before starting the renderer: %j', (conflict) => {
    const result = spawnSync(process.execPath, ['apps/hello/ssr/scripts/smoke-dawn.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SSR_FIXTURE: 'objects',
        SMOKE_DISPLAY_OBJECT_MOTION: '1',
        SMOKE_DISPLAY_DIR: 'unused-display-directory',
        ...conflict,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Display object motion requires the objects fixture and an isolated display journey',
    );
    expect(result.stderr).not.toContain('ENOENT');
  });

  it('detects a local outlier on the otherwise omitted ninth-image transition', () => {
    const { receipts, images, regions } = fixture();
    images[8].pixels[20] = 17;
    const result = measureDisplayCycle(receipts, images, regions);
    expect(result.transitions).toBe(8);
    expect(result.statistics.scene).toEqual({
      mean: 17 / 128,
      maximum: 17,
      above4: 1,
      worstPixel: [8, 1, 1],
      phasePeaks: [0, 0, 0, 0, 0, 0, 0, 17],
      temporalRange: { maximum: 17, above4: 1, worstPixel: [1, 1] },
    });
    expect(() => measureDisplayCycle(receipts.slice(1), images.slice(1), regions)).toThrow();
  });

  it('measures cross-cycle drift that remains small between adjacent frames', () => {
    const { receipts, images, regions } = fixture(129);
    for (let frame = 0; frame < images.length; frame++) images[frame].pixels[20] = frame;
    const result = measureDisplayCycle(receipts, images, regions);
    expect(result.transitions).toBe(128);
    expect(result.statistics.scene.maximum).toBe(1);
    expect(result.statistics.scene.above4).toBe(0);
    expect(result.statistics.scene.temporalRange).toEqual({
      maximum: 128,
      above4: 1,
      worstPixel: [1, 1],
    });
    receipts[100].after.historyValid = false;
    expect(() => measureDisplayCycle(receipts, images, regions)).toThrow();
  });

  it('refuses missing frames, view switches, and invalid history', () => {
    for (const field of ['frameIndex', 'epoch', 'deviceGeneration'] as const) {
      const { receipts, images, regions } = fixture();
      receipts[4].before[field]++;
      expect(() => measureDisplayCycle(receipts, images, regions)).toThrow();
    }
    const { receipts, images, regions } = fixture();
    receipts[4].after.viewIdentity = 'replacement-camera';
    expect(() => measureDisplayCycle(receipts, images, regions)).toThrow();
    receipts[4].after.viewIdentity = 'camera';
    receipts[4].after.historyValid = false;
    expect(() => measureDisplayCycle(receipts, images, regions)).toThrow();
  });

  it('refuses a resized image and a region without pixel support', () => {
    const { receipts, images, regions } = fixture();
    images[4].width = 5;
    expect(() => measureDisplayCycle(receipts, images, regions)).toThrow();
    images[4].width = 4;
    expect(() =>
      measureDisplayCycle(receipts, images, { empty: [0.01, 0.01, 0.02, 0.02] }),
    ).toThrow();
  });

  it('does not mistake an advanced temporal index for a completed frame receipt', () => {
    const { receipts, images, regions } = fixture();
    const observed = receipts.map((receipt, i) => ({
      ...receipt,
      execution: {
        before: { submitted: 128 + i, completed: 128 + i, inFlight: 0 },
        after: { submitted: 129 + i, completed: 129 + i, inFlight: 0 },
      },
    }));
    expect(measureDisplayCycle(observed, images, regions).transitions).toBe(8);
    const pending = observed[4];
    if (pending === undefined) throw new Error('Missing test frame');
    pending.execution.after.completed--;
    pending.execution.after.inFlight = 1;
    expect(() => measureDisplayCycle(observed, images, regions)).toThrow();
  });
});
