// @forgeax/engine-ecs — world-entity-lifecycle: entity lifecycle and hierarchy.
//
// Owns spawn preflight and hierarchy orchestration. World is the sole state
// owner; this module composes its typed internal capabilities into those
// public lifecycle behaviors.

import { err, ok, pack, type Result } from '@forgeax/engine-types';
import type { Component, ComponentSchema, InputShapeOf } from './component';
import { componentId, componentSchema } from './component';
import { expandComponentRequirements } from './component-schema';
import { ENTITY_NULL_RAW, type EntityHandle, entityGeneration, entityIndex } from './entity-handle';
import {
  ComponentNotPresentError,
  RelationshipDetachMismatchError,
  RelationshipSelfCycleError,
  StaleEntityError,
} from './errors';
import { relationshipRole } from './relationship-index';
import type { Archetype } from './storage/archetype';
import type { ArchetypeGraph } from './storage/archetype-graph';
import type { ComponentData, EcsError, World } from './world';
import { worldInternal } from './world-internal';

function tableRow(world: World, record: { archetypeId: number; archetypeRow: number }): number {
  const archetype = world[worldInternal].getGraph().archetypes[record.archetypeId];
  return archetype?.rows[record.archetypeRow] ?? -1;
}

/**
 * Core implementation of `spawn`.
 */
export function spawnCore(
  world: World,
  componentDatas: ComponentData[],
): Result<EntityHandle, EcsError> {
  componentDatas = expandComponentRequirements(componentDatas);
  for (const cd of componentDatas) {
    const preflight = world[worldInternal].preflightComponentData(null, cd);
    if (!preflight.ok) return preflight;
  }
  const spawnedEntity = world[worldInternal].allocatePendingEntity();
  const materialized = world[worldInternal].materializeEntity(spawnedEntity, componentDatas);
  if (!materialized.ok) return materialized;
  return ok(spawnedEntity);
}

/** Attach a child and maintain the relationship mirror through component storage. */
export function worldAddChild<S extends ComponentSchema>(
  world: World,
  parent: EntityHandle,
  child: EntityHandle,
  component: Component<string, S>,
  data: Partial<InputShapeOf<S>>,
): Result<void, EcsError> {
  const holderComp = component as Component;
  if (relationshipRole(holderComp)?.kind !== 'source') {
    return err(new ComponentNotPresentError(child as number, component.name));
  }

  const parentResult = world[worldInternal].lookupAlive(parent, 'addChild', component.name);
  if (!parentResult.ok) return parentResult;
  const parentSlot = entityIndex(parent);
  const parentGeneration = entityGeneration(parent);
  const childResult = world[worldInternal].lookupAlive(child, 'addChild', component.name);
  if (!childResult.ok) return childResult;
  const childSlot = entityIndex(child);

  const role = relationshipRole(holderComp);
  if (child === parent && !(role?.kind === 'source' && role.allowSelf)) {
    return err(new RelationshipSelfCycleError(component.name, child as number, child as number));
  }
  const cycleHit =
    child === parent && role?.kind === 'source' && role.allowSelf
      ? null
      : relationshipChainCycleHit(world, holderComp, parentSlot, parentGeneration, childSlot);
  if (cycleHit !== null) {
    return err(new RelationshipSelfCycleError(component.name, child as number, cycleHit as number));
  }

  return world.addComponent(child, { component, data });
}

/** Detach a child only when its current relationship target matches `parent`. */
export function worldRemoveChild<S extends ComponentSchema>(
  world: World,
  parent: EntityHandle,
  child: EntityHandle,
  component: Component<string, S>,
): Result<void, EcsError> {
  const holderComp = component as Component;
  const childResult = world[worldInternal].lookupAlive(child, 'removeChild', component.name);
  if (!childResult.ok) return childResult;

  const childRecord = childResult.value;
  const childArch = (world[worldInternal].getGraph() as ArchetypeGraph).archetypes[
    childRecord.archetypeId
  ];
  if (!childArch) {
    return err(
      new StaleEntityError(child as number, entityIndex(child), entityGeneration(child), {
        operation: 'removeChild',
        component: component.name,
        expectedGeneration: entityGeneration(child),
        actualGeneration: childRecord.generation,
      }),
    );
  }
  if (
    !childArch.components.some((component) => componentId(component) === componentId(holderComp))
  ) {
    return err(
      new RelationshipDetachMismatchError(component.name, child as number, parent as number, 0),
    );
  }

  const oldValue = world[worldInternal].readRow(
    childArch,
    holderComp,
    tableRow(world, childRecord),
  ) as Record<string, unknown>;
  const currentTarget = relationshipTargetEntity(holderComp, oldValue);
  if (currentTarget !== parent) {
    return err(
      new RelationshipDetachMismatchError(
        component.name,
        child as number,
        parent as number,
        currentTarget ?? 0,
      ),
    );
  }

  return world.removeComponent(child, component);
}

/** Move a child to a new parent after cycle validation and old-mirror detachment. */
export function worldReparent<S extends ComponentSchema>(
  world: World,
  child: EntityHandle,
  newParent: EntityHandle,
  component: Component<string, S>,
  data: Partial<InputShapeOf<S>>,
): Result<void, EcsError> {
  const holderComp = component as Component;
  const role = relationshipRole(holderComp);
  if (role?.kind !== 'source') {
    return err(new ComponentNotPresentError(child as number, component.name));
  }
  if (child === newParent && !role.allowSelf) {
    return err(
      new RelationshipSelfCycleError(component.name, child as number, newParent as number),
    );
  }
  const cycleHit =
    child === newParent && role.allowSelf
      ? null
      : relationshipChainCycleHit(
          world,
          holderComp,
          entityIndex(newParent),
          entityGeneration(newParent),
          entityIndex(child),
        );
  if (cycleHit !== null) {
    return err(new RelationshipSelfCycleError(component.name, child as number, cycleHit as number));
  }

  const childResult = world[worldInternal].lookupAlive(child, 'reparent', component.name);
  if (!childResult.ok) return childResult;

  const childRecord = childResult.value;
  const childArch = (world[worldInternal].getGraph() as ArchetypeGraph).archetypes[
    childRecord.archetypeId
  ];
  if (!childArch) {
    return err(
      new StaleEntityError(child as number, entityIndex(child), entityGeneration(child), {
        operation: 'reparent',
        component: component.name,
        expectedGeneration: entityGeneration(child),
        actualGeneration: childRecord.generation,
      }),
    );
  }
  const payload = {
    ...(data as Record<string, unknown>),
    [role.sourceField]: newParent,
  } as Partial<InputShapeOf<S>>;
  if (
    childArch.components.some((component) => componentId(component) === componentId(holderComp))
  ) {
    // Existing exclusive sources are updated through the same owner-level
    // write barrier as `world.set`; remove+add would expose a partial mirror
    // state and would invalidate unrelated query spans.
    return world.set(child, component as never, payload as never);
  }
  return world.addComponent(child, { component, data: payload });
}

/** Iterate ancestors in child-to-root order while safely terminating corrupt cycles. */
export function worldIterAncestors(world: World, entity: EntityHandle): Iterable<EntityHandle> {
  return {
    *[Symbol.iterator]() {
      const records = world[worldInternal].getRecords();
      const slot = entityIndex(entity);
      const generation = entityGeneration(entity);
      if (!world[worldInternal].recordIsLive(records[slot], generation)) return;

      const visited = new Set<number>();
      let currentSlot = slot;
      let currentGeneration = generation;
      while (true) {
        const key = pack(currentSlot, currentGeneration);
        if (visited.has(key)) return;
        visited.add(key);

        const currentRecord = records[currentSlot];
        if (!world[worldInternal].recordIsLive(currentRecord, currentGeneration)) return;
        const currentArch = (world[worldInternal].getGraph() as ArchetypeGraph).archetypes[
          currentRecord.archetypeId
        ];
        if (!currentArch) return;

        let foundParent = false;
        for (const component of currentArch.components) {
          if (
            relationshipRole(component)?.kind !== 'source' ||
            !currentArch.components.some(
              (candidate) => componentId(candidate) === componentId(component),
            )
          )
            continue;
          const value = world[worldInternal].readRow(
            currentArch,
            component,
            tableRow(world, currentRecord),
          ) as Record<string, unknown>;
          const target = relationshipTargetEntity(component, value);
          if (target === null) continue;
          yield target;
          currentSlot = entityIndex(target);
          currentGeneration = entityGeneration(target);
          if (!world[worldInternal].recordIsLive(records[currentSlot], currentGeneration)) return;
          foundParent = true;
          break;
        }
        if (!foundParent) return;
      }
    },
  };
}

/** Iterate descendants depth-first through relationship mirror lists. */
export function worldIterDescendants(world: World, entity: EntityHandle): Iterable<EntityHandle> {
  return {
    *[Symbol.iterator]() {
      const records = world[worldInternal].getRecords();
      const slot = entityIndex(entity);
      const generation = entityGeneration(entity);
      if (!world[worldInternal].recordIsLive(records[slot], generation)) return;

      const visited = new Set<number>();
      const stack: number[] = [slot];
      while (stack.length > 0) {
        const currentSlot = stack.pop();
        if (currentSlot === undefined) break;
        const currentRecord = records[currentSlot];
        if (!currentRecord || currentRecord.archetypeId === -1) continue;
        const currentArch = world[worldInternal].getGraph().archetypes[currentRecord.archetypeId];
        if (!currentArch) continue;

        for (const child of descendantChildren(
          world,
          currentArch,
          tableRow(world, currentRecord),
        )) {
          const childSlot = entityIndex(child);
          const childGeneration = entityGeneration(child);
          const key = pack(childSlot, childGeneration);
          if (
            visited.has(key) ||
            !world[worldInternal].recordIsLive(records[childSlot], childGeneration)
          ) {
            continue;
          }
          visited.add(key);
          yield child;
          stack.push(childSlot);
        }
      }
    },
  };
}

function descendantChildren(world: World, arch: Archetype, row: number): EntityHandle[] {
  const children: EntityHandle[] = [];
  for (const component of arch.components) {
    const value = world[worldInternal].readRow(arch, component, row) as Record<string, unknown>;
    for (const [fieldName, fieldType] of Object.entries(componentSchema(component))) {
      if (fieldType !== 'array<entity>') continue;
      const list = value[fieldName];
      if (!(list instanceof Uint32Array)) continue;
      for (const raw of list) children.push(raw as EntityHandle);
    }
  }
  return children;
}

function relationshipTargetEntity(
  component: Component,
  value: Record<string, unknown>,
): EntityHandle | null {
  for (const [fieldName, fieldType] of Object.entries(componentSchema(component))) {
    if (fieldType !== 'entity') continue;
    const raw = value[fieldName];
    if (raw === null || raw === undefined || raw === ENTITY_NULL_RAW) return null;
    return raw as EntityHandle;
  }
  return null;
}

function relationshipChainCycleHit(
  world: World,
  holderComponent: Component,
  startSlot: number,
  startGeneration: number,
  targetSlot: number,
): EntityHandle | null {
  const visited = new Set<number>();
  let currentSlot = startSlot;
  let currentGeneration = startGeneration;
  while (true) {
    const key = pack(currentSlot, currentGeneration);
    if (visited.has(key)) return null;
    visited.add(key);
    const currentRecord = world[worldInternal].getRecords()[currentSlot];
    if (!world[worldInternal].recordIsLive(currentRecord, currentGeneration)) return null;
    const currentArchetype = (world[worldInternal].getGraph() as ArchetypeGraph).archetypes[
      currentRecord.archetypeId
    ];
    if (
      !currentArchetype?.components.some(
        (candidate) => componentId(candidate) === componentId(holderComponent),
      )
    )
      return null;
    const value = world[worldInternal].readRow(
      currentArchetype,
      holderComponent,
      tableRow(world, currentRecord),
    ) as Record<string, unknown>;
    const target = relationshipTargetEntity(holderComponent, value);
    if (target === null) return null;
    const targetEntitySlot = entityIndex(target);
    if (targetEntitySlot === targetSlot) return target;
    currentSlot = targetEntitySlot;
    currentGeneration = entityGeneration(target);
  }
}
