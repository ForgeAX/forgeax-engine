import { vec3 } from '@forgeax/engine-math';
import {
  type PhysicsBodyDynamics,
  PhysicsFixedError,
  type PhysicsSolverOutput,
  type PhysicsSolverParticipantInput,
  type PhysicsSolverStepContext,
  type PhysicsSolverTask,
  type PhysicsVector,
} from '@forgeax/engine-physics';
import { err, ok } from '@forgeax/engine-types';
import { loadRapier3D } from './wasm-loader.js';

export interface RapierSolverWorkerRequest {
  readonly kind: 'step';
  readonly sequence: number;
  readonly snapshot: Uint8Array;
  readonly deltaSeconds: number;
  readonly solveStep: number;
  readonly sourceStep: number;
  readonly timestampSeconds: number;
  readonly bodies: readonly {
    readonly entity: number;
    readonly generation: number;
    readonly handle: number;
  }[];
  readonly tasks: readonly PhysicsSolverTask[];
  readonly isolatedBodyPairs: readonly (readonly [number, number])[];
}

export interface RapierSolverWorkerResponse {
  readonly kind: 'completed';
  readonly sequence: number;
  readonly snapshot: Uint8Array;
  readonly outputs: readonly PhysicsSolverOutput[];
  readonly collisions: readonly (readonly [number, number, boolean])[];
}

/** Install backend code inside a module Worker. The processor never receives a native object. */
export async function runRapierSolverWorker(
  preSimulate: NonNullable<PhysicsSolverParticipantInput['preSimulate']>,
): Promise<void> {
  const rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
  const port = globalThis as unknown as {
    onmessage: ((event: MessageEvent<RapierSolverWorkerRequest>) => void) | null;
    postMessage(value: unknown, transfer?: Transferable[]): void;
  };
  port.onmessage = ({ data: request }) => {
    if (request.kind !== 'step') return;
    const raw = rapier.World.restoreSnapshot(request.snapshot);
    const queue = new rapier.EventQueue(true);
    const bodies = new Map(request.bodies.map((body) => [body.entity, body]));
    const tuple = (v: { x: number; y: number; z: number }): PhysicsVector => [v.x, v.y, v.z];
    const nativeBody = (entity: number) => {
      const identity = bodies.get(entity);
      return identity === undefined ? undefined : raw.getRigidBody(identity.handle);
    };
    for (const identity of request.bodies) {
      const body = nativeBody(identity.entity);
      if (body) body.userData = identity.entity;
    }
    let reading = true;
    let callbackSequence = 0;
    const fail = (entity: number, reason: string) =>
      err(new PhysicsFixedError('fixed-step-stale', { entity, reason }));
    const dynamics = (entity: number) => {
      if (!reading) return fail(entity, 'solver callback read window has ended');
      const identity = bodies.get(entity),
        body = nativeBody(entity);
      if (!identity || !body) return fail(entity, 'solver body is unavailable');
      const q = body.rotation(),
        iq = body.principalInertiaLocalFrame();
      return ok<PhysicsBodyDynamics>({
        entity,
        generation: identity.generation,
        completedStep: request.sourceStep,
        nextFixedStep: request.solveStep,
        massKg: body.mass(),
        positionM: tuple(body.translation()),
        rotation: [q.x, q.y, q.z, q.w],
        centerOfMassM: tuple(body.worldCom()),
        localCenterOfMassM: tuple(body.localCom()),
        linearVelocityMps: tuple(body.linvel()),
        angularVelocityRadps: tuple(body.angvel()),
        principalInertiaKgM2: tuple(body.principalInertia()),
        principalInertiaLocalRotation: [iq.x, iq.y, iq.z, iq.w],
      });
    };
    const admit = (input: { entity: number; generation: number; fixedStep: number }) => {
      if (!reading) return undefined;
      const body = nativeBody(input.entity),
        identity = bodies.get(input.entity);
      return body?.isDynamic() &&
        identity?.generation === input.generation &&
        input.fixedStep === request.solveStep
        ? body
        : undefined;
    };
    const createContext = (): PhysicsSolverStepContext => {
      const callback = ++callbackSequence;
      const canRead = () => reading && callback === callbackSequence;
      return {
        solveStep: request.solveStep,
        deltaSeconds: request.deltaSeconds,
        timestampSeconds: request.timestampSeconds,
        getBodyDynamics: (entity) =>
          canRead() ? dynamics(entity) : fail(entity, 'solver callback read window has ended'),
        applyForceAtPoint: (input) => {
          if (!canRead()) return fail(input.entity, 'solver callback read window has ended');
          const body = admit(input);
          if (!body || ![...input.forceN, ...input.pointM].every(Number.isFinite))
            return fail(input.entity, 'force does not match the current solver step');
          body.addForceAtPoint(
            { x: input.forceN[0], y: input.forceN[1], z: input.forceN[2] },
            { x: input.pointM[0], y: input.pointM[1], z: input.pointM[2] },
            true,
          );
          return ok(undefined);
        },
        applyTorque: (input) => {
          if (!canRead()) return fail(input.entity, 'solver callback read window has ended');
          const body = admit(input);
          if (!body || !input.torqueNm.every(Number.isFinite))
            return fail(input.entity, 'torque does not match the current solver step');
          body.addTorque(
            { x: input.torqueNm[0], y: input.torqueNm[1], z: input.torqueNm[2] },
            true,
          );
          return ok(undefined);
        },
        raycast: (origin, direction, maxDistance, filterMask) => {
          if (!canRead()) return undefined;
          const ray = new rapier.Ray(
            { x: origin[0], y: origin[1], z: origin[2] },
            { x: direction[0], y: direction[1], z: direction[2] },
          );
          const hit = raw.castRayAndGetNormal(ray, maxDistance, true, undefined, filterMask);
          if (!hit) return undefined;
          const point = ray.pointAt(hit.timeOfImpact);
          return {
            entity: hit.collider.parent()?.userData ?? 0,
            point: vec3.create(point.x, point.y, point.z),
            normal: vec3.create(hit.normal.x, hit.normal.y, hit.normal.z),
            timeOfImpact: hit.timeOfImpact,
          };
        },
        traceTerrainDown: (position, terrainEntities, maxDistance) => {
          if (!canRead() || !(maxDistance > 0) || !position.every(Number.isFinite))
            return undefined;
          const roster = new Set(terrainEntities);
          const ray = new rapier.Ray(
            { x: position[0], y: position[1], z: position[2] },
            { x: 0, y: -1, z: 0 },
          );
          const hit = raw.castRay(
            ray,
            maxDistance,
            true,
            undefined,
            undefined,
            undefined,
            undefined,
            (collider: import('../pkg/rapier.mjs').Collider) => {
              const body = collider.parent();
              return (
                !collider.isSensor() &&
                body?.isFixed() === true &&
                roster.has(body.userData as number)
              );
            },
          );
          return hit ? position[1] - hit.timeOfImpact : undefined;
        },
      };
    };
    const outputs: PhysicsSolverOutput[] = [];
    try {
      for (const task of request.tasks) {
        const { payload, ...identity } = task;
        let result: PhysicsSolverOutput['result'];
        const body = dynamics(task.entity);
        if (
          task.solveStep !== request.solveStep ||
          task.sourceStep !== request.sourceStep ||
          !body.ok ||
          body.value.generation !== task.entityGeneration
        )
          result = fail(task.entity, 'serialized input body/source/solve generation is stale');
        else {
          const context = createContext();
          try {
            result = preSimulate(task, context);
          } catch (cause) {
            result = fail(task.entity, String(cause));
          } finally {
            callbackSequence++;
          }
        }
        payload.fill(0);
        outputs.push({
          ...identity,
          completedStep: request.solveStep,
          outputTimestampSeconds: request.timestampSeconds,
          inputReleased: true,
          result,
        });
      }
      reading = false;
      raw.timestep = request.deltaSeconds;
      const isolated = new Set(
        request.isolatedBodyPairs.flatMap(([a, b]) => [`${a}:${b}`, `${b}:${a}`]),
      );
      raw.step(
        queue,
        isolated.size === 0
          ? undefined
          : {
              filterContactPair: (_a: number, _b: number, a: number, b: number) =>
                isolated.has(`${a}:${b}`) ? null : rapier.SolverFlags.COMPUTE_IMPULSES,
              filterIntersectionPair: (_a: number, _b: number, a: number, b: number) =>
                !isolated.has(`${a}:${b}`),
            },
      );
      raw.forEachRigidBody(
        (body: { resetForces(wake: boolean): void; resetTorques(wake: boolean): void }) => {
          body.resetForces(false);
          body.resetTorques(false);
        },
      );
      const collisions: (readonly [number, number, boolean])[] = [];
      queue.drainCollisionEvents((a: number, b: number, started: boolean) =>
        collisions.push([a, b, started]),
      );
      const snapshot: Uint8Array = raw.takeSnapshot();
      const response: RapierSolverWorkerResponse = {
        kind: 'completed',
        sequence: request.sequence,
        snapshot,
        outputs,
        collisions,
      };
      const wire = {
        ...response,
        outputs: outputs.map((output) => ({
          ...output,
          result: output.result.ok
            ? output.result
            : {
                ok: false,
                error: {
                  code: output.result.error.code,
                  detail: output.result.error.detail,
                },
              },
        })),
      };
      port.postMessage(wire, [snapshot.buffer as ArrayBuffer]);
    } catch (cause) {
      port.postMessage({ kind: 'failed', sequence: request.sequence, reason: String(cause) });
    } finally {
      reading = false;
      try {
        queue.free();
      } finally {
        raw.free();
      }
    }
  };
  port.postMessage({ kind: 'ready' });
}
