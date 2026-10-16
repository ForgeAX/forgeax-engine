import type { HostTransportClient, HostTransportServer } from '@forgeax/engine-host/transport';
import type { ToolCallerIdentity } from '@forgeax/engine-tool-runtime';
import type { WorkspaceSummary } from './contract.ts';
import type { ViewFileOpenRequest } from './frontend-contract.ts';
import { VIEW_WORKSPACE_CORE_OPERATION_EFFECTS, workspaceError } from './contract.ts';

export type PresentationResource = { asset: { guid: string; kind: string } } | { file: ViewFileOpenRequest['file'] };
export type PresentationSnapshot = {
  shellState: 'mounted' | 'project-restoring';
  activePageId: string | null;
  pages: readonly { id: string; typeId: string; title: string; closable: boolean; resource?: PresentationResource }[];
  pageTypes: readonly { typeId: string; title: string; openable: boolean }[];
  panels: readonly { id: string; title: string; mounted: boolean; visible: boolean; active: boolean; placement: string }[];
  hasMorePages: boolean; hasMorePageTypes: boolean; hasMorePanels: boolean;
  appearance: { theme: string; preference: string; language: string };
};
export type WorkspacePresentation = PresentationSnapshot & { connectionId: string; workspace: WorkspaceSummary };
export type PresentationOperation = Extract<keyof typeof VIEW_WORKSPACE_CORE_OPERATION_EFFECTS, `presentation.${string}`>;
export function isPresentationOperation(operation: string): operation is PresentationOperation {
  return operation.startsWith('presentation.') && Object.hasOwn(VIEW_WORKSPACE_CORE_OPERATION_EFFECTS, operation);
}
export type PresentationOwner = (operation: PresentationOperation, args: Record<string, unknown>, signal: AbortSignal) => PresentationSnapshot | Promise<PresentationSnapshot>;
const TOPIC = 'forgeax.view.presentation.request';
const REPLY = 'forgeax.view.presentation.reply';
type Request = { requestId: string; operation: PresentationOperation; args: Record<string, unknown>; cancelled?: boolean };
type Failure = { code: string; expected: string; hint: string };
type Reply = { requestId: string; snapshot?: PresentationSnapshot; failure?: Failure };

function failure(code: string, expected: string, hint: string) { return workspaceError(code, expected, hint); }
function diagnostic(error: unknown): Failure {
  const value = error as Partial<Failure>;
  return {
    code: typeof value?.code === 'string' ? value.code.slice(0, 160) : 'view-presentation-failed',
    expected: typeof value?.expected === 'string' ? value.expected.slice(0, 512) : 'the requested View presentation action to complete',
    hint: typeof value?.hint === 'string' ? value.hint.slice(0, 512) : error instanceof Error ? error.message.slice(0, 512) : 'Read presentation.get and retry the intended action.',
  };
}

/** A result projection, never a second page or panel store. */
export function serializePresentation(input: PresentationSnapshot): PresentationSnapshot {
  const invalid = (): never => { throw failure('view-presentation-invalid', 'a committed View presentation snapshot with valid field types', 'Reconnect the View frontend.'); };
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 512) : invalid();
  const identity = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : invalid();
  const flag = (value: unknown) => typeof value === 'boolean' ? value : invalid();
  const resource = (value: PresentationResource | undefined): PresentationResource | undefined => {
    if (value === undefined) return;
    if (value && 'asset' in value) return { asset: { guid: identity(value.asset?.guid), kind: identity(value.asset?.kind) } };
    if (value && 'file' in value && typeof value.file?.path === 'string' && value.file.path.length > 0 && value.file.path.length <= 4096)
      return { file: { projectId: identity(value.file.projectId), path: value.file.path, extension: identity(value.file.extension) } };
    return invalid();
  };
  if (!input || !['mounted', 'project-restoring'].includes(input.shellState) || !Array.isArray(input.pages) || !Array.isArray(input.pageTypes) || !Array.isArray(input.panels) || !input.appearance)
    throw failure('view-presentation-invalid', 'a committed View presentation snapshot', 'Reconnect the View frontend.');
  return {
    shellState: input.shellState,
    activePageId: input.activePageId === null ? null : identity(input.activePageId),
    pages: input.pages.slice(0, 64).map(row => ({ id: identity(row?.id), typeId: identity(row?.typeId), title: text(row?.title), closable: flag(row?.closable), ...(row?.resource === undefined ? {} : { resource: resource(row.resource) }) })),
    pageTypes: input.pageTypes.slice(0, 64).map(row => ({ typeId: identity(row?.typeId), title: text(row?.title), openable: flag(row?.openable) })),
    panels: input.panels.slice(0, 128).map(row => ({ id: identity(row?.id), title: text(row?.title), mounted: flag(row?.mounted), visible: flag(row?.visible), active: flag(row?.active), placement: text(row?.placement) })),
    hasMorePages: flag(input.hasMorePages) || input.pages.length > 64,
    hasMorePageTypes: flag(input.hasMorePageTypes) || input.pageTypes.length > 64,
    hasMorePanels: flag(input.hasMorePanels) || input.panels.length > 128,
    appearance: { theme: text(input.appearance.theme), preference: text(input.appearance.preference), language: text(input.appearance.language) },
  };
}

/** Request/reply lifetime only. UI facts remain with the addressed frontend. */
export function createPresentationRelay(transport: HostTransportServer, resolveConnection: (caller: ToolCallerIdentity | undefined, requested: unknown) => string, timeoutMs = 3000) {
  const pending = new Map<string, { connectionId: string; finish: (snapshot?: PresentationSnapshot, error?: unknown) => void }>();
  let disposed = false;
  const unregister = transport.register<Reply, { accepted: boolean }>(REPLY, ({ payload, caller }) => {
    const request = pending.get(payload?.requestId);
    if (!request || request.connectionId !== caller.connectionId) return { accepted: false };
    if (payload.failure) request.finish(undefined, failure(payload.failure.code, payload.failure.expected, payload.failure.hint));
    else {
      try { request.finish(serializePresentation(payload.snapshot!)); }
      catch (error) { request.finish(undefined, error); }
    }
    return { accepted: true };
  });
  const disconnect = transport.onClientDisconnect(caller => {
    for (const request of pending.values()) if (request.connectionId === caller.connectionId)
      request.finish(undefined, failure('view-presentation-disconnected', 'the selected View document to remain connected', 'Read pages.list and choose a live document.'));
  });
  return {
    call(operation: PresentationOperation, args: Record<string, unknown>, caller: ToolCallerIdentity | undefined, signal?: AbortSignal) {
      if (disposed) throw failure('view-presentation-unavailable', 'a live View presentation provider', 'Reconnect View.');
      if (pending.size >= 64) throw failure('view-presentation-busy', 'fewer than 64 pending presentation requests', 'Wait for current requests to complete.');
      const connectionId = resolveConnection(caller, args.connectionId);
      const requestId = crypto.randomUUID();
      const { connectionId: _connection, ...input } = args;
      return new Promise<PresentationSnapshot & { connectionId: string }>((resolve, reject) => {
        const cancel = () => finish(undefined, failure('view-presentation-cancelled', 'the presentation request to remain active', 'Read presentation.get before retrying a write; it may already have applied.'));
        const timer = setTimeout(() => finish(undefined, failure('view-presentation-timeout', 'the selected View document to answer the presentation request', 'Read presentation.get after reconnecting; never replay writes automatically.')), timeoutMs);
        const finish = (snapshot?: PresentationSnapshot, error?: unknown) => {
          if (!pending.delete(requestId)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          if (error) {
            transport.publish(TOPIC, { requestId, operation, args: input, cancelled: true } satisfies Request, { connectionId });
            reject(error);
          } else resolve({ ...snapshot!, connectionId });
        };
        pending.set(requestId, { connectionId, finish });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) { cancel(); return; }
        transport.publish(TOPIC, { requestId, operation, args: input } satisfies Request, { connectionId });
      });
    },
    dispose() {
      disposed = true;
      for (const request of pending.values()) request.finish(undefined, failure('view-presentation-unavailable', 'a live View presentation provider', 'Reconnect View.'));
      unregister(); disconnect();
    },
  };
}

/** Native frontend lease; disposal cancels work before revoking the listener. */
export function attachPresentationResponder(transport: HostTransportClient, owner: PresentationOwner) {
  const active = new Map<string, AbortController>();
  const cancelAll = () => { for (const controller of active.values()) controller.abort(); active.clear(); };
  const disconnected = transport.onDisconnect(cancelAll);
  const unsubscribe = transport.subscribe<Request>(TOPIC, request => {
    if (request.cancelled) { active.get(request.requestId)?.abort(); active.delete(request.requestId); return; }
    if (active.has(request.requestId)) return;
    const controller = new AbortController();
    active.set(request.requestId, controller);
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      let reply: Reply;
      try { reply = { requestId: request.requestId, snapshot: serializePresentation(await owner(request.operation, request.args, controller.signal)) }; }
      catch (error) { reply = { requestId: request.requestId, failure: diagnostic(error) }; }
      if (!controller.signal.aborted) await transport.request(REPLY, reply, { signal: controller.signal });
    }).catch(() => { /* Host disconnect retires the backend request. */ }).finally(() => active.delete(request.requestId));
  });
  return () => { unsubscribe(); disconnected(); cancelAll(); };
}
