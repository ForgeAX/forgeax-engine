import type { PageController } from './frontend-contract.ts';
import type { WorkspacePreview, WorkspaceState, WorkspaceTarget } from './contract.ts';
import type { ViewWorkspaceClient } from './client.ts';
import { createResourcePageTitleController, resourceAssetName } from './page-title.ts';
import { selectResourceOpenStatus, selectWorkspaceResourcePreview, selectWorkspaceResourceSubject } from './resource-open.ts';
import { reportWorkspaceCommandError } from './command-error.ts';

/** A resource page retains presentation; Engine retains target and cleanup authority. */
export function createResourcePageController(client: ViewWorkspaceClient | undefined, kinds: readonly string[], release: (target: WorkspaceTarget) => Promise<void>): PageController {
  const title = createResourcePageTitleController(client, kinds);
  if (kinds.length === 0) return title;
  let state: WorkspaceState | undefined;
  let accepted: WorkspacePreview | undefined;
  let scope = '';
  let cleanupFailure: unknown;
  let disposed = false;
  let closing: Promise<void> | undefined;
  let retiring = Promise.resolve();
  const failedRetirements = new Set<WorkspacePreview>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const opening = () => selectResourceOpenStatus(state, kinds);
  const pending = () => opening()?.phase === 'opening';
  const retire = async (preview: WorkspacePreview, detached = release(preview.target), observedScope = scope) => {
    await detached;
    if (disposed || scope !== observedScope) return;
    if (Array.isArray(state?.previews) && !state.previews.some(entry =>
      entry.target.targetId === preview.target.targetId && entry.target.generation === preview.target.generation)) return;
    await client?.closePreview({ targetId: preview.target.targetId, targetGeneration: preview.target.generation });
  };
  const stop = client?.subscribe(next => {
    state = next;
    const nextScope = JSON.stringify([next.project?.id, next.projectTarget?.targetId, next.browserGeneration]);
    if (scope !== nextScope) { scope = nextScope; accepted = undefined; cleanupFailure = undefined; failedRetirements.clear(); }
    const subject = selectWorkspaceResourceSubject(next, kinds);
    const preview = selectWorkspaceResourcePreview(next, subject?.guid);
    if (preview && (accepted?.target.targetId !== preview.target.targetId || accepted?.target.generation !== preview.target.generation)) {
      const previous = accepted;
      accepted = preview;
      if (previous) {
        const detached = release(previous.target);
        // Detach starts synchronously; observe rejection while an earlier close drains.
        void detached.catch(() => {});
        const observedScope = scope;
        retiring = retiring.then(() => retire(previous, detached, observedScope)).catch(error => {
        if (disposed || scope !== observedScope) return;
        failedRetirements.add(previous);
        cleanupFailure = error;
        reportWorkspaceCommandError(error, { operation: 'preview.close' });
        notify();
      });
      }
    }
    notify();
  });
  const waitForOpening = (signal: AbortSignal) => pending() ? new Promise<void>((resolve, reject) => {
    const finish = () => { listeners.delete(check); signal.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(signal.reason); };
    const check = () => { if (!pending()) { finish(); resolve(); } };
    listeners.add(check);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else check();
  }) : Promise.resolve();
  return {
    ...title,
    getTitle() {
      return pending() ? resourceAssetName(opening()?.asset) ?? title.getTitle() : title.getTitle();
    },
    getStatus() {
      const request = opening();
      if (request && kinds.includes(request.asset.kind) && request.phase === 'opening') return { phase: 'opening' };
      if (request && kinds.includes(request.asset.kind) && request.phase === 'failed') return { phase: 'failed', message: request.failure?.hint ?? request.failure?.expected };
      if (cleanupFailure) return { phase: 'failed', message: cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure) };
      return undefined;
    },
    subscribeTitle(listener) {
      listeners.add(listener);
      const unsubscribe = title.subscribeTitle(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    },
    beforeClose(signal) {
      if (closing) return closing;
      const observedScope = scope;
      closing = (async () => {
        signal.throwIfAborted();
        await waitForOpening(signal);
        await retiring;
        signal.throwIfAborted();
        if (scope !== observedScope) throw new DOMException('Page scope changed while closing', 'AbortError');
        for (const previous of failedRetirements) {
          await retire(previous);
          failedRetirements.delete(previous);
        }
        const previous = accepted;
        if (!previous) return;
        try { await retire(previous); }
        catch (error) { cleanupFailure = error; notify(); throw error; }
        if (accepted !== previous) throw new DOMException('Page resource changed while closing', 'AbortError');
        accepted = undefined;
        cleanupFailure = undefined;
      })().finally(() => { closing = undefined; });
      return closing;
    },
    dispose() { disposed = true; stop?.(); title.dispose(); listeners.clear(); },
  };
}
