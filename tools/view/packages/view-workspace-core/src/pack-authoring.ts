import type { PackDraftReply, PackDraftRequest, PackDraftSnapshot } from '@forgeax/engine/app';
import type { ViewWorkspaceClient } from './client.ts';
import type { WorkspaceProject, WorkspaceTarget } from './contract.ts';

export type { PackDraftField, PackDraftSnapshot } from '@forgeax/engine/app';

const packTransactions = new WeakMap<ViewWorkspaceClient, Map<string, Promise<void>>>();

async function withPackTransaction<T>(client: ViewWorkspaceClient, key: string, run: () => Promise<T>): Promise<T> {
  let transactions = packTransactions.get(client);
  if (!transactions) packTransactions.set(client, transactions = new Map());
  const previous = transactions.get(key);
  const result = previous ? previous.then(run) : run();
  const settled = result.then(() => {}, () => {});
  transactions.set(key, settled);
  try { return await result; }
  finally { if (transactions.get(key) === settled) transactions.delete(key); }
}

/** A conversation reference from the selected owner facts, with no source parsing or mutation. */
export function packParameterReference(input: {
  sourcePath: string;
  project?: WorkspaceProject | null;
  target?: WorkspaceTarget | null;
  draft?: PackDraftSnapshot;
  error?: string;
  field?: { component: string; key: string; value: unknown; schema?: unknown; asset: string; address: unknown; path?: readonly string[] };
}) {
  const field = input.field;
  const title = field ? `Expose ${field.component}.${field.key}` : 'Expose Pack parameter';
  const context = {
    project: input.project && { id: input.project.id, root: input.project.root },
    target: input.target && { targetId: input.target.targetId, generation: input.target.generation },
    sourcePath: input.sourcePath,
    revision: input.draft?.revision,
    unsaved: input.draft?.unsaved,
    parameters: input.draft?.fields.map(value => ({ name: value.name, mode: typeof value.apply === 'object' ? 'runtime' : 'generation' })),
    error: input.error || undefined,
    field: field && { asset: field.asset, component: field.component, key: field.key, schema: field.schema, currentPreviewValue: field.value, address: field.address },
    apply: field?.path && { asset: field.asset, path: field.path },
  };
  return { title, text: [
    `${title} in the View Pack parameters panel.`,
    JSON.stringify(context, null, 2),
    'Resolve the selected project Engine with project.engine.status ' + JSON.stringify({ root: input.project?.root }) + '. Use that installation to inspect the declaration with asset.inspect ' + JSON.stringify({ root: input.project?.root, subject: input.sourcePath, parametersOnly: true }) + '.',
    'A parameter with apply binds an existing runtime field; a parameter without apply is a generation input. Keep existing parameters and unrelated source edits.',
    field?.path
      ? 'Use the supplied apply path and reflected field type. Move the existing authored value into the literal descriptor default and remove that leaf assignment; keep its containing objects. The preview value above is a sample: verify the authored default before moving it.'
      : 'Select the intended field and its owning source. For nested entities, resolve the owning source or an existing instance override before choosing an apply path.',
    'Keep parameter descriptors literal. Do not add a field-specific UI, component, or handler. Confirm the domain permits immediate writes; generation-dependent values stay generation inputs.',
    'Re-run parameter inspection after the edit. View picks up the source change automatically. Check a live edit on the selected preview (open one if absent), then Save and reopen. Generate only when generation inputs changed; declaration validation alone does not prove preview application.',
  ].join('\n\n') };
}

/** A presentation subscription and bounded pending input queue, never a second draft owner. */
export function createPackAuthoringClient(client: ViewWorkspaceClient, input: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly sourcePath: string;
  readonly previewTargetId?: () => string | undefined;
  readonly previewTargetIdForAsset?: (sourceKey: string) => string | undefined;
  readonly previewTargetIds?: () => readonly string[];
}) {
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const queued = new Map<string, unknown>();
  let state: { draft?: PackDraftSnapshot; pending: boolean; closed: boolean } = { pending: false, closed: false };
  let flushing: Promise<void> | undefined;
  let previewEdit = false;
  const transactionKey = `${input.sessionId}\0${input.sourcePath}`;
  const publish = (next: typeof state) => {
    if (lifetime.signal.aborted) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const accept = (reply: PackDraftReply) => {
    if ('closed' in reply) {
      if (state.draft?.id === reply.closed) publish({ pending: false, closed: true });
      return;
    }
    const previous = state.draft;
    if (previous && (previous.id !== reply.id || previous.sequence >= reply.sequence)) return;
    if ('changed' in reply) {
      if (previous) publish({ ...state, draft: { ...previous, ...reply, error: reply.error, values: { ...previous.values, [reply.changed.field]: reply.changed.value } } });
    } else publish({ ...state, draft: reply, closed: false });
  };
  const call = async (request: PackDraftRequest, options?: { previewTargetId?: string; quiet?: boolean }) => {
    lifetime.signal.throwIfAborted();
    const previewTargetId = options && 'previewTargetId' in options ? options.previewTargetId
      : ['open', 'save', 'close'].includes(request.action) ? undefined : input.previewTargetId?.();
    const reply = await client.call<PackDraftReply>('asset.source.draft', {
      projectId: input.projectId, targetId: input.targetId, request, ...(previewTargetId ? { previewTargetId } : {}),
    }, { signal: lifetime.signal, reportError: false });
    lifetime.signal.throwIfAborted();
    if (!options?.quiet) accept(reply);
    return reply;
  };
  const unsubscribe = client.transport.subscribe?.('engine.workspace.pack-draft.changed', (event: { sessionId: string; reply: PackDraftReply }) => {
    const id = 'closed' in event.reply ? event.reply.closed : event.reply.id;
    const opening = !state.draft && 'sourcePath' in event.reply && (event.reply.sourcePath === input.sourcePath || input.sourcePath.endsWith(`/${event.reply.sourcePath}`));
    if (!previewEdit && event.sessionId === input.sessionId && (id === state.draft?.id || opening)) accept(event.reply);
  });
  const replayPreviews = async (draftId: string, updatedTargetId?: string) => {
    const targets = [...new Set(input.previewTargetIds?.() ?? [])];
    if (targets.length === 1 && targets[0] === updatedTargetId) return;
    for (const previewTargetId of targets) {
      const snapshot = await call({ action: 'get', draftId }, { previewTargetId, quiet: true }) as PackDraftSnapshot;
      state = { ...state, draft: snapshot };
    }
  };
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = withPackTransaction(client, transactionKey, async () => {
      while (queued.size) {
        lifetime.signal.throwIfAborted();
        const draftId = state.draft?.id;
        if (!draftId) throw new Error('Open the Pack draft before editing');
        const [field, value] = queued.entries().next().value!;
        queued.delete(field);
        const definition = state.draft?.fields.find(candidate => candidate.name === field);
        const runtimeAsset = definition && typeof definition.apply === 'object' ? definition.apply.asset : undefined;
        const previewTargetId = runtimeAsset
          ? input.previewTargetIdForAsset ? input.previewTargetIdForAsset(runtimeAsset) : input.previewTargetId?.()
          : input.previewTargetId?.();
        const runtimeField = !!runtimeAsset;
        previewEdit = !!previewTargetId;
        try {
          if (previewTargetId) {
            const snapshot = await call({ action: 'get', draftId }, { previewTargetId, quiet: true }) as PackDraftSnapshot;
            state = { ...state, draft: snapshot };
          }
          await call({ action: 'edit', draftId, field, value }, { previewTargetId });
          if (runtimeField) {
            previewEdit = true;
            await replayPreviews(draftId, previewTargetId);
          }
        } finally { previewEdit = false; }
      }
    }).finally(() => {
      flushing = undefined;
      publish({ ...state, pending: queued.size > 0 });
    });
    return flushing;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open: () => call({ action: 'open', sourcePath: input.sourcePath }),
    async syncPreviews() {
      await withPackTransaction(client, transactionKey, async () => {
        const draftId = state.draft?.id;
        if (!draftId) return;
        previewEdit = true;
        try { await replayPreviews(draftId); }
        finally { previewEdit = false; publish({ ...state }); }
      });
    },
    edit(field: string, value: unknown) {
      lifetime.signal.throwIfAborted();
      queued.set(field, value);
      publish({ ...state, pending: true });
    },
    flush,
    async act(action: PackDraftRequest['action'], discard = false) {
      await flush();
      return withPackTransaction(client, transactionKey, async () => {
        const draftId = state.draft?.id;
        if (!draftId) throw new Error('The Pack draft is closed');
        if (action === 'generate') {
          const targets = [...new Set([input.previewTargetId?.(), ...(input.previewTargetIds?.() ?? [])].filter((id): id is string => !!id))];
          if (!targets.length) throw new Error('Open a Pack output preview before generating');
          let reply: PackDraftReply | undefined;
          const failures: unknown[] = [];
          for (const previewTargetId of targets) {
            try { reply = await call({ action, draftId }, { previewTargetId }); }
            catch (cause) { failures.push(cause); }
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length) throw new AggregateError(failures, 'Generated content could not be loaded by every open preview');
          return reply!;
        }
        const reply = await call({ action, draftId, ...(discard ? { discard } : {}) });
        if (['save', 'discard', 'undo', 'redo'].includes(action)) {
          await replayPreviews(draftId);
          publish({ ...state });
        }
        return reply;
      });
    },
    dispose() { lifetime.abort(); unsubscribe?.(); queued.clear(); listeners.clear(); },
  };
}
