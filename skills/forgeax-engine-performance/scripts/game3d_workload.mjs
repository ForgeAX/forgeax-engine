import assert from 'node:assert/strict';

const TOPIC = 'game-3d.runtime-vase';
const DEFAULTS = Object.freeze({ height: 2.4, radius: 0.75, sides: 32 });

/** Read the actual producer projection, including failures hidden by a preserved old mesh. */
export function game3dWorkloadReceipt(state) {
  assert(state && typeof state === 'object', 'Runtime vase producer state is unavailable');
  assert(state.error === undefined, 'Runtime vase generation failed: ' + JSON.stringify(state.error));
  assert.equal(state.busy, false, 'Runtime vase generation is still busy');
  assert(typeof state.guid === 'string' && state.guid.length > 0, 'Missing runtime vase GUID');
  assert(Number.isSafeInteger(state.generation) && state.generation > 0, 'Missing runtime vase publication generation');
  assert(Number.isSafeInteger(state.entity) && state.entity >= 0, 'Missing bound runtime vase entity');
  assert.deepEqual(state.values, DEFAULTS, 'Measured vase parameters differ from the selected stock workload');
  assert.equal(state.vertexCount, 495, 'Measured vase geometry differs from the stock generated mesh');
  assert(Array.isArray(state.aabb) && state.aabb.length === 6 && state.aabb.every(Number.isFinite), 'Invalid runtime vase bounds');
  for (let axis = 0; axis < 3; axis++)
    assert(state.aabb[axis] <= state.aabb[axis + 3], 'Inverted runtime vase bounds');
  return { topic: TOPIC, guid: state.guid, generation: state.generation, entity: state.entity,
    values: { ...state.values }, vertexCount: state.vertexCount, aabb: [...state.aabb] };
}

/** Busy is an ordinary bounded startup wait; a terminal producer error is never retried here. */
export async function admitGame3dWorkload(play, { timeoutMs = 15000, now = () => performance.now() } = {}) {
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
    if (error instanceof Error) error.workload = { topic: TOPIC, state, elapsedMs: now() - started };
    throw error;
  }
}

/** Publication/mesh/parameters must still be the same after the capture and its pause recovery. */
export async function assertGame3dWorkloadStable(play, receipt) {
  const state = await play.state(TOPIC);
  try {
    const current = game3dWorkloadReceipt(state);
    assert.deepEqual(current, receipt, 'Runtime vase publication changed during the measured capture');
    return current;
  } catch (error) {
    if (error instanceof Error) error.workload = { topic: TOPIC, state, initial: receipt };
    throw error;
  }
}
