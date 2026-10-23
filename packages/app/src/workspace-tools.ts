import type { PackProgramSource } from '@forgeax/engine-pack/runtime';
import type { PackDraftRequest } from '@forgeax/engine-pack/source';
import {
  defineTool,
  type ToolContribution,
  type ToolExecutionContext,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import {
  type EngineWorkspaceCameraInput,
  EngineWorkspaceError,
  type EngineWorkspaceRuntime,
} from './workspace';
import type { EngineWorkspaceRuntimePackRequest } from './workspace-runtime-pack';
import type { EngineWorkspacePickGranularity } from './workspace-target-tools';

export const ENGINE_WORKSPACE_TOOL_SOURCE = 'engine-workspace';
export const ENGINE_WORKSPACE_STATE_TOPIC = 'engine.workspace.state';

type Args = Record<string, unknown>;
type Handler = (args: Args, context: ToolExecutionContext) => unknown | Promise<unknown>;

function string(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`workspace requires ${name}`);
  return value;
}

/** Keep a structured hint readable: String() would reduce it to "[object Object]". */
function workspaceHintText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A serializable projection of existing owners, never a second state store. */
export function snapshotEngineWorkspace(
  runtime: EngineWorkspaceRuntime,
  catalogEpoch = 0,
  preview = runtime.preview,
) {
  const opened = runtime.project;
  const target = (value: NonNullable<typeof opened>['target']) => {
    if (!value) return null;
    const { surface: _surface, ...identity } = value;
    return identity;
  };
  return {
    apiVersion: runtime.apiVersion,
    catalogEpoch,
    project: opened ? structuredClone(opened.project) : null,
    projectTarget: target(opened?.target),
    ...(opened?.phase === undefined ? {} : { projectPhase: opened.phase }),
    ...(opened?.browserGeneration === undefined
      ? {}
      : { browserGeneration: opened.browserGeneration }),
    play: runtime.play
      ? {
          target: target(runtime.play.target),
          phase: runtime.play.phase,
        }
      : null,
    previews: runtime.previews.map((preview) => ({
      target: target(preview.target),
      asset: preview.asset ? structuredClone(preview.asset) : null,
      assetBinding: preview.assetBinding,
    })),
    preview: preview
      ? {
          target: target(preview.target),
          asset: preview.asset ? structuredClone(preview.asset) : null,
          assetBinding: preview.assetBinding,
        }
      : null,
  };
}

/** CLI and browser adapters register these same Engine handlers. No UI identifiers are accepted. */
export function createEngineWorkspaceTools(
  runtime: EngineWorkspaceRuntime,
  changed: () => void = () => {},
): readonly ToolContribution[] {
  const afterRetirement = (previous: EngineWorkspaceRuntime['project']) => {
    const failure = previous?.failure as { detail?: Readonly<Record<string, unknown>> } | undefined;
    return {
      ...snapshotEngineWorkspace(runtime),
      ...(previous !== runtime.project && failure?.detail?.cleanup === 'unconfirmed'
        ? { retiredTarget: failure.detail }
        : {}),
    };
  };
  const project = (args: Args) => {
    const current = runtime.project;
    if (!current || current.project.id !== string(args, 'projectId')) {
      throw new EngineWorkspaceError(
        'engine-workspace-project-mismatch',
        'engine workspace project identity mismatch',
      );
    }
    return current;
  };
  const preview = (args: Args) => {
    const current = [...runtime.previews, runtime.play].find(
      (owner) => owner?.target.targetId === args.targetId,
    );
    if (!current || current.target.targetId !== string(args, 'targetId')) {
      throw new EngineWorkspaceError(
        'engine-workspace-target-mismatch',
        'engine workspace target identity mismatch',
      );
    }
    if (args.targetGeneration !== current.target.generation) {
      throw new EngineWorkspaceError(
        'engine-workspace-target-stale',
        'the current preview generation',
        'Refresh engine.workspace.get and submit targetGeneration from preview.target.generation.',
      );
    }
    return current;
  };
  const materialPreview = (args: Args) => {
    const control = preview(args).material;
    if (!control)
      throw new EngineWorkspaceError(
        'engine-workspace-capability-unavailable',
        'A material preview target',
      );
    return control;
  };
  const cameraInput = (args: Args, context: ToolExecutionContext): EngineWorkspaceCameraInput => ({
    targetId: string(args, 'targetId'),
    clientId: context.caller?.sourceId ?? string(args, 'clientId'),
    ...(context.caller === undefined ? {} : { connectionId: context.caller.connectionId }),
    signal: context.signal,
    ...(typeof args.interactionId === 'string' ? { interactionId: args.interactionId } : {}),
    ...(typeof args.operationId === 'string' ? { operationId: args.operationId } : {}),
    ...(typeof args.expectedVersion === 'number' ? { expectedVersion: args.expectedVersion } : {}),
    ...(typeof args.baseVersion === 'number' ? { baseVersion: args.baseVersion } : {}),
    ...(args.camera === undefined ? {} : { camera: args.camera }),
    ...(args.input === undefined ? {} : { input: args.input }),
  });
  const handlers: Record<
    string,
    {
      summary: string;
      run: Handler;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    }
  > = {
    'target.pick': {
      summary:
        'Pick against the actual submitted display mapping using bounds or exact triangle geometry.',
      properties: {
        granularity: { type: 'string', enum: ['bounds', 'triangle'] },
      },
      async run(args) {
        const owner = preview(args);
        if (!owner.tools?.pick)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'Display picking tools',
          );
        if (typeof args.x !== 'number' || typeof args.y !== 'number')
          throw new TypeError('Picking requires output pixels');
        const result = await owner.tools.pick({
          x: args.x,
          y: args.y,
          ...(args.granularity === undefined
            ? {}
            : { granularity: args.granularity as EngineWorkspacePickGranularity }),
        });
        if (owner !== preview(args))
          throw new EngineWorkspaceError('engine-workspace-target-stale', 'The same target');
        return result;
      },
    },
    'entity.highlight': {
      summary: 'Set or clear the target tools highlight without changing entity materials.',
      run(args) {
        const owner = preview(args);
        return (
          owner.tools?.highlight?.(
            typeof args.entityId === 'string' ? { entityId: args.entityId } : {},
          ) ?? { available: false }
        );
      },
    },
    'play.start': {
      summary:
        'Start an isolated game from the current project, returning its Engine URL before readiness.',
      async run(args, context) {
        if (!runtime.startPlay)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'An Engine Play provider',
          );
        await runtime.startPlay({ ...project(args), signal: context.signal });
        return snapshotEngineWorkspace(runtime);
      },
    },
    'play.ready': {
      summary: 'Wait for the actual Play World after presenting its Engine URL.',
      async run(args, context) {
        const owner = preview(args);
        if (owner !== runtime.play)
          throw new EngineWorkspaceError(
            'engine-workspace-target-mismatch',
            'The current Play target',
          );
        await runtime.play.ready(context.signal);
        if (runtime.play !== owner)
          throw new EngineWorkspaceError('engine-workspace-target-stale', 'The same Play target');
        return snapshotEngineWorkspace(runtime);
      },
    },
    'play.stop': {
      summary:
        'Stop only the identified Editor Play, preserving the edit target and independent runs.',
      async run(args) {
        const owner = preview(args);
        if (owner !== runtime.play)
          throw new EngineWorkspaceError(
            'engine-workspace-target-mismatch',
            'The current Play target',
          );
        await runtime.stopPlay?.(runtime.play);
        return snapshotEngineWorkspace(runtime);
      },
    },
    'target.control': {
      summary: 'Hand input and camera control between the game and its observation tools.',
      async run(args, context) {
        const owner = preview(args);
        if (!owner.setControl)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'Target control tools',
          );
        if (args.mode !== 'player' && args.mode !== 'observer')
          throw new TypeError('Control requires player or observer mode');
        return owner.setControl({ ...cameraInput(args, context), mode: args.mode });
      },
    },
    'workspace.get': {
      summary: 'Read the Engine project and preview identities.',
      run: () => snapshotEngineWorkspace(runtime),
    },
    'project.open': {
      summary: 'Open an Engine project and return its target URL before browser readiness.',
      async run(args, context) {
        const previous = runtime.project;
        if (
          args.expectedTargetId !== undefined &&
          args.expectedTargetId !== null &&
          typeof args.expectedTargetId !== 'string'
        )
          throw new TypeError('expectedTargetId must be a target identity or null');
        if (args.expectedTargetState !== undefined && args.expectedTargetState !== 'lost')
          throw new TypeError('expectedTargetState must be lost');
        await runtime.openProject({
          root: string(args, 'root'),
          signal: context.signal,
          ...(args.expectedTargetId === undefined
            ? {}
            : { expectedTargetId: args.expectedTargetId as string | null }),
          ...(args.expectedTargetState === undefined
            ? {}
            : { expectedTargetState: 'lost' as const }),
        });
        return afterRetirement(previous);
      },
    },
    'project.close': {
      summary: 'Close the identified Engine workspace project and its preview.',
      async run(args) {
        const previous = project(args);
        await runtime.closeProject(previous);
        return afterRetirement(previous);
      },
    },
    'assets.list': {
      summary: 'Read assets from the Engine project catalog.',
      async run(args, context) {
        const opened = project(args);
        const assets = await runtime.listAssets({ ...opened, signal: context.signal });
        if (runtime.project !== opened) throw new Error('engine workspace assets became stale');
        return { project: opened.project, assets };
      },
    },
    'assets.search': {
      summary: 'Search the Engine project catalog with a bounded page of asset identities.',
      async run(args, context) {
        const opened = project(args);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 20;
        if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 100_000)
          throw new TypeError('workspace requires offset from 0 to 100000');
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50)
          throw new TypeError('workspace requires limit from 1 to 50');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 128))
          throw new TypeError('workspace requires query of at most 128 characters');
        if (args.kind !== undefined && (typeof args.kind !== 'string' || args.kind.length > 64))
          throw new TypeError('workspace requires kind of at most 64 characters');
        const query =
          typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase('en-US') : '';
        const assets = await runtime.listAssets({ ...opened, signal: context.signal });
        if (runtime.project !== opened) throw new Error('engine workspace assets became stale');
        const matches = assets.filter(
          (asset) =>
            (args.kind === undefined || asset.kind === args.kind) &&
            (!query ||
              [asset.guid, asset.kind, asset.name, asset.sourceKey, asset.path].some((value) =>
                value?.toLocaleLowerCase('en-US').includes(query),
              )),
        );
        matches.sort((a, b) => a.guid.localeCompare(b.guid));
        const page = matches.slice(offset as number, (offset as number) + (limit as number));
        return {
          project: opened.project,
          assets: page.map((asset) => ({
            guid: asset.guid,
            kind: asset.kind,
            ...(asset.packageId === undefined ? {} : { packageId: asset.packageId }),
            ...(asset.sourceKey === undefined ? {} : { sourceKey: asset.sourceKey }),
            publicationState: asset.lifecycle ?? 'unknown',
          })),
          hasMore: (offset as number) + page.length < matches.length,
          nextOffset:
            (offset as number) + page.length < matches.length
              ? (offset as number) + page.length
              : null,
        };
      },
    },
    'asset.open': {
      summary: 'Open an independent Engine asset preview.',
      async run(args, context) {
        const opened = project(args);
        const assets = await runtime.listAssets({ ...opened, signal: context.signal });
        if (runtime.project !== opened) throw new Error('engine workspace assets became stale');
        const asset = assets.find((value) => value.guid === string(args, 'guid'));
        if (!asset)
          throw new EngineWorkspaceError(
            'engine-workspace-asset-not-found',
            'engine workspace asset not found',
          );
        if (asset.previewable === false)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            `A preview owner for asset kind ${asset.kind}`,
            'Inspect this asset through engine.asset.inspect; it has no preview owner.',
          );
        const extent = (name: string, fallback: number): number => {
          const value = args[name] ?? fallback;
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
            throw new TypeError(`workspace requires positive ${name}`);
          return value;
        };
        const preview = await runtime.openPreview({
          project: opened.project,
          projectHandle: opened.handle,
          asset,
          width: extent('width', 1280),
          height: extent('height', 720),
          signal: context.signal,
        });
        return snapshotEngineWorkspace(runtime, 0, preview);
      },
    },
    'preview.close': {
      summary: 'Close only the identified Engine preview.',
      async run(args) {
        const owner = preview(args);
        if (owner === runtime.play)
          throw new EngineWorkspaceError(
            'engine-workspace-operation-unavailable',
            'Use play.stop for the game target',
          );
        const closing = runtime.closePreview(owner);
        changed();
        await closing;
        return snapshotEngineWorkspace(runtime);
      },
    },
    'preview.material.get': {
      summary: 'Read the exact material preview mesh, rotation and center.',
      run(args) {
        return materialPreview(args).get();
      },
    },
    'preview.material.set': {
      summary:
        'Select the primitive on the exact material preview without changing the material or camera.',
      properties: { mesh: { type: 'string', enum: ['sphere', 'cylinder', 'plane', 'cube'] } },
      run(args) {
        return materialPreview(args).set(
          args.mesh as import('./workspace-material-preview').MaterialPreviewMesh,
        );
      },
    },
    'preview.material.rotate': {
      summary: 'Rotate only the exact material preview object by yaw and pitch in radians.',
      properties: { yaw: { type: 'number' }, pitch: { type: 'number' } },
      run(args) {
        return materialPreview(args).rotate({
          yaw: args.yaw as number,
          pitch: args.pitch as number,
        });
      },
    },
    'preview.material.reset': {
      summary:
        'Restore the exact material preview object orientation, retaining its mesh and camera.',
      run(args) {
        return materialPreview(args).reset();
      },
    },
    'preview.texture.get': {
      summary: 'Read the bound texture dimensions, mip levels and display settings.',
      run(args) {
        const owner = preview(args);
        if (!owner.texture)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'A texture preview target',
          );
        return owner.texture.get();
      },
    },
    'preview.texture.set': {
      summary:
        'Set texture channels, mip, slice, projection and display settings on the exact target.',
      run(args) {
        const owner = preview(args);
        if (!owner.texture)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'A texture preview target',
          );
        return owner.texture.set(args.options);
      },
    },
    'preview.resize': {
      summary: 'Resize the identified workspace output in pixels without replacing its World.',
      async run(args, context) {
        const owner = preview(args);
        if (!owner.resize)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'A resizable workspace target',
          );
        const width = args.width;
        const height = args.height;
        if (
          typeof width !== 'number' ||
          typeof height !== 'number' ||
          ![width, height].every((size) => Number.isSafeInteger(size) && size > 0)
        )
          throw new TypeError('Workspace resize requires positive integer output pixels');
        await owner.resize({
          targetId: owner.target.targetId,
          width,
          height,
          signal: context.signal,
        });
        return { target: owner.target };
      },
    },
    'preview.display.get': {
      summary: 'Read the identified resource preview display capabilities and current settings.',
      properties: { uvChannel: { type: 'integer', minimum: 0, maximum: 7 } },
      async run(args, context) {
        const owner = preview(args);
        if (!owner.display)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'A resource preview display plugin',
          );
        if (
          args.uvChannel !== undefined &&
          (typeof args.uvChannel !== 'number' ||
            !Number.isInteger(args.uvChannel) ||
            args.uvChannel < 0 ||
            args.uvChannel > 7)
        )
          throw new TypeError('uvChannel must be an integer from 0 to 7');
        const result = await owner.display.get({
          signal: context.signal,
          ...(typeof args.uvChannel === 'number' ? { uvChannel: args.uvChannel } : {}),
        });
        if (owner !== preview(args))
          throw new EngineWorkspaceError(
            'engine-workspace-target-stale',
            'The same preview target',
          );
        return result;
      },
    },
    'preview.display.set': {
      summary: 'Change display geometry only on the identified resource preview.',
      properties: {
        mode: { enum: ['material', 'wireframe'] },
        collision: { type: 'boolean' },
        bounds: { type: 'boolean' },
      },
      async run(args, context) {
        const owner = preview(args);
        if (!owner.display)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'A resource preview display plugin',
          );
        if (args.mode !== undefined && args.mode !== 'material' && args.mode !== 'wireframe')
          throw new TypeError('Display mode must be material or wireframe');
        for (const key of ['collision', 'bounds'])
          if (args[key] !== undefined && typeof args[key] !== 'boolean')
            throw new TypeError(`${key} must be boolean`);
        const result = await owner.display.set(
          {
            ...(args.mode === 'material' || args.mode === 'wireframe' ? { mode: args.mode } : {}),
            ...(typeof args.collision === 'boolean' ? { collision: args.collision } : {}),
            ...(typeof args.bounds === 'boolean' ? { bounds: args.bounds } : {}),
          },
          { signal: context.signal },
        );
        if (owner !== preview(args))
          throw new EngineWorkspaceError(
            'engine-workspace-target-stale',
            'The same preview target',
          );
        return result;
      },
    },
    'preview.capture': {
      summary: 'Capture the actual Engine preview surface.',
      run(args, context) {
        const owner = preview(args);
        if (!owner.capture) throw new Error('engine workspace capture capability unavailable');
        return owner.capture({
          targetId: owner.target.targetId,
          signal: context.signal,
          ...(typeof args.width === 'number' ? { width: args.width } : {}),
          ...(typeof args.height === 'number' ? { height: args.height } : {}),
        });
      },
    },
    'camera.get': {
      summary: 'Read the authoritative Engine camera and version.',
      run(args, context) {
        const owner = preview(args);
        return owner.getCamera({ targetId: owner.target.targetId, signal: context.signal });
      },
    },
  };
  for (const [operation, method] of [
    ['camera.begin', 'beginCameraInteraction'],
    ['camera.update', 'updateCameraDraft'],
    ['camera.commit', 'commitCamera'],
    ['camera.abort', 'abortCameraInteraction'],
  ] as const) {
    handlers[operation] = {
      summary: `${operation} on the identified Engine preview.`,
      async run(args, context) {
        const owner = preview(args);
        const invoke = owner[method];
        if (!invoke) throw new Error(`engine workspace ${operation} capability unavailable`);
        const input = cameraInput(
          operation === 'camera.begin' && args.interactionId === undefined
            ? { ...args, interactionId: crypto.randomUUID() }
            : args,
          context,
        );
        const revoke = () => {
          if (input.connectionId !== undefined)
            void Promise.resolve(
              owner.revokeConnection?.({
                targetId: owner.target.targetId,
                connectionId: input.connectionId,
              }),
            ).catch(() => {});
        };
        context.signal.addEventListener('abort', revoke, { once: true });
        try {
          context.signal.throwIfAborted();
          const result = await invoke(input);
          if (!runtime.previews.includes(owner) && runtime.play !== owner)
            throw new EngineWorkspaceError(
              'engine-workspace-target-stale',
              'the same preview owner after the operation',
              'Refresh engine.workspace.get before issuing another operation.',
            );
          if (context.signal.aborted) {
            revoke();
            context.signal.throwIfAborted();
          }
          return result;
        } finally {
          context.signal.removeEventListener('abort', revoke);
        }
      },
    };
  }
  for (const [operation, method] of [
    ['scene.tree.get', 'tree'],
    ['entity.inspect', 'inspect'],
    ['entity.focus', 'focus'],
  ] as const) {
    handlers[operation] = {
      summary: `${operation} on the actual Engine World through its optional tools plugin.`,
      async run(args, context) {
        const owner = preview(args);
        const tools = owner.tools;
        if (!tools)
          throw new EngineWorkspaceError(
            'engine-workspace-capability-unavailable',
            'The target tools plugin is unavailable',
            'Enable the optional Engine target tools plugin in the execution realm.',
          );
        context.signal.throwIfAborted();
        const result =
          method === 'tree'
            ? await tools.tree({
                ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
                ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
                ...(typeof args.revision === 'number' ? { revision: args.revision } : {}),
              })
            : await tools[method]({ entityId: string(args, 'entityId') });
        context.signal.throwIfAborted();
        if (!runtime.previews.includes(owner) && runtime.play !== owner)
          throw new EngineWorkspaceError(
            'engine-workspace-target-stale',
            'The same target owner after the query',
          );
        return result;
      },
    };
  }
  if (runtime.inspectAsset) {
    handlers['asset.inspect'] = {
      summary: 'Inspect an Engine asset using the project authority.',
      async run(args, context) {
        const opened = project(args);
        const inspection = await runtime.inspectAsset?.({
          ...opened,
          guid: string(args, 'guid'),
          signal: context.signal,
        });
        if (runtime.project !== opened) throw new Error('engine workspace inspection became stale');
        return { project: opened.project, inspection };
      },
    };
  }
  const authorPack = runtime.authorPack;
  if (authorPack) {
    handlers['asset.source.draft'] = {
      summary:
        'Edit a memory Pack draft, explicitly generate its preview, or atomically save its source.',
      required: ['projectId', 'request'],
      properties: {
        request: { type: 'object', additionalProperties: true },
        previewTargetId: { type: 'string' },
      },
      async run(args, context) {
        const opened = project(args);
        if (args.request === null || typeof args.request !== 'object')
          throw new TypeError('A Pack draft request is required');
        const result = await authorPack({
          ...opened,
          request: args.request as PackDraftRequest,
          ...(typeof args.previewTargetId === 'string'
            ? { previewTargetId: args.previewTargetId }
            : {}),
          signal: context.signal,
        });
        if (runtime.project !== opened)
          throw new EngineWorkspaceError(
            'engine-workspace-project-stale',
            'The same project after authoring',
          );
        return result;
      },
    };
  }
  if (runtime.rebuildAssetSource) {
    for (const mode of ['rebuild', 'cold-cook'] as const) {
      handlers[`asset.source.${mode}`] = {
        summary: `${mode} through the Engine asset source owner.`,
        async run(args, context) {
          const opened = project(args);
          const result = await runtime.rebuildAssetSource?.({
            ...opened,
            guid: string(args, 'guid'),
            requestId: string(args, 'requestId'),
            expectedRevision: string(args, 'expectedRevision'),
            mode,
            signal: context.signal,
          });
          if (runtime.project !== opened)
            throw new Error('engine workspace source operation became stale');
          return result;
        },
      };
    }
  }
  if (runtime.runtimePack) {
    const operations = {
      inspect: {
        summary:
          'Inspect admitted definitions, available Engine import identities and generation state.',
      },
      admit: {
        summary:
          'Admit new Pack content atomically without running its generator or installing plugins.',
        field: 'content',
      },
      generate: {
        summary:
          'Generate one Pack instance in the current project App, including before the first preview.',
        field: 'instance',
      },
      snapshot: {
        summary: 'Export original Pack content and fixed recovery closure as durable JSON.',
      },
      restore: {
        summary: 'Restore saved Pack content and instances; plugin installation remains explicit.',
        field: 'snapshot',
      },
      withdraw: {
        summary:
          'Withdraw the identified runtime Pack publication; existing held resources retain their owner.',
        field: 'packageId',
      },
      'plugin-inspect': {
        summary:
          'Inspect native plugin installations owned by this connection in the project World.',
      },
      'plugin-install': {
        summary: 'Start one PluginAsset as a native Fiber owned by this connection.',
        field: 'guid',
      },
      'plugin-dispose': {
        summary:
          'Dispose only this connection native plugin installation and report cleanup completion.',
        field: 'uid',
      },
    } as const;
    for (const [name, definition] of Object.entries(operations)) {
      const field = 'field' in definition ? definition.field : undefined;
      handlers[`runtime-pack.${name}`] = {
        summary: definition.summary,
        required: ['projectId', 'targetId', 'worldId', ...(field ? [field] : [])],
        properties: {
          ...(field
            ? {
                [field]:
                  field === 'uid'
                    ? { type: 'integer', minimum: 0 }
                    : field === 'guid' || field === 'packageId'
                      ? { type: 'string', minLength: 1 }
                      : { type: 'object' },
              }
            : {}),
        },
        async run(args, context) {
          const opened = project(args);
          const target = opened.target;
          if (
            !target ||
            target.targetId !== string(args, 'targetId') ||
            target.worldId !== string(args, 'worldId')
          )
            throw new EngineWorkspaceError(
              'engine-workspace-target-stale',
              'The current project App and World',
              'Refresh engine.workspace.get.',
            );
          const request = {
            operation: name,
            ...(field ? { [field]: args[field] } : {}),
          } as EngineWorkspaceRuntimePackRequest;
          return runtime.runtimePack?.({
            ...opened,
            targetId: target.targetId,
            worldId: target.worldId,
            request,
            signal: context.signal,
            ...(context.caller ? { connectionId: context.caller.connectionId } : {}),
          });
        },
      };
    }
  }
  if (runtime.prepareRuntimePackProgram)
    handlers['runtime-pack.prepare'] = {
      summary:
        'Prepare JS modules or transpile TS through the Node producer, preserving original TS for saving. Does not execute or admit code.',
      required: ['projectId', 'source'],
      properties: {
        source: {
          type: 'object',
          required: ['entry', 'export', 'modules'],
          properties: {
            entry: { type: 'string' },
            export: { type: 'string' },
            modules: { type: 'object', additionalProperties: { type: 'string' } },
            imports: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
      },
      run(args, context) {
        return runtime.prepareRuntimePackProgram?.({
          ...project(args),
          source: args.source as PackProgramSource,
          signal: context.signal,
        });
      },
    };
  return Object.entries(handlers).map(([operation, handler]) => {
    const required =
      handler.required ??
      (operation === 'project.open'
        ? ['root']
        : operation.startsWith('camera.') ||
            operation.startsWith('preview.') ||
            operation.startsWith('entity.') ||
            operation.startsWith('target.') ||
            operation === 'play.ready' ||
            operation === 'play.stop' ||
            operation === 'scene.tree.get'
          ? ['targetId', 'targetGeneration']
          : operation === 'workspace.get'
            ? []
            : ['projectId']);
    const schema = {
      type: 'object',
      required,
      properties: {
        root: { type: 'string', minLength: 1 },
        expectedTargetId: {
          description: 'Expected current target identity; null requires no open project.',
        },
        expectedTargetState: { type: 'string', enum: ['lost'] },
        projectId: { type: 'string', minLength: 1 },
        targetId: { type: 'string', minLength: 1 },
        worldId: { type: 'string', minLength: 1 },
        targetGeneration: { type: 'integer', minimum: 1 },
        guid: { type: 'string', minLength: 1 },
        entityId: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['player', 'observer'] },
        x: { type: 'number' },
        y: { type: 'number' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        revision: { type: 'integer', minimum: 0 },
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
        ...handler.properties,
      },
    } as const;
    return defineTool<unknown, unknown>(
      {
        id: `engine.${operation}`,
        path: ['engine', ...operation.split('.')],
        title: operation,
        summary: handler.summary,
        realm: 'host',
        argsSchema: toolJsonSchema(schema),
        resultSchema: toolJsonSchema({}),
        inputSchema: schema as import('@forgeax/engine-tool-runtime').JsonValue,
        outputSchema: {},
        evidence: [],
      },
      async (value, context) => {
        try {
          const result = await handler.run(value as Args, context);
          return result === undefined ? null : JSON.parse(JSON.stringify(result));
        } catch (error) {
          if (
            error instanceof EngineWorkspaceError ||
            (error !== null &&
              typeof error === 'object' &&
              'code' in error &&
              'expected' in error &&
              'hint' in error)
          )
            return {
              ok: false,
              error: {
                code: String(error.code),
                expected: String(error.expected),
                hint: workspaceHintText(error.hint),
                detail: 'detail' in error ? JSON.parse(JSON.stringify(error.detail)) : {},
              },
            };
          if (error instanceof TypeError)
            return {
              ok: false,
              error: {
                code: 'engine-workspace-invalid-args',
                expected: error.message,
                hint: 'Use the operation schema and explicit project/target identities.',
              },
            };
          throw error;
        } finally {
          if (
            ![
              'workspace.get',
              'assets.list',
              'assets.search',
              'asset.inspect',
              'asset.source.draft',
              'scene.tree.get',
              'entity.inspect',
              'target.pick',
              'camera.get',
              'preview.display.get',
              'preview.material.get',
              'preview.capture',
              'runtime-pack.inspect',
              'runtime-pack.snapshot',
              'runtime-pack.plugin-inspect',
              'runtime-pack.prepare',
            ].includes(operation)
          )
            changed();
        }
      },
    );
  });
}
