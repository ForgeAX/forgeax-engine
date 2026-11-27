import { createCommandFailedError, createSystemFailedError, isEcsFault } from './errors';
import { relationshipTarget } from './relationship-index';
// @forgeax/engine-ecs — CommandBuffer: deferred structural changes.
//
// System execution queues spawn/despawn/addComponent/removeComponent commands.
// world.update() flushes the queue at frame end with while(queue.length > 0)
// cascade support (D-06). Deferred spawn returns pending Entity handle (D-07).

import type { Result } from '@forgeax/engine-types';
import type { Component, ComponentData, ComponentSchema } from './component';
import {
  componentDefinition,
  componentId,
  expandComponentRequirements,
  implicitComponentInputs,
} from './component';
import {
  componentRemovalError,
  InitializedComponentData,
  isArrayPayload,
  validateComponentDataKeys,
} from './component-input';
import { type EntityHandle, entityGeneration, entityIndex } from './entity-handle';
import {
  type CommandCommitEvidence,
  type CommandFailedError,
  type CommandKind,
  ComponentAlreadyPresentError,
  ComponentNotPresentError,
  type EcsError,
  StaleEntityError,
} from './errors';
import type { WorldExecutionState } from './execution/shared-kernel';
import { isExclusiveRelationshipSource, relationshipRole } from './relationship-index';
import { type WorldInternal, worldInternal } from './world-internal';
// Command types

export type Command =
  | { type: 'spawn'; componentDatas: ComponentData[]; entity: EntityHandle }
  | { type: 'despawn'; entity: EntityHandle }
  | { type: 'addComponent'; entity: EntityHandle; componentData: ComponentData }
  | { type: 'removeComponent'; entity: EntityHandle; component: Component };
// CommandBuffer interface

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
// World access interface (avoids circular import)

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
// Implementation

export interface CommandBufferImpl extends CommandBuffer {
  /** @internal Queue size without materializing storage for an unused buffer. */
  readonly _queueLength: number;
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
}

/**
 * Prototype-backed CommandBuffer. One buffer is created per system run, so
 * its methods live on the prototype instead of being fresh closures per run.
 */
class CommandBufferState implements CommandBufferImpl {
  private queue: Command[] | undefined;
  /** Created by the first deferred spawn; most system buffers never spawn. */
  private pending: Set<number> | undefined;
  _queueError: CommandBufferImpl['_queueError'] = null;
  private currentStatus: CommandBuffer['status'] = 'open';

  constructor(
    private readonly world: WorldForCommands,
    readonly _systemName: string,
    readonly _scheduleName: string,
  ) {}

  get status(): CommandBuffer['status'] {
    return this.currentStatus;
  }

  get _queue(): Command[] {
    this.queue ??= [];
    return this.queue;
  }

  get _queueLength(): number {
    return this.queue?.length ?? 0;
  }

  get _pendingEntities(): Set<number> {
    this.pending ??= new Set<number>();
    return this.pending;
  }

  private ensureOpen(): void {
    if (this.currentStatus !== 'open') throw new Error(`CommandBuffer is ${this.currentStatus}`);
  }

  private recordQueueError(index: number, kind: CommandKind, cause: unknown): void {
    if (this._queueError === null) this._queueError = { index, kind, cause };
  }

  private finish(status: 'committed' | 'aborted'): void {
    if (this.pending !== undefined)
      for (const raw of this.pending) {
        this.world[worldInternal].cancelPendingEntity(raw as EntityHandle);
      }
    this.currentStatus = status;
    if (this.queue !== undefined) this.queue.length = 0;
    this.pending?.clear();
    this._queueError = null;
  }

  commit(): void {
    this.ensureOpen();
    this.finish('committed');
  }

  abort(): void {
    if (this.currentStatus === 'open') this.finish('aborted');
  }

  spawn(...componentDatas: ComponentData[]): EntityHandle {
    this.ensureOpen();
    // bug-20260615: validate raw spawn keys at queue time (synchronous,
    // points at the calling system's stack) rather than only at flush
    // time. Commands.spawn returns EntityHandle (no Result channel), so
    // unknown-key is captured as a batch preflight failure.  The handle is
    // still reserved so callers may compose later commands; abort releases
    // every reservation without leaking a free slot.
    for (const cd of componentDatas) {
      const keyErr = validateComponentDataKeys(cd.component, cd.data as Record<string, unknown>);
      if (keyErr !== null) this.recordQueueError(this._queue.length, 'spawn', keyErr);
    }
    const entity = this.world[worldInternal].allocatePendingEntity();
    this._pendingEntities.add(entity as unknown as number);
    this._queue.push({ type: 'spawn', componentDatas, entity });
    return entity;
  }

  despawn(entity: EntityHandle): void {
    this.ensureOpen();
    this._queue.push({ type: 'despawn', entity });
  }

  addComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
  ): void {
    this.ensureOpen();
    const keyErr = validateComponentDataKeys(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );
    if (keyErr !== null) this.recordQueueError(this._queue.length, 'addComponent', keyErr);
    this._queue.push({
      type: 'addComponent',
      entity,
      componentData: componentData as ComponentData,
    });
  }

  removeComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): void {
    this.ensureOpen();
    this._queue.push({ type: 'removeComponent', entity, component: component as Component });
  }

  isDeferred(entity: EntityHandle): boolean {
    return this.pending?.has(entity as unknown as number) === true;
  }
}

/**
 * Create a CommandBuffer bound to a World.
 * @param world - the World (for pending entity allocation)
 */
export function createCommandBuffer(
  world: WorldForCommands,
  systemName = '<unknown-system>',
  scheduleName = '<unknown-schedule>',
): CommandBufferImpl {
  return new CommandBufferState(world, systemName, scheduleName);
}

/** Fixed-step suspension outlives the query and frame-arena views that staged these values. */
export function detachCommandBufferPayloads(buffer: CommandBufferImpl): void {
  if (buffer._queueLength === 0) return;
  const detach = (input: ComponentData): ComponentData => {
    const initialized = InitializedComponentData.is(input)
      ? input
      : new InitializedComponentData(input.component, input.data);
    const data = initialized.data as Record<string, unknown>;
    for (const [name, plan] of Object.entries(
      componentDefinition(initialized.component).plan.fields,
    )) {
      const value = data[name];
      if ((plan.kind === 'array' || plan.kind === 'fixed-array') && isArrayPayload(value, plan)) {
        data[name] = Array.from(value as ArrayLike<unknown>);
      }
    }
    return initialized;
  };
  for (const command of buffer._queue) {
    if (command.type === 'spawn') command.componentDatas = command.componentDatas.map(detach);
    else if (command.type === 'addComponent') command.componentData = detach(command.componentData);
  }
}

function commandFailure(
  buffer: CommandBufferImpl,
  index: number,
  kind: CommandKind,
  cause: unknown,
): CommandFailedError {
  return createCommandFailedError(buffer._systemName, buffer._scheduleName, index, kind, cause);
}

function setOverlayTarget(
  overlay: Map<number, Map<number, EntityHandle | null>>,
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
 * Validate the failures that can be proven from the current World and the
 * command batch without mutating storage.  The commit loop remains the only
 * writer; any failure not provable here is treated as an unexpected post-write
 * failure and poisons the World.
 */
function preflightCommands(buffer: CommandBufferImpl, world: WorldForCommands, offset = 0): void {
  if (buffer._queueError !== null) {
    const { index, kind, cause } = buffer._queueError;
    throw commandFailure(buffer, offset + index, kind, cause);
  }
  if (buffer._queueLength === 0) return;

  const shadows = new Map<number, Map<number, boolean>>();
  const relationshipOverlay = new Map<number, Map<number, EntityHandle | null>>();
  const unavailableEntities = new Set<number>();
  const availablePendingEntities = new Set<number>();
  const membershipFor = (entity: EntityHandle): Map<number, boolean> => {
    let membership = shadows.get(entity);
    if (membership === undefined) {
      membership = new Map();
      shadows.set(entity, membership);
    }
    return membership;
  };
  const admitData = (
    holder: EntityHandle | null,
    componentData: ComponentData,
    index: number,
    kind: CommandKind,
  ): Readonly<ComponentData> => {
    const result = world[worldInternal].preflightComponentData(
      'command',
      holder,
      componentData,
      availablePendingEntities,
      unavailableEntities,
      relationshipOverlay,
    );
    if (!result.ok) throw commandFailure(buffer, index, kind, result.error);
    return result.value;
  };
  const projectRelationship = (
    entity: EntityHandle,
    input: ComponentData,
    index: number,
    kind: CommandKind,
  ): void => {
    const role = relationshipRole(input.component);
    if (role?.kind !== 'source') return;
    const target = relationshipTarget(input.component, input.data as Record<string, unknown>);
    setOverlayTarget(relationshipOverlay, entity, input.component, target);
    const cycle = world[worldInternal].relationshipCycleError(
      input.component,
      role,
      target,
      entity,
      relationshipOverlay,
    );
    if (cycle !== null) throw commandFailure(buffer, index, kind, cycle);
  };
  const hasComponent = (
    entity: EntityHandle,
    component: Component,
    membership: Map<number, boolean>,
    pending: boolean,
  ): boolean =>
    membership.get(componentId(component)) ?? (!pending && world.hasComponent(entity, component));
  const pendingOrLive = (
    entity: EntityHandle,
    component: Component,
    index: number,
    kind: 'addComponent' | 'removeComponent',
  ): boolean => {
    const unavailable = unavailableEntities.has(entity);
    if (!unavailable && availablePendingEntities.has(entity)) return true;
    const operation = `command.${kind}`;
    const live = world[worldInternal].lookupAlive(entity, operation, component.name);
    if (!live.ok) throw commandFailure(buffer, index, kind, live.error);
    if (unavailable) {
      const generation = entityGeneration(entity);
      throw commandFailure(
        buffer,
        index,
        kind,
        new StaleEntityError(entity, entityIndex(entity), generation, {
          operation,
          expectedGeneration: generation,
          actualGeneration: -1,
        }),
      );
    }
    return false;
  };
  for (const [batchIndex, command] of buffer._queue.entries()) {
    const index = offset + batchIndex;
    switch (command.type) {
      case 'spawn': {
        command.componentDatas = expandComponentRequirements(command.componentDatas);
        const raw = command.entity as unknown as number;
        const membership = membershipFor(command.entity);
        availablePendingEntities.add(raw);
        for (
          let componentIndex = 0;
          componentIndex < command.componentDatas.length;
          componentIndex++
        ) {
          const componentData = admitData(
            command.entity,
            command.componentDatas[componentIndex] as ComponentData,
            index,
            command.type,
          );
          command.componentDatas[componentIndex] = componentData;
          if (membership.get(componentId(componentData.component)) === true) {
            throw commandFailure(
              buffer,
              index,
              command.type,
              new ComponentAlreadyPresentError(raw, componentData.component.name),
            );
          }
          membership.set(componentId(componentData.component), true);
          projectRelationship(command.entity, componentData, index, command.type);
        }
        break;
      }
      case 'despawn':
        // Stale despawn is a no-op; the handle is unavailable to later commands either way.
        unavailableEntities.add(command.entity);
        availablePendingEntities.delete(command.entity);
        break;
      case 'addComponent': {
        const { entity } = command;
        command.componentData = admitData(entity, command.componentData, index, command.type);
        const component = command.componentData.component;
        const pending = pendingOrLive(entity, component, index, command.type);
        const membership = membershipFor(entity);
        const present = hasComponent(entity, component, membership, pending);
        if (present && (pending || !isExclusiveRelationshipSource(component))) {
          throw commandFailure(
            buffer,
            index,
            command.type,
            new ComponentAlreadyPresentError(entity, component.name),
          );
        }
        const dependencies = implicitComponentInputs(command.componentData);
        if (dependencies !== undefined) {
          for (const input of dependencies) {
            if (hasComponent(entity, input.component, membership, pending)) continue;
            const admitted = admitData(command.entity, input, index, command.type);
            membership.set(componentId(input.component), true);
            projectRelationship(command.entity, admitted, index, command.type);
          }
        }
        // Reparenting keeps the existing membership source, including an earlier staged add.
        if (!present) membership.set(componentId(component), true);
        projectRelationship(command.entity, command.componentData, index, command.type);
        break;
      }
      case 'removeComponent': {
        const { entity, component } = command;
        const protectedComponent = componentRemovalError(component);
        if (protectedComponent !== undefined)
          throw commandFailure(buffer, index, command.type, protectedComponent);
        const pending = pendingOrLive(entity, component, index, command.type);
        const membership = membershipFor(entity);
        if (!hasComponent(entity, component, membership, pending)) {
          throw commandFailure(
            buffer,
            index,
            command.type,
            new ComponentNotPresentError(entity, component.name),
          );
        }
        membership.set(componentId(component), false);
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
 * Admit and drain complete batches; callbacks stage the following batch.
 */
export function flushCommands(buffer: CommandBufferImpl, world: WorldForCommands): void {
  if (buffer.status !== 'open') return;
  // Most system buffers stay empty: commit without the batch preflight.
  if (buffer._queueLength === 0 && buffer._queueError === null) {
    buffer.commit();
    return;
  }
  const queue = buffer._queue;
  try {
    preflightCommands(buffer, world);
  } catch (error) {
    buffer.abort(error);
    throw error;
  }
  // Once the preflight boundary has passed, a command may have touched
  // storage even when its Result is an error (for example relationship
  // maintenance after a row was appended).
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
      const batch = queue.splice(0);
      for (const cmd of batch) {
        // A release/asset callback can end the buffer while this batch is detached.
        if (buffer.status !== 'open') return;
        commandIndex += 1;
        currentCommand = cmd;
        mutationStarted = true;
        switch (cmd.type) {
          case 'spawn':
            requireSuccess(world[worldInternal].materializeEntity(cmd.entity, cmd.componentDatas));
            buffer._pendingEntities.delete(cmd.entity as unknown as number);
            break;
          case 'despawn':
            requireSuccess(world.despawn(cmd.entity));
            break;
          case 'addComponent':
            requireSuccess(world.addComponent(cmd.entity, cmd.componentData));
            break;
          case 'removeComponent':
            requireSuccess(world.removeComponent(cmd.entity, cmd.component));
            break;
        }
        lastCommittedCommand = { index: commandIndex, kind: cmd.type };
      }
      if (buffer.status !== 'open') return;
      if (queue.length > 0) preflightCommands(buffer, world, commandIndex + 1);
    }
    if (buffer.status === 'open') buffer.commit();
  } catch (error) {
    buffer.abort(error);
    if (isEcsFault(error, 'command-failed') && !mutationStarted) throw error;
    if (!mutationStarted) {
      throw commandFailure(
        buffer,
        Math.max(commandIndex, 0),
        currentCommand?.type ?? 'spawn',
        error,
      );
    }
    world[worldInternal].poisonExecution({
      code: 'system-failed',
      systemName: buffer._systemName,
      schedule: buffer._scheduleName,
      cause: error,
      partialWrite: true,
      retryable: false,
    });
    throw createSystemFailedError(
      buffer._systemName,
      buffer._scheduleName,
      error,
      lastCommittedCommand,
    );
  }
}
