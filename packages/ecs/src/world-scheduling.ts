import {
  type Resource,
  type ResourceIdentity,
  getResource as resGet,
  hasResource as resHas,
  insertResource as resInsert,
  removeResource as resRemove,
} from './resource';
// @forgeax/engine-ecs -- World schedule and resource orchestration.

import { err, ok, type Result } from '@forgeax/engine-types';
import { type CommandBufferImpl, detachCommandBufferPayloads } from './commands';

import {
  CommandFailedError,
  CyclicDependencyError,
  ProtectedResourceError,
  ScheduleScopeMismatchError,
  SharedKernelFailureError,
  SystemFailedError,
  type SystemSetNotRegisteredError,
  TimeConfigInvalidError,
  TimeDeltaInvalidError,
  type WorldPoisonedError,
} from './errors';
import { worldPoisonedError } from './errors/shared-kernel-errors';
import {
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelDispatch,
} from './execution/shared-kernel';
import {
  discardDeferredFixedStep,
  onDeferredFixedStepReady,
  resumeDeferredFixedStep,
  withFixedStepDeferral,
} from './fixed-step-barrier';
import type { QueryDescriptor } from './query/query';

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
import type { ArchetypeGraph } from './storage/archetype-graph';
import { FixedTime, type MutableFixedTimeResource, Time } from './time';
import type {
  World,
  WorldInspection,
  WorldScheduleData,
  WorldScheduleQueryData,
  WorldScheduleSystemData,
} from './world';
import { worldInternal } from './world-internal';

const fixedContinuations = new WeakMap<
  World,
  {
    remaining: readonly ScheduleNode[];
    commands: Map<SystemToken, CommandBufferImpl>;
    stepsRemaining: number;
  }
>();

function abortFixedContinuation(world: World): void {
  const pending = fixedContinuations.get(world);
  if (pending)
    for (const commands of pending.commands.values())
      if (commands.status === 'open') commands.abort();
  fixedContinuations.delete(world);
  discardDeferredFixedStep(world);
}

function continueFixedWhenReady(world: World): void {
  onDeferredFixedStepReady(world, () => {
    if (worldPoisonedError(world.execution) !== undefined) {
      abortFixedContinuation(world);
      return;
    }
    const arena = world[worldInternal].getFrameArena();
    const ownsArena = !arena.isActive;
    if (ownsArena) arena.open();
    const accumulator = { value: world[worldInternal].getFixedAccumulator() };
    try {
      const fixed = world[worldInternal].getClockWriter().fixed;
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
      if (ownsArena) {
        arena.close();
        world[worldInternal].maintainMemory();
      }
    }
  });
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
  return err(new ScheduleScopeMismatchError(token?.name ?? 'Unknown', Update.name));
}

function setOwner(world: World, set: SystemSet): ScheduleToken | undefined {
  for (const [token, schedule] of world[worldInternal].getSchedules()) {
    if (schedule.sets.has(set)) return token;
  }
  return undefined;
}

function scopeError(
  source: ScheduleToken,
  target: ScheduleToken,
  reference?: string,
): Result<never, ScheduleScopeMismatchError> {
  return err(new ScheduleScopeMismatchError(source.name, target.name, reference));
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
  for (const schedule of world[worldInternal].getSchedules().values())
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
          return new ScheduleScopeMismatchError(token.name, reference.name, reference.name);
        }
        continue;
      }
      const local = isSystemSet(reference)
        ? schedule.sets.has(reference)
        : schedule.systems.has(reference);
      if (local) continue;
      for (const [otherToken, other] of world[worldInternal].getSchedules()) {
        const registered = isSystemSet(reference)
          ? other.sets.has(reference)
          : other.systems.has(reference);
        if (otherToken !== token && registered)
          return new ScheduleScopeMismatchError(token.name, otherToken.name, reference.name);
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
  const pending = fixedContinuations.get(world);
  if (pending !== undefined) {
    let remaining: readonly ScheduleNode[] | undefined;
    try {
      if (!resumeDeferredFixedStep(world)) return;
      remaining = withFixedStepDeferral(world, () =>
        runSchedule(fixedSchedule, world, pending.remaining, pending.commands),
      );
    } catch (cause) {
      abortFixedContinuation(world);
      throw cause;
    }
    if (remaining !== undefined) {
      for (const buffer of pending.commands.values()) detachCommandBufferPayloads(buffer);
      pending.remaining = remaining;
      continueFixedWhenReady(world);
      return;
    }
    stepBudget = pending.stepsRemaining;
    fixedContinuations.delete(world);
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
      fixedContinuations.set(world, {
        remaining,
        commands,
        stepsRemaining: stepBudget - steps - 1,
      });
      continueFixedWhenReady(world);
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

export function worldUpdate(
  world: World,
  deltaSeconds = 0,
): Result<
  void,
  | TimeDeltaInvalidError
  | TimeConfigInvalidError
  | ScheduleScopeMismatchError
  | WorldPoisonedError
  | CommandFailedError
  | SystemFailedError
  | CyclicDependencyError
  | SharedKernelFailureError
> {
  const poisoned = worldPoisonedError(world.execution);
  if (poisoned !== undefined) return err(poisoned);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
    return err(new TimeDeltaInvalidError(deltaSeconds));

  const writer = world[worldInternal].getClockWriter();
  const time = writer.time;
  const fixed = writer.fixed;
  if (time.maxDeltaSeconds < (fixed.maxStepsPerUpdate + 1) * fixed.delta) {
    return err(
      new TimeConfigInvalidError({
        fixedDeltaSeconds: fixed.delta,
        maxStepsPerUpdate: fixed.maxStepsPerUpdate,
        maxDeltaSeconds: time.maxDeltaSeconds,
      }),
    );
  }

  for (const [token, schedule] of world[worldInternal].getSchedules()) {
    const mismatch = validateScheduleReferences(world, token, schedule);
    if (mismatch) return err(mismatch);
  }

  world[worldInternal].updateRemovedComponents();
  const measured = Math.min(deltaSeconds, time.maxDeltaSeconds);
  time.delta = measured;
  time.elapsed += measured;
  // Accumulate the measured frame delta. maxDeltaSeconds bounds Time's public
  // delta, while the fixed cap makes oversized host gaps observable via metrics.
  const accumulator = { value: world[worldInternal].getFixedAccumulator() + measured };
  const update = world[worldInternal].getSchedule(Update) as Schedule | undefined;
  if (!update) return err(new ScheduleScopeMismatchError('World', Update.name));

  const arena = world[worldInternal].getFrameArena();
  const ownsArena = !arena.isActive;
  if (ownsArena) arena.open();
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
    if (error instanceof CommandFailedError || error instanceof SystemFailedError) {
      return err(error);
    }
    if (error instanceof CyclicDependencyError || error instanceof SharedKernelFailureError) {
      return err(error);
    }
    world[worldInternal].poisonExecution({
      code: 'shared-kernel-failed',
      kernelName: `schedule:${Update.name}`,
      cause: error,
      partialWrite: true,
      retryable: false,
    });
    return err(new SystemFailedError('<schedule>', Update.name, error));
  } finally {
    if (ownsArena) {
      arena.close();
      world[worldInternal].maintainMemory();
    }
  }
  world[worldInternal].setFixedAccumulator(accumulator.value);
  fixed.overstep = accumulator.value;
  return ok(undefined);
}

export function worldRun(
  world: World,
  token: ScheduleToken,
): Result<
  void,
  | ScheduleScopeMismatchError
  | WorldPoisonedError
  | CommandFailedError
  | SystemFailedError
  | CyclicDependencyError
  | SharedKernelFailureError
> {
  const poisoned = worldPoisonedError(world.execution);
  if (poisoned !== undefined) return err(poisoned);
  if (!isDomainSchedule(token)) return scopeError(token, Update);
  const schedule = world[worldInternal].getSchedule(token) as Schedule;
  const mismatch = validateScheduleReferences(world, token, schedule);
  if (mismatch) return err(mismatch);
  const arena = world[worldInternal].getFrameArena();
  const ownsArena = !arena.isActive;
  if (ownsArena) arena.open();
  try {
    runSchedule(schedule, world);
  } catch (error) {
    if (
      error instanceof CommandFailedError ||
      error instanceof SystemFailedError ||
      error instanceof CyclicDependencyError ||
      error instanceof SharedKernelFailureError
    )
      return err(error);
    world[worldInternal].poisonExecution({
      code: 'shared-kernel-failed',
      kernelName: `schedule:${token.name}`,
      cause: error,
      partialWrite: true,
      retryable: false,
    });
    return err(new SystemFailedError('<schedule>', token.name, error));
  } finally {
    if (ownsArena) {
      arena.close();
      world[worldInternal].maintainMemory();
    }
  }
  return ok(undefined);
}

function isClockResource(resource: object): boolean {
  return resource === Time || resource === FixedTime;
}

export function worldInsertResource<T>(world: World, key: Resource<T>, value: T): void {
  const name = key.name;
  if (isClockResource(key)) {
    throw new ProtectedResourceError(name, 'insert');
  }
  resInsert(
    world[worldInternal].getResources(),
    key,
    value,
    world[worldInternal].nextMutationEpoch(),
  );
}

export function worldGetResource<T>(world: World, key: Resource<T>): T {
  return resGet<T>(world[worldInternal].getResources(), key);
}

export function worldHasResource(world: World, key: ResourceIdentity): boolean {
  return resHas(world[worldInternal].getResources(), key);
}

export function worldRemoveResource(world: World, key: ResourceIdentity): void {
  const name = key.name;
  if (isClockResource(key)) {
    throw new ProtectedResourceError(name, 'remove');
  }
  if (resHas(world[worldInternal].getResources(), key)) {
    resRemove(world[worldInternal].getResources(), key);
    world[worldInternal].nextMutationEpoch();
  }
}

export function worldInspect(world: World): WorldInspection {
  const graph = world[worldInternal].getGraph() as ArchetypeGraph;
  const resources = world[worldInternal].getResources();
  let entityCount = 0;
  const archetypes: WorldInspection['archetypes'] = [];
  const activeComponentSet = new Set<string>();
  for (const arch of graph.archetypes) {
    if (!arch) continue;
    entityCount += arch.size;
    const componentNames = arch.components.map((component) => component.name);
    archetypes.push({
      key: arch.key,
      componentNames,
      entityCount: arch.size,
      tableId: arch.tableId,
    });
    if (arch.size > 0) for (const name of componentNames) activeComponentSet.add(name);
  }

  const schedules = [
    ...(world[worldInternal].getSchedules() as ReadonlyMap<ScheduleToken, Schedule>),
  ].map(([token, schedule]) => {
    const systems = [...schedule.systems.entries()].map(([name]) => ({
      id: schedule.systems.get(name)?.registrationIndex ?? -1,
      name: name.name,
      sets: [...schedule.sets].flatMap(([set, record]) =>
        record.members.has(name) ? [set.name] : [],
      ),
    }));
    return { schedule: token, systems };
  });
  const systems = schedules.flatMap((entry) => entry.systems);
  const tables = graph.tables.map((table) => ({
    id: table.id,
    key: table.key,
    componentNames: table.components.map((component) => component.name),
    entityCount: table.size,
    capacity: table.capacity,
  }));
  return {
    entityCount,
    archetypeCount: archetypes.length,
    archetypes,
    tableCount: tables.length,
    tables,
    activeComponents: [...activeComponentSet],
    systemCount: systems.length,
    systems,
    resourceKeys: [...resources.entries.keys()].map((key) => key.name),
    schedules,
    scheduleSystemCount(token: ScheduleToken): number {
      return schedules.find((entry) => entry.schedule === token)?.systems.length ?? 0;
    },
  };
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
  return [...world[worldInternal].getSchedules()].map(([token, schedule], scheduleId) => {
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

function queryUsesComponent(query: QueryDescriptor, component: object): boolean {
  return [
    query.read,
    query.write,
    query.optional,
    query.with,
    query.without,
    query.changed,
    query.added,
  ].some((items) => items?.includes(component as never) === true);
}

/** Control-plane guard used before releasing a World-local component registration. */
export function worldScheduleUsesComponent(world: World, component: object): boolean {
  for (const schedule of (
    world[worldInternal].getSchedules() as ReadonlyMap<ScheduleToken, Schedule>
  ).values()) {
    for (const record of schedule.systems.values()) {
      if (record.descriptor.queries.some((query) => queryUsesComponent(query, component)))
        return true;
    }
  }
  return false;
}
