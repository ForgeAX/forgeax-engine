import type { RuntimePackContent, RuntimePackSnapshot } from '@forgeax/engine-import';
import type { PackInstanceJson } from '@forgeax/engine-pack/source';
import {
  type Context,
  disposePluginFiber,
  type Fiber,
  inspectPluginFiber,
  startNativePlugin,
  startPluginAsset,
} from '@forgeax/engine-plugin';
import type { App } from './types';
import { EngineWorkspaceError } from './workspace';

/** Serializable commands for the existing producer and native plugin lifecycle. */
export type EngineWorkspaceRuntimePackRequest =
  | { readonly operation: 'inspect' | 'snapshot' | 'plugin-inspect' | 'release' }
  | { readonly operation: 'admit'; readonly content: RuntimePackContent }
  | { readonly operation: 'generate'; readonly instance: PackInstanceJson }
  | { readonly operation: 'restore'; readonly snapshot: RuntimePackSnapshot }
  | { readonly operation: 'withdraw'; readonly packageId: string }
  | { readonly operation: 'plugin-install'; readonly guid: string }
  | { readonly operation: 'plugin-dispose'; readonly uid: number };

const connectionOwner = Symbol('workspace.plugin-assets.connection');
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    [connectionOwner]?: string;
  }
}

function children(context: Context): Fiber[] {
  return [...context.registry.values()].flatMap((runtime) =>
    [...runtime.fibers].filter(
      (fiber) => fiber.uid !== null && fiber.parent.fiber === context.fiber,
    ),
  );
}

function scopes(context: Context, connectionId?: string): Fiber[] {
  return children(context).filter(
    (fiber) =>
      fiber.ctx[connectionOwner] !== undefined &&
      (connectionId === undefined || fiber.ctx[connectionOwner] === connectionId),
  );
}

/** Report actual cleanup completion; a deadline does not claim native disposal stopped. */
export async function disposeWorkspacePluginFiber(fiber: Fiber): Promise<void> {
  const before = inspectPluginFiber(fiber);
  const result = await disposePluginFiber(fiber);
  if (result.cleanup === 'completed') return;
  throw new EngineWorkspaceError(
    result.cleanup === 'timeout'
      ? 'engine-workspace-plugin-cleanup-timeout'
      : 'engine-workspace-plugin-cleanup-failed',
    'The native Fiber to finish disposal',
    'Inspect the owning plugin; cleanup is incomplete and retry is not proven safe.',
    {
      cleanup: result.cleanup,
      fiber: before,
      ...(result.cause === undefined ? {} : { cause: String(result.cause) }),
    },
  );
}

export async function releaseWorkspacePlugins(
  context: Context,
  connectionId?: string,
): Promise<void> {
  // Native ancestry is the ownership authority. No parallel installation registry.
  const results = await Promise.allSettled(
    scopes(context, connectionId).map(disposeWorkspacePluginFiber),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length)
    throw new EngineWorkspaceError(
      'engine-workspace-plugin-release-incomplete',
      'All identified native plugin scopes to finish disposal',
      'Inspect each cleanup failure before retrying or closing this execution environment.',
      { cleanup: 'failed', failures },
    );
}

/** Runs outside the frame loop and returns only JSON plus an optional local cancellation owner. */
export async function executeWorkspaceRuntimePack(
  context: Context,
  app: App,
  request: EngineWorkspaceRuntimePackRequest,
  signal: AbortSignal,
  connectionId?: string,
): Promise<{ readonly value: unknown; readonly installed?: Fiber }> {
  signal.throwIfAborted();
  if (!request || typeof request !== 'object')
    throw new TypeError('A runtime Pack request is required');
  if (request.operation === 'release') {
    if (!connectionId) throw new TypeError('A trusted connection identity is required');
    await releaseWorkspacePlugins(context, connectionId);
    return { value: { cleanup: 'completed' } };
  }
  if (request.operation.startsWith('plugin-')) {
    if (!connectionId)
      throw new TypeError('A trusted connection identity is required for plugin ownership');
    let owner = scopes(context, connectionId)[0];
    const installations = owner ? children(owner.ctx) : [];
    switch (request.operation) {
      case 'plugin-inspect':
        return { value: { plugins: installations.map(inspectPluginFiber) } };
      case 'plugin-dispose': {
        if (!Number.isSafeInteger(request.uid))
          throw new TypeError('A native Fiber UID is required');
        const fiber = installations.find((fiber) => fiber.uid === request.uid);
        if (!fiber)
          throw new EngineWorkspaceError(
            'engine-workspace-plugin-owner-mismatch',
            'An installation owned by this target and connection',
            'Inspect the current connection installations before disposing one.',
          );
        await disposeWorkspacePluginFiber(fiber);
        return { value: { uid: request.uid, cleanup: 'completed' } };
      }
      case 'plugin-install': {
        if (typeof request.guid !== 'string' || !request.guid.trim())
          throw new TypeError('A plugin GUID is required');
        if (!owner)
          owner = (
            await startNativePlugin(
              context.extend({ [connectionOwner]: connectionId }),
              {
                name: 'forgeax:workspace-plugin-assets',
                inject: ['assets', 'pluginPrograms'],
                apply() {},
              },
              undefined,
              { signal },
            )
          ).unwrap();
        const installed = (await startPluginAsset(owner.ctx, request.guid, { signal })).unwrap();
        return { value: inspectPluginFiber(installed), installed };
      }
    }
  }
  const runtime = app.pluginContext.get('runtimePacks');
  if (!runtime)
    throw new EngineWorkspaceError(
      'engine-workspace-capability-unavailable',
      'The target App runtime Pack producer',
      'Enable runtimePacks in this App asset assembly.',
    );
  const producer = runtime.producer;
  switch (request.operation) {
    case 'inspect':
      return { value: producer.inspect() };
    case 'snapshot':
      return { value: producer.snapshot() };
    case 'admit':
      return { value: (await producer.admit(request.content, signal)).unwrap() };
    case 'generate':
      return { value: (await producer.generate(request.instance, signal)).unwrap() };
    case 'restore':
      (await producer.restore(request.snapshot, signal)).unwrap();
      return { value: producer.inspect() };
    case 'withdraw':
      if (typeof request.packageId !== 'string' || !request.packageId.trim())
        throw new TypeError('A Pack identity is required');
      producer.withdraw(request.packageId);
      return { value: producer.inspect() };
    default:
      throw new TypeError('Unknown runtime Pack operation');
  }
}
