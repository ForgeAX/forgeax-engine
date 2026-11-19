import assert from 'node:assert/strict';
import { assertGame3dMotionPosition } from './game3d_motion.mjs';

const TOPIC = 'game-3d.runtime-vase';
const DEFAULTS = Object.freeze({ height: 2.4, radius: 0.75, sides: 32 });

/** Read the actual producer projection, including failures hidden by a preserved old mesh. */
export function game3dWorkloadReceipt(state) {
  assert(state && typeof state === 'object', 'Runtime vase producer state is unavailable');
  assert(
    state.error === undefined,
    'Runtime vase generation failed: ' + JSON.stringify(state.error),
  );
  assert.equal(state.busy, false, 'Runtime vase generation is still busy');
  assert(typeof state.guid === 'string' && state.guid.length > 0, 'Missing runtime vase GUID');
  assert(
    Number.isSafeInteger(state.generation) && state.generation > 0,
    'Missing runtime vase publication generation',
  );
  assert(
    Number.isSafeInteger(state.entity) && state.entity >= 0,
    'Missing bound runtime vase entity',
  );
  assert.deepEqual(
    state.values,
    DEFAULTS,
    'Measured vase parameters differ from the selected stock workload',
  );
  assert.equal(
    state.vertexCount,
    495,
    'Measured vase geometry differs from the stock generated mesh',
  );
  assert(
    Array.isArray(state.aabb) && state.aabb.length === 6 && state.aabb.every(Number.isFinite),
    'Invalid runtime vase bounds',
  );
  for (let axis = 0; axis < 3; axis++)
    assert(state.aabb[axis] <= state.aabb[axis + 3], 'Inverted runtime vase bounds');
  return {
    topic: TOPIC,
    guid: state.guid,
    generation: state.generation,
    entity: state.entity,
    values: { ...state.values },
    vertexCount: state.vertexCount,
    aabb: [...state.aabb],
  };
}

/** Busy is an ordinary bounded startup wait; a terminal producer error is never retried here. */
export async function admitGame3dWorkload(
  play,
  { scenario = 'runtime-vase', timeoutMs = 15000, now = () => performance.now() } = {},
) {
  assert(
    ['runtime-vase', 'stock-corridor'].includes(scenario),
    'Unknown game-3d workload scenario',
  );
  if (scenario === 'stock-corridor') return stockCorridorReceipt(play);
  const started = now();
  let state;
  try {
    while (true) {
      if (play.signal?.aborted) throw play.signal.reason;
      state = await play.state(TOPIC);
      if (state?.error !== undefined || state?.busy !== true) return game3dWorkloadReceipt(state);
      const remaining = timeoutMs - (now() - started);
      assert(remaining > 0, 'Runtime vase producer did not finish before the admission deadline');
      await play.wait(Math.min(100, remaining));
    }
  } catch (error) {
    if (error instanceof Error)
      error.workload = { topic: TOPIC, state, elapsedMs: now() - started };
    throw error;
  }
}

async function stockCorridorReceipt(play) {
  const player = await play.state('game-3d.player');
  assertGame3dMotionPosition(player);
  assert.equal(player.mode, 'robot', 'Stock capture requires the ordinary robot player');
  assert.equal(player.transformProgress, 0);
  assert.equal(player.controls?.run, false);
  const renderer = await play.page.evaluate(() => globalThis.__forgeaxGameInspection.renderer());
  const execution = renderer?.execution;
  assert.equal(renderer?.state, 'alive');
  assert.equal(renderer.rendererError ?? null, null);
  assert.equal(execution?.fault ?? null, null);
  assert.equal(execution?.world?.health, 'healthy');
  assert.equal(execution?.workers?.engine?.enabled, true);
  assert.equal(execution?.workers?.render?.enabled, true);
  assert.equal(execution?.render?.capabilities?.backendKind, 'webgpu');
  assert(typeof execution.world.identity === 'string' && execution.world.identity.length > 0);
  assert(Number.isSafeInteger(execution.render.epoch) && execution.render.epoch > 0);
  return {
    topic: 'game-3d.player',
    scenario: 'stock-corridor',
    worldIdentity: execution.world.identity,
    renderEpoch: execution.render.epoch,
    mode: player.mode,
    transformProgress: player.transformProgress,
    backend: execution.render.capabilities.backendKind,
    engineWorker: true,
    renderWorker: true,
  };
}

/** Publication/mesh/parameters must still be the same after the capture and its pause recovery. */
export async function assertGame3dWorkloadStable(play, receipt) {
  if (receipt.scenario === 'stock-corridor') {
    const current = await stockCorridorReceipt(play);
    assert.deepEqual(
      current,
      receipt,
      'Stock corridor runtime identity changed during the capture',
    );
    return current;
  }
  const state = await play.state(TOPIC);
  try {
    const current = game3dWorkloadReceipt(state);
    assert.deepEqual(
      current,
      receipt,
      'Runtime vase publication changed during the measured capture',
    );
    return current;
  } catch (error) {
    if (error instanceof Error) error.workload = { topic: TOPIC, state, initial: receipt };
    throw error;
  }
}
