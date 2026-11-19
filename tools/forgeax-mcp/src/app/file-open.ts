import { VIEW_PACK_SOURCES_SERVICE, VIEW_WORKSPACE_TAB_ID } from '@forgeax/view/workspace/contract';

// View's public source distribution exports JavaScript without type declarations.
// This adapter describes only the public operations it consumes.
type WorkspaceState = {
  revision?: number;
  project?: { id: string; root: string } | null;
  projectStatus?: { phase: string; sessionId: string; generation: number; failure?: { hint: string } } | null;
  projectPhase?: string;
  projectDocumentPresentation?: 'presenter' | 'observer';
  projectDocument?: { sessionId: string; targetId: string; url: string } | null;
};
export interface ViewFileDocumentOwner {
  getSnapshot(): { document: { sessionId: string; targetId: string; url: string }; phase: string; ready: Promise<void>;
    failure?: { message: string } } | undefined;
  subscribe(listener: (snapshot: ReturnType<ViewFileDocumentOwner['getSnapshot']>) => void): () => void;
}
type SourceOutput = { guid: string; sourcePath?: string; path?: string };
type PackSourceListing = { sources: readonly {
  sourcePath: string; revision?: string; packageId?: string;
  outputs: readonly SourceOutput[]; diagnostic?: { code: string; hint: string };
}[]; hasMore: boolean };
type CallOptions = { signal: AbortSignal; tabId?: string };
export interface ViewFileClient {
  projectSession?: { ready: Promise<unknown>; getSnapshot(): { busy: boolean };
    subscribe(listener: (state: { busy: boolean }) => void): () => void };
  transport: { request<I, O>(service: string, input: I, options: { signal: AbortSignal }): Promise<O> };
  getState(options: CallOptions): Promise<WorkspaceState>;
  presentProject(options: CallOptions): Promise<WorkspaceState>;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
  openProject(root: string, options: CallOptions & { expectedProject: { kind: 'empty' } | { kind: 'session'; sessionId: string; generation: number } }): Promise<WorkspaceState>;
  listAssets(projectId: string, options: CallOptions): Promise<{ assets: readonly SourceOutput[] }>;
  openAsset(guid: string, options: CallOptions & { projectId: string }): Promise<unknown>;
  revealPack(input: { projectId: string; sourcePath: string; revision: string; packageId?: string }, options: { signal: AbortSignal }): Promise<{ ok: boolean; code: string }>;
}

export type ViewFile = { projectRoot: string; sourcePath: string };
export type ViewFileResult = { ok: true; value: ViewFile } | { ok: false; error: { code: string; hint: string } };

function awaitReady(ready: Promise<unknown>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    ready.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

function sourceKey(path: string, root: string) {
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${root}/${path}`).replaceAll('\\', '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Subscribe before reading so readiness cannot be lost between the two steps. */
function waitFor<T>(subscribe: (accept: (value: T) => void) => () => void,
  read: () => Promise<T>, select: (value: T) => boolean, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let stop = () => {};
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      stop();
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(signal.reason);
    const accept = (value: T) => {
      try { if (select(value)) finish(undefined, value); }
      catch (error) { finish(error); }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    stop = subscribe(accept);
    if (settled) stop();
    else void read().then(accept, finish);
  });
}

/** Only existing guarded View operations select projects and open assets. */
export async function openViewFile(client: ViewFileClient, file: ViewFile, signal: AbortSignal, documentOwner?: ViewFileDocumentOwner, existingPresenter = false) {
  const session = client.projectSession;
  if (session) {
    await awaitReady(session.ready, signal);
    signal.throwIfAborted();
    await waitFor(session.subscribe, async () => session.getSnapshot(), state => !state.busy, signal);
  }
  // A file tab can be activated by the host without a pointer event in View.
  // Claim presentation through the same owner used by ordinary View focus.
  let state = existingPresenter ? await client.getState({ signal }) : await client.presentProject({ signal });
  if (existingPresenter && state.projectDocumentPresentation !== 'presenter')
    throw new Error('The addressed View no longer presents this project. Retry after activating View.');
  signal.throwIfAborted();
  if (sourceKey(state.project?.root ?? '', '/') !== sourceKey(file.projectRoot, '/')) {
    const expectedProject = state.project
      ? state.projectStatus ? { kind: 'session' as const, sessionId: state.projectStatus.sessionId, generation: state.projectStatus.generation } : undefined
      : { kind: 'empty' as const };
    if (!expectedProject) throw new Error('Refresh View to obtain the current project session before opening this file.');
    state = await client.openProject(file.projectRoot, { expectedProject, tabId: VIEW_WORKSPACE_TAB_ID, signal });
  }
  const projectId = state.project?.id;
  if (!projectId) throw new Error('View did not select the asset project.');
  const activation = new AbortController();
  const floor = state.revision ?? 0;
  signal = AbortSignal.any([signal, activation.signal]);
  const stopActivation = client.subscribe(next => {
    if ((next.revision ?? 0) < floor) return;
    if (next.project?.id !== projectId || next.projectDocumentPresentation === 'observer')
      activation.abort(new DOMException('View file activation was superseded', 'AbortError'));
  });
  try {
    const running = (value: WorkspaceState) => {
      if (value.project?.id !== projectId) throw new Error('The selected project changed while opening the asset.');
      if (value.projectStatus?.phase === 'failed') throw new Error(value.projectStatus.failure?.hint ?? 'Project preparation failed.');
      return value.projectStatus?.phase === 'running' || value.projectPhase === 'running';
    };
    if (!running(state)) state = await waitFor(listener => client.subscribe(listener), () => client.getState({ signal }), running, signal);
    // A presentation handoff can still report the old browser as running. The
    // exact Shell-owned replacement Frame must finish preparation before queries
    // or asset commands enter that realm.
    if (documentOwner) {
      const document = state.projectDocument;
      if (!document) throw new Error('View has no admitted project document for this file.');
      const frame = await waitFor(listener => documentOwner.subscribe(listener), async () => documentOwner.getSnapshot(), value => {
        if (!value || value.document.sessionId !== document.sessionId || value.document.targetId !== document.targetId || value.document.url !== document.url) return false;
        if (value.failure) throw new Error(value.failure.message);
        return value.phase === 'ready';
      }, signal);
      await awaitReady(frame!.ready, signal);
      state = await waitFor(listener => client.subscribe(listener), () => client.getState({ signal }), value => {
        if (value.projectDocument?.sessionId !== document.sessionId || value.projectDocument?.targetId !== document.targetId
          || value.projectDocument?.url !== document.url || value.projectDocumentPresentation !== 'presenter')
          throw new DOMException('View file activation was superseded', 'AbortError');
        return running(value);
      }, signal);
      if (state.projectDocument?.sessionId !== document.sessionId
        || state.projectDocument?.targetId !== document.targetId || state.projectDocument?.url !== document.url)
        throw new DOMException('View file activation was superseded', 'AbortError');
    }
    await selectFileAsset(client, file, projectId, signal);
  } finally { stopActivation(); }
}

async function selectFileAsset(client: ViewFileClient, file: ViewFile, projectId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const inventory = await client.transport.request<{ projectId: string }, PackSourceListing>(VIEW_PACK_SOURCES_SERVICE, { projectId }, { signal });
    const source = inventory.sources.find(row => sourceKey(row.sourcePath, file.projectRoot) === sourceKey(file.sourcePath, file.projectRoot));
    if (!source) throw new Error(inventory.hasMore ? 'This source is outside the current Content Browser inventory limit.' : 'This file is not an asset source in the selected project.');
    if (source.diagnostic && source.diagnostic.code !== 'pack-source-unmaterialized') throw new Error(source.diagnostic.hint);
    signal.throwIfAborted();
    // Scriptable Packs already materialized by this running project have no
    // static source-index outputs. Use the existing catalog, never evaluate again.
    const outputs = source.diagnostic?.code === 'pack-source-unmaterialized'
      ? (await client.listAssets(projectId, { signal, tabId: VIEW_WORKSPACE_TAB_ID })).assets.filter(asset => {
        const path = asset.sourcePath ?? asset.path;
        return path !== undefined && sourceKey(path, file.projectRoot) === sourceKey(file.sourcePath, file.projectRoot);
      })
      : source.outputs;
    signal.throwIfAborted();
    if (outputs.length === 1) {
      await client.openAsset(outputs[0].guid, { projectId, tabId: VIEW_WORKSPACE_TAB_ID, signal });
      return;
    }
    if (!source.revision) throw new Error('The asset source has no current revision.');
    const result = await client.revealPack({ projectId, sourcePath: source.sourcePath, revision: source.revision,
      ...(source.packageId ? { packageId: source.packageId } : {}) }, { signal });
    if (!result.ok) throw new Error(`View could not reveal this asset source: ${result.code}.`);
}

/** One pending activation per document; service replacement fences the old client. */
export function createViewFileOpener(resolveFile: (signal: AbortSignal) => Promise<ViewFileResult>,
  report: (error?: unknown) => void) {
  let client: ViewFileClient | undefined;
  let documentOwner: ViewFileDocumentOwner | undefined;
  let pending = false;
  let controller: AbortController | undefined;
  let sequence = 0;
  let chain = Promise.resolve();
  let disposed = false;
  let selection: { file: ViewFile; signal: AbortSignal; resolve(): void; reject(error: unknown): void; cleanup(): void } | undefined;
  const cancel = () => { ++sequence; controller?.abort(); controller = undefined; };
  const retireSelection = (error: unknown) => {
    const previous = selection;
    selection = undefined;
    previous?.cleanup();
    previous?.reject(error);
  };
  const run = () => {
    cancel();
    if (!pending || !client || disposed) return;
    const current = client;
    const currentDocument = documentOwner;
    const requested = selection;
    const revision = sequence;
    const lifetime = controller = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000), ...(requested ? [requested.signal] : [])]);
    report();
    chain = chain.then(async () => {
      signal.throwIfAborted();
      const result = requested ? { ok: true as const, value: requested.file } : await resolveFile(signal);
      signal.throwIfAborted();
      if (!result.ok) throw new Error(result.error.hint);
      await openViewFile(current, result.value, signal, currentDocument, !!requested);
      if (sequence === revision) {
        pending = false;
        if (selection === requested) {
          selection = undefined;
          requested?.cleanup();
          requested?.resolve();
        }
      }
    }).catch(error => {
      if (sequence !== revision || lifetime.signal.aborted) return;
      if (requested && selection === requested) { pending = false; retireSelection(error); }
      if (error instanceof DOMException && error.name === 'AbortError') { pending = false; return; }
      report(error);
    });
  };
  const superseded = () => new DOMException('View source action was superseded', 'AbortError');
  return {
    activate() {
      if (!disposed) { retireSelection(superseded()); pending = true; run(); }
    },
    select(file: ViewFile, signal: AbortSignal): Promise<void> {
      if (disposed) return Promise.reject(new Error('View document retired.'));
      signal.throwIfAborted();
      retireSelection(superseded());
      return new Promise((resolve, reject) => {
        const abort = () => {
          if (selection !== requested) return;
          pending = false;
          retireSelection(signal.reason);
          cancel();
        };
        const requested = { file, signal, resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) };
        selection = requested;
        signal.addEventListener('abort', abort, { once: true });
        pending = true;
        run();
        if (signal.aborted) abort();
      });
    },
    cancel() { pending = false; retireSelection(superseded()); cancel(); report(); },
    attach(value: ViewFileClient, owner?: ViewFileDocumentOwner) {
      if (client && (client !== value || documentOwner !== owner)) retireSelection(new Error('View workspace connection replaced.'));
      client = value; documentOwner = owner; run();
      return () => {
        if (client === value && documentOwner === owner) {
          client = undefined; documentOwner = undefined;
          if (selection) { pending = false; retireSelection(new Error('View workspace connection retired.')); }
          cancel();
        }
      };
    },
    dispose() { disposed = true; pending = false; client = undefined; documentOwner = undefined; retireSelection(new Error('View document retired.')); cancel(); },
  };
}
