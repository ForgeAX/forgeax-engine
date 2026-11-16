import type { PhysicsWorld } from './physics-world.js';

/** Interface availability only; per-body and completed-step Results remain authoritative. */
export function inspectPhysicsCapabilities(world: PhysicsWorld | undefined) {
  return {
    version: 1 as const,
    pointForce: typeof world?.applyBodyForceAtPoint === 'function',
    bodyDynamics: typeof world?.getCommittedBodyDynamics === 'function',
    sphereSweepAll: typeof world?.sweepSphereAll === 'function',
    sensorOverlap: typeof world?.getSensorOverlaps === 'function',
    solverParticipant: typeof world?.createSolverParticipant === 'function',
    solverClock: typeof world?.getSolverClock === 'function',
  };
}

export type PhysicsCapabilities = ReturnType<typeof inspectPhysicsCapabilities>;
