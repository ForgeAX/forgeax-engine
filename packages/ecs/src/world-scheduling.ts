// @forgeax/engine-ecs -- World schedule and resource orchestration.

import { err, ok, type Result } from '@forgeax/engine-types';
import type { CommandBufferImpl } from './commands';
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
  type SharedKernelExecutor,
} from './execution/shared-kernel';
import type { QueryDescriptor } from './query/query';
import {
  getResource as resGet,
  hasResource as resHas,
  insertResource as resInsert,
  removeResource as resRemove,
} from './resource';
import {
  buildSchedule,
  currentScheduleRevision,
  runSchedule,
  type Schedule,
  type SystemDescriptor,
  type SystemSet,
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
import { FIXED_TIME_RESOURCE_KEY, type MutableFixedTimeResource, TIME_RESOURCE_KEY } from './time';
import type {
  World,
  WorldInspection,
  WorldScheduleData,
  WorldScheduleQueryData,
  WorldScheduleSystemData,
} from './world';
import { worldInternal } from './world-internal';

const FIXED_ANCHOR_NAME = FixedUpdate.name;
type ResourceKey = string | { readonly name: string };

function resourceName(key: ResourceKey): string {
  return typeof key === 'string' ? key : key.name;
}

function warmSharedKernel(world: World, descriptor: unknown): void {
  if (
    (descriptor as { readonly kind?: string }).kind !== 'shared-kernel' ||
    !world.hasResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY)
  )
    return;
  world
    .getResource<SharedKernelExecutor>(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY)
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
    if (schedule.sets.has(set.name)) return token;
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
  descriptor: SystemDescriptor<Qs>,
): Result<void, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  scheduleAddSystem(target.value, descriptor);
  warmSharedKernel(world, descriptor);
  return ok(undefined);
}

export function worldRemoveSystem(
  world: World,
  token: ScheduleToken,
  name: string,
): ReturnType<typeof scheduleRemoveSystem> | Result<never, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  return scheduleRemoveSystem(target.value, name);
}

export function worldReplaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  world: World,
  token: ScheduleToken,
  name: string,
  descriptor: SystemDescriptor<Qs>,
): ReturnType<typeof scheduleReplaceSystem> | Result<never, ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  const replaced = scheduleReplaceSystem(target.value, name, descriptor);
  if (replaced.ok) warmSharedKernel(world, descriptor);
  return replaced;
}

export function worldAddSystems<const Qs extends ReadonlyArray<QueryDescriptor>>(
  world: World,
  token: ScheduleToken,
  set: SystemSet,
  systems: ReadonlyArray<SystemDescriptor<Qs>>,
): Result<void, SystemSetNotRegisteredError | ScheduleScopeMismatchError> {
  const target = scheduleFor(world, token);
  if (!target.ok) return target;
  const owner = setOwner(world, set);
  if (owner && owner !== token) return scopeError(token, owner, set.name);
  const added = scheduleAddSystems(target.value, set, systems);
  if (added.ok) {
    for (const system of systems) warmSharedKernel(world, system);
  }
  return added;
}

function validateScheduleReferences(
  world: World,
  token: ScheduleToken,
  schedule: Schedule,
): ScheduleScopeMismatchError | undefined {
  // References only change with registration, which advances the revision.
  const revision = currentScheduleRevision();
  if (schedule.validatedRevision === revision) return undefined;
  const mismatch = scheduleReferenceMismatch(world, token, schedule);
  if (mismatch === undefined) schedule.validatedRevision = revision;
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
      if (typeof reference === 'string') {
        for (const [otherToken, other] of world[worldInternal].getSchedules()) {
          if (otherToken !== token && other.systems.has(reference)) {
            return new ScheduleScopeMismatchError(token.name, otherToken.name, reference);
          }
        }
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
  // Compare against the original total, not a repeatedly rounded remainder:
  // at 60 Hz, rounding 0.05 - delta twice otherwise loses the third tick.
  while (
    fixed.catchUp === 'substeps' &&
    accumulated >= (steps + 1) * fixed.delta &&
    steps < fixed.maxStepsPerUpdate
  ) {
    accumulator.value = Math.round((accumulated - (steps + 1) * fixed.delta) * 1e12) / 1e12;
    fixed.overstep = accumulator.value;
    fixed.tick += 1;
    fixed.stepDelta = fixed.delta;
    runSchedule(fixedSchedule, world);
    steps += 1;
  }
  if (steps === fixed.maxStepsPerUpdate && accumulator.value >= fixed.delta) {
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

  const measured = Math.min(deltaSeconds, time.maxDeltaSeconds);
  time.delta = measured;
  time.elapsed += measured;
  // Accumulate the measured frame delta. maxDeltaSeconds bounds Time's public
  // delta, while the fixed cap makes oversized host gaps observable via metrics.
  const accumulator = { value: world[worldInternal].getFixedAccumulator() + measured };
  const update = world[worldInternal].getSchedule(Update) as Schedule | undefined;
  if (!update) return err(new ScheduleScopeMismatchError('World', Update.name));

  try {
    if (update.dirty) buildSchedule(update);
    const order = update.sortedOrder;
    const anchor = order.indexOf(FIXED_ANCHOR_NAME);
    if (anchor < 0) {
      runSchedule(
        update,
        world,
        order.filter((name) => name !== FIXED_ANCHOR_NAME),
      );
      if (measured > 0) discardFixedOverflow(fixed, accumulator);
    } else {
      const updateCommands = new Map<string, CommandBufferImpl>();
      runSchedule(update, world, order.slice(0, anchor), updateCommands, false);
      if (measured > 0) runFixed(world, fixed, accumulator);
      // Downstream Update systems consume the final remainder even when no
      // fixed tick ran or catch-up discarded whole steps.
      fixed.overstep = accumulator.value;
      runSchedule(update, world, order.slice(anchor + 1), updateCommands);
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
  }
  return ok(undefined);
}

export function worldInsertResource<T>(world: World, key: ResourceKey, value: T): void {
  const name = resourceName(key);
  if (name === TIME_RESOURCE_KEY || name === FIXED_TIME_RESOURCE_KEY) {
    throw new ProtectedResourceError(name, 'insert');
  }
  resInsert(
    world[worldInternal].getResources(),
    name,
    value,
    world[worldInternal].nextMutationEpoch(),
  );
}

export function worldGetResource<T>(world: World, key: ResourceKey): T {
  return resGet<T>(world[worldInternal].getResources(), resourceName(key));
}

export function worldHasResource(world: World, key: ResourceKey): boolean {
  return resHas(world[worldInternal].getResources(), resourceName(key));
}

export function worldRemoveResource(world: World, key: ResourceKey): void {
  const name = resourceName(key);
  if (name === TIME_RESOURCE_KEY || name === FIXED_TIME_RESOURCE_KEY) {
    throw new ProtectedResourceError(name, 'remove');
  }
  if (resHas(world[worldInternal].getResources(), name)) {
    resRemove(world[worldInternal].getResources(), name);
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
    const systems = [...schedule.systems.entries()]
      .filter(([name]) => name !== FIXED_ANCHOR_NAME)
      .map(([name]) => ({
        name,
        sets: [...schedule.sets].flatMap(([setName, record]) =>
          record.members.has(name) ? [setName] : [],
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
    resourceKeys: [...resources.entries.keys()],
    schedules,
    scheduleSystemCount(token: ScheduleToken): number {
      return schedules.find((entry) => entry.schedule === token)?.systems.length ?? 0;
    },
  };
}

function referenceName(reference: string | ScheduleToken): string {
  return typeof reference === 'string' ? reference : reference.name;
}

function componentNames(components: readonly { readonly name: string }[] | undefined): string[] {
  return (components ?? []).map((component) => component.name);
}

function queryData(query: QueryDescriptor): WorldScheduleQueryData {
  return {
    with: componentNames(query.with),
    without: componentNames(query.without),
    optional: componentNames(query.optional),
    changed: componentNames(query.changed),
    added: componentNames(query.added),
  };
}

/** Project schedule registration into a JSON-safe graph for tooling and AI inspection. */
export function worldScheduleData(world: World): ReadonlyArray<WorldScheduleData> {
  return [...(world[worldInternal].getSchedules() as ReadonlyMap<ScheduleToken, Schedule>)].map(
    ([token, schedule]) => {
      if (schedule.dirty) buildSchedule(schedule);

      const systems: WorldScheduleSystemData[] = [...schedule.systems.entries()]
        .filter(([name]) => name !== FIXED_ANCHOR_NAME)
        .map(([name, record]) => {
          const descriptor = record.descriptor;
          const queries = descriptor.queries.map(queryData);
          return {
            name,
            sets: [...schedule.sets].flatMap(([setName, set]) =>
              set.members.has(name) ? [setName] : [],
            ),
            before: (descriptor.before ?? []).map((reference) => referenceName(reference)),
            after: (descriptor.after ?? []).map((reference) => referenceName(reference)),
            queries,
            resources: [],
          };
        });

      const systemSets = [...schedule.sets].map(([name, set]) => ({
        name,
        members: [...set.members].filter((member) => schedule.systems.has(member)),
        before: [],
        after: [],
        chained: set.chained,
      }));
      const dependencies = [...schedule.predecessors].flatMap(([target, predecessors]) =>
        [...predecessors].map((source) => [source, target] as const),
      );

      return { name: token.name, systems, systemSets, dependencies };
    },
  );
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
