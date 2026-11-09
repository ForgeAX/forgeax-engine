import assert from 'node:assert/strict';

// Keep the full character capsule clear of the ramp/step, including turn
// overshoot. Absolute targets prevent collision/timing error accumulating.
const TARGETS = Object.freeze([[1.1, 6.9], [2.3, 6.9], [2.3, 8.6], [1.1, 8.6]]);
export const GAME3D_MOTION_PROTOCOL = 'bounded-corridor-v3-50ms';

async function readMotionPlayer(state, now, observation) {
  const started = now();
  const player = await state('game-3d.player');
  const elapsed = now() - started;
  observation.reads++;
  observation.lastStateMs = elapsed;
  observation.totalStateMs += elapsed;
  observation.maxStateMs = Math.max(observation.maxStateMs, elapsed);
  return player;
}

// Steering compensates for transport age only; evidence and guards always use actual samples.
// The selected stock player walks at 5.5 m/s and never receives Shift in this workload.
function steeringPosition(player, held, ageMs) {
  const yaw = player.camera?.yaw ?? 0;
  assert(Number.isFinite(yaw), 'Motion camera yaw must be finite');
  assert(!player.controls?.run, 'Measured movement must retain the stock walking speed');
  const distance = ageMs / 1000 * 5.5;
  let x = player.position[0], z = player.position[2];
  if (held === 'd') { x += distance * Math.cos(yaw); z += distance * Math.sin(yaw); }
  if (held === 'a') { x -= distance * Math.cos(yaw); z -= distance * Math.sin(yaw); }
  if (held === 'w') { x += distance * Math.sin(yaw); z -= distance * Math.cos(yaw); }
  if (held === 's') { x -= distance * Math.sin(yaw); z += distance * Math.cos(yaw); }
  return { x, z, yaw };
}

export function assertGame3dMotionPosition(player) {
  const position = player?.position;
  assert(position?.length === 3 && position.every(Number.isFinite), 'Motion position must be finite');
  assert(position[1] >= 0.75 && position[1] <= 1.3, `Motion height left the grounded corridor: ${JSON.stringify(position)}`);
  assert(position[0] >= -0.1 && position[0] <= 3.5 && position[2] >= 5.5 && position[2] <= 10,
    `Motion position left the fixed corridor: ${JSON.stringify(position)}`);
}

/** Actual held keyboard input with position feedback; no teleports or scene edits. */
export async function moveGame3dWindow({ page, state, wait, signal, now = () => performance.now() }, ms) {
  const started = now(), positions = [];
  const observation = { reads: 0, totalStateMs: 0, lastStateMs: 0, maxStateMs: 0, maxCycleMs: 0 };
  let player, target = 0, targetsReached = 0, held;
  try {
    player = await readMotionPlayer(state, now, observation);
    assertGame3dMotionPosition(player);
    positions.push(player.position);
    while (now() - started < ms) {
      const cycleStarted = now();
      if (signal?.aborted) throw signal.reason;
      assertGame3dMotionPosition(player);
      let destination = TARGETS[target];
      if (Math.hypot(destination[0] - player.position[0], destination[1] - player.position[2]) < 0.45) {
        target = (target + 1) % TARGETS.length;
        targetsReached++;
        destination = TARGETS[target];
      }
      const { x, z, yaw } = steeringPosition(player, held, observation.lastStateMs);
      const dx = destination[0] - x, dz = destination[1] - z;
      const horizontal = dx * Math.cos(yaw) + dz * Math.sin(yaw);
      const vertical = dx * Math.sin(yaw) - dz * Math.cos(yaw);
      const key = Math.abs(horizontal) > Math.abs(vertical) ? (horizontal > 0 ? 'd' : 'a') : (vertical > 0 ? 'w' : 's');
      if (key !== held) {
        if (held !== undefined) await page.keyboard.up(held);
        held = key;
        await page.keyboard.down(held);
      }
      await wait(Math.max(0, Math.min(50, ms - (now() - started))));
      player = await readMotionPlayer(state, now, observation);
      observation.maxCycleMs = Math.max(observation.maxCycleMs, now() - cycleStarted);
      assertGame3dMotionPosition(player);
      positions.push(player.position);
    }
    let travel = 0;
    for (let index = 1; index < positions.length; index++)
      travel += Math.hypot(positions[index][0] - positions[index - 1][0], positions[index][2] - positions[index - 1][2]);
    assert(travel > ms / 1000, 'Motion workload travelled too little');
    assert(ms < 3000 || targetsReached >= 2, 'Motion workload did not complete its corridor targets');
    return { protocol: GAME3D_MOTION_PROTOCOL, positions, travel, targetsReached, observation };
  } catch (cause) {
    if (cause instanceof Error)
      cause.motion = { protocol: GAME3D_MOTION_PROTOCOL, positions, lastPlayer: player, targetsReached, observation };
    throw cause;
  } finally {
    if (held !== undefined) await page.keyboard.up(held);
  }
}
