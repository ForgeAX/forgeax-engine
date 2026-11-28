import type { CanvasInputBoundary } from '@forgeax/engine-input';
import { pickDisplay, pickTriangleDisplay } from '@forgeax/engine-picking';
import type { Plugin } from '@forgeax/engine-plugin';
import type {
  RenderInspection,
  ViewportOutputInspection,
  ViewportOutputMode,
} from '@forgeax/engine-render';

export type { ViewportOutputInspection, ViewportOutputMode };

import {
  defaultViewportOutputInspection,
  editorAssistance,
  isViewportOutputMode,
  readEditorAssistance,
} from '@forgeax/engine-render';
import { readBrowserFrameSubmitted } from './browser-frame-signal';
import type { GameProjectionValue, GameReadDef } from './game-context';
import type { AppObservation } from './observation';
import type { App } from './types';
import { EngineWorkspaceError } from './workspace';
import {
  createWorkspaceEditorAssistance,
  type EngineWorkspaceAssistanceRequest,
} from './workspace-editor-assistance';
import { createObservationInspection, observationEntity } from './workspace-target-inspection';

type Inspection = ReturnType<typeof createObservationInspection>;
type WorkspaceGameObservation = {
  readonly id: string;
  readonly targetId: string;
  readonly worldId: string;
  readonly value: GameProjectionValue;
};

function requirePickDisplayFrame(canvas: HTMLCanvasElement, worldIdentity: string) {
  const frame = readBrowserFrameSubmitted(canvas);
  const reason = !frame
    ? 'missing-frame'
    : frame.worldIdentity !== worldIdentity
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
        worldIdentity: worldIdentity,
        frameWorldIdentity: frame?.worldIdentity,
        frameId: frame?.frameId,
        deviceGeneration: frame?.deviceGeneration,
        frameExtent:
          frame?.barrelDistortion === undefined
            ? undefined
            : {
                width: frame.barrelDistortion.width,
                height: frame.barrelDistortion.height,
              },
        canvasExtent: { width: canvas.width, height: canvas.height },
      },
    );
  return frame;
}

const MAX_GAME_OBSERVATION_BYTES = 128 * 1024;

function inspectGameReads(
  definitions: Iterable<GameReadDef>,
  { entity, targetId, worldId }: ReturnType<Inspection['inspect']>,
): WorkspaceGameObservation[] {
  const observations: WorkspaceGameObservation[] = [];
  let remainingBytes = MAX_GAME_OBSERVATION_BYTES;
  const encoder = new TextEncoder();
  for (const { id, workspace } of definitions) {
    try {
      if (workspace?.entity() !== entity) continue;
      const value = workspace.read();
      if (value === undefined) continue;
      // A detached copy preserves the observation across game ticks and transport.
      const json = JSON.stringify({ id, targetId, worldId, value }, (_key, item) => {
        if (typeof item === 'number' && !Number.isFinite(item))
          throw new TypeError('Game observations require finite numbers');
        if (
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null
        )
          throw new TypeError('Game observations require plain JSON objects');
        return item;
      });
      if (json.length > remainingBytes) continue;
      const bytes = encoder.encode(json).byteLength;
      if (bytes > remainingBytes) continue;
      observations.push(JSON.parse(json));
      remainingBytes -= bytes;
    } catch {
      // A game-owned read must not prevent inspection of Engine-owned facts.
    }
  }
  return observations;
}

export type EngineWorkspaceEntityInspection = ReturnType<Inspection['inspect']> & {
  readonly source?: EngineWorkspaceEntitySource;
  readonly gameObservations?: readonly WorkspaceGameObservation[];
  readonly rendererObservation?: {
    readonly targetId: string;
    readonly worldId: string;
    readonly frame: RenderInspection['frame'];
    readonly cloudLayer?: RenderInspection['cloudLayer'];
  };
};
export type EngineWorkspacePickGranularity = 'bounds' | 'triangle' | 'visible-entity';
export interface EngineWorkspaceEntitySource {
  readonly guid: string;
  readonly sourcePath: string;
  readonly sourceKey: string;
  readonly address: import('@forgeax/engine-types').SceneEntityAddress;
  /** Existing nested overrides that author this entity's fields in the root source. */
  readonly fieldPaths?: readonly {
    readonly component: string;
    readonly field: string;
    readonly path: readonly string[];
  }[];
}
/** The same capability can be local or carried across a Host transport. */
export interface EngineWorkspaceTargetTools {
  /** Retire only the derived presentation held by this connection. */
  revokeConnection?(connectionId: string): void;
  tree(
    input?: Parameters<Inspection['tree']>[0],
  ): ReturnType<Inspection['tree']> | Promise<ReturnType<Inspection['tree']>>;
  inspect(
    input: Parameters<Inspection['inspect']>[0] & { readonly signal?: AbortSignal },
  ): EngineWorkspaceEntityInspection | Promise<EngineWorkspaceEntityInspection>;
  focus(input: { entityId: string }): unknown | Promise<unknown>;
  pick?: (input: {
    x: number;
    y: number;
    granularity?: EngineWorkspacePickGranularity;
    frameId?: number;
    deviceGeneration?: number;
    viewIdentity?: string;
    signal?: AbortSignal;
  }) => unknown | Promise<unknown>;
  assistance?: (input: EngineWorkspaceAssistanceRequest) => unknown | Promise<unknown>;
  highlight?: (input: { entityId?: string }) => unknown | Promise<unknown>;
  viewportOutput?: {
    get(): ViewportOutputInspection | Promise<ViewportOutputInspection>;
    set(input: {
      mode: ViewportOutputMode;
    }): ViewportOutputInspection | Promise<ViewportOutputInspection>;
  };
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
  gameReads?: () => Iterable<GameReadDef>;
}> = {
  name: 'forgeax:workspace-target-tools',
  inject: ['world'],
  provide: ['engineWorkspaceTargetTools'],
  apply(ctx, options) {
    if (!options?.targetId?.trim()) throw new TypeError('Target tools require a target identity');
    const display = options.display;
    const boundary = options.input;
    const inspection = createObservationInspection(
      ctx.world,
      options.targetId,
      () => ctx.get('assets', false) || undefined,
    );
    const assistanceOwner = {};
    const editor =
      display === undefined
        ? undefined
        : createWorkspaceEditorAssistance(ctx.world, options.targetId, display.canvas);
    let available = true;
    let ownsObservation = false;
    let controlOwner: string | undefined;
    const release = () => {
      if (ownsObservation) options.observation?.release();
      ownsObservation = false;
      controlOwner = undefined;
      options.input?.grantGame();
    };
    ctx.effect(() => () => {
      available = false;
      editor?.dispose();
      release();
      readEditorAssistance(ctx.world)?.releaseSelection(assistanceOwner);
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
      ...(editor === undefined ? {} : { revokeConnection: editor.revoke }),
      ...(editor === undefined
        ? {}
        : {
            assistance: (request: EngineWorkspaceAssistanceRequest) => {
              assertAvailable();
              return editor.invoke(request);
            },
          }),
      ...(display
        ? {
            pick({
              x,
              y,
              granularity = 'bounds',
              signal,
              ...submitted
            }: {
              x: number;
              y: number;
              granularity?: EngineWorkspacePickGranularity;
              frameId?: number;
              deviceGeneration?: number;
              viewIdentity?: string;
              signal?: AbortSignal;
            }) {
              assertAvailable();
              if (
                granularity !== 'bounds' &&
                granularity !== 'triangle' &&
                granularity !== 'visible-entity'
              )
                throw new TypeError('Unsupported pick granularity');
              signal?.throwIfAborted();
              const canvas = display.canvas;
              const frame = requirePickDisplayFrame(canvas, ctx.world.identity);
              const helper = editor?.pick({ x, y, ...submitted });
              if (helper?.action !== undefined)
                return {
                  targetId: options.targetId,
                  frameId: helper.frame.frameId,
                  entityId: `${options.targetId}:${ctx.world.identity}:${helper.action.entity}`,
                  granularity,
                  helper: helper.action.kind,
                };
              const matched = helper?.frame ?? frame;
              const mapping = matched.barrelDistortion;
              if (mapping?.camera === undefined)
                throw new EngineWorkspaceError(
                  'engine-workspace-frame-unavailable',
                  'A submitted camera mapping',
                );
              if (granularity === 'visible-entity') {
                const unavailable = (reason: string) =>
                  new EngineWorkspaceError(
                    'engine-workspace-capability-unavailable',
                    'GPU picking for the submitted view',
                    'Wait for an eligible frame or explicitly request geometry picking.',
                    { reason },
                  );
                const request = display.app.renderer.requestViewportHit?.(
                  {
                    x,
                    y,
                    width: canvas.width,
                    height: canvas.height,
                    afterFrameId: matched.frameId,
                    worldIdentity: ctx.world.identity,
                    deviceGeneration: matched.deviceGeneration,
                  },
                  signal,
                );
                if (request === undefined) throw unavailable('renderer');
                return request.then((result) => {
                  assertAvailable();
                  signal?.throwIfAborted();
                  const current = readBrowserFrameSubmitted(canvas);
                  const currentMapping = current?.barrelDistortion;
                  if (
                    result.kind === 'stale' ||
                    current?.worldIdentity !== matched.worldIdentity ||
                    current?.deviceGeneration !== matched.deviceGeneration ||
                    current.configurationRevision !== matched.configurationRevision ||
                    canvas.width !== mapping.width ||
                    canvas.height !== mapping.height ||
                    currentMapping?.strength !== mapping.strength ||
                    currentMapping.centerX !== mapping.centerX ||
                    currentMapping.centerY !== mapping.centerY
                  )
                    throw new EngineWorkspaceError(
                      'engine-workspace-frame-unavailable',
                      'The same view, World and device throughout GPU picking',
                      'Wait for a current frame and pick again.',
                      { reason: result.kind === 'stale' ? result.reason : 'frame-identity' },
                    );
                  if (result.kind === 'unavailable') throw unavailable(result.reason);
                  const entityId =
                    result.entity === null
                      ? null
                      : `${options.targetId}:${ctx.world.identity}:${result.entity}`;
                  if (entityId !== null) observationEntity(ctx.world, entityId, options.targetId);
                  return {
                    targetId: options.targetId,
                    frameId: result.frameId,
                    entityId,
                    granularity,
                  };
                });
              }
              let entityId: string | null;
              if (granularity === 'triangle') {
                const result = pickTriangleDisplay(
                  ctx.world,
                  x,
                  y,
                  mapping,
                  canvas.width,
                  canvas.height,
                );
                if (result.status === 'unavailable')
                  throw new EngineWorkspaceError(
                    'engine-workspace-capability-unavailable',
                    'CPU triangle geometry for the exact display ray',
                    'Wait for supported current mesh geometry or request bounds picking.',
                    { reason: result.reason, entities: result.entities },
                  );
                entityId =
                  result.status === 'hit'
                    ? `${options.targetId}:${ctx.world.identity}:${result.hit.entity}`
                    : null;
              } else {
                const result = pickDisplay(ctx.world, x, y, mapping, canvas.width, canvas.height);
                entityId = result
                  ? `${options.targetId}:${ctx.world.identity}:${result.entity}`
                  : null;
              }
              return {
                targetId: options.targetId,
                frameId: matched.frameId,
                entityId,
                granularity,
              };
            },
            highlight(input: { entityId?: string }) {
              assertAvailable();
              if (input.entityId === undefined)
                readEditorAssistance(ctx.world)?.releaseSelection(assistanceOwner);
              else {
                const entity = observationEntity(ctx.world, input.entityId, options.targetId);
                const assistance = editorAssistance(ctx.world);
                assistance.configure({ enabled: true, camera: undefined }).unwrap();
                assistance.select([entity], undefined, assistanceOwner).unwrap();
              }
              editor?.observe();
              return { entityId: input.entityId ?? null };
            },
            viewportOutput: {
              get(): ViewportOutputInspection {
                assertAvailable();
                return (
                  display.app.renderer.getViewportOutput?.() ??
                  defaultViewportOutputInspection(false)
                );
              },
              set(input: { mode: ViewportOutputMode }): ViewportOutputInspection {
                assertAvailable();
                if (!isViewportOutputMode(input.mode))
                  throw new TypeError(`Unsupported viewport output mode: ${String(input.mode)}`);
                const setter = display.app.renderer.setViewportOutput;
                if (setter === undefined)
                  throw new EngineWorkspaceError(
                    'engine-workspace-capability-unavailable',
                    'Viewport output visualization tools',
                  );
                const result = setter.call(display.app.renderer, input.mode);
                if (!result.ok) throw result.error;
                return result.value;
              },
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
        input.signal?.throwIfAborted();
        const entity = inspection.inspect(input);
        if (display?.app.world !== ctx.world) return entity;
        const gameObservations =
          options.gameReads === undefined ? [] : inspectGameReads(options.gameReads(), entity);
        input.signal?.throwIfAborted();
        assertAvailable();
        if (display.app.world !== ctx.world)
          throw new EngineWorkspaceError(
            'engine-workspace-target-stale',
            'The same App World after the inspection',
          );
        const observed = gameObservations.length ? { ...entity, gameObservations } : entity;
        if (!entity.components.some((component) => component.name === 'VolumetricCloudLayer'))
          return observed;
        const renderer = display.app.renderer.inspect({ fields: ['frame', 'cloudLayer'] });
        return {
          ...observed,
          rendererObservation: {
            targetId: options.targetId,
            worldId: ctx.world.identity,
            frame: renderer.frame,
            ...(renderer.cloudLayer === undefined ? {} : { cloudLayer: renderer.cloudLayer }),
          },
        };
      },
    });
  },
};
