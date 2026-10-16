// @forgeax/engine-ecs — CommandBuffer: deferred structural changes.
//
// System execution queues spawn/despawn/addComponent/removeComponent commands.
// world.update() flushes the queue at frame end with while(queue.length > 0)
// cascade support (D-06). Deferred spawn returns pending Entity handle (D-07).

import type { Result } from '@forgeax/engine-types';
import type { Component, ComponentSchema } from './component';
import { componentId } from './component';
import { fillComponentDefaults, validateComponentDataKeys } from './component-default-fallback';
import { Entity } from './entity';
import { ENTITY_NULL_RAW, type EntityHandle, entityGeneration, entityIndex } from './entity-handle';
import {
  type CommandCommitEvidence,
  CommandFailedError,
  type CommandKind,
  ComponentAlreadyPresentError,
  ComponentNotPresentError,
  RelationshipSelfCycleError,
  RelationshipTargetReadonlyError,
  RemoveEssentialComponentError,
  StaleEntityError,
  SystemFailedError,
} from './errors';
import type { WorldExecutionState } from './execution/shared-kernel';
import { isRelationshipTarget, relationshipRole } from './relationship-index';
import type { ComponentData, EcsError } from './world';
import { type WorldInternal, worldInternal } from './world-internal';

// ────────────────────────────────────────────────────────────────────────────
// Command types
// ────────────────────────────────────────────────────────────────────────────

export type Command =
  | { type: 'spawn'; componentDatas: ComponentData[]; entity: EntityHandle }
  | { type: 'despawn'; entity: EntityHandle }
  | { type: 'addComponent'; entity: EntityHandle; componentData: ComponentData }
  | { type: 'removeComponent'; entity: EntityHandle; component: Component };

// ────────────────────────────────────────────────────────────────────────────
// CommandBuffer interface
// ────────────────────────────────────────────────────────────────────────────

/**
 * CommandBuffer queues structural changes (spawn/despawn/addComponent/removeComponent)
 * during system execution. Flushed at end of world.update().
 */
export interface CommandBuffer {
  readonly status: 'open' | 'committed' | 'aborted';
  /** Deferred spawn: returns pending Entity handle. */
  spawn(...componentDatas: ComponentData[]): EntityHandle;
  /** Deferred despawn. */
  despawn(entity: EntityHandle): unknown;
  /** Deferred addComponent. */
  addComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
  ): unknown;
  /** Deferred removeComponent. */
  removeComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): unknown;
  /** Check if an entity is pending (deferred spawn, not yet flushed). */
  isDeferred(entity: EntityHandle): boolean;
  commit(): void;
  abort(error?: unknown): void;
}

// ────────────────────────────────────────────────────────────────────────────
// World access interface (avoids circular import)
// ────────────────────────────────────────────────────────────────────────────

/** Minimal world interface needed by CommandBuffer for entity allocation. */
export interface WorldForCommands {
  readonly [worldInternal]: WorldInternal;
  readonly execution: WorldExecutionState;
  /**
   * Allocate a pending entity index, returning [entity handle, index slot].
   * @internal
   */
  /**
   * Mark a pending entity as materialized (flush phase).
   * @internal
   */
  /** Execute despawn directly (flush phase). */
  despawn(entity: EntityHandle): Result<void, EcsError>;
  /** Execute addComponent directly (flush phase). */
  addComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
  ): Result<void, EcsError>;
  /** Execute removeComponent directly (flush phase). */
  removeComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<void, EcsError>;
  /** Fast membership probe used by command preflight. */
  hasComponent(entity: EntityHandle, component: Component): boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────────────

export interface CommandBufferImpl extends CommandBuffer {
  /** @internal */
  _queue: Command[];
  /** @internal */
  _pendingEntities: Set<number>;
  /** @internal First validation failure captured while the system was staging commands. */
  _queueError: {
    readonly index: number;
    readonly kind: CommandKind;
    readonly cause: unknown;
  } | null;
  /** @internal */
  readonly _systemName: string;
  /** @internal */
  readonly _scheduleName: string;
  /** @internal */
  _setStatus(status: 'committed' | 'aborted'): void;
}

/**
 * Create a CommandBuffer bound to a World.
 * @param world - the World (for pending entity allocation)
 */
export function createCommandBuffer(
  world: WorldForCommands,
  context: { readonly systemName?: string; readonly scheduleName?: string } = {},
): CommandBufferImpl {
  const queue: Command[] = [];
  const pendingEntities = new Set<number>();
  let status: CommandBuffer['status'] = 'open';
  let queueError: CommandBufferImpl['_queueError'] = null;
  const ensureOpen = (): void => {
    if (status !== 'open') throw new Error(`CommandBuffer is ${status}`);
  };
  const recordQueueError = (index: number, kind: CommandKind, cause: unknown): void => {
    if (queueError === null) queueError = { index, kind, cause };
  };

  const buffer: CommandBufferImpl = {
    _queue: queue,
    _pendingEntities: pendingEntities,
    _systemName: context.systemName ?? '<unknown-system>',
    _scheduleName: context.scheduleName ?? '<unknown-schedule>',
    get status() {
      return status;
    },
    get _queueError() {
      return queueError;
    },
    _setStatus(next) {
      if (status === 'open') status = next;
    },
    commit() {
      ensureOpen();
      status = 'committed';
      queue.length = 0;
      pendingEntities.clear();
      queueError = null;
    },
    abort() {
      if (status !== 'open') return;
      for (const raw of pendingEntities) {
        world[worldInternal].cancelPendingEntity(raw as EntityHandle);
      }
      status = 'aborted';
      queue.length = 0;
      pendingEntities.clear();
      queueError = null;
    },

    spawn(...componentDatas: ComponentData[]): EntityHandle {
      ensureOpen();
      // bug-20260615: validate raw spawn keys at queue time (synchronous,
      // points at the calling system's stack) rather than only at flush
      // time. Commands.spawn returns EntityHandle (no Result channel), so
      // unknown-key is captured as a batch preflight failure.  The handle is
      // still reserved so callers may compose later commands; abort releases
      // every reservation without leaking a free slot.
      for (const cd of componentDatas) {
        const keyErr = validateComponentDataKeys(cd.component, cd.data as Record<string, unknown>);
        if (keyErr !== null) recordQueueError(queue.length, 'spawn', keyErr);
      }
      const entity = world[worldInternal].allocatePendingEntity();
      pendingEntities.add(entity as unknown as number);
      queue.push({ type: 'spawn', componentDatas, entity });
      return entity;
    },

    despawn(entity: EntityHandle): void {
      ensureOpen();
      queue.push({ type: 'despawn', entity });
    },

    addComponent<S extends ComponentSchema>(
      entity: EntityHandle,
      componentData: ComponentData<S>,
    ): void {
      ensureOpen();
      const keyErr = validateComponentDataKeys(
        componentData.component,
        componentData.data as Record<string, unknown>,
      );
      if (keyErr !== null) recordQueueError(queue.length, 'addComponent', keyErr);
      queue.push({ type: 'addComponent', entity, componentData: componentData as ComponentData });
    },

    removeComponent<S extends ComponentSchema>(
      entity: EntityHandle,
      component: Component<string, S>,
    ): void {
      ensureOpen();
      queue.push({ type: 'removeComponent', entity, component: component as Component });
    },

    isDeferred(entity: EntityHandle): boolean {
      return pendingEntities.has(entity as unknown as number);
    },
  };

  return buffer;
}

function commandFailure(
  buffer: CommandBufferImpl,
  index: number,
  kind: CommandKind,
  cause: unknown,
): CommandFailedError {
  return new CommandFailedError(buffer._systemName, buffer._scheduleName, index, kind, cause);
}

type RelationshipOverlay = Map<number, Map<number, EntityHandle | null>>;

function relationshipTarget(
  component: Component,
  data: Readonly<Record<string, unknown>>,
): EntityHandle | null {
  const role = relationshipRole(component);
  if (role?.kind !== 'source') return null;
  const raw = data[role.sourceField];
  if (raw === null || raw === undefined || raw === ENTITY_NULL_RAW) return null;
  return raw as EntityHandle;
}

function overlayTarget(
  overlay: RelationshipOverlay,
  entity: EntityHandle,
  component: Component,
): EntityHandle | null | undefined {
  return overlay.get(entity as number)?.get(componentId(component));
}

function setOverlayTarget(
  overlay: RelationshipOverlay,
  entity: EntityHandle,
  component: Component,
  target: EntityHandle | null,
): void {
  let entries = overlay.get(entity as number);
  if (entries === undefined) {
    entries = new Map();
    overlay.set(entity as number, entries);
  }
  entries.set(componentId(component), target);
}

/**
 * Check a relationship edge against committed rows plus the batch overlay.
 * The overlay is the only extra state needed: it records at most one target
 * per affected source/component, so a batch remains O(C + A) rather than
 * rescanning every World entity.
 */
function relationshipCycle(
  world: WorldForCommands,
  holder: EntityHandle,
  component: Component,
  target: EntityHandle | null,
  overlay: RelationshipOverlay,
): RelationshipSelfCycleError | undefined {
  if (target === null) return undefined;
  const role = relationshipRole(component);
  const allowSelf = role?.kind === 'source' && role.allowSelf;
  if (holder === target && !allowSelf) {
    return new RelationshipSelfCycleError(component.name, holder as number, target as number);
  }
  const visited = new Set<number>();
  let current: EntityHandle | null = target;
  while (current !== null) {
    const raw = current as number;
    if (raw === (holder as number) && !(holder === target && allowSelf)) {
      return new RelationshipSelfCycleError(component.name, holder as number, raw);
    }
    if (visited.has(raw)) return undefined;
    visited.add(raw);
    const staged = overlayTarget(overlay, current, component);
    if (staged !== undefined || overlay.get(raw)?.has(componentId(component)) === true) {
      current = staged ?? null;
      continue;
    }
    const row = world[worldInternal].getQueryRow(current, component);
    if (!row.ok) return undefined;
    current = relationshipTarget(component, row.value);
  }
  return undefined;
}

/**
 * Validate the failures that can be proven from the current World and the
 * command batch without mutating storage.  The commit loop remains the only
 * writer; any failure not provable here is treated as an unexpected post-write
 * failure and poisons the World.
 */
function preflightCommands(buffer: CommandBufferImpl, world: WorldForCommands): void {
  if (buffer._queueError !== null) {
    const { index, kind, cause } = buffer._queueError;
    throw commandFailure(buffer, index, kind, cause);
  }

  type Shadow = {
    readonly components: Set<number>;
    readonly added: Set<number>;
    readonly removed: Set<number>;
    dead: boolean;
    pending: boolean;
  };
  const shadows = new Map<number, Shadow>();
  const relationshipOverlay: RelationshipOverlay = new Map();
  const unavailableEntities = new Set<number>();
  const availablePendingEntities = new Set<number>();
  const shadowFor = (entity: EntityHandle): Shadow => {
    const raw = entity as unknown as number;
    const current = shadows.get(raw);
    if (current !== undefined) return current;
    const shadow: Shadow = {
      components: new Set<number>(),
      added: new Set<number>(),
      removed: new Set<number>(),
      dead: false,
      pending: false,
    };
    shadows.set(raw, shadow);
    return shadow;
  };
  const validateData = (
    holder: EntityHandle | null,
    componentData: ComponentData,
  ): unknown | undefined => {
    const result = world[worldInternal].preflightComponentData(
      holder,
      componentData,
      availablePendingEntities,
      unavailableEntities,
    );
    return result.ok ? undefined : result.error;
  };
  const liveError = (entity: EntityHandle, operation: string, component?: Component): unknown => {
    const result = world[worldInternal].lookupAlive(entity, operation, component?.name);
    return result.ok ? undefined : result.error;
  };
  for (const [index, command] of buffer._queue.entries()) {
    switch (command.type) {
      case 'spawn': {
        const raw = command.entity as unknown as number;
        const shadow = shadowFor(command.entity);
        shadow.pending = true;
        availablePendingEntities.add(raw);
        for (const componentData of command.componentDatas) {
          const dataError = validateData(command.entity, componentData);
          if (dataError !== undefined) throw commandFailure(buffer, index, command.type, dataError);
          if (shadow.components.has(componentId(componentData.component))) {
            throw commandFailure(
              buffer,
              index,
              command.type,
              new ComponentAlreadyPresentError(raw, componentData.component.name),
            );
          }
          shadow.components.add(componentId(componentData.component));
          const role = relationshipRole(componentData.component);
          if (role?.kind === 'source') {
            const filled = fillComponentDefaults(
              componentData.component,
              componentData.data as Record<string, unknown>,
            );
            const target = relationshipTarget(componentData.component, filled);
            setOverlayTarget(relationshipOverlay, command.entity, componentData.component, target);
            const cycle = relationshipCycle(
              world,
              command.entity,
              componentData.component,
              target,
              relationshipOverlay,
            );
            if (cycle !== undefined) throw commandFailure(buffer, index, command.type, cycle);
          }
        }
        break;
      }
      case 'despawn': {
        const shadow = shadowFor(command.entity);
        if (!shadow.pending && !world.hasComponent(command.entity, Entity)) {
          // A stale handle is a no-op for the direct facade today; preserve
          // that contract instead of inventing a new command error.
          shadow.dead = true;
          unavailableEntities.add(command.entity as unknown as number);
          availablePendingEntities.delete(command.entity as unknown as number);
          break;
        }
        shadow.dead = true;
        unavailableEntities.add(command.entity as unknown as number);
        availablePendingEntities.delete(command.entity as unknown as number);
        break;
      }
      case 'addComponent': {
        const raw = command.entity as unknown as number;
        const shadow = shadowFor(command.entity);
        const dataError = validateData(command.entity, command.componentData);
        if (dataError !== undefined) throw commandFailure(buffer, index, command.type, dataError);
        if (!shadow.pending) {
          const stale = liveError(
            command.entity,
            'command.addComponent',
            command.componentData.component,
          );
          if (stale !== undefined) throw commandFailure(buffer, index, command.type, stale);
        }
        const role = relationshipRole(command.componentData.component);
        const present = shadow.pending
          ? shadow.components.has(componentId(command.componentData.component))
          : shadow.removed.has(componentId(command.componentData.component))
            ? false
            : shadow.added.has(componentId(command.componentData.component)) ||
              world.hasComponent(command.entity, command.componentData.component);
        if (shadow.dead) {
          throw commandFailure(
            buffer,
            index,
            command.type,
            liveError(command.entity, 'command.addComponent', command.componentData.component) ??
              new StaleEntityError(
                raw,
                entityIndex(command.entity),
                entityGeneration(command.entity),
                {
                  operation: 'command.addComponent',
                  expectedGeneration: entityGeneration(command.entity),
                  actualGeneration: -1,
                },
              ),
          );
        }
        const reparent =
          present && role?.kind === 'source' && role.exclusive === true && !shadow.pending;
        if (present && !reparent) {
          throw commandFailure(
            buffer,
            index,
            command.type,
            new ComponentAlreadyPresentError(raw, command.componentData.component.name),
          );
        }
        shadow.components.add(componentId(command.componentData.component));
        if (!reparent) shadow.added.add(componentId(command.componentData.component));
        shadow.removed.delete(componentId(command.componentData.component));
        if (role?.kind === 'source') {
          const filled = fillComponentDefaults(
            command.componentData.component,
            command.componentData.data as Record<string, unknown>,
          );
          const target = relationshipTarget(command.componentData.component, filled);
          setOverlayTarget(
            relationshipOverlay,
            command.entity,
            command.componentData.component,
            target,
          );
          const cycle = relationshipCycle(
            world,
            command.entity,
            command.componentData.component,
            target,
            relationshipOverlay,
          );
          if (cycle !== undefined) throw commandFailure(buffer, index, command.type, cycle);
        }
        break;
      }
      case 'removeComponent': {
        const raw = command.entity as unknown as number;
        if (isRelationshipTarget(command.component)) {
          throw commandFailure(
            buffer,
            index,
            command.type,
            new RelationshipTargetReadonlyError(command.component.name, 'removeComponent'),
          );
        }
        if (componentId(command.component) === 0) {
          throw commandFailure(
            buffer,
            index,
            command.type,
            new RemoveEssentialComponentError(command.component.name),
          );
        }
        const shadow = shadowFor(command.entity);
        if (shadow.dead) {
          throw commandFailure(
            buffer,
            index,
            command.type,
            liveError(command.entity, 'command.removeComponent', command.component) ??
              new StaleEntityError(
                raw,
                entityIndex(command.entity),
                entityGeneration(command.entity),
                {
                  operation: 'command.removeComponent',
                  expectedGeneration: entityGeneration(command.entity),
                  actualGeneration: -1,
                },
              ),
          );
        }
        if (!shadow.pending) {
          const stale = liveError(command.entity, 'command.removeComponent', command.component);
          if (stale !== undefined) throw commandFailure(buffer, index, command.type, stale);
        }
        const present = shadow.pending
          ? shadow.components.has(componentId(command.component))
          : shadow.removed.has(componentId(command.component))
            ? false
            : shadow.added.has(componentId(command.component)) ||
              world.hasComponent(command.entity, command.component);
        if (!present) {
          throw commandFailure(
            buffer,
            index,
            command.type,
            new ComponentNotPresentError(raw, command.component.name),
          );
        }
        shadow.components.delete(componentId(command.component));
        shadow.removed.add(componentId(command.component));
        shadow.added.delete(componentId(command.component));
        if (relationshipRole(command.component)?.kind === 'source') {
          setOverlayTarget(relationshipOverlay, command.entity, command.component, null);
        }
        break;
      }
    }
  }
}

/**
 * Flush all queued commands against the World.
 * Uses while(queue.length > 0) to support cascade (commands spawned during flush).
 */
export function flushCommands(buffer: CommandBufferImpl, world: WorldForCommands): void {
  if (buffer.status !== 'open') return;
  const queue = buffer._queue;
  try {
    preflightCommands(buffer, world);
  } catch (error) {
    buffer.abort(error);
    throw error;
  }
  let applied = 0;
  // Once the preflight boundary has passed, a command may have touched
  // storage even when its Result is an error (for example relationship
  // maintenance after a row was appended). `applied` is intentionally not
  // used as the poison decision: it only counts commands that returned ok.
  let mutationStarted = false;
  let commandIndex = -1;
  let currentCommand: Command | undefined;
  let lastCommittedCommand: CommandCommitEvidence | null = null;
  try {
    const requireSuccess = (result: unknown): void => {
      if (
        result !== null &&
        typeof result === 'object' &&
        'ok' in result &&
        (result as { readonly ok: boolean }).ok === false
      ) {
        throw (result as { readonly error?: unknown }).error ?? new Error('Command failed');
      }
    };
    while (queue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: queue length is checked
      const cmd = queue.shift()!;
      commandIndex += 1;
      currentCommand = cmd;
      switch (cmd.type) {
        case 'spawn':
          mutationStarted = true;
          requireSuccess(
            world[worldInternal].materializePendingEntity(cmd.entity, cmd.componentDatas),
          );
          buffer._pendingEntities.delete(cmd.entity as unknown as number);
          applied += 1;
          lastCommittedCommand = { index: commandIndex, kind: cmd.type };
          break;
        case 'despawn':
          mutationStarted = true;
          requireSuccess(world.despawn(cmd.entity));
          applied += 1;
          lastCommittedCommand = { index: commandIndex, kind: cmd.type };
          break;
        case 'addComponent':
          mutationStarted = true;
          requireSuccess(world.addComponent(cmd.entity, cmd.componentData));
          applied += 1;
          lastCommittedCommand = { index: commandIndex, kind: cmd.type };
          break;
        case 'removeComponent':
          mutationStarted = true;
          requireSuccess(world.removeComponent(cmd.entity, cmd.component));
          applied += 1;
          lastCommittedCommand = { index: commandIndex, kind: cmd.type };
          break;
      }
    }
    buffer.commit();
  } catch (error) {
    buffer.abort(error);
    if (error instanceof CommandFailedError) throw error;
    if (!mutationStarted && applied === 0) {
      throw commandFailure(
        buffer,
        Math.max(commandIndex, 0),
        currentCommand?.type ?? 'spawn',
        error,
      );
    }
    world[worldInternal].poisonExecution({
      code: 'shared-kernel-failed',
      kernelName: 'CommandBuffer.flush',
      cause: error,
      partialWrite: true,
      retryable: false,
    });
    throw new SystemFailedError(
      buffer._systemName,
      buffer._scheduleName,
      error,
      lastCommittedCommand,
    );
  }
}
