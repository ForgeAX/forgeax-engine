import {
  PHYSICS_SOLVER_MAX_PAYLOAD_BYTES,
  PhysicsFixedError,
  type PhysicsSolverOutput,
  type PhysicsSolverParticipant,
  type PhysicsSolverParticipantInput,
  type PhysicsSolverStepContext,
  type PhysicsSolverTask,
} from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';

const failure = (entity: number, reason: string) =>
  new PhysicsFixedError('fixed-input-invalid', { entity, reason });

/** The native World owns input admission, solver reads and completed output lifetime. */
export class SolverParticipants {
  private readonly participants = new Map<
    string,
    {
      input: PhysicsSolverParticipantInput;
      queued: PhysicsSolverTask[];
      completing: PhysicsSolverOutput[];
      outputs: PhysicsSolverOutput[];
      reading: PhysicsSolverTask[];
      cancelled: Set<number>;
      disposed: boolean;
      counters: {
        accepted: number;
        backpressure: number;
        cancelled: number;
        stale: number;
        consumed: number;
        released: number;
      };
    }
  >();

  constructor(private readonly canSubmit: () => boolean = () => true) {}

  get hasWorker(): boolean {
    return [...this.participants.values()].some(
      (record) => !record.disposed && record.input.workerUrl !== undefined,
    );
  }

  create(
    input: PhysicsSolverParticipantInput,
  ): Result<PhysicsSolverParticipant, PhysicsFixedError> {
    if (
      [...this.participants.values()].some(
        (record) => !record.disposed && record.input.workerUrl !== input.workerUrl,
      )
    )
      return err(failure(0, 'one native World admits one solver execution mode and worker module'));
    if (
      !input.id ||
      this.participants.has(input.id) ||
      !Number.isInteger(input.capacity) ||
      input.capacity < 1 ||
      input.capacity > 256
    )
      return err(failure(0, 'solver participant requires a unique id and capacity in [1, 256]'));
    const record = {
      input,
      queued: [] as PhysicsSolverTask[],
      completing: [] as PhysicsSolverOutput[],
      outputs: [] as PhysicsSolverOutput[],
      reading: [] as PhysicsSolverTask[],
      cancelled: new Set<number>(),
      disposed: false,
      counters: { accepted: 0, backpressure: 0, cancelled: 0, stale: 0, consumed: 0, released: 0 },
    };
    this.participants.set(input.id, record);
    let disposed = false;
    return ok({
      execution: input.workerUrl === undefined ? 'inline-solver' : 'worker-solver',
      asyncResults: input.workerUrl !== undefined,
      capacity: input.capacity,
      submit: (task) => {
        if (disposed) return err(failure(task.entity, 'solver participant was disposed'));
        if (!this.canSubmit())
          return err(
            new PhysicsFixedError('fixed-operation-unavailable', {
              entity: task.entity,
              reason: 'submit only before integration at an admitted fixed-step source fence',
            }),
          );
        if (
          ![task.taskId, task.entity, task.entityGeneration, task.sourceStep, task.solveStep].every(
            (v) => Number.isSafeInteger(v) && v >= 0,
          ) ||
          task.solveStep <= task.sourceStep ||
          !Number.isFinite(task.referenceTimeSeconds) ||
          !task.snapshotHash ||
          !(task.payload instanceof Uint8Array) ||
          task.payload.byteLength === 0 ||
          task.payload.byteLength > PHYSICS_SOLVER_MAX_PAYLOAD_BYTES ||
          [...this.participants.values()].some((owner) =>
            [...owner.queued, ...owner.reading, ...owner.completing, ...owner.outputs].some(
              (v) => v.taskId === task.taskId,
            ),
          )
        )
          return err(failure(task.entity, 'invalid, duplicate or oversized solver task'));
        if (
          record.queued.length +
            record.reading.length +
            record.completing.length +
            record.outputs.length >=
          input.capacity
        ) {
          record.counters.backpressure++;
          return err(
            new PhysicsFixedError('fixed-operation-unavailable', {
              entity: task.entity,
              reason: 'solver input/output queue is full; drain or cancel before resubmitting',
            }),
          );
        }
        record.queued.push(Object.freeze({ ...task, payload: task.payload.slice() }));
        record.counters.accepted++;
        return ok(undefined);
      },
      cancel: (taskId) => {
        if (record.reading.some((task) => task.taskId === taskId)) {
          if (!record.cancelled.has(taskId)) record.counters.cancelled++;
          record.cancelled.add(taskId);
          return true;
        }
        const pending = record.queued.find((task) => task.taskId === taskId);
        if (pending) {
          pending.payload.fill(0);
          record.counters.released++;
        }
        const size = record.queued.length + record.completing.length + record.outputs.length;
        record.queued = record.queued.filter((task) => task.taskId !== taskId);
        record.completing = record.completing.filter((task) => task.taskId !== taskId);
        record.outputs = record.outputs.filter((task) => task.taskId !== taskId);
        const removed =
          size !== record.queued.length + record.completing.length + record.outputs.length;
        if (removed) record.counters.cancelled++;
        return removed;
      },
      drain: () => {
        const outputs = record.outputs;
        record.outputs = [];
        return outputs;
      },
      inspect: () =>
        Object.freeze({
          queued: record.queued.length,
          awaitingCompletion: record.completing.length + record.reading.length,
          outputs: record.outputs.length,
          ...record.counters,
        }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        record.disposed = true;
        for (const task of record.reading) record.cancelled.add(task.taskId);
        for (const task of record.queued) {
          task.payload.fill(0);
          record.counters.released++;
        }
        // In-flight payloads stay retained until the worker acknowledges its read.
        record.queued = [];
        record.completing = [];
        record.outputs = [];
        if (record.reading.length === 0) this.participants.delete(input.id);
      },
    });
  }

  preSimulate(context: PhysicsSolverStepContext): void {
    for (const record of this.participants.values()) {
      if (record.disposed || record.input.workerUrl !== undefined) continue;
      const queued = record.queued;
      record.queued = [];
      for (const task of queued) {
        if (task.solveStep > context.solveStep) {
          record.queued.push(task);
          continue;
        }
        const { payload, ...identity } = task;
        let result: PhysicsSolverOutput['result'];
        const dynamics = context.getBodyDynamics(task.entity);
        if (
          task.solveStep !== context.solveStep ||
          !dynamics.ok ||
          dynamics.value.generation !== task.entityGeneration ||
          dynamics.value.completedStep !== task.sourceStep
        ) {
          record.counters.stale++;
          result = err(
            new PhysicsFixedError('fixed-step-stale', {
              entity: task.entity,
              reason: 'solver task no longer matches its exact source/body/solve fence',
              expected: context.solveStep,
              actual: task.solveStep,
            }),
          );
        } else {
          record.counters.consumed++;
          try {
            const computed =
              record.input.preSimulate?.(task, context) ??
              err(failure(task.entity, 'worker-only participant cannot execute inline'));
            result = computed.ok ? ok(computed.value.slice()) : computed;
          } catch (cause) {
            result = err(
              new PhysicsFixedError('fixed-input-invalid', {
                entity: task.entity,
                reason: `solver participant failed: ${String(cause)}`,
              }),
            );
          }
        }
        payload.fill(0);
        record.counters.released++;
        record.completing.push(
          Object.freeze({
            ...identity,
            outputTimestampSeconds: context.timestampSeconds,
            completedStep: context.solveStep,
            inputReleased: true,
            result,
          }),
        );
      }
    }
  }

  complete(step: number): void {
    for (const record of this.participants.values()) {
      record.outputs.push(...record.completing.filter((output) => output.completedStep === step));
      record.completing = record.completing.filter((output) => output.completedStep > step);
    }
  }

  takeWorkerTasks(solveStep: number): readonly PhysicsSolverTask[] {
    const tasks: PhysicsSolverTask[] = [];
    for (const record of this.participants.values()) {
      if (!record.input.workerUrl || record.disposed) continue;
      const ready = record.queued.filter((task) => task.solveStep <= solveStep);
      record.reading.push(...ready);
      tasks.push(...ready.map((task) => ({ ...task, payload: task.payload.slice() })));
      record.counters.consumed += ready.length;
      record.queued = record.queued.filter((task) => task.solveStep > solveStep);
    }
    return tasks;
  }

  acknowledgeWorker(outputs: readonly PhysicsSolverOutput[]): void {
    for (const record of this.participants.values()) {
      for (const task of record.reading) {
        task.payload.fill(0);
        record.counters.released++;
        const output = outputs.find(
          (value) =>
            value.taskId === task.taskId &&
            value.entity === task.entity &&
            value.snapshotHash === task.snapshotHash,
        );
        if (output && !record.cancelled.has(task.taskId) && !record.disposed)
          record.completing.push(output);
        else record.counters.stale++;
      }
      record.reading = [];
      record.cancelled.clear();
      if (record.disposed) this.participants.delete(record.input.id);
    }
  }

  dispose(): void {
    for (const record of this.participants.values())
      for (const task of [...record.queued, ...record.reading]) task.payload.fill(0);
    this.participants.clear();
  }
}
