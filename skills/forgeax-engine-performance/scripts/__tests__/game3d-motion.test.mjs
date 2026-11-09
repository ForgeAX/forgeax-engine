import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGame3dMotionPosition, moveGame3dWindow } from '../game3d_motion.mjs';

test('rejects falling, nonfinite and out-of-corridor motion instead of accepting horizontal travel', () => {
  for (const position of [[0, -5, 7], [0, NaN, 7], [15, 1, 7], [0, 1, 20]])
    assert.throws(() => assertGame3dMotionPosition({ position, camera: { yaw: 0 } }));
});

function fixture(advance) {
  let time = 0, key;
  const position = [0, 0.96, 7.4], released = [];
  return {
    released,
    io: {
      page: { keyboard: { down: async value => { key = value; }, up: async value => { released.push(value); key = undefined; } } },
      state: async () => ({ position: [...position], camera: { yaw: 0 }, grounded: true }),
      wait: async ms => { time += ms; advance(position, key, ms); },
      now: () => time,
    },
  };
}

test('feedback keeps repeated real-input windows in the fixed corridor despite integration error', async () => {
  const f = fixture((position, key, ms) => {
    const displacement = ms / 1000 * 5.5 * 1.03;
    if (key === 'w') position[2] -= displacement;
    if (key === 's') position[2] += displacement;
    if (key === 'a') position[0] -= displacement;
    if (key === 'd') position[0] += displacement;
  });
  for (let index = 0; index < 12; index++) {
    const result = await moveGame3dWindow(f.io, 30000);
    assert(result.travel > 60);
    assert(result.targetsReached >= 4);
    for (const position of result.positions) assertGame3dMotionPosition({ position });
  }
  assert(f.released.length > 0);
});

test('stalled motion fails and always releases held input', async () => {
  const f = fixture(() => {});
  await assert.rejects(moveGame3dWindow(f.io, 3000), error => {
    assert.match(error.message, /Motion/);
    assert(error.motion.positions.length > 0);
    assert.deepEqual(error.motion.lastPlayer.position, [0, 0.96, 7.4]);
    return true;
  });
  assert(f.released.length > 0);
});

test('falling during a window fails immediately and releases input', async () => {
  const f = fixture(position => { position[1] = -10; });
  await assert.rejects(moveGame3dWindow(f.io, 30000), /height/);
  assert.equal(f.released.length, 1);
});

test('keeps capsule clearance under delayed input observations and archives a failed trajectory', async () => {
  const f = fixture((position, key, ms) => {
    const displacement = (ms + 40) / 1000 * 5.5;
    if (key === 'w') position[2] -= displacement;
    if (key === 's') position[2] += displacement;
    if (key === 'a') position[0] -= displacement;
    if (key === 'd') position[0] += displacement;
  });
  for (let index = 0; index < 12; index++) {
    const result = await moveGame3dWindow(f.io, 30000);
    for (const [x] of result.positions) {
      // Ramp right extent -0.6; step left extent 4.1; capsule radius 0.35.
      assert(x - 0.35 > -0.6 && x + 0.35 < 4.1);
    }
  }
  const falling = fixture(position => { position[1] = -10; });
  await assert.rejects(moveGame3dWindow(falling.io, 3000), error => {
    assert.match(error.message, /-10/);
    assert.equal(error.motion.lastPlayer.position[1], -10);
    assert(error.motion.positions.length > 0);
    return true;
  });
});

test('keeps continuous input bounded when state RPC returns an older position after transport delay', async () => {
  for (const stale of [true, false]) {
  let time = 0, key, reads = 0;
  const position = [0, 0.96, 7.4], delays = [40, 100, 160, 80], released = [];
  const advance = ms => {
    const displacement = ms / 1000 * 5.5;
    if (key === 'w') position[2] -= displacement;
    if (key === 's') position[2] += displacement;
    if (key === 'a') position[0] -= displacement;
    if (key === 'd') position[0] += displacement;
    time += ms;
  };
  const io = {
    page: { keyboard: {
      down: async value => { key = value; },
      up: async value => { released.push(value); key = undefined; },
    } },
    state: async () => {
      const snapshot = { position: [...position], camera: { yaw: 0 }, grounded: true };
      advance(delays[reads++ % delays.length]);
      return stale ? snapshot : { position: [...position], camera: { yaw: 0 }, grounded: true };
    },
    wait: async ms => advance(ms),
    now: () => time,
  };
  for (let window = 0; window < 12; window++) {
    const result = await moveGame3dWindow(io, 30000);
    assert(result.travel > 60);
    assert(result.targetsReached >= 4);
    assert.equal(result.observation.maxStateMs, 160);
    assert(result.observation.maxCycleMs <= 210);
    assertGame3dMotionPosition({ position });
  }
  assert.equal(key, undefined);
  assert.equal(released.length > 0, true);
  }
});
