import { err, ok, type Result } from '@forgeax/engine-types';
import { type CommandBuffer, createCommandBuffer, flushCommands } from './commands';
import type { Component } from './component';
import {
  createCyclicDependencyError,
  createSystemFailedError,
  ScheduleMutationError,
  type SystemSetNotRegisteredError,
  systemSetNotRegistered,
} from './errors';
import { isSuspendedMemoryResult, MemoryError } from './memory-types';
import type { Query, QueryDescriptor } from './query/query';
import {
  beginScheduleCommandDrain,
  type ScheduleObservers,
  scheduleObservers,
} from './schedule-observation';
import { FixedUpdate, isScheduleToken, type ScheduleToken, Update } from './schedule-token';
import type { World } from './world';
import { worldInternal } from './world-internal';

const SYSTEM_ID = Symbol.for('forgeax.ecs.system.identity');
const SYSTEM_SET_ID = Symbol.for('forgeax.ecs.system-set.identity');

/** A stable system identity; its name is a diagnostic label. */
export interface SystemToken {
  readonly [SYSTEM_ID]: true;
  readonly name: string;
}

export interface SystemSet {
  readonly [SYSTEM_SET_ID]: true;
  readonly name: string;
  readonly runIf?: (world: World) => boolean;
  readonly chained?: boolean;
}

export type SystemOrderReference = SystemToken | SystemSet | ScheduleToken;
export type ScheduleNode = SystemToken | ScheduleToken;

type SystemQueryResults<Qs extends readonly QueryDescriptor[]> = {
  [K in keyof Qs]: Qs[K] extends QueryDescriptor<
    infer R extends readonly Component[],
    infer W extends readonly Component[],
    infer O extends readonly Component[]
  >
    ? Query<NoInfer<R>, NoInfer<W>, NoInfer<O>>
    : Query;
};

/** Executable behavior and ordering, independent of registration identity. */
export interface SystemDescriptor<
  Qs extends readonly QueryDescriptor[] = readonly QueryDescriptor[],
> {
  readonly queries: Qs;
  readonly commands?: 'deferred' | 'none';
  readonly fn: (world: World, queries: SystemQueryResults<Qs>, commands: CommandBuffer) => unknown;
  readonly before?: readonly SystemOrderReference[];
  readonly after?: readonly SystemOrderReference[];
  readonly runIf?: (world: World) => boolean;
}

export type System<Qs extends readonly QueryDescriptor[] = readonly QueryDescriptor[]> =
  SystemDescriptor<Qs> & SystemToken & { readonly sets?: readonly SystemSet[] };

export function defineSystem<const Qs extends readonly QueryDescriptor[]>(
  descriptor: SystemDescriptor<Qs> & {
    readonly name: string;
    readonly sets?: readonly SystemSet[];
  },
): System<Qs> {
  const { name, queries, fn, commands, before, after, runIf, sets } = descriptor;
  if (name.length === 0) throw new RangeError('A system requires a diagnostic name');
  for (const set of sets ?? [])
    if (!isSystemSet(set)) throw new TypeError('System membership requires a system set token');
  for (const reference of [...(before ?? []), ...(after ?? [])]) {
    if (!isSystemToken(reference) && !isSystemSet(reference) && !isScheduleToken(reference))
      throw new TypeError('System ordering requires a system, system set or schedule token');
  }
  return Object.freeze({
    name,
    queries,
    fn,
    [SYSTEM_ID]: true as const,
    ...(commands === undefined ? {} : { commands }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(runIf === undefined ? {} : { runIf }),
    ...(sets === undefined ? {} : { sets }),
  });
}

export function defineSystemSet(options: {
  readonly name: string;
  readonly runIf?: (world: World) => boolean;
  readonly chained?: boolean;
}): SystemSet {
  if (options.name.length === 0) throw new RangeError('A system set requires a diagnostic name');
  return Object.freeze({
    name: options.name,
    [SYSTEM_SET_ID]: true as const,
    ...(options.runIf === undefined ? {} : { runIf: options.runIf }),
    ...(options.chained === undefined ? {} : { chained: options.chained }),
  });
}

export function isSystemToken(value: unknown): value is SystemToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<SystemToken>)[SYSTEM_ID] === true
  );
}
export function isSystemSet(value: unknown): value is SystemSet {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<SystemSet>)[SYSTEM_SET_ID] === true
  );
}

const EMPTY_QUERY_RESULTS: readonly [] = Object.freeze([]);
function deferredCommandsUnavailable(): never {
  throw new Error('System declared commands: none; deferred structural commands are unavailable');
}
const NO_COMMANDS: CommandBuffer = Object.freeze({
  status: 'committed',
  spawn: deferredCommandsUnavailable,
  despawn: deferredCommandsUnavailable,
  addComponent: deferredCommandsUnavailable,
  removeComponent: deferredCommandsUnavailable,
  isDeferred: () => false,
  commit: deferredCommandsUnavailable,
  abort: () => {},
});

interface SystemRecord {
  descriptor: SystemDescriptor;
  readonly registrationIndex: number;
  queries: Query[] | null;
  deferredCommands: boolean;
}
export interface SetRecord {
  readonly members: Set<SystemToken>;
  readonly runIf: ((world: World) => boolean) | undefined;
  readonly chained: boolean;
}
export interface Schedule {
  readonly token: ScheduleToken;
  readonly suspendIf: ((world: World) => boolean) | undefined;
  readonly systems: Map<SystemToken, SystemRecord>;
  readonly sets: Map<SystemSet, SetRecord>;
  nextIndex: number;
  dirty: boolean;
  sortedOrder: ScheduleNode[];
  predecessors: Map<ScheduleNode, readonly ScheduleNode[]>;
  systemToSets: Map<SystemToken, SystemSet[]>;
  plain: boolean;
  deferredCommands: boolean;
  referencesValidated: boolean;
}
export function createSchedule(
  token: ScheduleToken,
  suspendIf?: (world: World) => boolean,
): Schedule {
  return {
    token,
    suspendIf,
    systems: new Map(),
    sets: new Map(),
    nextIndex: 0,
    dirty: true,
    sortedOrder: [],
    predecessors: new Map(),
    systemToSets: new Map(),
    plain: true,
    deferredCommands: false,
    referencesValidated: false,
  };
}
export function addSystem<const Qs extends readonly QueryDescriptor[]>(
  schedule: Schedule,
  system: System<Qs>,
): void {
  if (!isSystemToken(system)) throw new TypeError('Use defineSystem to create a system token');
  if (schedule.systems.has(system)) return;
  for (const set of system.sets ?? [])
    if (!isSystemSet(set)) throw new TypeError('Use defineSystemSet to create a system set');
  schedule.systems.set(system, {
    descriptor: system as unknown as SystemDescriptor,
    registrationIndex: schedule.nextIndex++,
    queries: null,
    deferredCommands: system.commands !== 'none',
  });
  for (const set of system.sets ?? []) {
    if (!isSystemSet(set)) throw new TypeError('Use defineSystemSet to create a system set');
    let record = schedule.sets.get(set);
    if (record === undefined) {
      record = { members: new Set(), runIf: set.runIf, chained: set.chained ?? false };
      schedule.sets.set(set, record);
    }
    record.members.add(system);
  }
  schedule.dirty = true;
}
export function removeSystem(
  schedule: Schedule,
  system: SystemToken,
): Result<void, ScheduleMutationError> {
  if (!schedule.systems.has(system)) return missingSystem(schedule, system);
  schedule.systems.delete(system);
  for (const [token, set] of schedule.sets) {
    set.members.delete(system);
    if (set.members.size === 0) schedule.sets.delete(token);
  }
  schedule.dirty = true;
  return ok(undefined);
}
export function replaceSystem<const Qs extends readonly QueryDescriptor[]>(
  schedule: Schedule,
  system: SystemToken,
  descriptor: SystemDescriptor<Qs>,
): Result<void, ScheduleMutationError> {
  const record = schedule.systems.get(system);
  if (record === undefined) return missingSystem(schedule, system);
  record.descriptor = descriptor as unknown as SystemDescriptor;
  record.deferredCommands = descriptor.commands !== 'none';
  record.queries = null;
  schedule.dirty = true;
  return ok(undefined);
}
function missingSystem(
  schedule: Schedule,
  system: SystemToken,
): Result<never, ScheduleMutationError> {
  return err(
    new ScheduleMutationError(
      'system-before-unknown',
      `System '${system?.name ?? 'Unknown'}' is not registered in ${schedule.token.name}.`,
      'Pass the original registered system token.',
      { candidates: [...schedule.systems.keys()].map((token) => token.name) },
    ),
  );
}
export function addSystems<const Qs extends readonly QueryDescriptor[]>(
  schedule: Schedule,
  set: SystemSet,
  systems: readonly System<Qs>[],
): Result<void, SystemSetNotRegisteredError> {
  if (!isSystemSet(set)) return err(systemSetNotRegistered('Unknown', []));
  if (systems.length === 0) return ok(undefined);
  let record = schedule.sets.get(set);
  if (record === undefined) {
    record = { members: new Set(), runIf: set.runIf, chained: set.chained ?? false };
    schedule.sets.set(set, record);
  }
  for (const system of systems) {
    addSystem(schedule, system);
    record.members.add(system);
  }
  schedule.dirty = true;
  return ok(undefined);
}

/** Compile object identities into an ordered graph. Missing optional owners add no edge. */
export function buildSchedule(schedule: Schedule): ScheduleNode[] {
  const systems = schedule.systems;
  const nodes: ScheduleNode[] = [...systems.keys()];
  if (schedule.token === Update) nodes.push(FixedUpdate);
  const present = new Set(nodes);
  const adjacent = new Map<ScheduleNode, Set<ScheduleNode>>();
  const predecessors = new Map<ScheduleNode, ScheduleNode[]>();
  for (const node of nodes) {
    adjacent.set(node, new Set());
    predecessors.set(node, []);
  }
  const edge = (from: ScheduleNode, to: ScheduleNode): void => {
    const outgoing = adjacent.get(from);
    if (outgoing === undefined || outgoing.has(to)) return;
    outgoing.add(to);
    predecessors.get(to)?.push(from);
  };
  const first = new Set<SystemToken>();
  const last = new Set<SystemToken>();
  for (const [system, record] of systems) {
    if (record.descriptor.before?.includes(schedule.token)) first.add(system);
    if (record.descriptor.after?.includes(schedule.token)) last.add(system);
  }
  for (const node of nodes) {
    if (first.has(node as SystemToken) && last.has(node as SystemToken)) edge(node, node);
    if (!first.has(node as SystemToken)) for (const start of first) edge(start, node);
    if (!last.has(node as SystemToken)) for (const end of last) edge(node, end);
  }
  const targets = (reference: SystemOrderReference): readonly ScheduleNode[] => {
    if (isSystemSet(reference)) return [...(schedule.sets.get(reference)?.members ?? [])];
    return present.has(reference) ? [reference] : [];
  };
  for (const [system, record] of systems) {
    for (const reference of record.descriptor.after ?? []) {
      if (reference !== schedule.token)
        for (const dependency of targets(reference)) edge(dependency, system);
    }
    for (const reference of record.descriptor.before ?? []) {
      if (reference !== schedule.token)
        for (const target of targets(reference)) edge(system, target);
    }
  }
  const memberships = new Map<SystemToken, SystemSet[]>();
  for (const [set, record] of schedule.sets) {
    for (const member of record.members) {
      let groups = memberships.get(member);
      if (groups === undefined) {
        groups = [];
        memberships.set(member, groups);
      }
      groups.push(set);
    }
    if (record.chained) {
      const members = [...record.members];
      for (let index = 1; index < members.length; index++) {
        const previous = members[index - 1];
        const next = members[index];
        if (previous !== undefined && next !== undefined) edge(previous, next);
      }
    }
  }
  const registration = (node: ScheduleNode): number =>
    systems.get(node as SystemToken)?.registrationIndex ?? Number.MAX_SAFE_INTEGER;
  const compare = (a: ScheduleNode, b: ScheduleNode): number => registration(a) - registration(b);
  const degree = new Map<ScheduleNode, number>();
  const queue = nodes
    .filter((node) => {
      const incoming = predecessors.get(node)?.length ?? 0;
      degree.set(node, incoming);
      return incoming === 0;
    })
    .sort(compare);
  const sorted: ScheduleNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    sorted.push(node);
    const ready: ScheduleNode[] = [];
    for (const next of adjacent.get(node) ?? []) {
      const remaining = (degree.get(next) ?? 0) - 1;
      degree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
    queue.push(...ready.sort(compare));
  }
  if (sorted.length !== nodes.length) {
    const unfinished = nodes.filter((node) => !sorted.includes(node));
    throw createCyclicDependencyError(findCyclePath(unfinished, adjacent).map((node) => node.name));
  }
  schedule.sortedOrder = sorted;
  schedule.predecessors = predecessors;
  schedule.systemToSets = memberships;
  schedule.plain =
    ![...schedule.sets.values()].some((set) => set.runIf !== undefined) &&
    sorted.every((node) => {
      const record = systems.get(node as SystemToken);
      return (
        record !== undefined &&
        record.descriptor.queries.length === 0 &&
        record.descriptor.runIf === undefined &&
        (predecessors.get(node)?.length ?? 0) === 0
      );
    });
  schedule.deferredCommands = sorted.some(
    (node) => systems.get(node as SystemToken)?.deferredCommands === true,
  );
  schedule.dirty = false;
  return sorted;
}
function findCyclePath(
  nodes: ScheduleNode[],
  edges: Map<ScheduleNode, Set<ScheduleNode>>,
): ScheduleNode[] {
  const remaining = new Set(nodes);
  const done = new Set<ScheduleNode>();
  const path: ScheduleNode[] = [];
  const active = new Set<ScheduleNode>();
  const visit = (node: ScheduleNode): ScheduleNode[] | undefined => {
    if (active.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (done.has(node)) return undefined;
    active.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!remaining.has(next)) continue;
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    active.delete(node);
    done.add(node);
    return undefined;
  };
  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle !== undefined) return cycle;
  }
  return nodes;
}

function poisonSystemFailure(world: World, systemName: string, cause: unknown): void {
  const poison = world[worldInternal].poisonExecution;
  poison({
    code: 'shared-kernel-failed',
    kernelName: `system:${systemName}`,
    cause,
    partialWrite: true,
    retryable: false,
  });
}

function abortOutstandingCommands(
  commandsBySystem: Map<SystemToken, ReturnType<typeof createCommandBuffer>> | undefined,
): void {
  if (commandsBySystem === undefined) return;
  commandsBySystem.forEach(abortOpenCommands);
}

/** Native Map traversal preserves live ledger order without iterator result objects. */
function abortOpenCommands(commands: ReturnType<typeof createCommandBuffer>): void {
  if (commands.status === 'open') commands.abort();
}

function flushCommandForWorld(this: World, commands: ReturnType<typeof createCommandBuffer>): void {
  flushCommands(commands, this);
}

/** A final boundary drains the live ledger, including callback-enqueued buffers. */
function drainScheduleCommands(
  world: World,
  scheduleName: string,
  commandsBySystem: Map<SystemToken, ReturnType<typeof createCommandBuffer>>,
): void {
  const observation = beginScheduleCommandDrain(world, scheduleName);
  try {
    commandsBySystem.forEach(flushCommandForWorld, world);
  } catch (error) {
    abortOutstandingCommands(commandsBySystem);
    throw error;
  } finally {
    observation?.end();
  }
}

/** Apply only buffers that have an explicit graph edge into the next system. */
function flushPredecessorCommands(
  predecessors: readonly ScheduleNode[] | undefined,
  scheduleName: string,
  world: World,
  commandsBySystem: Map<SystemToken, ReturnType<typeof createCommandBuffer>> | undefined,
): void {
  // Systems without inbound edges skip the iterator entirely.
  if (predecessors === undefined || predecessors.length === 0 || commandsBySystem === undefined)
    return;
  let observation: ReturnType<typeof beginScheduleCommandDrain>;
  let observationAttempted = false;
  try {
    for (const predecessor of predecessors) {
      const producerCommands = commandsBySystem.get(predecessor as SystemToken);
      if (producerCommands) {
        if (!observationAttempted) {
          observationAttempted = true;
          observation = beginScheduleCommandDrain(world, scheduleName);
        }
        flushCommands(producerCommands, world);
      }
    }
  } catch (error) {
    abortOutstandingCommands(commandsBySystem);
    throw error;
  } finally {
    observation?.end();
  }
}

/** One invocation owns its capability, error boundary and returned Result. */
function invokeSystem(
  record: SystemRecord,
  system: SystemToken,
  scheduleName: string,
  world: World,
  queries: Parameters<SystemRecord['descriptor']['fn']>[1],
  commandsBySystem: Map<SystemToken, ReturnType<typeof createCommandBuffer>> | undefined,
  observation?: ScheduleObservers,
): void {
  const name = system.name;
  const commands = record.deferredCommands
    ? createCommandBuffer(world, name, scheduleName)
    : undefined;
  if (commands !== undefined) {
    if (commandsBySystem === undefined) throw new Error('Missing deferred execution storage');
    commandsBySystem.set(system, commands);
  }
  let returnValue: unknown;
  try {
    observation?.functionStart(scheduleName, name);
    try {
      returnValue = record.descriptor.fn(world, queries, commands ?? NO_COMMANDS);
    } finally {
      observation?.functionEnd(scheduleName, name);
    }
    if (isSuspendedMemoryResult(returnValue))
      throw new MemoryError({ kind: 'scope', reason: 'asynchronous' });
  } catch (error) {
    abortOutstandingCommands(commandsBySystem);
    poisonSystemFailure(world, name, error);
    throw createSystemFailedError(name, scheduleName, error);
  }
  if (returnValue && typeof returnValue === 'object' && 'ok' in returnValue) {
    const result = returnValue as { ok: boolean; error?: unknown };
    if (result.ok === false && result.error !== undefined) {
      abortOutstandingCommands(commandsBySystem);
      poisonSystemFailure(world, name, result.error);
      throw createSystemFailedError(name, scheduleName, result.error);
    }
  }
}

/**
 * Execute all systems in sorted order. Rebuilds schedule if dirty.
 * Each system receives its query results and a command buffer.
 * The world parameter provides the archetype graph, component ID resolution,
 * and resource checks.
 *
 * Empty required queries skip their system; explicit runIf predicates gate execution.
 * A returned Result error poisons the active frame and stops execution.
 */
function runScheduleBody(
  schedule: Schedule,
  world: World,
  selected: ReadonlySet<ScheduleNode> | undefined,
  commandsBySystem: Map<SystemToken, ReturnType<typeof createCommandBuffer>> | undefined,
  finalDrain = true,
  start: number,
  end: number,
): readonly ScheduleNode[] | undefined {
  const order = schedule.sortedOrder;
  if (selected === undefined && (commandsBySystem?.size ?? 0) === 0 && schedule.plain) {
    const runPlainSchedule = () => {
      for (let index = start; index < end; index++) {
        const name = order[index] as SystemToken;
        const record = schedule.systems.get(name);
        /* istanbul ignore next -- sortedOrder comes from systems Map keys */
        if (!record) continue;
        const observation = world[scheduleObservers];
        observation?.start(schedule.token.name, name.name);
        let outcome: 'skipped' | 'failed-before-invoke' | 'invoked' | 'failed-invoke' = 'skipped';
        try {
          try {
            invokeSystem(
              record,
              name,
              schedule.token.name,
              world,
              EMPTY_QUERY_RESULTS,
              commandsBySystem,
              observation,
            );
            outcome = 'invoked';
          } catch (cause) {
            outcome = 'failed-invoke';
            throw cause;
          }
          if (schedule.suspendIf?.(world))
            return schedule.sortedOrder.slice(schedule.sortedOrder.indexOf(name) + 1);
        } finally {
          observation?.end(schedule.token.name, name.name, outcome);
        }
      }
      if (finalDrain && commandsBySystem !== undefined)
        drainScheduleCommands(world, schedule.token.name, commandsBySystem);
      return undefined;
    };
    return runPlainSchedule();
  }
  const systemToSets = schedule.systemToSets;

  // Per-frame set runIf cache (D-5). Discarded at frame end — no cross-frame state.
  // Created on the first gated set so ungated schedules allocate nothing here.
  let setRunIfCache: Map<SystemSet, boolean> | undefined;
  const setConditionsPass = (system: SystemToken): boolean => {
    const sets = systemToSets.get(system);
    if (sets === undefined) return true;
    for (const set of sets) {
      const record = schedule.sets.get(set);
      if (!record?.runIf) continue;
      setRunIfCache ??= new Map();
      let allowed = setRunIfCache.get(set);
      if (allowed === undefined) {
        allowed = record.runIf(world);
        setRunIfCache.set(set, allowed);
      }
      if (!allowed) return false;
    }
    return true;
  };

  for (let index = start; index < end; index++) {
    const name = order[index] as SystemToken;
    if (selected && !selected.has(name)) continue;
    const record = schedule.systems.get(name);
    /* istanbul ignore next -- defensive: sortedOrder comes from systems Map keys */
    if (!record) continue;
    const observation = world[scheduleObservers];
    observation?.start(schedule.token.name, name.name);
    let outcome: 'skipped' | 'failed-before-invoke' | 'invoked' | 'failed-invoke' = 'skipped';
    try {
      flushPredecessorCommands(
        schedule.predecessors.get(name),
        schedule.token.name,
        world,
        commandsBySystem,
      );

      // Lazily initialize the persistent executable queries on first run.
      if (record.queries === null) {
        record.queries = record.descriptor.queries.map((descriptor) => {
          const result = world.query(descriptor);
          if (!result.ok) throw result.error;
          return result.value;
        });
      }
      if (!setConditionsPass(name)) continue;

      // ── Run condition (runIf) — evaluated after query preparation, before
      // query iteration. false -> skip silently (no query, no fn, no cursor advance). ──
      if (record.descriptor.runIf && !record.descriptor.runIf(world)) {
        continue;
      }

      // ── Layer 3: system execution + Result collection ──
      // trusted-cast: the descriptor tuple constructed the matching Query tuple above.
      try {
        invokeSystem(
          record,
          name,
          schedule.token.name,
          world,
          record.queries as Parameters<typeof record.descriptor.fn>[1],
          commandsBySystem,
          observation,
        );
        outcome = 'invoked';
      } catch (cause) {
        outcome = 'failed-invoke';
        throw cause;
      }
      if (schedule.suspendIf?.(world))
        return schedule.sortedOrder
          .slice(schedule.sortedOrder.indexOf(name) + 1)
          .filter((candidate) => selected === undefined || selected.has(candidate));
    } catch (cause) {
      if (outcome === 'skipped') outcome = 'failed-before-invoke';
      throw cause;
    } finally {
      observation?.end(schedule.token.name, name.name, outcome);
    }
    // void return is treated as successful execution.
  }

  if (finalDrain && commandsBySystem !== undefined)
    drainScheduleCommands(world, schedule.token.name, commandsBySystem);

  return undefined;
}

/**
 * Execute one schedule with a terminalization guard.  Query construction,
 * run-if evaluation, DAG compilation, and command draining may all throw an
 * unexpected error; every still-open buffer is nevertheless aborted before the
 * error reaches World.update.
 */
export function runSchedule(
  schedule: Schedule,
  world: World,
  selectedNames?: readonly ScheduleNode[],
  commandsBySystem?: Map<SystemToken, ReturnType<typeof createCommandBuffer>>,
  finalDrain = true,
  selectedStart = 0,
  selectedEnd?: number,
): readonly ScheduleNode[] | undefined {
  if (schedule.dirty) buildSchedule(schedule);
  // Update borrows a window of this exact compiled order. A registration during
  // the preceding segment may replace it: only that cold path needs membership
  // filtering against the new order, preserving the original selected names.
  const direct = selectedNames === undefined || selectedNames === schedule.sortedOrder;
  const start = direct && selectedNames !== undefined ? selectedStart : 0;
  const end =
    direct && selectedNames !== undefined
      ? (selectedEnd ?? schedule.sortedOrder.length)
      : schedule.sortedOrder.length;
  const selected = direct ? undefined : new Set(selectedNames?.slice(selectedStart, selectedEnd));
  if (commandsBySystem === undefined && schedule.deferredCommands) commandsBySystem = new Map();
  let completed = false;
  let remaining: readonly ScheduleNode[] | undefined;
  try {
    remaining = runScheduleBody(
      schedule,
      world,
      selected,
      commandsBySystem,
      finalDrain,
      start,
      end,
    );
    completed = true;
    return remaining;
  } finally {
    // When Update is split around the FixedUpdate anchor, the first segment
    // deliberately leaves its command buffers open so FixedUpdate observes a
    // stable pre-frame World and the second segment can drain them. Only the
    // final segment (or an exceptional exit) may abort outstanding buffers.
    if (!completed || (finalDrain && remaining === undefined))
      abortOutstandingCommands(commandsBySystem);
  }
}
