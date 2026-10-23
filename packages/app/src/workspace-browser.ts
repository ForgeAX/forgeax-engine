import type { RuntimePackContent } from '@forgeax/engine-import';
import {
  attachBrowserInputBackend,
  type CanvasInputBoundary,
  createCanvasInputBoundary,
} from '@forgeax/engine-input';
import { decodePackData } from '@forgeax/engine-pack/runtime';
import { type Context, type Fiber, joinPluginFiber, type Plugin } from '@forgeax/engine-plugin';
import {
  type BrowserFrameCompleted,
  FORGEAX_FRAME_COMPLETED_EVENT,
  subscribeBrowserFrameSubmitted,
} from './browser-frame-signal';
import { syncCanvasDrawingBuffer } from './canvas-sizing';
import type { App } from './types';
import {
  createEngineWorkspaceAppPreview,
  createEngineWorkspaceAppTarget,
  ENGINE_WORKSPACE_COMMAND_TOPIC,
  type EngineWorkspaceAppTargetOptions,
  type EngineWorkspaceAsset,
  type EngineWorkspaceCameraInput,
  EngineWorkspaceError,
  type EngineWorkspacePreview,
  type EngineWorkspacePreviewDisplayOptions,
  type EngineWorkspaceProject,
  type EngineWorkspaceTarget,
  engineWorkspaceResultService,
  inspectEngineWorkspaceAsset,
  projectEngineWorkspaceAssets,
} from './workspace';
import type { WorkspaceAssetFieldWrite } from './workspace-asset-authoring';
import { bindWorkspaceCameraEvents } from './workspace-camera-events';
import {
  disposeWorkspacePluginFiber,
  type EngineWorkspaceRuntimePackRequest,
  executeWorkspaceRuntimePack,
  releaseWorkspacePlugins,
} from './workspace-runtime-pack';
import { engineWorkspaceTargetToolsPlugin } from './workspace-target-tools';

export interface EngineWorkspaceBrowserOptions {
  readonly input?: CanvasInputBoundary;
  readonly app: App;
  readonly surface?: HTMLElement;
  readonly initialAsset?: EngineWorkspaceAsset;
  readonly createPreviewApp?: (input: {
    context: Context;
    canvas: HTMLCanvasElement;
    asset: EngineWorkspaceAsset;
    targetId: string;
  }) => Promise<App>;
  readonly canvas: HTMLCanvasElement;
  readonly project: EngineWorkspaceProject;
  readonly target: EngineWorkspaceTarget;
  readonly transport: {
    request(service: string, payload: unknown): Promise<unknown>;
    subscribe(topic: string, listener: (value: unknown) => void): () => void;
    onDisconnect?(listener: () => void): () => void;
  };
  readonly openResourcePreview?: (
    input: Parameters<
      NonNullable<Parameters<typeof createEngineWorkspaceAppPreview>[0]['openResourcePreview']>
    >[0] & { canvas: HTMLCanvasElement },
  ) => Promise<import('./workspace').EngineWorkspaceResourcePreviewOwner>;
}

type CommandInput = EngineWorkspaceCameraInput & {
  readonly preparation?: number;
  readonly fields?: readonly WorkspaceAssetFieldWrite[];
  readonly fieldWrite?: WorkspaceAssetFieldWrite;
  readonly content?: RuntimePackContent;
  readonly guid?: string;
  readonly worldId?: string;
  readonly request?: EngineWorkspaceRuntimePackRequest;
  readonly mode?: 'player' | 'observer';
  readonly x?: number;
  readonly y?: number;
  readonly previewOwner?: string;
  readonly options?: unknown;
  readonly previewTargetId?: string;
  readonly asset?: EngineWorkspaceAsset;
  readonly width?: number;
  readonly height?: number;
  readonly entityId?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly revision?: number;
  readonly display?: EngineWorkspacePreviewDisplayOptions;
};
type ExecuteInput = CommandInput & { readonly signal: AbortSignal };
interface Command {
  readonly kind: 'command' | 'cancel';
  readonly id: string;
  readonly sessionId: string;
  readonly operation: string;
  readonly input: CommandInput;
}

/** App error events may carry a structured hint at runtime; keep it readable. */
function workspaceErrorHintText(hint: unknown, fallback: unknown): string {
  if (typeof hint === 'string') return hint;
  if (hint !== undefined && hint !== null) {
    try {
      return JSON.stringify(hint) ?? String(hint);
    } catch {
      return String(hint);
    }
  }
  return typeof fallback === 'string' ? fallback : String(fallback);
}

function workspaceCommandFailure(cause: unknown): EngineWorkspaceError {
  if (cause instanceof EngineWorkspaceError) return cause;
  if (cause !== null && typeof cause === 'object') {
    const value = cause as Partial<{
      code: unknown;
      expected: unknown;
      hint: unknown;
      message: unknown;
      detail: unknown;
    }>;
    const code = typeof value.code === 'string' ? value.code : 'engine-workspace-browser-failure';
    const expected =
      typeof value.expected === 'string' ? value.expected : 'The workspace command to complete';
    const hint =
      typeof value.hint === 'string'
        ? value.hint
        : typeof value.message === 'string'
          ? value.message
          : `Inspect the structured ${code} failure details.`;
    return new EngineWorkspaceError(
      code,
      expected,
      hint,
      value.detail !== null && typeof value.detail === 'object'
        ? (value.detail as Readonly<Record<string, unknown>>)
        : {},
    );
  }
  return new EngineWorkspaceError(
    'engine-workspace-browser-failure',
    'The workspace command to complete',
    String(cause),
  );
}

/** Owns browser command handling and tools; borrows the existing App and Host. */
const workspaceBrowserCommandsPlugin: Plugin.Object<EngineWorkspaceBrowserOptions> = {
  name: 'forgeax:workspace-browser-commands',
  inject: ['world', 'engineWorkspaceTargetTools'],
  provide: ['engineWorkspacePresentation'],
  async apply(ctx, options) {
    const { app, canvas, target, project, transport, openResourcePreview } = options;
    if (app.world !== ctx.world) throw new Error('Workspace tools require the actual App World');
    const targetTools = ctx.engineWorkspaceTargetTools;
    if (!targetTools) throw new Error('Workspace target tools are unavailable');
    const children = new Map<
      string,
      { dispose: () => Promise<void>; surface: HTMLElement; context: Context }
    >();
    let preview: EngineWorkspacePreview | undefined;
    let disposed = false;
    let workspaceClosed = false;
    if (options.surface)
      ctx.provide('engineWorkspacePresentation', {
        resolveTarget: (targetId) => {
          if (disposed || workspaceClosed) return undefined;
          if (targetId === target.targetId) return preview;
          return children
            .get(targetId)
            ?.context.get('engineWorkspacePresentation', false)
            ?.resolveTarget?.(targetId);
        },
        createSurface: (input) =>
          input?.target?.targetId && input.target.targetId !== target.targetId
            ? children.get(input.target.targetId)?.surface
            : options.surface,
      });
    let previewOwner: string | undefined;
    let started = false;
    let presented = true;
    let failure: EngineWorkspaceError | undefined;
    let queue = Promise.resolve();
    let unsubscribe = () => {};
    let removeCameraEvents: (() => Promise<void>) | undefined;
    if (!options.input && app.input?.setInputAllowed) {
      ctx.effect(() => {
        app.input?.setInputAllowed?.(false);
        return () => app.input?.setInputAllowed?.(true);
      });
    }
    // Only live requests may be cancelled; unknown IDs never grow a tombstone set.
    const pending = new Map<string, { controller: AbortController; completion: Promise<void> }>();
    const onDisconnect = transport.onDisconnect?.bind(transport);
    if (onDisconnect)
      ctx.effect(() =>
        onDisconnect(() => {
          workspaceClosed = true;
          for (const { controller } of pending.values()) controller.abort();
          void releaseWorkspacePlugins(ctx).catch((cause) => {
            failure = workspaceCommandFailure(cause);
          });
        }),
      );
    const errors: unknown[] = [];
    let submittedFrame = 0;
    let readyCompleted: BrowserFrameCompleted | undefined;
    if (typeof canvas.addEventListener === 'function')
      ctx.effect(() => {
        const removeSubmitted = subscribeBrowserFrameSubmitted(canvas, (frame) => {
          submittedFrame = frame.frameId;
        });
        const completed = (event: Event) => {
          const frame = (event as CustomEvent<BrowserFrameCompleted>).detail;
          if (frame.presentation === 'ready' && frame.frameId > (readyCompleted?.frameId ?? 0))
            readyCompleted = frame;
        };
        canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, completed);
        return () => {
          removeSubmitted();
          canvas.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, completed);
        };
      });
    if (!options.input && typeof IntersectionObserver === 'function') {
      ctx.effect(() => {
        const observer = new IntersectionObserver(([entry]) => {
          if (!entry || disposed) return;
          presented = entry.isIntersecting;
          if (!started || !preview || failure) return;
          (presented ? app.resume() : app.pause()).unwrap();
        });
        observer.observe(canvas);
        return () => observer.disconnect();
      });
    }
    let frameFloor = submittedFrame;
    const assertAvailable = () => {
      if (disposed || workspaceClosed)
        throw new EngineWorkspaceError(
          'engine-workspace-session-closed',
          'The workspace plugin must remain active',
        );
      if (failure) throw failure;
    };
    const closePreview = async () => {
      if (started) app.pause().unwrap();
      const old = preview;
      await old?.close?.({ targetId: target.targetId });
      if (preview === old) {
        preview = undefined;
        previewOwner = undefined;
      }
    };
    const send = async (payload: unknown) => {
      if (!disposed)
        await transport
          .request(engineWorkspaceResultService(target.targetId), payload)
          .catch(() => {});
    };
    const removeErrors = app.onError((error) => {
      if (errors.length === 32) errors.shift();
      errors.push({
        code: error.code,
        hint: error.hint,
        ...('detail' in error ? { detail: error.detail } : {}),
      });
      if (failure || disposed || app.world.execution.health !== 'poisoned') return;
      failure = new EngineWorkspaceError(
        error.code,
        error.expected,
        workspaceErrorHintText(error.hint, error.expected),
        'detail' in error ? { ...error.detail } : {},
      );
      app.pause();
      void send({
        kind: 'failed',
        id: target.sessionId,
        sessionId: target.sessionId,
        targetId: target.targetId,
        error: {
          code: error.code,
          expected: error.expected,
          hint: workspaceErrorHintText(error.hint, error.expected),
          ...('detail' in error ? { detail: error.detail } : {}),
        },
      });
    });
    ctx.effect(() => async () => {
      disposed = true;
      unsubscribe();
      removeErrors();
      const requests = [...pending.values()];
      for (const { controller } of requests) controller.abort();
      try {
        await Promise.all(requests.map(({ completion }) => completion));
        await removeCameraEvents?.();
        for (const child of children.values()) await child.dispose();
        children.clear();
        await closePreview();
      } finally {
        if (!options.initialAsset)
          canvas.ownerDocument.documentElement.removeAttribute('data-forgeax-workspace-ready');
      }
    });
    const active = (input: CommandInput) => {
      assertAvailable();
      if (input?.targetId !== target.targetId || !preview || input.previewOwner !== previewOwner)
        throw new EngineWorkspaceError(
          'engine-workspace-target-stale',
          'The current browser target and preview owner',
        );
      return preview;
    };
    const requireTools = (input: CommandInput) => {
      const tools = active(input).tools;
      if (!tools)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'The target tools plugin must be active',
        );
      return tools;
    };
    const capture: NonNullable<EngineWorkspacePreview['capture']> = async (input) => {
      assertAvailable();
      const current = preview;
      if (!current)
        throw new EngineWorkspaceError('engine-workspace-preview-required', 'An open preview');
      const width = input.width ?? current.target.width;
      const height = input.height ?? current.target.height;
      if (width !== current.target.width || height !== current.target.height)
        throw new Error(
          'Engine workspace capture dimensions must match the active target dimensions',
        );
      const deadline = Date.now() + 10_000;
      while (
        !readyCompleted ||
        readyCompleted.frameId <= frameFloor ||
        (readyCompleted.barrelDistortion !== undefined &&
          (readyCompleted.barrelDistortion.width !== canvas.width ||
            readyCompleted.barrelDistortion.height !== canvas.height))
      ) {
        assertAvailable();
        input.signal?.throwIfAborted();
        // Hidden previews retain their tools and can render an explicitly requested frame.
        if (!options.input && !presented) {
          const step = app.stepFrame(0);
          if (
            !step.ok &&
            (step.error.code !== 'app-frame-step-invalid' || step.error.detail.reason !== 'credit')
          )
            throw step.error;
        }
        if (Date.now() >= deadline) {
          const {
            state,
            surface,
            frame,
            environment,
            recovery,
            iblBinding,
            meshMaterialBindings,
            featureGraph,
            featureDiagnostics,
          } = app.renderer.inspect();
          const rhiCapture = (() => {
            const encoded = canvas.dataset?.forgeaxPreviewRhiWindow;
            if (encoded === undefined || encoded.length > 65_536) return undefined;
            try {
              const parsed = JSON.parse(encoded) as {
                targetId?: unknown;
                worldIdentity?: unknown;
              } | null;
              return parsed?.targetId === target.targetId &&
                parsed.worldIdentity === app.world.identity
                ? parsed
                : undefined;
            } catch {
              return undefined;
            }
          })();
          const detail = {
            ...(rhiCapture === undefined ? {} : { rhiCapture }),
            targetId: target.targetId,
            worldIdentity: app.world.identity,
            frameFloor,
            submittedFrame,
            readyCompletedFrame: readyCompleted?.frameId ?? 0,
            presented,
            extent: { width: canvas.width, height: canvas.height },
            renderer: {
              state,
              surface,
              frame,
              environment,
              recovery,
              iblBinding,
              featureGraph,
              meshMaterialBindings: meshMaterialBindings?.map(
                ({ worldId, worldIdentity, entityKey, bindings, diagnostics, residency }) => ({
                  worldId,
                  worldIdentity,
                  entityKey,
                  bindings,
                  diagnostics: diagnostics.map(({ code, slotIndex, handle }) => ({
                    code,
                    slotIndex,
                    handle,
                  })),
                  residency: residency.map(
                    ({ readiness, samplers, textures, preparationFailure }) => ({
                      readiness,
                      samplers,
                      textures,
                      preparationFailure:
                        preparationFailure === undefined
                          ? undefined
                          : {
                              code: preparationFailure.code,
                              expected: preparationFailure.expected,
                              hint: preparationFailure.hint,
                            },
                    }),
                  ),
                }),
              ),
              featureDiagnostics: featureDiagnostics?.map(({ identity, status, latestError }) => ({
                identity,
                status,
                latestError:
                  latestError === undefined
                    ? undefined
                    : {
                        code: latestError.code,
                        expected: latestError.expected,
                        hint: latestError.hint,
                      },
              })),
            },
            execution: app.execution.report(),
            errors: errors.slice(),
          };
          throw new EngineWorkspaceError(
            'engine-workspace-browser-failure',
            'A new ready frame from the requested Engine preview',
            `Engine workspace did not complete a new ready frame before capture: ${JSON.stringify(detail)}`,
            detail,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      const frameId = readyCompleted.frameId;
      const png = canvas.toDataURL('image/png');
      if (!png.startsWith('data:image/png'))
        throw new Error('Engine workspace canvas returned an invalid PNG');
      frameFloor = frameId;
      return {
        targetId: target.targetId,
        frameId,
        width: canvas.width,
        height: canvas.height,
        png,
        ...(errors.length ? { errors: errors.slice() } : {}),
      };
    };
    const resize: NonNullable<EngineWorkspaceAppTargetOptions['resize']> = ({ width, height }) => {
      const dpr = Math.max(1, canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1);
      canvas.style.width = `${width / dpr}px`;
      canvas.style.height = `${height / dpr}px`;
      syncCanvasDrawingBuffer(canvas, { width, height });
      frameFloor = submittedFrame;
    };
    const closeWorkspace = async () => {
      workspaceClosed = true;
      if (failure?.detail.cleanup === 'failed' || failure?.detail.cleanup === 'timeout')
        throw failure;
      await releaseWorkspacePlugins(ctx);
      return { cleanup: 'completed' };
    };
    const runRuntimePack = async (
      input: ExecuteInput,
      signal: AbortSignal,
      onInstalled?: (fiber: Fiber) => void,
    ) => {
      if (input.targetId !== target.targetId || input.worldId !== app.world.identity)
        throw new EngineWorkspaceError(
          'engine-workspace-target-stale',
          'The actual App World and target',
        );
      if (!input.request) throw new TypeError('A runtime Pack request is required');
      const result = await executeWorkspaceRuntimePack(
        ctx,
        app,
        input.request,
        signal,
        input.connectionId,
      );
      if (result.installed) onInstalled?.(result.installed);
      return result.value;
    };
    const listAssets = async () => {
      if (!app.assets) throw new Error('Engine workspace requires AssetRegistry');
      return projectEngineWorkspaceAssets((await app.assets.enumerateCatalog()).unwrap());
    };
    const inspectAsset = (input: ExecuteInput, signal: AbortSignal) => {
      if (!app.assets || !input.guid)
        throw new Error('Asset inspection requires an AssetRegistry and GUID');
      return inspectEngineWorkspaceAsset(app.assets, input.guid, signal);
    };
    /** An independent inline preview owns a child App in its own isolated native scope. */
    const openInlinePreview = async (
      input: ExecuteInput,
      childId: string,
      signal: AbortSignal,
    ): Promise<unknown> => {
      if (!options.createPreviewApp || !input.asset)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'Independent inline preview assembly',
        );
      const asset = input.asset;
      if (children.has(childId)) throw new Error('Preview identity is already allocated');
      const surface = canvas.ownerDocument.createElement('div');
      const childCanvas = canvas.ownerDocument.createElement('canvas');
      const { url: _url, ...parentTarget } = target;
      const childTarget = {
        ...parentTarget,
        targetId: childId,
        width: input.width ?? target.width,
        height: input.height ?? target.height,
      };
      childCanvas.width = childTarget.width;
      childCanvas.height = childTarget.height;
      surface.append(childCanvas);
      let opened: unknown;
      let childApp: App | undefined;
      let childBrowser: Fiber | undefined;
      const create = options.createPreviewApp;
      const childPlugin: Plugin = {
        name: 'forgeax:workspace-inline-preview',
        async apply(childContext) {
          const parking = canvas.ownerDocument.createElement('div');
          parking.hidden = true;
          parking.append(surface);
          canvas.ownerDocument.body.append(parking);
          childContext.effect(() => () => {
            surface.remove();
            parking.remove();
          });
          childApp = await create({
            context: childContext,
            canvas: childCanvas,
            asset: asset,
            targetId: childId,
          });
          childBrowser = await childContext.plugin(engineWorkspaceBrowserPlugin, {
            app: childApp,
            canvas: childCanvas,
            surface,
            target: { ...childTarget, worldId: childApp.world.identity },
            project,
            initialAsset: asset,
            ...(openResourcePreview ? { openResourcePreview: openResourcePreview } : {}),
            transport: {
              async request(_service: string, payload: unknown) {
                const value = payload as Record<string, unknown>;
                if (value.kind === 'ready') {
                  opened = value.preview;
                  return {};
                }
                return transport.request(engineWorkspaceResultService(target.targetId), value);
              },
              subscribe(topic: string, listener: (value: unknown) => void) {
                return transport.subscribe(topic, (value) => {
                  const command = value as Command;
                  if (
                    command?.kind === 'cancel' ||
                    (command?.input?.targetId === childId && command.operation !== 'closePreview')
                  )
                    listener(value);
                });
              },
            },
          });
          await childBrowser.await();
        },
      };
      // Native Cordis scopes separate App capabilities inside the same Host realm.
      const scope = [
        'world',
        'renderer',
        'assets',
        'pluginPrograms',
        'runtimePacks',
        'input',
        'renderFeatureHost',
        'audio',
        'physics',
        'engineWorkspaceTargetTools',
        'engineWorkspacePresentation',
      ].reduce((scope, name) => scope.isolate(name), ctx);
      const dispose = await ctx.effect(async function* () {
        const fiber = scope.plugin(childPlugin);
        yield joinPluginFiber(fiber);
        // Drain the App before its native renderer and service Fibers unload.
        yield async () => {
          await childBrowser?.dispose();
          await childApp?.dispose();
        };
        await fiber.await();
        signal.throwIfAborted();
        if (!opened) throw new Error('Inline preview did not publish its target');
      });
      if (!childBrowser) throw new Error('Inline preview did not publish its browser owner');
      children.set(childId, { dispose, surface, context: childBrowser.ctx });
      return opened;
    };
    /** The editing target replaces its own asset preview and resumes the App on it. */
    const openTargetPreview = async (
      command: Command,
      input: ExecuteInput,
      signal: AbortSignal,
    ) => {
      if (options.input)
        throw new EngineWorkspaceError(
          'engine-workspace-operation-unavailable',
          'Asset previews belong to the editing target',
        );
      if (!app.assets || !input.asset)
        throw new TypeError('Workspace requires an asset and AssetRegistry');
      const width = input.width ?? target.width;
      const height = input.height ?? target.height;
      if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0))
        throw new TypeError('Invalid target extent');
      await closePreview();
      signal.throwIfAborted();
      errors.length = 0;
      await resize({ targetId: target.targetId, width, height });
      const next = await createEngineWorkspaceAppPreview({
        app,
        assets: app.assets,
        asset: input.asset,
        project,
        target: { ...target, width, height },
        capture,
        resize,
        tools: targetTools,
        ...(openResourcePreview === undefined
          ? {}
          : {
              openResourcePreview: (input) => openResourcePreview({ ...input, canvas }),
            }),
      });
      try {
        assertAvailable();
        signal.throwIfAborted();
        (started ? app.resume() : app.start()).unwrap();
        started = true;
        if (!presented) app.pause().unwrap();
        preview = next;
        previewOwner = command.id;
        frameFloor = submittedFrame;
        return {
          previewOwner,
          target: next.target,
          asset: next.asset,
          assetBinding: next.assetBinding,
        };
      } catch (error) {
        await next.close?.();
        throw error;
      }
    };
    const closePreviewCommand = async (input: ExecuteInput) => {
      const child = input.targetId ? children.get(input.targetId) : undefined;
      if (child && input.targetId) {
        await child.dispose();
        if (children.get(input.targetId) === child) children.delete(input.targetId);
        return { closed: true, targetId: input.targetId };
      }
      if (input.previewOwner !== previewOwner) return { closed: false, stale: true };
      await closePreview();
      return { closed: true, targetId: target.targetId };
    };
    const writeAuthoringField = async (input: ExecuteInput) => {
      const owner = active(input);
      if (!owner.writeAssetField || !input.fieldWrite)
        throw new TypeError('This target has no asset authoring capability');
      await owner.writeAssetField(input.fieldWrite);
      return { applied: true };
    };
    const prepareAuthoringContent = async (input: ExecuteInput, signal: AbortSignal) => {
      const owner = active(input);
      if (!owner.prepareAssetContent || !input.content)
        throw new TypeError('This target has no author generation capability');
      return await owner.prepareAssetContent(
        decodePackData(input.content) as RuntimePackContent,
        signal,
      );
    };
    const commitAuthoringContent = async (input: ExecuteInput) => {
      const owner = active(input);
      if (
        !owner.commitAssetContent ||
        typeof input.preparation !== 'number' ||
        !Array.isArray(input.fields)
      )
        throw new TypeError('This target has no prepared author content');
      await owner.commitAssetContent(input.preparation, input.fields as WorkspaceAssetFieldWrite[]);
      return null;
    };
    const setTargetControl = (input: ExecuteInput) => {
      if (input.mode !== 'player' && input.mode !== 'observer')
        throw new TypeError('Invalid control mode');
      const setControl = active(input).setControl;
      if (!setControl)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'Game input control tools',
        );
      return setControl({ ...input, mode: input.mode });
    };
    const resizeTarget = async (input: ExecuteInput) => {
      if (typeof input.width !== 'number' || typeof input.height !== 'number')
        throw new TypeError('Workspace resize requires output dimensions');
      return {
        target: await active(input).resize?.({
          ...input,
          width: input.width,
          height: input.height,
        }),
      };
    };
    const requireTexturePreview = (input: ExecuteInput) => {
      const texture = active(input).texture;
      if (!texture) throw new Error('Texture preview controls are unavailable');
      return texture;
    };
    const requireDisplay = (input: ExecuteInput) => {
      const display = active(input).display;
      if (!display)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'A resource preview display plugin',
        );
      return display;
    };
    const revokeCameraConnection = (input: ExecuteInput) => {
      if (typeof input.connectionId !== 'string')
        throw new TypeError('A connection identity is required');
      return active(input).revokeConnection?.({
        targetId: input.targetId,
        connectionId: input.connectionId,
      });
    };
    const pickTarget = (input: ExecuteInput) => {
      if (
        typeof input.x !== 'number' ||
        typeof input.y !== 'number' ||
        !Number.isFinite(input.x) ||
        !Number.isFinite(input.y)
      )
        throw new TypeError('Picking requires finite output pixels');
      const pick = requireTools(input).pick;
      if (!pick)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'Display picking tools',
        );
      return pick({ x: input.x, y: input.y });
    };
    const requireEntityId = (input: ExecuteInput) => {
      if (typeof input.entityId !== 'string')
        throw new TypeError('An entity reference is required');
      return input.entityId;
    };
    /** Operations served by the target tools plugin of the active preview. */
    const executeTargetToolCommand = (operation: string, input: ExecuteInput): unknown => {
      switch (operation) {
        case 'target.pick':
          return pickTarget(input);
        case 'entity.highlight':
          return (
            requireTools(input).highlight?.(input.entityId ? { entityId: input.entityId } : {}) ?? {
              available: false,
            }
          );
        case 'scene.tree.get':
          return requireTools(input).tree(input);
        case 'entity.inspect': {
          const entityId = requireEntityId(input);
          return requireTools(input).inspect({ entityId });
        }
        case 'entity.focus': {
          const entityId = requireEntityId(input);
          return requireTools(input).focus({ entityId });
        }
        default:
          throw new EngineWorkspaceError(
            'engine-workspace-operation-unavailable',
            'An installed workspace operation',
          );
      }
    };
    /** Operations owned by the active preview: authoring, control, output and camera. */
    const executeTargetCommand = async (
      operation: string,
      input: ExecuteInput,
      signal: AbortSignal,
    ): Promise<unknown> => {
      switch (operation) {
        case 'authoring.write':
          return writeAuthoringField(input);
        case 'authoring.prepare':
          return prepareAuthoringContent(input, signal);
        case 'authoring.commit':
          return commitAuthoringContent(input);
        case 'target.control':
          return setTargetControl(input);
        case 'resize':
          return resizeTarget(input);
        case 'capture':
          return active(input).capture?.(input);
        case 'preview.texture.get':
          return requireTexturePreview(input).get();
        case 'preview.texture.set': {
          const result = await requireTexturePreview(input).set(input.options);
          frameFloor = submittedFrame;
          return result;
        }
        case 'preview.display.get':
          return requireDisplay(input).get();
        case 'preview.display.set': {
          const result = await requireDisplay(input).set(input.display ?? {});
          frameFloor = submittedFrame;
          return result;
        }
        case 'camera.get':
          return active(input).getCamera(input);
        case 'camera.begin':
          return active(input).beginCameraInteraction?.(input);
        case 'camera.update': {
          const result = await active(input).updateCameraDraft?.(input);
          frameFloor = submittedFrame;
          return result;
        }
        case 'camera.commit': {
          const result = await active(input).commitCamera?.(input);
          frameFloor = submittedFrame;
          return result;
        }
        case 'camera.abort': {
          const result = await active(input).abortCameraInteraction?.(input);
          frameFloor = submittedFrame;
          return result;
        }
        case 'camera.revoke':
          return revokeCameraConnection(input);
        default:
          return executeTargetToolCommand(operation, input);
      }
    };
    /** Session operations; everything else addresses the active preview. */
    const execute = async (
      command: Command,
      signal: AbortSignal,
      onInstalled?: (fiber: Fiber) => void,
    ): Promise<unknown> => {
      if (command.operation === 'closeWorkspace') return closeWorkspace();
      assertAvailable();
      signal.throwIfAborted();
      const input = { ...command.input, signal };
      switch (command.operation) {
        case 'runtimePack':
          return runRuntimePack(input, signal, onInstalled);
        case 'describe':
          return { project, target };
        case 'listAssets':
          return listAssets();
        case 'inspectAsset':
          return inspectAsset(input, signal);
        case 'openPreview':
          if (input.previewTargetId && input.previewTargetId !== target.targetId)
            return openInlinePreview(input, input.previewTargetId, signal);
          return openTargetPreview(command, input, signal);
        case 'closePreview':
          return closePreviewCommand(input);
        default:
          return executeTargetCommand(command.operation, input, signal);
      }
    };
    if (options.input) {
      preview = createEngineWorkspaceAppTarget({
        app,
        target,
        tools: targetTools,
        capture,
        resize,
      });
      previewOwner = target.sessionId;
      removeCameraEvents = bindWorkspaceCameraEvents(canvas, options.input, preview);
    }
    unsubscribe = transport.subscribe(ENGINE_WORKSPACE_COMMAND_TOPIC, (value) => {
      if (!value || typeof value !== 'object') return;
      const command = value as Command;
      if (disposed || command.sessionId !== target.sessionId || typeof command.id !== 'string')
        return;
      if (command.kind === 'cancel') {
        pending.get(command.id)?.controller.abort();
        return;
      }
      if (command.kind !== 'command' || pending.has(command.id)) return;
      if (
        command.input?.targetId &&
        command.input.targetId !== target.targetId &&
        !(command.operation === 'closePreview' && children.has(command.input.targetId))
      )
        return;
      const controller = new AbortController();
      const run = async () => {
        let installed: Fiber | undefined;
        try {
          const result = await execute(command, controller.signal, (fiber) => {
            installed = fiber;
          });
          if (controller.signal.aborted && previewOwner === command.id) await closePreview();
          controller.signal.throwIfAborted();
          await send({
            kind: 'result',
            id: command.id,
            sessionId: target.sessionId,
            targetId: target.targetId,
            ok: true,
            value: result,
          });
          controller.signal.throwIfAborted();
        } catch (cause) {
          let reported = cause;
          if (installed) {
            try {
              await disposeWorkspacePluginFiber(installed);
            } catch (cleanup) {
              reported = cleanup;
            }
          }
          const error = workspaceCommandFailure(reported);
          if (error.detail.cleanup === 'failed' || error.detail.cleanup === 'timeout')
            failure = error;
          await send({
            kind: 'result',
            id: command.id,
            sessionId: target.sessionId,
            targetId: target.targetId,
            ok: false,
            error: {
              code: error.code,
              expected: error.expected,
              hint: error.hint,
              ...('detail' in error ? { detail: error.detail } : {}),
            },
          });
        } finally {
          pending.delete(command.id);
        }
      };
      // Existing synchronous reads observe their live target while an independent
      // preview starts. Lifecycle and writes retain their original ordering.
      const readOnly =
        command.operation === 'describe' ||
        command.operation === 'scene.tree.get' ||
        command.operation === 'entity.inspect' ||
        command.operation === 'preview.texture.get' ||
        command.operation === 'camera.get' ||
        command.operation === 'preview.display.get' ||
        command.operation === 'target.pick';
      const completion = (readOnly ? Promise.resolve() : queue).then(run, run);
      pending.set(command.id, { controller, completion });
      if (!readOnly) queue = completion;
    });
    let opened: unknown;
    if (options.initialAsset)
      opened = await execute(
        {
          kind: 'command',
          id: target.targetId,
          sessionId: target.sessionId,
          operation: 'openPreview',
          input: {
            targetId: target.targetId,
            asset: options.initialAsset,
            width: target.width,
            height: target.height,
          },
        },
        new AbortController().signal,
      );
    canvas.ownerDocument.documentElement.dataset.forgeaxWorkspaceReady = 'true';
    await send({
      kind: 'ready',
      id: target.sessionId,
      sessionId: target.sessionId,
      targetId: target.targetId,
      project,
      target,
      ...(opened ? { preview: opened } : {}),
    });
  },
};

/** Native child Fibers publish tools before activating their command consumer. */
export const engineWorkspaceBrowserPlugin: Plugin.Object<EngineWorkspaceBrowserOptions> = {
  name: 'forgeax:workspace-browser',
  inject: ['world'],
  async apply(ctx, options) {
    await ctx.plugin(engineWorkspaceTargetToolsPlugin, {
      targetId: options.target.targetId,
      ...(typeof options.canvas.addEventListener === 'function'
        ? { display: { canvas: options.canvas, app: options.app } }
        : {}),
      ...(options.input ? { input: options.input } : {}),
      ...(options.app.observation === undefined ? {} : { observation: options.app.observation }),
    });
    await ctx.plugin(workspaceBrowserCommandsPlugin, options);
  },
};

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    engineWorkspaceInput?: CanvasInputBoundary;
  }
}

/** Owns the one physical game input backend before App borrows its game view. */
export const engineWorkspaceInputPlugin: Plugin.Object<{ canvas: HTMLCanvasElement }> = {
  name: 'forgeax:workspace-input',
  provide: ['engineWorkspaceInput'],
  apply(ctx, { canvas }) {
    const remove = attachBrowserInputBackend(canvas);
    ctx.effect(() => remove);
    const boundary = createCanvasInputBoundary(remove.backend);
    boundary.grantGame();
    ctx.provide('engineWorkspaceInput', boundary);
  },
};
