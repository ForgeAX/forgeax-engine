import type { Context } from '@forgeax/engine-plugin';
import type { Dispose } from '@forgeax/view-workspace-core/frontend-contract';
import type { ViewPlatform, CarrierCapabilities } from './carrier-contract.ts';
import type { DisplayStatusInput, RunBinding, RunObservation } from './status.ts';
import type { ToolExecutionOwner } from '@forgeax/engine-tool-runtime';
import type { ToolCallerIdentity } from '@forgeax/engine-tool-runtime';
export type DisplayBackendConfig = { platform?: ViewPlatform; capabilities?: Partial<CarrierCapabilities> };
declare module '@forgeax/engine-plugin' { interface EngineContextServices { viewBroker: ViewResourceBroker; viewCarrier: ReturnType<typeof createViewCarrierAdapter>; viewCapabilities: Partial<CarrierCapabilities>; viewStatus: (caller?: ToolCallerIdentity) => DisplayStatusInput | ReturnType<ViewResourceBroker['handshake']> } }
import { registerTools } from '@forgeax/engine-plugin';
import { ViewResourceBroker } from './page-broker.ts';
import { createViewCarrierAdapter } from './carrier-adapter.ts';
import { runViewToolApi } from './tool-runtime.ts';
import {
  BACKEND_PLUGIN_ID,
  BACKEND_MODULE,
  VIEW_STATUS_SERVICE,
  VIEW_STATUS_TOPIC,
} from './identity.ts';
import { createDisplayApiTools } from './api.ts';

function bindPlatform(platform: ViewPlatform) {
  return {
    createPage: platform.createPage.bind(platform),
    ...(typeof platform.getCapabilities === 'function'
      ? { getCapabilities: platform.getCapabilities.bind(platform) }
      : {}),
    ...(typeof platform.dispose === 'function' ? { dispose: platform.dispose.bind(platform) } : {}),
  };
}

const viewDisplayBackendPlugin = {
  name: BACKEND_PLUGIN_ID,
  inject: ['viewWorkspaceCore', 'toolApi'],
  provide: ['viewCapabilities', 'viewStatus'],
  async apply(ctx: Context, config: DisplayBackendConfig = {}) {
    if (!config.platform) return installRunObserver(ctx);
    const broker = new ViewResourceBroker({
      platform: bindPlatform(config.platform),
      capabilities: config.capabilities,
    });
    const carrier = createViewCarrierAdapter({
      broker,
      attachTarget(target) {
        const page = broker.getPage(target);
        return {
          page,
          execution: broker.getExecution(target),
          close: async (reason = 'engine-release') => { await broker.release(target, reason); },
        };
      },
    });
    const status = () => broker.handshake();
    const nativeTransport = ctx.get?.('hostTransport', false);
    const transport = nativeTransport && 'register' in nativeTransport ? nativeTransport : undefined;
    const unsubscribeStatus = broker.subscribe((snapshot) => {
      transport?.publish?.(VIEW_STATUS_TOPIC, snapshot);
    });
    const toolApi = ctx.get?.('toolApi', false);
    const workspace = ctx.get('viewWorkspaceCore');
    const statusTools = toolApi ? createDisplayApiTools(broker) : undefined;
    const statusProviderId = `view-display-status:${String(ctx.fiber.uid)}`;
    let revokeTools: Dispose | undefined;
    let unregisterStatus: (() => void) | undefined;
    let statusOwner: ToolExecutionOwner | undefined;
    ctx.effect(() => async () => {
      unregisterStatus?.();
      unsubscribeStatus();
      await revokeTools?.();
      await broker.dispose();
    });
    if (toolApi && statusTools) {
      revokeTools = registerTools(ctx, statusTools, {
        providerId: statusProviderId,
        sourceId: 'view-backend',
        module: BACKEND_MODULE,
        realm: 'host',
      });
      statusOwner = toolApi.describe(statusTools[0]?.descriptor.id, 'view-backend')[0]?.owner;
    }
    unregisterStatus = transport?.register?.(VIEW_STATUS_SERVICE, ({ payload, signal, caller }) =>
      statusOwner === undefined
        ? broker.handshake()
        : runViewToolApi(toolApi!, {
            operation: statusTools![0].descriptor.id,
            args: payload ?? {},
            signal,
            caller,
            providerId: statusOwner.providerId,
            generation: statusOwner.generation,
          }),
    );
    ctx.provide('viewBroker', broker);
    ctx.provide('viewCarrier', carrier);
    ctx.provide('viewCapabilities', broker.capabilities);
    ctx.provide('viewStatus', status);
  },
};

export default viewDisplayBackendPlugin;

/** Observe cached Engine output; this plugin never owns or drives a run. */
async function installRunObserver(ctx: Context) {
  const transport = ctx.get('hostTransport');
  if (!transport || !('register' in transport)) throw new Error('Display backend requires a server transport');
  const api = ctx.get('toolApi');
  if (!api) throw new Error('Display backend requires ToolApi');
  type Session = {
    binding: RunBinding | null;
    snapshot: DisplayStatusInput;
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
  };
  const createSession = (): Session => ({
    binding: null, snapshot: { status: 'idle', binding: null, observation: null },
    controller: new AbortController(),
  });
  const ordinary = createSession();
  const pages = new Map<string, Session>();
  let disposed = false;
  const pageId = (caller?: ToolCallerIdentity) => {
    if (caller?.kind !== 'frontend') return undefined;
    if (caller.sourceId === 'view-frontend') return caller.connectionId;
    const resolve = ctx.get?.('engineWorkspaceForCaller', false);
    const target = (resolve ? resolve(caller) : ctx.get?.('engineWorkspace', false))?.project?.target;
    return target && caller.sourceId === `forgeax-workspace:${target.sessionId}:${target.targetId}`
      ? caller.connectionId : undefined;
  };
  const sessionFor = (caller?: ToolCallerIdentity) => {
    const id = pageId(caller);
    if (!id) return ordinary;
    let session = pages.get(id);
    if (!session) { session = createSession(); pages.set(id, session); }
    return session;
  };
  const publish = (session: Session, connectionId?: string) => transport.publish(VIEW_STATUS_TOPIC, session.snapshot,
    connectionId ? { connectionId } : { excludeConnectionIds: [...pages.keys()] });
  const stopSession = (session: Session) => { session.controller.abort(); clearTimeout(session.timer); session.timer = undefined; };
  const observe = async (root: string, signal: AbortSignal) => {
    const owner = api.describe('engine.run.observe', 'engine-workspace').find(record => record.callable)?.owner;
    if (!owner) throw new Error('Engine run observation is unavailable.');
    const terminal = await api.run('engine.run.observe', { root }, {
      sourceId: 'engine-workspace', providerId: owner.providerId, generation: owner.generation, signal,
    }).terminal;
    if (terminal.outcome === 'failed') throw new Error(terminal.failure.hint);
    return terminal.result as RunObservation;
  };
  const accept = (session: Session, selected: RunBinding, observation: RunObservation) => {
    const matches = observation.status?.runId === selected.runId;
    session.snapshot = matches
      ? { status: observation.status?.phase === 'ready' ? 'running' : observation.status?.phase ?? 'idle', binding: selected, observation }
      : { status: 'unavailable', binding: selected, observation: session.snapshot.observation ?? null, error: 'The bound run is no longer active. Connect again to view the current run.' };
    return matches;
  };
  const refresh = async (session: Session, connectionId?: string) => {
    const selected = session.binding;
    const signal = session.controller.signal;
    if (disposed || !selected || signal.aborted) return;
    let matches = true;
    try {
      const observation = await observe(selected.root, signal);
      if (disposed || signal.aborted || session.binding !== selected) return;
      matches = accept(session, selected, observation);
    } catch (error) {
      if (!signal.aborted && session.binding === selected) session.snapshot = { status: 'unavailable', binding: selected, observation: session.snapshot.observation ?? null, error: String(error) };
    } finally {
      if (!disposed && !signal.aborted && session.binding === selected) {
        publish(session, connectionId);
        if (matches) {
          session.timer = setTimeout(() => void refresh(session, connectionId), 1000);
          session.timer.unref?.();
        }
      }
    }
  };
  const status = (caller?: ToolCallerIdentity) => sessionFor(caller).snapshot;
  const unregister = transport.register(VIEW_STATUS_SERVICE, ({ caller }) => status(caller));
  const removeDisconnect = transport.onClientDisconnect((caller) => {
    const id = caller.connectionId;
    const session = pages.get(id);
    if (!session) return;
    pages.delete(id);
    stopSession(session);
  });
  const tools = createDisplayApiTools({ handshake: status, async bind({ root, runId }, caller, signal) {
    const session = sessionFor(caller);
    stopSession(session);
    const controller = session.controller = new AbortController();
    session.binding = root !== null && runId !== undefined ? { root: root.trim(), runId: runId.trim() } : null;
    session.snapshot = { status: root === null ? 'idle' : 'connecting', binding: session.binding, observation: null };
    const id = pageId(caller);
    publish(session, id);
    if (root !== null && runId === undefined) {
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        const observation = await observe(root.trim(), controller.signal);
        if (disposed || controller.signal.aborted || session.controller !== controller) return session.snapshot;
        const discovered = observation.status?.runId;
        if (!discovered) session.snapshot = { status: 'idle', binding: null, observation: null };
        else {
          session.binding = { root: root.trim(), runId: discovered };
          accept(session, session.binding, observation);
          session.timer = setTimeout(() => void refresh(session, id), 1000);
          session.timer.unref?.();
        }
      } catch (error) {
        if (!controller.signal.aborted && session.controller === controller) session.snapshot = { status: 'unavailable', binding: null, observation: null, error: String(error) };
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (controller.signal.aborted && session.controller === controller) session.snapshot = { status: 'idle', binding: null, observation: null };
      }
      if (!disposed && session.controller === controller) publish(session, id);
      return session.snapshot;
    }
    void refresh(session, id);
    return session.snapshot;
  } });
  const provider = api.registerProvider({
    providerId: `view-observer:${ctx.fiber.uid}`, sourceId: 'view-backend', realm: 'host',
    module: BACKEND_MODULE, tools,
  });
  ctx.provide('viewStatus', status);
  ctx.provide('viewCapabilities', { ready: true, supportsPage: false });
  ctx.effect(() => async () => {
    disposed = true;
    stopSession(ordinary);
    for (const session of pages.values()) stopSession(session);
    pages.clear();
    removeDisconnect();
    unregister();
    await provider.revoke('View observer disposed');
  });
}
