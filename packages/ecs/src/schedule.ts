// @forgeax/engine-ecs — DAG Schedule: Kahn topological sort + cycle detection.
//
// addSystem registers a system + marks dirty. First update() triggers buildSchedule().
// Same in-degree systems ordered by addSystem call order (stable tie-breaker, D-05).

import { err, ok, type Result } from '@forgeax/engine-types';
import { type CommandBuffer, createCommandBuffer, flushCommands } from './commands';
import type { Component } from './component';
import {
  CyclicDependencyError,
  ScheduleMutationError,
  SystemFailedError,
  type SystemSetNotRegisteredError,
  systemSetNotRegistered,
} from './errors';
import type { Query, QueryDescriptor } from './query/query';
// type-only import: erases at build time, carries no runtime edge (same
// criterion as scripts/check-ecs-no-runtime-import.mjs). `world.ts` already
// value-imports `schedule.ts`; this back-reference is type-space only so no
// runtime cycle forms (plan-strategy D-1).
import type { ScheduleToken } from './schedule-token';
import type { World } from './world';
import { worldInternal } from './world-internal';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type SystemQueryResults<
  Qs extends ReadonlyArray<QueryDescriptor> = ReadonlyArray<QueryDescriptor>,
> = {
  [K in keyof Qs]: Qs[K] extends QueryDescriptor<
    infer R extends ReadonlyArray<Component>,
    infer W extends ReadonlyArray<Component>,
    infer O extends ReadonlyArray<Component>
  >
    ? Query<NoInfer<R>, NoInfer<W>, NoInfer<O>>
    : Query;
};

/**
 * System descriptor passed to `world.addSystem` — `fn` receives one persistent
 * executable Query per descriptor, mapped over `Qs` without casts.
 *
 * `Qs` is the tuple of query descriptors; defaults to
 * `readonly QueryDescriptor[]` so non-generic call sites stay zero-modification
 * (KD-5). The `fn` first parameter is mapped over `Qs` so each
 * `queryResults[i]` recovers its own row access roles (S-5, KD-2).
 *
 * @example
 * ```ts
 * // Single-query system — row access recovers each component schema.
 * import { defineComponent, World } from '@forgeax/engine-ecs';
 *
 * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
 * const Velocity = defineComponent('Velocity', { dx: 'f32', dy: 'f32' });
 *
 * const world = new World();
 * world.addSystem(Update, {
 *   name: 'movement',
 *   queries: [{ write: [Position], read: [Velocity] }],
 *   fn: (_world, queryResults, _commands) => {
 *     for (const row of queryResults[0]) {
 *       row.mut(Position).x += row.get(Velocity).dx;
 *     }
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Multi-query system — each queryResults[i] keeps its own row shape.
 * const Health = defineComponent('Health', { hp: 'f32' });
 * world.addSystem(Update, {
 *   name: 'multi',
 *   queries: [{ read: [Position] }, { read: [Health] }],
 *   fn: (_world, queryResults) => {
 *     for (const row of queryResults[0]) void row.get(Position).x;
 *     for (const row of queryResults[1]) void row.get(Health).hp;
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Commands-only system — `queries: []` is a legal form; fn receives `[]`.
 * world.addSystem(Update, {
 *   name: 'spawner',
 *   queries: [],
 *   fn: (_world, _queryResults, commands) => {
 *     commands.spawn({ component: Position, data: { x: 0, y: 0 } });
 *   },
 * });
 * ```
 */
export interface SystemDescriptor<
  Qs extends ReadonlyArray<QueryDescriptor> = ReadonlyArray<QueryDescriptor>,
> {
  /** Unique system name (used for before/after references). */
  readonly name: string;
  /** Query descriptors this system reads. */
  readonly queries: Qs;
  /**
   * System function — receives the World, resolved query results, and commands.
   *
   * @param world The owning World — read resources (`world.getResource(KEY)`),
   * resolve components by name, etc. without closure capture.
   * @param queryResults Mapped over `Qs`: each entry is a persistent Query.
   * @param commands Deferred-mutation buffer (flushed after the system).
   */
  readonly fn: (
    world: World,
    queryResults: SystemQueryResults<Qs>,
    commands: CommandBuffer,
  ) => void | unknown;
  /** Run this system after named systems or the FixedUpdate anchor. */
  readonly after?: ReadonlyArray<string | ScheduleToken>;
  /** Run this system before named systems or the FixedUpdate anchor. */
  readonly before?: ReadonlyArray<string | ScheduleToken>;
  /**
   * Run condition. Evaluated each frame after ParamValidation passes (tag
   * 'ok') and before query iteration. Returning `false` skips the system silently —
   * no query runs, no fn call, no state added (plan-strategy D-8). Omitting it
   * (undefined) always runs the system.
   */
  readonly runIf?: (world: World) => boolean;
}

/**
 * A registered system token returned by {@link defineSystem}. Structurally the
 * frozen {@link SystemDescriptor} itself (plan-strategy D-6 — "define ==
 * register"). `world.addSystem(handle)` consumes it directly; the generic `Qs`
 * flows through so the `fn` per-query row access shapes survive (S-5).
 */
export type SystemHandle<
  Qs extends ReadonlyArray<QueryDescriptor> = ReadonlyArray<QueryDescriptor>,
> = SystemDescriptor<Qs>;

/** Internal system record with registration index. */
interface SystemRecord {
  descriptor: SystemDescriptor;
  /** Registration order index (for tie-breaking). */
  registrationIndex: number;
  /** Cached executable Queries, one per descriptor. */
  queries: Query[] | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Schedule
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-set record in the Schedule. Created lazily on first addSystems /
 * addSystems call for a given set name.
 */
export interface SetRecord {
  /** Member system names (insertion-ordered, Set preserves add order). */
  readonly members: Set<string>;
  /** Snapshot of runIf from the defining token. */
  readonly runIf: ((world: import('./world').World) => boolean) | undefined;
  /** Snapshot of chained from the defining token. */
  readonly chained: boolean;
}

/** The Schedule manages system registration, DAG sorting, and execution. */
export interface Schedule {
  /** Owning token for scope-aware diagnostics. */
  readonly token: ScheduleToken;
  /** All registered systems by name. */
  systems: Map<string, SystemRecord>;
  /** Set records keyed by set name. Created lazily. */
  sets: Map<string, SetRecord>;
  /** Next registration index. */
  nextIndex: number;
  /** Whether the sorted order is stale. */
  dirty: boolean;
  /** Sorted system names after buildSchedule(). */
  sortedOrder: string[];
  /** Direct predecessor names derived while the DAG is built. */
  predecessors: Map<string, Set<string>>;
  /** Reverse set membership derived with the schedule graph. */
  systemToSets: Map<string, string[]>;
}

/** Create a fresh Schedule. */
export function createSchedule(token: ScheduleToken): Schedule {
  return {
    token,
    systems: new Map(),
    sets: new Map(),
    nextIndex: 0,
    dirty: true,
    sortedOrder: [],
    predecessors: new Map(),
    systemToSets: new Map(),
  };
}

/**
 * Register a system. Marks schedule as dirty.
 * Queries are lazily initialized on first runSchedule.
 *
 * `const Qs` locks the `queries` tuple at the call site so `fn`'s first
 * parameter recovers per-query row shapes without `as const` annotations
 * (S-5, KD-2). `SystemRecord` itself is intentionally non-generic — the
 * heterogeneous `Qs` cannot be expressed inside the systems Map (KD-3).
 */
export function addSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  schedule: Schedule,
  descriptor: SystemDescriptor<Qs>,
): void {
  const record: SystemRecord = {
    descriptor: descriptor as unknown as SystemDescriptor,
    registrationIndex: schedule.nextIndex++,
    queries: null,
  };
  schedule.systems.set(descriptor.name, record);
  schedule.dirty = true;
}

// ────────────────────────────────────────────────────────────────────────────
// System token construction (token-first World ownership)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Define a system at module level. Returns a frozen {@link SystemHandle} token
 * (the descriptor itself); executable registration is World-local.
 *
 * `world.addSystem(handle)` consumes the token directly — no by-name overload
 * (OOS-8). Duplicate names are resolved by the owning World schedule.
 *
 * `const Qs` locks the `queries` tuple so `fn`'s query-results parameter
 * recovers per-query row access shapes without `as const` (S-5).
 *
 * @example
 * ```ts
 * const Move = defineSystem({
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (_world, queryResults) => { ... },
 * });
 * world.addSystem(Move);
 * ```
 */
export function defineSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  descriptor: SystemDescriptor<Qs>,
): SystemHandle<Qs> {
  const handle = Object.freeze(descriptor) as unknown as SystemHandle<Qs>;
  return handle;
}

/**
 */
// ────────────────────────────────────────────────────────────────────────────
// SystemSet — nominal token (D-2c step 1, w2)
// ────────────────────────────────────────────────────────────────────────────

/** Brand symbol for {@link SystemSet}. Declared (not runtime-initialised) so
 * the token interface carries nominal identity without a runtime allocation.
 * Mirrors the `FORGEAX_STATE_BRAND` pattern in `@forgeax/engine-state`. */
declare const FORGEAX_SYSTEM_SET_BRAND: unique symbol;

/**
 * Opaque branded type for system-set tokens.
 *
 * Use {@link defineSystemSet} to create a token; never construct manually.
 * The {@link __forgeaxSystemSet} brand prevents plain-object assignment and
 * enables TypeScript narrowing at the two mutation entry points.
 */
export interface SystemSet {
  /** Brand — prevents structural compatibility with plain objects. */
  readonly __forgeaxSystemSet: typeof FORGEAX_SYSTEM_SET_BRAND;
  /** The user-supplied set name. */
  readonly name: string;
  /** Optional per-frame run condition. Consumed by M3 condition gate. */
  readonly runIf?: (world: import('./world').World) => boolean;
  /** Whether this set forms a sequential chain (M2). */
  readonly chained?: boolean;
}

/**
 * Define a system set at module level. Returns a frozen branded token and
 * keeps membership in the World-local Schedule.
 *
 * Duplicate names are independent tokens; the owning World decides membership.
 *
 * @example
 * ```ts
 * const GameplaySet = defineSystemSet({ name: 'gameplay', runIf: (w) => !w.getResource<boolean>('paused') });
 * const OrderedSet = defineSystemSet({ name: 'ordered', chained: true });
 * ```
 */
export function defineSystemSet(opts: {
  readonly name: string;
  readonly runIf?: (world: import('./world').World) => boolean;
  readonly chained?: boolean;
}): SystemSet {
  const token: Record<string, unknown> = {
    __forgeaxSystemSet: undefined as unknown as typeof FORGEAX_SYSTEM_SET_BRAND,
    name: opts.name,
  };
  if (opts.runIf !== undefined) {
    token.runIf = opts.runIf;
  }
  if (opts.chained !== undefined) {
    token.chained = opts.chained;
  }
  const frozen = Object.freeze(token) as unknown as SystemSet;
  return frozen;
}

/**
/**
 * Validate every token in `tokens` for local structural validity.
 * Returns `ok(undefined)` for a structurally valid token and reports an empty
 * token name as a structured registration error.
 *
 * Does not write any Schedule state — callers consume the `Result` and proceed
 * only on `ok`.
 */
export function validateSystemSetTokens(
  tokens: readonly SystemSet[],
): Result<void, SystemSetNotRegisteredError> {
  for (const token of tokens) {
    if (token.name.length === 0) {
      return err(systemSetNotRegistered(token.name, []));
    }
  }
  return ok(undefined);
}

/**
 * Remove a registered system by name (M2 — plan-strategy D-3).
 *
 * Drops the entry from `schedule.systems` and marks the schedule dirty so the
 * next `runSchedule` rebuilds the sorted order via Kahn topo. Cycle detection
 * already happens inside `buildSchedule`, so a removal that breaks an unrelated
 * `before/after` reference simply skips the unknown name (existing behaviour).
 *
 * Failure: name not registered → `Result.err(ScheduleMutationError)` with
 * `.code = 'system-before-unknown'` and `.detail.candidates` carrying the
 * registered names for AI-friendly typo recovery.
 */
export function removeSystem(
  schedule: Schedule,
  name: string,
): Result<void, ScheduleMutationError> {
  if (!schedule.systems.has(name)) {
    return err(
      new ScheduleMutationError(
        'system-before-unknown',
        `Cannot removeSystem: no system registered as "${name}".`,
        'Call world.inspect().systems to discover registered names.',
        { candidates: [...schedule.systems.keys()] },
      ),
    );
  }
  schedule.systems.delete(name);
  // Prune set membership: remove this system name from every set's members (D-1).
  for (const [, setRecord] of schedule.sets) {
    setRecord.members.delete(name);
  }
  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Replace a registered system in-place (M2 — plan-strategy D-3 atomic semantics).
 *
 * Overwrites the `descriptor` field of the existing `SystemRecord` while
 * keeping `registrationIndex` and the `Map` slot identical, so all `before /
 * after` edges that reference this name remain bound to the same slot. Marks
 * the schedule dirty: the next `runSchedule` re-sorts.
 *
 * Failure: name not registered → `Result.err(ScheduleMutationError)` with
 * `.code = 'system-before-unknown'`.
 */
export function replaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  schedule: Schedule,
  name: string,
  descriptor: SystemDescriptor<Qs>,
): Result<void, ScheduleMutationError> {
  const record = schedule.systems.get(name);
  if (!record) {
    return err(
      new ScheduleMutationError(
        'system-before-unknown',
        `Cannot replaceSystem: no system registered as "${name}".`,
        'Call world.inspect().systems to discover registered names; or addSystem(descriptor) to register a new system.',
        { candidates: [...schedule.systems.keys()] },
      ),
    );
  }
  record.descriptor = descriptor as unknown as SystemDescriptor;
  // Reset cached query states — descriptor.queries may have changed shape.
  record.queries = null;
  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Batch-register systems to a set. Validates the set token before writing.
 *
 * - First call for a system name: registers via the existing `addSystem` path.
 * - Subsequent calls: only adds the system name to the set's members (dedup).
 * - `runIf` / `chained` are snapshotted from the token into the SetRecord on
 *   first encounter.
 *
 * Returns `Result.err` with `SystemSetNotRegisteredError` if the set token
 * fails identity validation.
 */
export function addSystems<const Qs extends ReadonlyArray<QueryDescriptor>>(
  schedule: Schedule,
  set: SystemSet,
  systems: ReadonlyArray<SystemDescriptor<Qs>>,
): Result<void, SystemSetNotRegisteredError> {
  const validated = validateSystemSetTokens([set]);
  if (!validated.ok) {
    return err(validated.error);
  }

  const setName = set.name;
  let record = schedule.sets.get(setName);
  if (!record) {
    record = {
      members: new Set(),
      runIf: set.runIf,
      chained: set.chained ?? false,
    };
    schedule.sets.set(setName, record);
  }

  for (const system of systems) {
    const name = system.name;
    // Dedup: only register the system once in schedule.systems.
    if (!schedule.systems.has(name)) {
      addSystem(schedule, system);
    }
    // Always add membership — multi-belong is supported.
    record.members.add(name);
  }

  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Build the sorted execution order via Kahn's topological sort.
 * Throws CyclicDependencyError if a cycle is detected.
 *
 * @returns sorted system names
 */
export function buildSchedule(schedule: Schedule): string[] {
  const systems = schedule.systems;
  const names = [...systems.keys()];
  if (schedule.token.name === 'Update') names.push('FixedUpdate');
  const nameSet = new Set(names);

  // Build adjacency list + in-degree map.
  const adj = new Map<string, string[]>(); // adj[a] = [b] means a → b (a must run before b)
  const inDegree = new Map<string, number>();
  const predecessors = new Map<string, Set<string>>();

  for (const name of names) {
    adj.set(name, []);
    inDegree.set(name, 0);
    predecessors.set(name, new Set());
  }

  const addEdge = (source: string, target: string): void => {
    adj.get(source)?.push(target);
    predecessors.get(target)?.add(source);
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  };
  const orderReferenceName = (reference: string | ScheduleToken): string =>
    typeof reference === 'string' ? reference : reference.name;

  // A reference to the registration scope brackets every execution of that
  // schedule. Reuse the existing ordering vocabulary for per-tick boundaries.
  const first = new Set<string>();
  const last = new Set<string>();
  for (const [name, record] of systems) {
    if (record.descriptor.before?.includes(schedule.token)) first.add(name);
    if (record.descriptor.after?.includes(schedule.token)) last.add(name);
  }
  for (const name of names) {
    if (first.has(name) && last.has(name)) addEdge(name, name);
    if (!first.has(name)) for (const start of first) addEdge(start, name);
    if (!last.has(name)) for (const end of last) addEdge(name, end);
  }

  for (const [name, record] of systems) {
    const desc = record.descriptor;

    // "after" constraints: for each dep in after, dep → name (dep runs before name)
    if (desc.after) {
      for (const reference of desc.after) {
        if (reference === schedule.token) continue;
        const dep = orderReferenceName(reference);
        if (!nameSet.has(dep)) continue; // scope validation handles cross-schedule references
        addEdge(dep, name);
      }
    }

    // "before" constraints: for each target in before, name → target (name runs before target)
    if (desc.before) {
      for (const reference of desc.before) {
        if (reference === schedule.token) continue;
        const target = orderReferenceName(reference);
        if (!nameSet.has(target)) continue; // scope validation handles cross-schedule references
        addEdge(name, target);
      }
    }
  }

  // Set membership contributes only run conditions and optional chaining.
  const systemToSets = new Map<string, string[]>();
  for (const [setName, setRecord] of schedule.sets) {
    for (const member of setRecord.members) {
      if (!systems.has(member)) continue;
      let sets = systemToSets.get(member);
      if (sets === undefined) {
        sets = [];
        systemToSets.set(member, sets);
      }
      sets.push(setName);
    }
    if (setRecord.chained) {
      const members = [...setRecord.members];
      for (let i = 0; i < members.length - 1; i++) {
        const m1 = members[i];
        const m2 = members[i + 1];
        if (!m1 || !m2 || !nameSet.has(m1) || !nameSet.has(m2)) continue;
        // m1 → m2 (m1 runs before m2)
        addEdge(m1, m2);
      }
    }
  }

  // Kahn's algorithm with registration-order tie-breaker.
  // Use a queue sorted by registrationIndex for deterministic ordering.
  const queue: string[] = [];
  for (const name of names) {
    if (inDegree.get(name) === 0) {
      queue.push(name);
    }
  }
  // Sort initial queue by registration index. The fixed anchor is intrinsic and
  // receives a deterministic slot after user systems with the same indegree.
  queue.sort(
    (a, b) =>
      (systems.get(a)?.registrationIndex ?? Number.MAX_SAFE_INTEGER) -
      (systems.get(b)?.registrationIndex ?? Number.MAX_SAFE_INTEGER),
  );

  const sorted: string[] = [];
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: while(queue.length > 0) guarantees shift() returns a value
    const current = queue.shift()!;
    sorted.push(current);

    const neighbors = adj.get(current) ?? [];
    // Collect newly freed neighbors, then sort by registration index
    const freed: string[] = [];
    for (const neighbor of neighbors) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        freed.push(neighbor);
      }
    }
    freed.sort(
      (a, b) =>
        (systems.get(a)?.registrationIndex ?? Number.MAX_SAFE_INTEGER) -
        (systems.get(b)?.registrationIndex ?? Number.MAX_SAFE_INTEGER),
    );
    queue.push(...freed);
  }

  // Cycle detection: if we didn't process all nodes, there's a cycle.
  if (sorted.length < names.length) {
    // Find nodes still with in-degree > 0 (part of cycle).
    const remaining = names.filter((n) => !sorted.includes(n));
    const cyclePath = findCyclePath(remaining, adj);
    throw new CyclicDependencyError(cyclePath);
  }

  schedule.sortedOrder = sorted;
  schedule.predecessors = predecessors;
  schedule.systemToSets = systemToSets;
  schedule.dirty = false;
  return sorted;
}

/**
 * Find a cycle path among the remaining (unprocessed) nodes.
 * Returns the cycle as a readonly array of node names.
 */
function findCyclePath(remaining: string[], adj: Map<string, string[]>): readonly string[] {
  const remainSet = new Set(remaining);
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): readonly string[] | null {
    if (visited.has(node)) {
      // Found cycle: extract cycle from path
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart);
      cycle.push(node);
      return cycle;
    }
    visited.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (!remainSet.has(neighbor)) continue;
      const result = dfs(neighbor);
      if (result) return result;
    }

    path.pop();
    return null;
  }

  for (const start of remaining) {
    visited.clear();
    path.length = 0;
    const result = dfs(start);
    if (result) return result;
  }

  /* istanbul ignore next -- fallback: DFS always finds cycle in remaining nodes */
  return remaining;
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
  commandsBySystem: Map<string, ReturnType<typeof createCommandBuffer>>,
): void {
  for (const commands of commandsBySystem.values()) {
    if (commands.status === 'open') commands.abort();
  }
}

/**
 * Execute all systems in sorted order. Rebuilds schedule if dirty.
 * Each system receives its query results and a command buffer.
 * The world parameter provides the archetype graph, component ID resolution,
 * and resource checks.
 *
 * Layer 2 (ParamValidation): query empty → skip, resource missing → invalid.
 * A returned Result error poisons the active frame and stops execution.
 */
function runScheduleBody(
  schedule: Schedule,
  world: World,
  selectedNames: readonly string[] | undefined,
  commandsBySystem: Map<string, ReturnType<typeof createCommandBuffer>>,
  finalDrain = true,
): void {
  if (schedule.dirty) {
    buildSchedule(schedule);
  }
  if (
    selectedNames === undefined &&
    schedule.sets.size === 0 &&
    commandsBySystem.size === 0 &&
    schedule.sortedOrder.every((name) => {
      const record = schedule.systems.get(name);
      return (
        record !== undefined &&
        record.descriptor.queries.length === 0 &&
        record.descriptor.runIf === undefined &&
        (schedule.predecessors.get(name)?.size ?? 0) === 0
      );
    })
  ) {
    for (const name of schedule.sortedOrder) {
      const record = schedule.systems.get(name);
      /* istanbul ignore next -- sortedOrder comes from systems Map keys */
      if (!record) continue;

      const commands = createCommandBuffer(world, {
        systemName: name,
        scheduleName: schedule.token.name,
      });
      commandsBySystem.set(name, commands);
      let returnValue: unknown;
      try {
        returnValue = record.descriptor.fn(world, [], commands);
      } catch (error) {
        abortOutstandingCommands(commandsBySystem);
        poisonSystemFailure(world, name, error);
        throw new SystemFailedError(name, schedule.token.name, error);
      }
      if (returnValue && typeof returnValue === 'object' && 'ok' in returnValue) {
        const result = returnValue as { ok: boolean; error?: unknown };
        if (result.ok === false && result.error !== undefined) {
          abortOutstandingCommands(commandsBySystem);
          poisonSystemFailure(world, name, result.error);
          throw new SystemFailedError(name, schedule.token.name, result.error);
        }
      }
    }
    if (finalDrain) {
      try {
        for (const commands of commandsBySystem.values()) {
          flushCommands(commands, world);
        }
      } catch (error) {
        abortOutstandingCommands(commandsBySystem);
        throw error;
      }
    }
    return;
  }
  const selected = selectedNames ? new Set(selectedNames) : undefined;

  const systemToSets = schedule.systemToSets;

  // Per-frame set runIf cache (D-5). Discarded at frame end — no cross-frame state.
  const setRunIfCache = new Map<string, boolean>();

  for (const name of schedule.sortedOrder) {
    if (selected && !selected.has(name)) continue;
    const record = schedule.systems.get(name);
    /* istanbul ignore next -- defensive: sortedOrder comes from systems Map keys */
    if (!record) continue;

    // Apply only buffers that have an explicit graph edge into this system.
    for (const predecessor of schedule.predecessors.get(name) ?? []) {
      const producerCommands = commandsBySystem.get(predecessor);
      if (producerCommands) {
        try {
          flushCommands(producerCommands, world);
        } catch (error) {
          abortOutstandingCommands(commandsBySystem);
          throw error;
        }
      }
    }

    // Lazily initialize the persistent executable queries on first run.
    if (record.queries === null) {
      record.queries = record.descriptor.queries.map((descriptor) => {
        const result = world.query(descriptor);
        if (!result.ok) throw result.error;
        return result.value;
      });
    }
    // ── Set-level runIf AND gate (D-5) ──
    // before system-level runIf. Each set's runIf is lazily cached per frame. ──
    const setNames = systemToSets.get(name);
    let allSetConditionsPass = true;
    if (setNames) {
      for (const setName of setNames) {
        const setRecord = schedule.sets.get(setName);
        if (setRecord?.runIf) {
          let cached = setRunIfCache.get(setName);
          if (cached === undefined) {
            cached = setRecord.runIf(world);
            setRunIfCache.set(setName, cached);
          }
          if (!cached) {
            allSetConditionsPass = false;
            break;
          }
        }
      }
    }
    if (!allSetConditionsPass) {
      continue; // skip system: no system runIf, query iteration, or fn
    }

    // ── Run condition (runIf) — evaluated after ParamValidation 'ok', before
    // query iteration. false -> skip silently (no query, no fn, no cursor advance). ──
    if (record.descriptor.runIf && !record.descriptor.runIf(world)) {
      continue;
    }

    // ── Layer 3: system execution + Result collection ──
    // trusted-cast: the descriptor tuple constructed the matching Query tuple above.
    const commands = createCommandBuffer(world, {
      systemName: name,
      scheduleName: schedule.token.name,
    });
    commandsBySystem.set(name, commands);
    let returnValue: unknown;
    try {
      returnValue = record.descriptor.fn(
        world,
        record.queries as Parameters<typeof record.descriptor.fn>[1],
        commands,
      );
    } catch (error) {
      abortOutstandingCommands(commandsBySystem);
      poisonSystemFailure(world, name, error);
      throw new SystemFailedError(name, schedule.token.name, error);
    }

    // A returned Result error is a poisoned frame failure.
    if (returnValue && typeof returnValue === 'object' && 'ok' in (returnValue as object)) {
      const result = returnValue as { ok: boolean; error?: unknown };
      if (result.ok === false && result.error !== undefined) {
        abortOutstandingCommands(commandsBySystem);
        poisonSystemFailure(world, name, result.error);
        throw new SystemFailedError(name, schedule.token.name, result.error);
      }
    }
    // void return is treated as successful execution.
  }

  if (finalDrain) {
    // A schedule boundary drains every remaining buffer, including commands
    // enqueued by lifecycle hooks while another command is being applied.
    try {
      for (const commands of commandsBySystem.values()) {
        flushCommands(commands, world);
      }
    } catch (error) {
      abortOutstandingCommands(commandsBySystem);
      throw error;
    }
  }
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
  selectedNames?: readonly string[],
  commandsBySystem = new Map<string, ReturnType<typeof createCommandBuffer>>(),
  finalDrain = true,
): void {
  let completed = false;
  try {
    runScheduleBody(schedule, world, selectedNames, commandsBySystem, finalDrain);
    completed = true;
  } finally {
    // When Update is split around the FixedUpdate anchor, the first segment
    // deliberately leaves its command buffers open so FixedUpdate observes a
    // stable pre-frame World and the second segment can drain them. Only the
    // final segment (or an exceptional exit) may abort outstanding buffers.
    if (!completed || finalDrain) abortOutstandingCommands(commandsBySystem);
  }
}
