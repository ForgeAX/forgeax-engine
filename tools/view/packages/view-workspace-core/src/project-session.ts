import type { FrontendPlatform } from '@forgeax/engine-host/platform';
import { navigateBrowserDocument } from './document-navigation.ts';
import type { WorkspaceState } from './contract.ts';
import type { ViewWorkspaceClient } from './client.ts';
export type ProjectSessionWindow = Pick<Window, 'location' | 'localStorage' | 'sessionStorage' | 'performance' | 'history' | 'addEventListener' | 'removeEventListener'> & { fetch: typeof fetch };
type ProjectSessionRecord = { version: number; root?: string; entry?: string; targetId?: string; preferences?: Record<string, string> };
export type ProjectSessionState = { snapshot: WorkspaceState; busy: boolean; error: string | null; restoring: boolean };
export type ProjectSession = ReturnType<typeof createProjectSession>;

import { VIEW_WORKSPACE_TAB_ID } from './contract.ts';

const KEY = 'forgeax.view.project-session/1';
const HASH = 'forgeaxViewRestore';
const PREFERENCES = ['forgeax-view-theme', 'forgeax.view.locale'];
const isLoopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export function restoreProjectPreferences(window: ProjectSessionWindow = globalThis) {
  const record = readProjectSession(window);
  for (const key of PREFERENCES) {
    const value = record?.preferences?.[key];
    if (typeof value === 'string') {
      try { window.localStorage?.setItem(key, value); } catch { /* Optional preference. */ }
    }
  }
}

export function readProjectSession(window: ProjectSessionWindow = globalThis): ProjectSessionRecord | null {
  try {
    const hash = new URLSearchParams(new URL(window.location.href).hash.slice(1));
    const raw = hash.get(HASH) ?? window.sessionStorage?.getItem(KEY) ?? 'null';
    if (raw.length > 64000) return null;
    const value = JSON.parse(raw);
    if (value?.version !== 1 || typeof value.root !== 'string' || !value.root.trim()) return null;
    if (value.targetId !== undefined && typeof value.targetId !== 'string') return null;
    if (value.resources !== undefined && (!Array.isArray(value.resources) ||
        value.resources.length > 32 || !value.resources.every((guid: unknown) => typeof guid === 'string'))) return null;
    const presentation = value.presentation;
    if (presentation !== undefined && (!presentation || typeof presentation !== 'object' || Array.isArray(presentation) ||
        (presentation.pageOrder !== undefined && (!Array.isArray(presentation.pageOrder) ||
          !presentation.pageOrder.every((type: unknown) => typeof type === 'string'))) ||
        (presentation.activeType !== undefined && typeof presentation.activeType !== 'string') ||
        (presentation.layouts !== undefined && (!presentation.layouts || typeof presentation.layouts !== 'object' ||
          Array.isArray(presentation.layouts))))) return null;
    if (value.entry) {
      const entry = new URL(value.entry);
      const current = new URL(window.location.href);
      const sameHost = entry.hostname === current.hostname || (isLoopback(entry.hostname) && isLoopback(current.hostname));
      if (!sameHost || entry.protocol !== current.protocol ||
          !['http:', 'https:'].includes(entry.protocol) || entry.username || entry.password) return null;
    }
    // Read old records without reviving their resource, camera or layout history.
    return { version: 1, root: value.root, entry: value.entry, targetId: value.targetId, preferences: value.preferences };
  } catch { return null; }
}

function save(window: ProjectSessionWindow, value: ProjectSessionRecord | null) {
  if (!value) return;
  value.preferences = {};
  for (const key of PREFERENCES) {
    try {
      const preference = window.localStorage?.getItem(key);
      if (preference) value.preferences[key] = preference;
    } catch { /* Storage is optional. */ }
  }
  try { window.sessionStorage?.setItem(KEY, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}

export function projectSessionUrl(url: string, record: ProjectSessionRecord | null) {
  const next = new URL(url);
  next.hash = new URLSearchParams({ [HASH]: JSON.stringify(record) }).toString();
  return next.href;
}

/** Transfer the confirmed project identity across origins, never runtime history. */
export function navigateProjectSession(snapshot: WorkspaceState, window: ProjectSessionWindow = globalThis, record: ProjectSessionRecord | null = readProjectSession(window)) {
  const url = snapshot?.projectTarget?.url;
  if (!url || !window.location?.assign) return;
  if (!snapshot.project?.root) { window.location.assign(url); return; }
  const current = new URL(window.location.href);
  const next = {
    ...record, version: 1, root: snapshot.project.root,
    targetId: snapshot.projectTarget?.targetId,
    entry: record?.entry ?? current.origin + current.pathname,
  };
  save(window, next);
  window.location.assign(projectSessionUrl(url, next));
}

/** One Cordis-owned project intent/recovery projection shared by all React consumers. */
export function createProjectSession(client: ViewWorkspaceClient, { window = globalThis, navigate: navigateDocument = (url, options) => navigateBrowserDocument(window, url, options) }: { window?: ProjectSessionWindow; navigate?: FrontendPlatform['navigate'] } = {}) {
  let disposed = false;
  let record = readProjectSession(window);
  const location = window.location;
  const url = location?.href ? new URL(location.href) : null;
  const explicitRoot = url?.searchParams.get('project')?.trim();
  const pageTarget = url?.searchParams.get('forgeaxWorkspaceTarget');
  const navigation = window.performance?.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
  let state: ProjectSessionState = {
    snapshot: {}, busy: false, error: null,
    restoring: Boolean(pageTarget ? navigation?.type === 'reload' : explicitRoot || (record?.root && record?.targetId)),
  };
  let initializing = true;
  let openedIntent = Boolean(pageTarget || explicitRoot || record?.targetId);
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelDelay: (() => void) | undefined;
  let reconnecting: Promise<void> | undefined;
  const listeners = new Set<(state: ProjectSessionState) => void>();
  const controller = new AbortController();
  const options = { tabId: VIEW_WORKSPACE_TAB_ID, signal: controller.signal };
  const changed = (patch: Partial<ProjectSessionState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  let reloadWatch = Boolean(pageTarget && navigation?.type === 'reload');
  let reloadSawStarting = false;
  let reloadFloor = -1;
  const releaseReload = (snapshot: WorkspaceState) => {
    if (!reloadWatch) return;
    if (snapshot?.workspaceTargetLost === true) {
      reloadWatch = false;
      changed({ restoring: false, busy: false });
      return;
    }
    if (snapshot?.projectTarget?.targetId !== pageTarget) return;
    const phase = snapshot.projectPhase;
    const generation = typeof snapshot.browserGeneration === 'number' ? snapshot.browserGeneration : undefined;
    if (phase === 'starting') {
      reloadSawStarting = true;
      reloadFloor = generation ?? reloadFloor;
      changed({ restoring: true });
      return;
    }
    if (phase === 'failed') {
      reloadWatch = false;
      changed({ restoring: false, busy: false });
      return;
    }
    if (phase === 'running') {
      if (reloadSawStarting && (generation ?? 0) <= reloadFloor) return;
      // The detach may not have been observed yet. Leave the watch open so a
      // later `starting` hides the shell again until the replacement generation.
      if (reloadSawStarting) reloadWatch = false;
      changed({ restoring: false, busy: false });
      return;
    }
    // An engine that does not report browser phase must not trap the shell on refresh.
    if (phase === undefined) {
      reloadWatch = false;
      changed({ restoring: false, busy: false });
    }
  };
  const accept = (snapshot: WorkspaceState) => {
    if (disposed || (snapshot.revision ?? 0) < (state.snapshot.revision ?? -1)) return;
    changed({ snapshot });
    releaseReload(snapshot);
    // A project opened outside this page (for example `view project open`)
    // is adopted by an empty shell that holds no earlier target identity.
    // Headed documents carry pageTarget and never adopt; a page remembering
    // another target keeps its explicit conflict instead of chasing someone
    // else's session.
    if (!pageTarget && !explicitRoot && !record?.targetId && !initializing && !state.busy && !openedIntent
      && snapshot.projectIntent?.root) {
      void open(snapshot.projectIntent.root);
      return;
    }
    const remoteTargetUrl = snapshot?.projectTarget?.url;
    if (!pageTarget && !explicitRoot && !record?.targetId && !initializing && !state.busy
      && snapshot?.workspaceTargetLost !== true && snapshot?.projectPhase !== 'failed'
      && typeof snapshot?.project?.root === 'string' && snapshot.project.root.trim() !== ''
      && typeof remoteTargetUrl === 'string' && remoteTargetUrl.trim() !== '') {
      void Promise.resolve(navigate(snapshot)).catch(fail);
      return;
    }
    if (initializing || !pageTarget || snapshot.projectTarget?.targetId !== pageTarget || !snapshot.project?.root) return;
    record = {
      ...record, version: 1, root: snapshot.project.root, targetId: pageTarget,
    };
    save(window, record);
  };
  const fail = (error: unknown) => {
    // A terminal failure ends restoration. Keep the error visible and allow an
    // explicit retry instead of leaving project pages behind a loading screen.
    reloadWatch = false;
    changed({ busy: false, restoring: false, error: error instanceof Error ? error.message : String(error) });
  };
  const run = async (action: () => Promise<unknown>) => {
    if (disposed || state.busy) return;
    changed({ busy: true, error: null, restoring: true });
    try { await action(); }
    catch (error) { if (!controller.signal.aborted) fail(error); }
    finally { changed({ busy: false, restoring: false }); }
  };
  const navigate = (snapshot: WorkspaceState) => {
    if (disposed) return;
    if (snapshot.projectTarget && !snapshot.projectTarget.url) {
      changed({ restoring: false });
      return;
    }
    record = { ...record, version: 1, root: snapshot?.project?.root,
      targetId: snapshot?.projectTarget?.targetId };
    if (!snapshot.projectTarget?.url) return;
    save(window, record);
    return (async () => {
      await navigateDocument(projectSessionUrl(snapshot.projectTarget!.url!, record), { signal: controller.signal });
      if (disposed) return;
      // Embedded documents retain this Shell. Do not admit viewport commands before Engine readiness.
      const targetId = snapshot.projectTarget!.targetId;
      await new Promise<void>((resolve, reject) => {
        let remove = () => {};
        const finish = (error?: Error) => { remove(); controller.signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
        const cancel = () => finish(new Error('Project attachment cancelled'));
        const check = (current: WorkspaceState) => {
          if (current.projectTarget?.targetId !== targetId) return;
          if (current.projectPhase === 'running' || current.projectPhase === undefined) finish();
          else if (current.projectPhase === 'failed' || current.workspaceTargetLost) finish(new Error('Engine target startup failed; inspect its diagnostics before reconnecting'));
        };
        remove = client.subscribe(check);
        controller.signal.addEventListener('abort', cancel, { once: true });
        void client.getState({ signal: controller.signal }).then(current => {
          // A legacy provider without phase evidence settles immediately.
          if (current.projectPhase === undefined) finish(); else check(current);
        }, error => finish(error instanceof Error ? error : new Error(String(error))));
        if (controller.signal.aborted) cancel();
      });
    })();
  };
  const recover = async () => {
    const snapshot = await client.getState({ signal: controller.signal });
    accept(snapshot);
    const expectedTargetId = pageTarget ?? record?.targetId;
    if (!expectedTargetId || snapshot.projectTarget?.targetId !== expectedTargetId)
      throw new Error('The project changed in another page. Open the current View entry and choose a project explicitly.');
    return navigate(await client.reopenProject({ ...options, expectedTargetId, expectedTargetState: 'lost' }));
  };
  const open = (root: string) => run(async () => {
    openedIntent = true;
    const snapshot = await client.getState({ signal: controller.signal });
    accept(snapshot);
    if (snapshot.project) {
      if (snapshot.project.root !== root) throw new Error('Another project is already open. Close it explicitly before opening a different project.');
      record = { ...record, version: 1, root, targetId: snapshot.projectTarget?.targetId };
      if (!snapshot.projectTarget?.url) return;
      await recover();
      return;
    }
    record = { version: 1, root, entry: url ? url.origin + url.pathname : undefined };
    return navigate(await client.openProject(root, { ...options, expectedTargetId: null }));
  });
  const reconnect = () => run(recover);
  const stop = client.subscribe(accept);
  const probeEntry = async () => {
    if (!record?.entry || disposed) return;
    changed({ busy: true, error: null, restoring: true });
    for (const delay of [0, 250, 500, 1000, 2000, 4000]) {
      await new Promise<void>(resolve => {
        cancelDelay = resolve;
        retryTimer = setTimeout(resolve, delay);
      });
      cancelDelay = undefined;
      if (disposed) return;
      try {
        const response = await window.fetch(new URL('/__forgeax/view/health', record.entry), {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
        });
        if (!response.ok) throw new Error('View entry is unavailable');
        if (!disposed) {
          const destination = projectSessionUrl(record.entry, record);
          await navigateDocument(destination, { signal: controller.signal, replace: true });
        }
        return;
      } catch (error) { if (disposed) return; }
    }
    fail(new Error('View is unavailable. Start or reconnect the backend and View, then retry.'));
  };
  const returnToEntry = () => reconnecting ??= probeEntry().finally(() => { reconnecting = undefined; });
  const disconnect = pageTarget ? client.onDisconnect?.(error => {
    if (/stopped|stopping|unauthorized|forbidden|incompatible/i.test(error?.message ?? '')) {
      fail(error);
    } else void returnToEntry();
  }) : undefined;
  const ready = (async () => {
    if (!url) return;
    if (url.hash.includes(HASH)) {
      save(window, record);
      url.hash = '';
      window.history?.replaceState(null, '', url.href);
    }
    // Refresh keeps this document. The project server and its catalog stay up;
    // the replacement browser reports ready and the shell leaves `restoring`.
    // Do not reopen the project or replay the previous page's resource history.
    if (pageTarget && navigation?.type === 'reload') {
      const snapshot = await client.getState({ signal: controller.signal });
      accept(snapshot);
      return;
    }
    const snapshot = await client.getState({ signal: controller.signal });
    accept(snapshot);
    if (!pageTarget) {
      if (explicitRoot) await open(explicitRoot);
      else if (record?.root && record?.targetId) await reconnect();
      else if (snapshot.projectIntent?.root) await open(snapshot.projectIntent.root);
      // A project remote-opened before this page loaded leaves no explicit
      // intent and no remembered target here; the post-initialization accept
      // below adopts its headed document.
      return;
    }
  })().catch(fail).finally(() => { initializing = false; accept(state.snapshot); });
  return {
    ready, open, reconnect,
    reconnectHost: returnToEntry,
    getSnapshot: () => state,
    subscribe(listener: (state: ProjectSessionState) => void) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    dispose() {
      disposed = true;
      controller.abort();
      clearTimeout(retryTimer);
      cancelDelay?.();
      disconnect?.();
      stop();
      listeners.clear();
    },
  };
}
