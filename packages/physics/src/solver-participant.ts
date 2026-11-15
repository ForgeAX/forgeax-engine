import type { Result } from '@forgeax/engine-types';
import type {
  PhysicsBodyDynamics,
  PhysicsBodyForceInput,
  PhysicsBodyTorqueInput,
  PhysicsFixedError,
} from './fixed-dynamics.js';
import type { PhysicsWorld } from './physics-world.js';

export const PHYSICS_SOLVER_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export type PhysicsSolverClock = Readonly<{
  completedStep: number;
  simulationTimeSeconds: number;
  externalTimeSeconds: number;
  resultsTimeSeconds: number;
  interpolationDelaySteps: number;
}>;

export type PhysicsSolverTask = Readonly<{
  taskId: number;
  entity: number;
  entityGeneration: number;
  sourceStep: number;
  solveStep: number;
  referenceTimeSeconds: number;
  snapshotHash: string;
  /** Detached serialized input. No backend objects or producer closures cross this boundary. */
  payload: Uint8Array;
}>;

export type PhysicsSolverOutput = Omit<PhysicsSolverTask, 'payload'> &
  Readonly<{
    outputTimestampSeconds: number;
    completedStep: number;
    inputReleased: true;
    result: Result<Uint8Array, PhysicsFixedError>;
  }>;

/** Valid only during this participant's callback, before the native integration. */
export interface PhysicsSolverStepContext {
  readonly solveStep: number;
  readonly deltaSeconds: number;
  readonly timestampSeconds: number;
  getBodyDynamics(entity: number): Result<PhysicsBodyDynamics, PhysicsFixedError>;
  applyForceAtPoint(input: PhysicsBodyForceInput): Result<void, PhysicsFixedError>;
  applyTorque(input: PhysicsBodyTorqueInput): Result<void, PhysicsFixedError>;
  readonly raycast: PhysicsWorld['raycast'];
  /** Nearest downward static, non-sensor collision from the captured Terrain entity roster. */
  traceTerrainDown(
    positionM: readonly [number, number, number],
    terrainEntities: readonly number[],
    maxDistanceM: number,
  ): number | undefined;
}

export interface PhysicsSolverParticipant {
  readonly execution: 'inline-solver' | 'worker-solver';
  readonly asyncResults: boolean;
  readonly capacity: number;
  submit(input: PhysicsSolverTask): Result<void, PhysicsFixedError>;
  cancel(taskId: number): boolean;
  drain(): readonly PhysicsSolverOutput[];
  inspect(): Readonly<{
    queued: number;
    awaitingCompletion: number;
    outputs: number;
    accepted: number;
    backpressure: number;
    cancelled: number;
    stale: number;
    consumed: number;
    released: number;
  }>;
  dispose(): void;
}

export interface PhysicsSolverParticipantInput {
  readonly id: string;
  readonly capacity: number;
  /** Solver-owned code; each task and result is a detached byte payload. */
  readonly preSimulate?: (
    input: PhysicsSolverTask,
    context: PhysicsSolverStepContext,
  ) => Result<Uint8Array, PhysicsFixedError>;
  /** ESM module exporting processPhysicsSolverTask. Mutually exclusive with preSimulate. */
  readonly workerUrl?: string;
}
