import type { WorkspaceState } from './contract.ts';
export type WorkspaceStateClient = { subscribe(listener: (state: WorkspaceState) => void): () => void; getState?: () => Promise<WorkspaceState> };
export type WorkspaceStateReader = { getSnapshot(): WorkspaceState | null; subscribe(listener: () => void): () => void; dispose(): void };

import { workspaceUiFingerprint } from './contract.ts';

/** Cancel a panel's reads at state publication, without waiting for React cleanup. */
export function createWorkspaceObservation(reader: WorkspaceStateReader, isCurrent: (state: WorkspaceState | null) => boolean) {
  const controller = new AbortController();
  let unsubscribe: (() => void) | undefined;
  const dispose = () => {
    controller.abort();
    unsubscribe?.();
    unsubscribe = undefined;
  };
  const check = () => {
    if (!isCurrent(reader.getSnapshot())) dispose();
  };
  unsubscribe = reader.subscribe(check);
  // subscribe may synchronously publish, before its disposer has been assigned.
  if (controller.signal.aborted) dispose();
  else check();
  return { signal: controller.signal, dispose };
}

/** A subscription owns its transport lease; snapshots remain Engine/View API results. */
export function createWorkspaceStateReader(client: WorkspaceStateClient | undefined): WorkspaceStateReader {
  if (!client || typeof client.subscribe !== 'function') {
    return { getSnapshot: () => null, subscribe: () => () => {}, dispose() {} };
  }
  let snapshot: WorkspaceState | null = null;
  let published: WorkspaceState | null = null;
  let publishedFingerprint = '';
  const listeners = new Set<() => void>();
  let transportUnsubscribe: (() => void) | undefined;
  let generation = 0;
  const stop = () => {
    generation++;
    transportUnsubscribe?.();
    transportUnsubscribe = undefined;
  };
  const start = () => {
    const current = ++generation;
    const accept = (next: WorkspaceState) => {
      if (current !== generation || !next) return;
      if (snapshot !== null && (next.revision ?? 0) < (snapshot.revision ?? 0)) return;
      snapshot = next;
      const fingerprint = workspaceUiFingerprint(next);
      if (fingerprint === publishedFingerprint) return;
      publishedFingerprint = fingerprint;
      published = next;
      for (const listener of listeners) listener();
    };
    transportUnsubscribe = client.subscribe(accept) ?? (() => {});
    void client.getState?.().then(accept).catch(() => {});
  };
  return {
    getSnapshot: () => published,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
    dispose() { stop(); listeners.clear(); snapshot = null; published = null; publishedFingerprint = ''; },
  };
}
