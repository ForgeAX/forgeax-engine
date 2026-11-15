import { INPUT_BACKEND_KEY, INPUT_MAP_KEY, INPUT_SNAPSHOT_RESOURCE_KEY } from './resources';

// frame-start-scan-system.ts -- bridges an `InputBackend` producer into
// the `InputSnapshot` Resource consumed by user systems (charter P5).
//
// Plan-strategy section 2.10 D-5 locks the system to a frame-start position
// in the schedule: user systems declare `after: [InputFrameStartScan]`
// to read the snapshot. The system itself holds zero queries; it only
// pulls one sample from the backend and writes the Resource.
//
// The backend is supplied via the `InputBackend` World resource rather than a
// captured closure. Resource reads remain explicit in the system body.

import { defineSystem, defineSystemSet, type System } from '@forgeax/engine-ecs';
import { deriveActionStates } from './action-state';
import { snapshotFromSample } from './input-snapshot';

export const InputSet = defineSystemSet({ name: 'input' });

/**
 * The frame-start scan system token (M2 — full resource-ification, D-4).
 *
 * Module-level `defineSystem` with the real fn body — no factory, no closure.
 * Each `world.update()` tick:
 *   1. reads the {@link InputBackend} from `INPUT_BACKEND_KEY` and calls
 *      `backend.sample()` once to atomically drain the per-frame accumulators
 *      (movement delta plus key/code/button press and release edge sets);
 *   2. derives a fresh `InputSnapshot` via `snapshotFromSample`;
 *   3. writes it under `INPUT_SNAPSHOT_RESOURCE_KEY` via
 *      `world.insertResource` -- idempotent overwrite, charter P4
 *      consistent abstraction (consumers always read the same Resource key
 *      regardless of which backend produced the sample).
 *
 * Labelled `'input'` (spec §6.2 label-anchor map).
 */
export const InputFrameStartScan: System<readonly []> = defineSystem({
  name: 'input-frame-start-scan',
  queries: [],
  fn: (world) => {
    const backend = world.getResource(INPUT_BACKEND_KEY);
    const sample = backend.sample();
    backend.feedback?.acceptResults(sample.feedbackResults ?? [], sample.feedbackLostResults ?? 0);

    const previousSnapshot = world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)
      ? world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY)
      : undefined;
    const actionStates = world.hasResource(INPUT_MAP_KEY)
      ? deriveActionStates(
          sample,
          world.getResource(INPUT_MAP_KEY),
          (action) => previousSnapshot?.action(action).isPressed() ?? false,
        )
      : undefined;
    const snapshot = snapshotFromSample(sample, actionStates, previousSnapshot);
    world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, snapshot);
  },
});
