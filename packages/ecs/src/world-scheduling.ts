import type { Component } from './component';
import {
  createScheduleScopeMismatchError,
  createSystemFailedError,
  createTimeConfigInvalidError,
  createTimeDeltaInvalidError,
  isEcsFault,
} from './errors';
// @forgeax/engine-ecs -- World schedule and resource orchestration.

import { err, ok, type Result } from '@forgeax/engine-types';
import { type CommandBufferImpl, detachCommandBufferPayloads } from './commands';
import {
  type CommandFailedError,
  type CyclicDependencyError,
  type ScheduleScopeMismatchError,
  type SharedKernelFailureError,
  type SystemFailedError,
  type SystemSetNotRegisteredError,
  type TimeConfigInvalidError,
  type TimeDeltaInvalidError,
  type WorldPoisonedError,
  worldPoisonedError,
} from './errors';
import {
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelDispatch,
} from './execution/shared-kernel';
import { DESCRIPTOR_ROLES, type QueryDescriptor } from './query/query';

import {
  buildSchedule,
  isSystemSet,
  runSchedule,
  type Schedule,
  type ScheduleNode,
  type System,
  type SystemDescriptor,
  type SystemSet,
  type SystemToken,
  addSystem as scheduleAddSystem,
  addSystems as scheduleAddSystems,
  removeSystem as scheduleRemoveSystem,
  replaceSystem as scheduleReplaceSystem,
} from './schedule';
import {
  FixedUpdate,
  isDomainSchedule,
  isScheduleToken,
  type ScheduleToken,
  Update,
} from './schedule-token';
import { FixedTime, type MutableFixedTimeResource } from './time';
import type {
  World,
  WorldScheduleData,
  WorldScheduleQueryData,
  WorldScheduleSystemData,
} from './world';
import { worldInternal } from './world-internal';

interface FixedContinuation {
  remaining: readonly ScheduleNode[];
  commands: Map<SystemToken, CommandBufferImpl>;
  stepsRemaining: number;
}
interface DeferredFixedStep {
  completion: 'waiting' | 'ready' | 'failed' | undefined;
  failure?: unknown;
  ready?: () => void;
  continuation: FixedContinuation | undefined;
}
// Pending completion and retained work share one asynchronous lifetime.
const deferredFixedSteps = new WeakMap<World, DeferredFixedStep>();
// This permission lasts only for the synchronous fixed-substep invocation.
const fixedScopes = new WeakSet<World>();

function withFixedStepDeferral<T>(world: World, run: () => T): T {
  fixedScopes.add(world);
  try {
    return run();
  } finally {
    fixedScopes.delete(world);
  }
}

/** Suspend the current fixed substep. Adopt solver state before resolving;
 * retain no borrowed query or arena view across the completion boundary. */
export function deferFixedStep(world: World, completion: Promise<void>): void {
  if (!fixedScopes.has(world) || world.getResource(FixedTime).catchUp !== 'substeps')
    throw new Error('Fixed-step deferral requires a running FixedUpdate substep');
  const current = deferredFixedSteps.get(world);
  if (current?.completion !== undefined)
    throw new Error('A fixed step already has an outstanding completion');
  const state: DeferredFixedStep = { completion: 'waiting', continuation: current?.continuation };
  deferredFixedSteps.set(world, state);
  void completion.then(
    () => {
      state.completion = 'ready';
      state.ready?.();
    },
    (failure: unknown) => {
      state.failure = failure;
      state.completion = 'failed';
      state.ready?.();
    },
  );
}

export function fixedStepIsDeferred(world: World): boolean {
  return deferredFixedSteps.get(world)?.completion !== undefined;
}

function abortFixedContinuation(world: World): void {
  const pending = deferredFixedSteps.get(world)?.continuation;
  if (pending)
    for (const commands of pending.commands.values())
      if (commands.status === 'open') commands.abort();
  deferredFixedSteps.delete(world);
}

function continueFixedWhenReady(world: World, pending: FixedContinuation): void {
  const state = deferredFixedSteps.get(world);
  if (state?.completion === undefined) throw new Error('No deferred fixed step exists');
  state.continuation = pending;
  const ready = world[worldInternal].resumeFixedStep;
  state.ready = ready;
  if (state.completion !== 'waiting') queueMicrotask(ready);
}

/** Consume one acknowledgement while retaining the work that still needs to run. */
function consumeFixedCompletion(state: DeferredFixedStep): FixedContinuation | undefined {
  const completion = state.completion;
  if (completion === undefined || completion === 'waiting') return undefined;
  state.completion = undefined;
  if (completion === 'failed') throw state.failure;
  return state.continuation;
}

/** Invoked through World's execution scope after a fixed completion settles. */
export function resumeWorldFixedStep(world: World): void {
  if (worldPoisonedError(world.execution) !== undefined) {
    abortFixedContinuation(world);
    return;
  }
  const ownsArena = world[worldInternal].openScheduleArena();
  const accumulator = { value: world[worldInternal].getFixedAccumulator() };
  try {
    const fixed = world[worldInternal].clockWriter.fixed;
    runFixed(world, fixed, accumulator);
    world[worldInternal].setFixedAccumulator(accumulator.value);
    fixed.overstep = accumulator.value;
  } catch (cause) {
    abortFixedContinuation(world);
    world[worldInternal].poisonExecution({
      code: 'shared-kernel-failed',
      kernelName: 'schedule:FixedUpdate',
      cause,
      partialWrite: true,
      retryable: false,
    });
  } finally {
    if (ownsArena) world[worldInternal].closeScheduleArena();
  }
}

function warmSharedKernel(world: World, descriptor: unknown): void {
  if (
    (descriptor as { readonly kind?: string }).kind !== 'shared-kernel' ||
    !world.hasResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY)
  )
    return;
  world
    .getResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY)
    .warmup?.(descriptor as SharedKernelDispatch);
}

function scheduleFor(
  world: World,
  token: ScheduleToken,
): Result<Schedule, ScheduleScopeMismatchError> {
  const schedule = isScheduleToken(token) ? world[worldInternal].getSchedule(token) : undefined;
  if (schedule) return ok(schedule);
  return err(createScheduleScopeMismatchError(token?.name ?? 'Unknown', Update.name));
}

function setOwner(world: World, set: SystemSet): ScheduleToken | undefined {
  for (const [token, schedule] of world[worldInternal].schedules) {
    if (schedule.sets.has(set)) return token;
  }
  return undefined;
}

function scopeError(
  source: ScheduleToken,
  target: ScheduleToken,
  reference?: string,
): Result<never, ScheduleScopeMismatchError> {
  return err(createScheduleScopeMismatchError(source.name, target.name, reference));
}

export function worldAddSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  world: World,
  token: ScheduleToken,
  descriptor: System<Qs>,
): Result<void, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  for (const set of descriptor.sets ?? []) {
    const owner = setOwner(world, set);
    if (owner !== undefined && owner !== token) return scopeError(token, owner, set.name);
  }
  scheduleAddSystem(target.value, descriptor);
  invalidateScheduleReferences(world);
  warmSharedKernel(world, descriptor);
  return ok(undefined);
}

export function worldRemoveSystem(
  world: World,
  token: ScheduleToken,
  system: SystemToken,
): ReturnType<typeof scheduleRemoveSystem> | Result<never, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  const removed = scheduleRemoveSystem(target.value, system);
  if (removed.ok) invalidateScheduleReferences(world);
  return removed;
}

export function worldReplaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  world: World,
  token: ScheduleToken,
  system: SystemToken,
  descriptor: SystemDescriptor<Qs>,
): ReturnType<typeof scheduleReplaceSystem> | Result<never, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  const replaced = scheduleReplaceSystem(target.value, system, descriptor);
  if (replaced.ok) {
    invalidateScheduleReferences(world);
    warmSharedKernel(world, descriptor);
  }
  return replaced;
}

export function worldAddSystems<const Qs extends ReadonlyArray<QueryDescriptor>>(
  world: World,
  token: ScheduleToken,
  set: SystemSet,
  systems: ReadonlyArray<System<Qs>>,
): Result<void, SystemSetNotRegisteredError | ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  const owner = setOwner(world, set);
  if (owner && owner !== token) return scopeError(token, owner, set.name);
  for (const system of systems)
    for (const group of system.sets ?? []) {
      const owner = setOwner(world, group);
      if (owner !== undefined && owner !== token) return scopeError(token, owner, group.name);
    }
  const added = scheduleAddSystems(target.value, set, systems);
  if (added.ok) {
    invalidateScheduleReferences(world);
    for (const system of systems) warmSharedKernel(world, system);
  }
  return added;
}

/** Registration can change an identity edge's scope in any schedule of this World. */
function invalidateScheduleReferences(world: World): void {
  for (const schedule of world[worldInternal].schedules.values())
    schedule.referencesValidated = false;
}

function validateScheduleReferences(
  world: World,
  token: ScheduleToken,
  schedule: Schedule,
): ScheduleScopeMismatchError | undefined {
  if (schedule.referencesValidated) return undefined;
  const mismatch = scheduleReferenceMismatch(world, token, schedule);
  if (mismatch === undefined) schedule.referencesValidated = true;
  return mismatch;
}

function scheduleReferenceMismatch(
  world: World,
  token: ScheduleToken,
  schedule: Schedule,
): ScheduleScopeMismatchError | undefined {
  for (const record of schedule.systems.values()) {
    for (const reference of [
      ...(record.descriptor.before ?? []),
      ...(record.descriptor.after ?? []),
    ]) {
      if (isScheduleToken(reference)) {
        const isFixedAnchor = token === Update && reference === FixedUpdate;
        if (reference !== token && !isFixedAnchor) {
          return createScheduleScopeMismatchError(token.name, reference.name, reference.name);
        }
        continue;
      }
      const local = isSystemSet(reference)
        ? schedule.sets.has(reference)
        : schedule.systems.has(reference);
      if (local) continue;
      for (const [otherToken, other] of world[worldInternal].schedules) {
        const registered = isSystemSet(reference)
          ? other.sets.has(reference)
          : other.systems.has(reference);
        if (otherToken !== token && registered)
          return createScheduleScopeMismatchError(token.name, otherToken.name, reference.name);
      }
    }
  }
  return undefined;
}

function runFixed(
  world: World,
  fixed: MutableFixedTimeResource,
  accumulator: { value: number },
): void {
  const fixedSchedule = world[worldInternal].getSchedule(FixedUpdate) as Schedule | undefined;
  if (!fixedSchedule) return;
  let stepBudget = fixed.maxStepsPerUpdate;
  const state = deferredFixedSteps.get(world);
  if (state !== undefined) {
    try {
      const pending = consumeFixedCompletion(state);
      if (pending === undefined) return;
      const remaining = withFixedStepDeferral(world, () =>
        runSchedule(fixedSchedule, world, pending.remaining, pending.commands),
      );
      if (remaining !== undefined) {
        for (const buffer of pending.commands.values()) detachCommandBufferPayloads(buffer);
        pending.remaining = remaining;
        continueFixedWhenReady(world, pending);
        return;
      }
      stepBudget = pending.stepsRemaining;
      deferredFixedSteps.delete(world);
    } catch (cause) {
      abortFixedContinuation(world);
      throw cause;
    }
  }
  if (stepBudget === 0) {
    discardFixedOverflow(fixed, accumulator);
    return;
  }
  if (fixedSchedule.systems.size === 0) {
    discardFixedOverflow(fixed, accumulator);
    return;
  }
  let steps = 0;
  const accumulated = accumulator.value;
  if (fixed.catchUp === 'merged') {
    let owed = 0;
    while (accumulated >= (owed + 1) * fixed.delta && owed < fixed.maxStepsPerUpdate) owed += 1;
    if (owed > 0) {
      // One schedule pass simulates every owed step: systems read the merged
      // delta, the tick advances once, and the base delta is restored after.
      const base = fixed.delta;
      const span = owed * base;
      accumulator.value = Math.round((accumulated - span) * 1e12) / 1e12;
      fixed.overstep = accumulator.value;
      fixed.tick += 1;
      fixed.stepDelta = span;
      fixed.delta = span;
      try {
        runSchedule(fixedSchedule, world);
      } finally {
        fixed.delta = base;
      }
      steps = owed;
    }
  }
  // Compare against the original total, not a repeatedly rounded remainder:
  // at 60 Hz, rounding 0.05 - delta twice otherwise loses the third tick.
  while (
    fixed.catchUp === 'substeps' &&
    accumulated >= (steps + 1) * fixed.delta &&
    steps < stepBudget
  ) {
    accumulator.value = Math.round((accumulated - (steps + 1) * fixed.delta) * 1e12) / 1e12;
    fixed.overstep = accumulator.value;
    fixed.tick += 1;
    fixed.stepDelta = fixed.delta;
    const commands = new Map<SystemToken, CommandBufferImpl>();
    const remaining = withFixedStepDeferral(world, () =>
      runSchedule(fixedSchedule, world, undefined, commands),
    );
    if (remaining !== undefined) {
      for (const buffer of commands.values()) detachCommandBufferPayloads(buffer);
      continueFixedWhenReady(world, {
        remaining,
        commands,
        stepsRemaining: stepBudget - steps - 1,
      });
      return;
    }
    steps += 1;
  }
  if (steps === stepBudget && accumulator.value >= fixed.delta) {
    const remainder = accumulator.value % fixed.delta;
    const dropped = accumulator.value - remainder;
    accumulator.value = remainder;
    fixed.droppedSeconds += dropped;
    fixed.droppedUpdates += 1;
  }
}

function discardFixedOverflow(
  fixed: MutableFixedTimeResource,
  accumulator: { value: number },
): void {
  if (accumulator.value < fixed.delta) return;
  const remainder = accumulator.value % fixed.delta;
  const dropped = accumulator.value - remainder;
  accumulator.value = remainder;
  fixed.droppedSeconds += dropped;
  fixed.droppedUpdates += 1;
}

export type ScheduleRunError =
  | ScheduleScopeMismatchError
  | WorldPoisonedError
  | CommandFailedError
  | SystemFailedError
  | CyclicDependencyError
  | SharedKernelFailureError;
export type ScheduleUpdateError = ScheduleRunError | TimeDeltaInvalidError | TimeConfigInvalidError;

function scheduleRunFailure(
  world: World,
  token: ScheduleToken,
  error: unknown,
): Result<never, ScheduleRunError> {
  if (
    isEcsFault(error, 'command-failed') ||
    isEcsFault(error, 'system-failed') ||
    isEcsFault(error, 'cyclic-dependency') ||
    isEcsFault(error, 'shared-kernel-failed')
  )
    return err(error);
  world[worldInternal].poisonExecution({
    code: 'shared-kernel-failed',
    kernelName: `schedule:${token.name}`,
    cause: error,
    partialWrite: true,
    retryable: false,
  });
  return err(createSystemFailedError('<schedule>', token.name, error));
}

export function worldUpdate(world: World, deltaSeconds = 0): Result<void, ScheduleUpdateError> {
  const poisoned = worldPoisonedError(world.execution);
  if (poisoned !== undefined) return err(poisoned);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
    return err(createTimeDeltaInvalidError(deltaSeconds));

  const writer = world[worldInternal].clockWriter;
  const time = writer.time;
  const fixed = writer.fixed;
  if (time.maxDeltaSeconds < (fixed.maxStepsPerUpdate + 1) * fixed.delta) {
    return err(
      createTimeConfigInvalidError({
        fixedDeltaSeconds: fixed.delta,
        maxStepsPerUpdate: fixed.maxStepsPerUpdate,
        maxDeltaSeconds: time.maxDeltaSeconds,
      }),
    );
  }

  for (const [token, schedule] of world[worldInternal].schedules) {
    const mismatch = validateScheduleReferences(world, token, schedule);
    if (mismatch) return err(mismatch);
  }

  world[worldInternal].updateRemovedComponents();
  time.unscaledDelta = deltaSeconds;
  time.unscaledElapsed += deltaSeconds;
  time.scale = world[worldInternal].clockWriter.effectiveScale();
  const measured = Math.min(deltaSeconds * time.scale, time.maxDeltaSeconds);
  time.delta = measured;
  time.elapsed += measured;
  // Accumulate the measured frame delta. maxDeltaSeconds bounds Time's public
  // delta, while the fixed cap makes oversized host gaps observable via metrics.
  const accumulator = { value: world[worldInternal].getFixedAccumulator() + measured };
  const update = world[worldInternal].getSchedule(Update) as Schedule | undefined;
  if (!update) return err(createScheduleScopeMismatchError('World', Update.name));

  const ownsArena = world[worldInternal].openScheduleArena();
  try {
    if (update.dirty) buildSchedule(update);
    const order = update.sortedOrder;
    const anchor = order.indexOf(FixedUpdate);
    if (anchor < 0) {
      runSchedule(update, world);
      if (measured > 0) discardFixedOverflow(fixed, accumulator);
    } else {
      const updateCommands = update.deferredCommands
        ? new Map<SystemToken, CommandBufferImpl>()
        : undefined;
      runSchedule(update, world, order, updateCommands, false, 0, anchor);
      if (measured > 0) runFixed(world, fixed, accumulator);
      // Downstream Update systems consume the final remainder even when no
      // fixed tick ran or catch-up discarded whole steps.
      fixed.overstep = accumulator.value;
      runSchedule(update, world, order, updateCommands, true, anchor + 1, order.length);
    }
  } catch (error) {
    return scheduleRunFailure(world, Update, error);
  } finally {
    if (ownsArena) world[worldInternal].closeScheduleArena();
  }
  world[worldInternal].setFixedAccumulator(accumulator.value);
  fixed.overstep = accumulator.value;
  return ok(undefined);
}

export function worldRun(world: World, token: ScheduleToken): Result<void, ScheduleRunError> {
  const poisoned = worldPoisonedError(world.execution);
  if (poisoned !== undefined) return err(poisoned);
  if (!isDomainSchedule(token)) return scopeError(token, Update);
  const schedule = world[worldInternal].getSchedule(token) as Schedule;
  const mismatch = validateScheduleReferences(world, token, schedule);
  if (mismatch) return err(mismatch);
  const ownsArena = world[worldInternal].openScheduleArena();
  try {
    runSchedule(schedule, world);
  } catch (error) {
    return scheduleRunFailure(world, token, error);
  } finally {
    if (ownsArena) world[worldInternal].closeScheduleArena();
  }
  return ok(undefined);
}

function referenceName(reference: { readonly name: string }): string {
  return reference.name;
}

function componentNames(components: readonly { readonly name: string }[] | undefined): string[] {
  return (components ?? []).map((component) => component.name);
}

function queryData(query: QueryDescriptor): WorldScheduleQueryData {
  return {
    read: componentNames(query.read),
    write: componentNames(query.write),
    with: componentNames(query.with),
    without: componentNames(query.without),
    optional: componentNames(query.optional),
    changed: componentNames(query.changed),
    added: componentNames(query.added),
  };
}

/** Project schedule registration into a JSON-safe graph for tooling and AI inspection. */
export function worldScheduleData(world: World): ReadonlyArray<WorldScheduleData> {
  return [...world[worldInternal].schedules].map(([token, schedule], scheduleId) => {
    if (schedule.dirty) buildSchedule(schedule);
    const sets = [...schedule.sets];
    const systemId = (system: import('./schedule').ScheduleNode): number =>
      system === FixedUpdate
        ? -1
        : (schedule.systems.get(system as SystemToken)?.registrationIndex ?? -1);
    const systems: WorldScheduleSystemData[] = [...schedule.systems].map(([system, record]) => ({
      id: record.registrationIndex,
      name: system.name,
      sets: sets.flatMap(([, set], index) => (set.members.has(system) ? [index] : [])),
      before: (record.descriptor.before ?? []).map(referenceName),
      after: (record.descriptor.after ?? []).map(referenceName),
      queries: record.descriptor.queries.map(queryData),
      resources: [],
    }));
    const systemSets = sets.map(([set, record], id) => ({
      id,
      name: set.name,
      members: [...record.members].map(systemId),
      chained: record.chained,
    }));
    const dependencies = [...schedule.predecessors].flatMap(([target, predecessors]) =>
      predecessors.map((source) => [systemId(source), systemId(target)] as const),
    );
    return {
      id: scheduleId,
      name: token.name,
      systems,
      systemSets,
      dependencies,
      anchors: token === Update ? [{ id: -1, name: FixedUpdate.name }] : [],
    };
  });
}

function queryUsesComponent(query: QueryDescriptor, component: Component): boolean {
  return DESCRIPTOR_ROLES.some((role) => query[role]?.includes(component) === true);
}

/** Control-plane guard used before releasing a World-local component registration. */
export function worldScheduleUsesComponent(world: World, component: Component): boolean {
  for (const schedule of world[worldInternal].schedules.values()) {
    for (const record of schedule.systems.values()) {
      if (record.descriptor.queries.some((query) => queryUsesComponent(query, component)))
        return true;
    }
  }
  return false;
}

export function detachWorldInspection<T extends object>(snapshot: T): Readonly<T> {
  return freezeInspection(snapshot);
}
function freezeInspection<T>(value: T): Readonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value as Readonly<T>;
  }
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && (typeof child === 'object' || typeof child === 'function')) {
      freezeInspection(child);
    }
  }
  return Object.freeze(value) as Readonly<T>;
}
