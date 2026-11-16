import { defineSystem, FixedUpdate, Update, World } from '@forgeax/engine-ecs';
import {
  Collider,
  type PhysicsSolverStepContext,
  RigidBody,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { type RapierSolverWorkerRequest, runRapierSolverWorker } from '../solver-worker';
import { loadRapier3D } from '../wasm-loader';

// Controlled acknowledgement transport tests native ownership fences, not Worker integration.
class AcknowledgementWorker {
  static active: AcknowledgementWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  request: RapierSolverWorkerRequest | undefined;
  terminated = false;
  constructor() {
    AcknowledgementWorker.active = this;
  }
  postMessage(message: RapierSolverWorkerRequest | { kind: 'initialize' }): void {
    if (message.kind === 'initialize')
      queueMicrotask(() => this.onmessage?.({ data: { kind: 'ready' } }));
    else this.request = message;
  }
  acknowledge(): void {
    const request = this.request;
    if (!request) throw new Error('No controlled solver request');
    this.request = undefined;
    this.onmessage?.({
      data: {
        kind: 'completed',
        sequence: request.sequence,
        snapshot: request.snapshot,
        outputs: [],
        collisions: [],
      },
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

async function fixture(asyncResultsInterpolation = true, maxStepsPerUpdate = 2) {
  vi.stubGlobal('Worker', AcknowledgementWorker);
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module, { asyncResultsInterpolation });
  const world = new World({ time: { fixedDeltaSeconds: 0.01, maxStepsPerUpdate } });
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  const release = registerPhysicsComponents(world);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: RigidBody, data: { gravityScale: 0 } },
      { component: Collider, data: {} },
    )
    .unwrap();
  physics._syncFromEcs(world, Transform);
  const step = defineSystem({ name: 'step', queries: [], fn: () => physics.step(0.01) });
  const publish = defineSystem({
    name: 'publish',
    after: [step],
    queries: [],
    fn: () => physics.finalizeDerivedFixedStep(),
  });
  world.addSystem(FixedUpdate, step).unwrap();
  world.addSystem(FixedUpdate, publish).unwrap();
  return { physics, world, entity, release, module, publish };
}
const microtasks = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};
afterEach(() => vi.unstubAllGlobals());

describe('solver Worker lifetime and results clock', () => {
  it('refuses host motion commands during an in-flight solve without native access or World poison', async () => {
    const f = await fixture();
    try {
      f.physics
        .createSolverParticipant({
          id: 'motion-fence',
          capacity: 4,
          workerUrl: 'https://example.invalid/processor.mjs',
        })
        .unwrap();
      const motion = {
        position: [3, 4, 5] as const,
        rotation: [0, 0, 0, 1] as const,
        linearVelocity: [1, 0, 0] as const,
        angularVelocity: [0, 1, 0] as const,
      };
      const candidateInput = {
        entity: f.entity,
        revision: 1,
        sourceKey: 'motion-fence',
        shapes: [
          {
            kind: 'convex-compound' as const,
            id: 'sensor',
            revision: 1,
            isSensor: true,
            pieces: [new Float32Array([-1, -1, -1, 1, -1, -1, -1, 1, -1, -1, -1, 1])],
            origin: [0, 0, 0] as const,
          },
        ],
      };
      const prepared = f.physics.prepareDerivedShapeCandidate(candidateInput).unwrap();
      const snapshot = f.physics.captureDerivedPhysicsState();
      const nativeReads = vi.spyOn(f.physics.raw, 'getRigidBody');
      f.world
        .addSystem(
          Update,
          defineSystem({
            name: 'host-motion-command',
            after: [FixedUpdate],
            queries: [],
            fn: () => {
              nativeReads.mockClear();
              expect(f.physics.setBodyMotion(f.entity, motion)).toMatchObject({
                ok: false,
                error: { code: 'managed-physics-unavailable' },
              });
              expect(f.physics.applyBodyImpulse(f.entity, [1, 0, 0])).toMatchObject({
                ok: false,
                error: { code: 'managed-physics-unavailable' },
              });
              expect(f.physics.createManagedJoints([])).toMatchObject({
                ok: false,
                error: { code: 'managed-physics-unavailable' },
              });
              for (const result of [
                f.physics.prepareDerivedShapeCandidate(candidateInput),
                f.physics.prepareDerivedShapeCandidates([candidateInput]),
                f.physics.prepareDerivedBodyTypeCandidates([]),
                f.physics.admitDerivedShapeCandidate(prepared),
                f.physics.admitDerivedShapeCandidates([prepared]),
                f.physics.admitDerivedShapeCandidateGroups([[prepared]]),
                f.physics.admitDerivedShapeCandidatesGuarded([prepared], () => true),
                f.physics.cancelDerivedShapeCandidate(prepared),
                f.physics.applyDerivedImpulse({
                  entity: f.entity,
                  sourceKey: 'motion-fence',
                  revision: 1,
                  impulse: [1, 0, 0],
                  point: [0, 0, 0],
                }),
                f.physics.restoreDerivedPhysicsState(snapshot),
                f.physics.removeDerivedConstraint('motion-fence'),
              ])
                expect(result).toMatchObject({
                  ok: false,
                  error: { code: 'derived-candidate-pending' },
                });
              expect(nativeReads).not.toHaveBeenCalled();
            },
          }),
        )
        .unwrap();
      f.world.update(0.01).unwrap();
      await microtasks();
      expect(f.world.execution.health).toBe('healthy');
      AcknowledgementWorker.active.acknowledge();
      await microtasks();
      nativeReads.mockRestore();
      f.physics.setBodyMotion(f.entity, motion).unwrap();
      expect(f.physics.getBodyMotion(f.entity).unwrap()).toMatchObject(motion);
    } finally {
      f.physics.dispose();
      f.release();
    }
  });

  it.each([
    'completed',
    'failure',
    'next-callback',
  ] as const)('rejects a retained callback context before native access after %s', async (finish) => {
    const f = await fixture();
    let held: PhysicsSolverStepContext | undefined;
    const messages: { kind: string }[] = [];
    vi.stubGlobal('postMessage', (value: { kind: string }) => {
      messages.push(value);
    });
    vi.stubGlobal('onmessage', null);
    const nativeReads = vi.spyOn(Object.getPrototypeOf(f.physics.raw), 'getRigidBody');
    try {
      f.world.update(0.01).unwrap();
      const generation = f.physics.getCommittedBodyDynamics(f.entity).unwrap().generation;
      const assertReleased = (context: PhysicsSolverStepContext) => {
        nativeReads.mockClear();
        expect(context.getBodyDynamics(f.entity)).toMatchObject({
          ok: false,
          error: { code: 'fixed-step-stale' },
        });
        expect(
          context.applyForceAtPoint({
            entity: f.entity,
            generation,
            fixedStep: 2,
            forceN: [0, 1, 0],
            pointM: [0, 0, 0],
          }),
        ).toMatchObject({ ok: false, error: { code: 'fixed-step-stale' } });
        expect(
          context.applyTorque({ entity: f.entity, generation, fixedStep: 2, torqueNm: [0, 1, 0] }),
        ).toMatchObject({ ok: false, error: { code: 'fixed-step-stale' } });
        expect(nativeReads).not.toHaveBeenCalled();
      };
      const bodies: { entity: number; generation: number; handle: number }[] = [];
      f.physics.raw.forEachRigidBody((body: { handle: number }) => {
        bodies.push({ entity: f.entity, generation, handle: body.handle });
      });
      await runRapierSolverWorker((task, context) => {
        if (held) assertReleased(held);
        held = context;
        expect(context.getBodyDynamics(f.entity).ok).toBe(true);
        if (finish === 'failure')
          structuredClone(task.payload, { transfer: [task.payload.buffer as ArrayBuffer] });
        return ok(new Uint8Array([1]));
      });
      const receive = (
        globalThis as unknown as { onmessage(event: { data: RapierSolverWorkerRequest }): void }
      ).onmessage;
      receive({
        data: {
          kind: 'step',
          sequence: 1,
          snapshot: f.physics.raw.takeSnapshot(),
          deltaSeconds: 0.01,
          solveStep: 2,
          sourceStep: 1,
          timestampSeconds: 0.01,
          bodies,
          isolatedBodyPairs: [],
          tasks: Array.from({ length: finish === 'next-callback' ? 2 : 1 }, (_, index) => ({
            taskId: index + 1,
            entity: f.entity,
            entityGeneration: generation,
            sourceStep: 1,
            solveStep: 2,
            referenceTimeSeconds: 0,
            snapshotHash: 'test',
            payload: new Uint8Array([1]),
          })),
        },
      });
      expect(messages.at(-1)?.kind).toBe(finish === 'failure' ? 'failed' : 'completed');
      if (finish !== 'failure')
        expect(messages.at(-1)).toMatchObject({
          outputs: Array.from({ length: finish === 'next-callback' ? 2 : 1 }, () => ({
            result: { ok: true },
          })),
        });
      expect(held).toBeDefined();
      if (!held) throw new Error('Solver callback did not execute');
      assertReleased(held);
    } finally {
      nativeReads.mockRestore();
      f.physics.dispose();
      f.release();
    }
  });

  it.each([
    true,
    false,
  ])('excludes suspended debt without clock reversal across the four-step budget (interpolate=%s)', async (interpolate) => {
    const f = await fixture(interpolate, 4);
    try {
      f.physics
        .createSolverParticipant({
          id: 'clock-debt',
          capacity: 4,
          workerUrl: 'https://example.invalid/processor.mjs',
        })
        .unwrap();
      const completedClocks: ReturnType<typeof f.physics.getSolverClock>[] = [];
      f.world
        .addSystem(
          FixedUpdate,
          defineSystem({
            name: 'clock',
            after: [f.publish],
            queries: [],
            fn: () => {
              completedClocks.push(f.physics.getSolverClock());
            },
          }),
        )
        .unwrap();
      f.world.update(0.015).unwrap();
      await microtasks();
      expect(f.physics.getSolverClock().simulationTimeSeconds).toBe(0);
      expect(f.physics.getCommittedBodyDynamics(f.entity)).toMatchObject({
        ok: true,
        value: { completedStep: 0 },
      });
      expect(
        f.physics.applyBodyForceAtPoint({
          entity: f.entity,
          generation: 1,
          fixedStep: 1,
          forceN: [0, 1, 0],
          pointM: [0, 0, 0],
        }),
      ).toMatchObject({ ok: false, error: { code: 'fixed-operation-unavailable' } });
      let previousExternalTime = f.physics.getSolverClock().externalTimeSeconds;
      for (let index = 0; index < 4; index++) {
        f.world.update(0.04).unwrap();
        const clock = f.physics.getSolverClock();
        expect(clock.externalTimeSeconds).toBeGreaterThanOrEqual(previousExternalTime);
        expect(clock.externalTimeSeconds).toBeLessThanOrEqual(clock.simulationTimeSeconds + 0.01);
        previousExternalTime = clock.externalTimeSeconds;
      }
      for (let index = 0; index < 4; index++) {
        AcknowledgementWorker.active.acknowledge();
        await microtasks();
      }
      expect(completedClocks).toHaveLength(4);
      for (const clock of completedClocks) {
        expect(clock.externalTimeSeconds).toBeGreaterThanOrEqual(previousExternalTime);
        expect(clock.externalTimeSeconds - clock.simulationTimeSeconds).toBeCloseTo(0.005, 10);
        expect(clock.resultsTimeSeconds).toBeCloseTo(
          clock.simulationTimeSeconds + (interpolate ? -0.015 : 0.005),
          10,
        );
        previousExternalTime = clock.externalTimeSeconds;
      }
      expect(f.physics.getSolverClock().externalTimeSeconds).toBeCloseTo(0.045, 10);
    } finally {
      f.physics.dispose();
      f.release();
    }
  });

  it.each([
    true,
    false,
  ])('uses the configured delay after sync-to-async transition (interpolate=%s)', async (interpolate) => {
    const f = await fixture(interpolate);
    try {
      f.world.update(0.055).unwrap();
      expect(f.physics.getSolverClock()).toMatchObject({
        simulationTimeSeconds: 0.02,
        interpolationDelaySteps: 0,
      });
      expect(f.physics.getSolverClock().externalTimeSeconds).toBeCloseTo(0.025, 12);
      const participant = f.physics
        .createSolverParticipant({
          id: 'clock',
          capacity: 4,
          workerUrl: 'https://example.invalid/processor.mjs',
        })
        .unwrap();
      expect(f.physics.getSolverClock().interpolationDelaySteps).toBe(interpolate ? 2 : 0);
      expect(f.physics.getSolverClock().resultsTimeSeconds).toBeCloseTo(
        interpolate ? 0.005 : 0.025,
        12,
      );
      f.world.update(0.01).unwrap();
      await microtasks();
      expect(AcknowledgementWorker.active.request?.timestampSeconds).toBe(0.02);
      AcknowledgementWorker.active.acknowledge();
      await microtasks();
      expect(f.physics.getSolverClock().simulationTimeSeconds).toBeCloseTo(0.03, 12);
      participant.dispose();
      expect(f.physics.getSolverClock().interpolationDelaySteps).toBe(0);
    } finally {
      f.physics.dispose();
      f.release();
    }
  });

  it.each([
    'acknowledge',
    'failure',
    'dispose',
  ] as const)('waits for the first pending source reader before retirement: %s', async (finish) => {
    const f = await fixture();
    try {
      f.physics
        .createSolverParticipant({
          id: 'retirement',
          capacity: 4,
          workerUrl: 'https://example.invalid/processor.mjs',
        })
        .unwrap();
      const prepared = f.physics
        .prepareDerivedShapeCandidate({
          entity: f.entity,
          revision: 1,
          sourceKey: 'water:first',
          shapes: [
            {
              kind: 'convex-compound',
              id: 'sensor',
              revision: 1,
              isSensor: true,
              pieces: [new Float32Array([-1, -1, -1, 1, -1, -1, -1, 1, -1, -1, -1, 1])],
              origin: [0, 0, 0],
            },
          ],
        })
        .unwrap();
      const token = f.physics.admitDerivedShapeCandidate(prepared).unwrap();
      f.world.update(0.01).unwrap();
      await microtasks();
      expect(f.physics.getDerivedPublication(f.entity)).toBeUndefined();
      let settled = false;
      const retirement = f.physics.retireDerivedSource(token).then((value) => {
        settled = true;
        return value;
      });
      await microtasks();
      expect(settled).toBe(false);
      if (finish === 'acknowledge') AcknowledgementWorker.active.acknowledge();
      else if (finish === 'failure')
        AcknowledgementWorker.active.onerror?.({ message: 'controlled worker failure' });
      else f.physics.dispose();
      const retired = await retirement;
      if (finish === 'failure')
        expect(retired).toMatchObject({ ok: false, error: { code: 'derived-backend-failed' } });
      else {
        expect(retired.ok, JSON.stringify(retired)).toBe(true);
        if (finish === 'acknowledge') {
          expect(f.physics.getDerivedPublication(f.entity)).toBeUndefined();
          expect(f.physics.raw.colliders.len()).toBe(1);
          expect(f.physics.hasBody(f.entity)).toBe(true);
        }
      }
    } finally {
      f.physics.dispose();
      f.release();
    }
  });
});
