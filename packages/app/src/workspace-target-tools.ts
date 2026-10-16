import { type EntityHandle, Update } from '@forgeax/engine-ecs';
import type { CanvasInputBoundary } from '@forgeax/engine-input';
import { pickDisplay } from '@forgeax/engine-picking';
import type { Plugin } from '@forgeax/engine-plugin';
import { Camera, getActiveCamera, Outline } from '@forgeax/engine-render';
import { Children, GlobalTransform } from '@forgeax/engine-scene';
import { readBrowserFrameSubmitted } from './browser-frame-signal';
import type { AppObservation } from './observation';
import type { App } from './types';
import { EngineWorkspaceError } from './workspace';
import { createObservationInspection, observationEntity } from './workspace-target-inspection';

type Inspection = ReturnType<typeof createObservationInspection>;
/** The same capability can be local or carried across a Host transport. */
export interface EngineWorkspaceTargetTools {
  tree(
    input?: Parameters<Inspection['tree']>[0],
  ): ReturnType<Inspection['tree']> | Promise<ReturnType<Inspection['tree']>>;
  inspect(
    input: Parameters<Inspection['inspect']>[0],
  ): ReturnType<Inspection['inspect']> | Promise<ReturnType<Inspection['inspect']>>;
  focus(input: { entityId: string }): unknown | Promise<unknown>;
  pick?: (input: { x: number; y: number }) => unknown | Promise<unknown>;
  highlight?: (input: { entityId?: string }) => unknown | Promise<unknown>;
  control?: {
    mode(): 'player' | 'observer';
    set(input: { mode: 'player' | 'observer'; connectionId?: string }): unknown;
    revoke(connectionId: string): void;
  };
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    engineWorkspaceTargetTools?: EngineWorkspaceTargetTools;
  }
}

/** Optional tools installed beside the real World, independent of its UI or carrier. */
export const engineWorkspaceTargetToolsPlugin: Plugin.Object<{
  targetId: string;
  observation?: AppObservation;
  input?: CanvasInputBoundary;
  display?: { canvas: HTMLCanvasElement; app: App };
}> = {
  name: 'forgeax:workspace-target-tools',
  inject: ['world'],
  provide: ['engineWorkspaceTargetTools'],
  apply(ctx, options) {
    if (!options?.targetId?.trim()) throw new TypeError('Target tools require a target identity');
    const display = options.display;
    const boundary = options.input;
    const inspection = createObservationInspection(ctx.world, options.targetId);
    let highlight: EntityHandle | undefined;
    const highlightSystem = `workspace-highlight:${ctx.fiber.uid}`;
    let syncing = false;
    let outlineLease:
      | {
          camera: EntityHandle;
          members: number[];
          introduced: number[];
          createdStyle?: {
            visibleColor: number[];
            hiddenColor: number[];
            width: number;
            occlusion: number;
          };
        }
      | undefined;
    let available = true;
    let ownsObservation = false;
    let controlOwner: string | undefined;
    const same = (left: readonly number[], right: readonly number[]) =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    const releaseOutline = () => {
      const lease = outlineLease;
      outlineLease = undefined;
      if (!lease) return;
      const current = ctx.world.get(lease.camera, Outline);
      if (!current.ok) return;
      const remaining = Array.from(current.value.entities).filter(
        (entity) => !lease.introduced.includes(entity),
      );
      if (same(remaining, Array.from(current.value.entities))) return;
      const style = lease.createdStyle;
      if (
        style &&
        remaining.length === 0 &&
        current.value.width === style.width &&
        current.value.occlusion === style.occlusion &&
        same(Array.from(current.value.visibleColor), style.visibleColor) &&
        same(Array.from(current.value.hiddenColor), style.hiddenColor)
      )
        ctx.world.removeComponent(lease.camera, Outline).unwrap();
      else ctx.world.set(lease.camera, Outline, { entities: remaining }).unwrap();
    };
    const activeCamera = (): EntityHandle | undefined => {
      const active = getActiveCamera(ctx.world)?.entity;
      let first: EntityHandle | undefined;
      for (const row of ctx.world.query({ with: [Camera, GlobalTransform] }).unwrap()) {
        first ??= row.entity;
        if (row.entity === active) return row.entity;
      }
      return first;
    };
    const outlineMembers = (): number[] => {
      if (highlight === undefined) return [];
      const pending = [highlight];
      const visited = new Set<number>();
      while (pending.length > 0) {
        const entity = pending.pop();
        if (entity === undefined || visited.has(entity) || !ctx.world.componentsOf(entity).ok)
          continue;
        visited.add(entity);
        const children = ctx.world.get(entity, Children);
        if (children.ok)
          for (const child of children.value.entities) pending.push(child as EntityHandle);
      }
      return [...visited];
    };
    const syncOutline = () => {
      const members = outlineMembers();
      if (highlight !== undefined && members.length === 0) highlight = undefined;
      const camera = members.length > 0 ? activeCamera() : undefined;
      const current = camera === undefined ? undefined : ctx.world.get(camera, Outline);
      if (
        outlineLease &&
        camera === outlineLease.camera &&
        same(members, outlineLease.members) &&
        current?.ok &&
        members.every((entity) => current.value.entities.includes(entity))
      )
        return;
      releaseOutline();
      if (camera === undefined || members.length === 0) return;
      const existing = ctx.world.get(camera, Outline);
      const authored = existing.ok ? Array.from(existing.value.entities) : [];
      const introduced = members.filter((entity) => !authored.includes(entity));
      if (existing.ok)
        ctx.world.set(camera, Outline, { entities: [...authored, ...introduced] }).unwrap();
      else
        ctx.world
          .addComponent(camera, { component: Outline, data: { entities: members, width: 4 } })
          .unwrap();
      const added = ctx.world.get(camera, Outline).unwrap();
      outlineLease = {
        camera,
        members,
        introduced,
        ...(existing.ok
          ? {}
          : {
              createdStyle: {
                visibleColor: Array.from(added.visibleColor),
                hiddenColor: Array.from(added.hiddenColor),
                width: added.width,
                occlusion: added.occlusion,
              },
            }),
      };
    };
    const release = () => {
      if (ownsObservation) options.observation?.release();
      ownsObservation = false;
      controlOwner = undefined;
      options.input?.grantGame();
    };
    ctx.effect(() => () => {
      available = false;
      release();
      if (syncing) ctx.world.removeSystem(Update, highlightSystem);
      releaseOutline();
    });
    const assertAvailable = () => {
      if (!available)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'The target tools plugin is unavailable',
          'Enable the Engine target tools plugin on this target and refresh its capabilities.',
        );
    };
    ctx.provide('engineWorkspaceTargetTools', {
      ...(display
        ? {
            pick({ x, y }: { x: number; y: number }) {
              assertAvailable();
              const canvas = display.canvas;
              const frame = readBrowserFrameSubmitted(canvas);
              const reason = !frame
                ? 'missing-frame'
                : frame.worldIdentity !== ctx.world.identity
                  ? 'world-mismatch'
                  : !frame.barrelDistortion?.camera
                    ? 'missing-mapping'
                    : frame.barrelDistortion.width !== canvas.width ||
                        frame.barrelDistortion.height !== canvas.height
                      ? 'extent-mismatch'
                      : undefined;
              if (reason || !frame?.barrelDistortion?.camera)
                throw new EngineWorkspaceError(
                  'engine-workspace-frame-unavailable',
                  'A current submitted display frame from this World',
                  'Wait for the current surface to submit a frame before picking.',
                  {
                    reason,
                    worldIdentity: ctx.world.identity,
                    frameWorldIdentity: frame?.worldIdentity,
                    frameId: frame?.frameId,
                    deviceGeneration: frame?.deviceGeneration,
                  },
                );
              const hit = pickDisplay(
                ctx.world,
                x,
                y,
                frame.barrelDistortion,
                canvas.width,
                canvas.height,
              );
              return {
                targetId: options.targetId,
                frameId: frame.frameId,
                entityId: hit ? `${options.targetId}:${ctx.world.identity}:${hit.entity}` : null,
                granularity: 'bounds',
              };
            },
            highlight(input: { entityId?: string }) {
              assertAvailable();
              highlight =
                input.entityId === undefined
                  ? undefined
                  : observationEntity(ctx.world, input.entityId, options.targetId);
              if (!syncing && highlight !== undefined) {
                ctx.world
                  .addSystem(Update, {
                    name: highlightSystem,
                    queries: [],
                    fn: syncOutline,
                  })
                  .unwrap();
                syncing = true;
              }
              syncOutline();
              if (syncing && highlight === undefined) {
                ctx.world.removeSystem(Update, highlightSystem).unwrap();
                syncing = false;
              }
              return { entityId: input.entityId ?? null };
            },
          }
        : {}),
      ...(boundary
        ? {
            control: {
              mode: () =>
                boundary.owner() === 'game' ? ('player' as const) : ('observer' as const),
              set(input: { mode: 'player' | 'observer'; connectionId?: string }) {
                assertAvailable();
                if (ownsObservation && controlOwner !== input.connectionId)
                  throw new EngineWorkspaceError(
                    'engine-workspace-target-busy',
                    'The current observation control owner',
                  );
                if (input.mode === 'player') release();
                else {
                  if (!options.observation)
                    throw new EngineWorkspaceError(
                      'engine-workspace-capability-unavailable',
                      'App observation',
                    );
                  options.observation.camera.set({});
                  ownsObservation = true;
                  controlOwner = input.connectionId;
                  boundary.revokeGame();
                }
                return { mode: input.mode, camera: options.observation?.camera.get() };
              },
              revoke(connectionId: string) {
                if (controlOwner === connectionId) release();
              },
            },
          }
        : {}),
      tree(input) {
        assertAvailable();
        return inspection.tree(input);
      },
      focus(input) {
        assertAvailable();
        if (options.input?.owner() === 'game')
          throw new EngineWorkspaceError(
            'engine-workspace-control-required',
            'Eject before controlling the game camera',
          );
        const entity = observationEntity(ctx.world, input.entityId, options.targetId);
        if (!options.observation)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'Observation is unavailable on this target',
          );
        const result = options.observation.focus({ entity });
        ownsObservation = true;
        return result;
      },
      inspect(input) {
        assertAvailable();
        return inspection.inspect(input);
      },
    });
  },
};
