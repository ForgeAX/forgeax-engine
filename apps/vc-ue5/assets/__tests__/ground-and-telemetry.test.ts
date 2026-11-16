import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { degrees, REFERENCE_EYE, REFERENCE_VERTICAL_FOV, SUN_DIRECTION, referenceCamera, stepGroundCamera, viewDirection } from '../terrain.ts';
import { completedFrameStats } from '../ui/hud.ts';

function near(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected} within ${tolerance}`);
}

describe('ground reference', () => {
  it('maps the UE frozen eye and optical axis into the ForgeaX camera', () => {
    assert.deepEqual(REFERENCE_EYE, [157.17355489, 0.35069365, 36.17745191]);
    const camera = referenceCamera();
    const [x, y, z] = viewDirection(camera.yaw, camera.pitch);
    near(x, 0.835, 0.005);
    near(y, 0.200, 0.0005);
    near(z, 0.513, 0.005);
  });

  it('uses the measured UE lens and outgoing daylight direction', () => {
    near(REFERENCE_VERTICAL_FOV / degrees, 73.739795);
    const ueSun = [0.5548266804182369, -0.5798598423334443, -0.5965986238210013];
    assert.deepEqual(SUN_DIRECTION, [ueSun[1], ueSun[2], -ueSun[0]]);
    near(Math.hypot(...SUN_DIRECTION), 1);
  });

  it('keeps diagonal speed bounded, clamps tilt, and resets to an independent pose', () => {
    const original = referenceCamera();
    const camera = referenceCamera();
    stepGroundCamera(camera, 1, 1, 45 * degrees, 90 * degrees, 0.25);
    near(Math.hypot(camera.x - original.x, camera.z - original.z), 0.75);
    near(camera.pitch, 80 * degrees);
    assert.deepEqual(referenceCamera(), original);
  });
});

describe('HUD completed frame clock', () => {
  it('ignores duplicate and stale receipts, does not count skipped IDs, and resets on epoch change', () => {
    const stats = completedFrameStats();
    const a = { worldIdentity: 'source-a', deviceGeneration: 1, presentation: 'ready' } as const;
    assert.equal(stats.accept({ ...a, frameId: 1, presentation: 'pending' }, 50), undefined);
    assert.deepEqual(stats.accept({ ...a, frameId: 5 }, 100), { count: 1, fps: undefined });
    assert.equal(stats.accept({ ...a, frameId: 5 }, 150), undefined);
    assert.equal(stats.accept({ ...a, frameId: 4 }, 200), undefined);
    assert.deepEqual(stats.accept({ ...a, frameId: 13 }, 600), { count: 2, fps: 2 });
    assert.deepEqual(stats.accept({ ...a, deviceGeneration: 2, frameId: 1 }, 800), { count: 1, fps: undefined });
    assert.equal(stats.accept({ ...a, frameId: 15 }, 810), undefined);
    assert.deepEqual(stats.accept({ worldIdentity: 'source-b', deviceGeneration: 1, frameId: 1, presentation: 'ready' }, 900), { count: 1, fps: undefined });
    assert.equal(stats.accept({ ...a, deviceGeneration: 2, frameId: 2 }, 910), undefined);
  });
});
