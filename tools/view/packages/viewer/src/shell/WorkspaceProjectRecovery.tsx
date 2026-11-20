import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { Button, Dialog, Field, Text, TextInput } from '@forgeax/view-components';
import { RefreshCw, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';

import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import {
  reopenWorkspaceProject,
  shouldOfferWorkspaceRecovery,
} from '@forgeax/view-workspace-core/workspace-recovery';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';

import { useTranslation } from '../i18n';
import { HeaderPersistentStatusTooltip } from './header-persistent-status-tooltip';
import {
  HostConnectionAnchoredStatus,
  HostConnectionIndicator,
  type HostConnection,
} from './HostConnectionIndicator';

export type WorkspaceSnapshot = WorkspaceState;
export type WorkspaceRecoveryClient = Pick<ViewWorkspaceClient, 'projectSession' | 'subscribe' | 'getState' | 'reopenProject' | 'openProject' | 'listAssets' | 'listProjects' | 'browseProjects' | 'registerProject'>;

const EMPTY_PROJECT_SESSION = { snapshot: {}, busy: false, error: null, restoring: false } as const;

export function useProjectSessionState(client?: WorkspaceRecoveryClient) {
  const session = client?.projectSession;
  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => {}), [session]);
  const getSnapshot = useCallback(() => session?.getSnapshot() ?? EMPTY_PROJECT_SESSION, [session]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PROJECT_SESSION);
}

function useWorkspaceRecovery(client?: WorkspaceRecoveryClient) {
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const snapshot = (useSyncExternalStore(
    reader.subscribe,
    reader.getSnapshot,
    reader.getSnapshot,
  ) ?? {}) as WorkspaceSnapshot;
  const sessionState = useProjectSessionState(client);
  const [localBusy, setBusy] = useState(false);
  const [localError, setError] = useState<string | null>(null);
  const busy = client?.projectSession ? sessionState.busy : localBusy;
  const error = client?.projectSession ? sessionState.error : localError;
  const [staleTarget, setStaleTarget] = useState(false);
  const [projectRoot, setProjectRoot] = useState(() => globalThis.location
    ? new URL(globalThis.location.href).searchParams.get('project') ?? '' : '');

  useEffect(() => () => reader.dispose(), [reader]);

  useEffect(() => {
    if (!client || client.projectSession) return;
    if (snapshot.workspaceTargetLost === true) {
      setStaleTarget(false);
      return;
    }
    const projectId = snapshot.project?.id;
    const root = snapshot.project?.root;
    if (!projectId || !root || typeof client.listAssets !== 'function') return;
    let cancelled = false;
    void client
      .listAssets(projectId, { tabId: VIEW_WORKSPACE_TAB_ID })
      .catch((caught) => {
        if (!cancelled && shouldOfferWorkspaceRecovery(caught)) setStaleTarget(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, snapshot.project?.id, snapshot.project?.root, snapshot.workspaceTargetLost]);

  const visible =
    typeof snapshot.project?.root === 'string'
    && (snapshot.workspaceTargetLost === true || staleTarget || (
      !client?.projectSession && snapshot.projectTarget?.url && globalThis.location
      && snapshot.projectTarget.url.split('#')[0] !== globalThis.location.href.split('#')[0]
    ));

  const onReconnect = useCallback(async () => {
    if (!client || busy) return;
    if (client.projectSession) { await client.projectSession.reconnect(); return; }
    setBusy(true);
    setError(null);
    try {
      await reopenWorkspaceProject(client, { tabId: VIEW_WORKSPACE_TAB_ID });
      setStaleTarget(false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, client]);

  const onOpenProject = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client?.openProject || busy || !projectRoot.trim()) return;
    if (client.projectSession) { void client.projectSession.open(projectRoot.trim()); return; }
    setBusy(true);
    setError(null);
    void client.openProject(projectRoot.trim(), { tabId: VIEW_WORKSPACE_TAB_ID })
      .then(() => setStaleTarget(false))
      .catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false));
  }, [busy, client, projectRoot]);

  return {
    snapshot,
    visible,
    busy,
    error,
    restoring: sessionState.restoring,
    projectRoot,
    setProjectRoot,
    onOpenProject,
    onReconnect,
  };
}

/** One chooser for unbound startup, explicit switching and service recovery. */
export function WorkspaceProjectChooser({ client, connection, launcher, requiresProject }: {
  client?: WorkspaceRecoveryClient;
  connection: HostConnection;
  launcher?: import('../launcher.ts').ViewLauncher;
  requiresProject: boolean;
}) {
  const { t } = useTranslation();
  const { snapshot, busy: sessionBusy, error: sessionError } = useWorkspaceRecovery(client);
  const bound = connection.phase === 'connected' && Boolean(snapshot.project?.root);
  const offline = connection.phase === 'disconnected' || connection.phase === 'unconfigured';
  const [opened, setOpened] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly import('@forgeax/engine/devkit').KnownProjectEntry[]>([]);
  const [listing, setListing] = useState<import('@forgeax/engine/devkit').ProjectDirectoryListing>();
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<'recent' | 'all'>('recent');
  const inputRef = useRef<HTMLInputElement>(null);
  const pathId = useId();
  const show = opened || (requiresProject && ((!bound && connection.phase === 'connected') || (offline && Boolean(launcher))));
  const loading = busy || sessionBusy;
  const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

  useEffect(() => {
    if (!show || connection.phase !== 'connected' || !client) return;
    const abort = new AbortController();
    void client.listProjects({ signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setProjects(result); })
      .catch(cause => { if (!abort.signal.aborted) setError(failure(cause)); });
    return () => abort.abort();
  }, [show, connection.phase, client]);

  useEffect(() => { if (bound && !sessionBusy && !sessionError) setOpened(false); }, [snapshot.project?.root]);

  const browse = async (directory?: string) => {
    if (!client || loading) return;
    setBusy(true); setError(null);
    try { setListing(await client.browseProjects(directory)); }
    catch (cause) { setError(failure(cause)); }
    finally { setBusy(false); }
  };
  const submit = async (projectPath = path) => {
    const selectedPath = projectPath.trim();
    if (loading || (!offline && !selectedPath)) return;
    setBusy(true); setError(null);
    try {
      if (offline) {
        if (!launcher) throw new Error('This View presentation has no backend launcher.');
        await launcher.start(selectedPath || undefined);
        connection.onReconnect?.();
      } else if (client) {
        const project = await client.registerProject(selectedPath);
        if (client.projectSession) await client.projectSession.open(project.root);
        else await client.openProject(project.root, { tabId: VIEW_WORKSPACE_TAB_ID });
        // Session errors remain visible; only an admitted new owner collapses selection.
        const state = client.projectSession?.getSnapshot();
        if (state?.error) throw new Error(state.error);
        setOpened(false); setListing(undefined);
      }
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(false); }
  };
  const visibleProjects = (scope === 'recent' ? projects.slice(0, 8) : projects)
    .filter(project => `${project.name} ${project.root}`.toLowerCase().includes(filter.toLowerCase()));

  return <>
    {bound && <Button variant="secondary" size="compact" leadingIcon={<FolderOpen className="fx-icon" aria-hidden />}
      onClick={() => { setOpened(true); setError(null); setPath(snapshot.project?.root ?? ''); }}>
      {snapshot.project?.name} · {snapshot.projectStatus?.phase ?? snapshot.projectPhase ?? ''}
    </Button>}
    {show && <Dialog open modal={false} dismissible={bound} closeLabel={t('view.close')} onClose={() => { setOpened(false); setListing(undefined); }}
      className="fx-view-project-open" title={offline ? t('view.projectChooser.offlineTitle') : t('view.projectOpen.title')} initialFocusRef={inputRef}>
      <form onSubmit={event => { event.preventDefault(); void submit(); }} onKeyDown={event => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          void submit();
        }
      }}>
        <Text variant="body" tone="secondary">{offline ? t('view.projectChooser.offlineDescription') : t('view.projectChooser.description')}</Text>
        {!offline && <>
          <div className="fx-view-project-chooser__tabs">
            <Button variant={scope === 'recent' ? 'primary' : 'secondary'} size="compact" onClick={() => setScope('recent')}>{t('view.projectChooser.recent')}</Button>
            <Button variant={scope === 'all' ? 'primary' : 'secondary'} size="compact" onClick={() => setScope('all')}>{t('view.projectChooser.all')}</Button>
          </div>
          <TextInput aria-label={t('view.projectChooser.search')} placeholder={t('view.projectChooser.search')} value={filter} onChange={event => setFilter(event.target.value)} />
          <div className="fx-view-project-chooser__list" aria-label={t('view.projectChooser.all')}>
            {visibleProjects.length === 0 && <Text tone="secondary">{t('view.projectChooser.empty')}</Text>}
            {visibleProjects.map(project => <button type="button" key={project.root} disabled={loading || project.availability !== 'available'}
              aria-pressed={path === project.root} onClick={() => setPath(project.root)}
              onDoubleClick={() => void submit(project.root)}
              title={project.availability === 'unavailable' ? `${project.failure.code}: ${project.failure.hint}` : project.root}>
              <strong>{project.name}</strong><span>{project.root}</span>
              {project.availability === 'unavailable' && <span>{t('view.projectChooser.unavailable')} · {project.failure.code}</span>}
            </button>)}
          </div>
        </>}
        <Field label={offline ? t('view.projectChooser.optionalPath') : t('view.projectOpen.pathLabel')} htmlFor={pathId} error={error ?? sessionError}>
          <TextInput id={pathId} ref={inputRef} value={path} placeholder={t('view.projectOpen.pathPlaceholder')}
            autoComplete="off" spellCheck={false} disabled={loading} onChange={event => setPath(event.target.value)} />
        </Field>
        {!offline && <Button variant="secondary" disabled={loading} onClick={() => void browse(path || undefined)}>{t('view.projectChooser.browse')}</Button>}
        {listing && !offline && <div className="fx-view-project-chooser__folders">
          <Text>{listing.path}</Text>
          <Button size="compact" variant="secondary" disabled={loading || !listing.parent} onClick={() => void browse(listing.parent ?? undefined)}>{t('view.projectChooser.parent')}</Button>
          <div className="fx-view-project-chooser__list">
            {listing.directories.map(directory => <button type="button" key={directory.path} disabled={loading} onClick={() => void browse(directory.path)}>
              <span>{directory.name}{directory.hasForgeManifest ? ' · forge.json' : ''}</span>
            </button>)}
          </div>
          <Button variant="secondary" disabled={loading} onClick={() => { setPath(listing.path); setListing(undefined); }}>{t('view.projectChooser.chooseFolder')}</Button>
        </div>}
        <div className="fx-view-project-chooser__actions">
          {bound && <Button variant="secondary" disabled={loading} onClick={() => setOpened(false)}>{t('view.projectChooser.cancel')}</Button>}
          <Button type="button" onClick={() => void submit()} variant="primary" loading={loading} disabled={loading || (!offline && !path.trim())}>
            {offline ? t('view.projectChooser.start') : t('view.projectChooser.next')}
          </Button>
        </div>
      </form>
    </Dialog>}
  </>;
}

export function HeaderConnectionStatus({
  connection,
  workspaceClient,
}: {
  connection: HostConnection;
  workspaceClient?: WorkspaceRecoveryClient;
}) {
  const { t } = useTranslation();
  const { visible, busy, error, restoring, onReconnect } = useWorkspaceRecovery(workspaceClient);

  if (connection.phase === 'disconnected' || connection.phase === 'unconfigured') {
    return <HostConnectionAnchoredStatus connection={connection} />;
  }

  if (restoring && !error) {
    return (
      <HeaderPersistentStatusTooltip
        resetKey="workspace-restoring"
        statusAriaLabel={t('view.projectRecovery.restoringTitle')}
        title={t('view.projectRecovery.restoringTitle')}
        description={t('view.projectRecovery.restoringDescription')}
      >
        <span className="fx-view-header__status-dot fx-view-header__status-dot--connecting" aria-hidden />
      </HeaderPersistentStatusTooltip>
    );
  }

  if (visible || error) {
    const reconnectButton = (
      <Button
        variant="secondary"
        size="compact"
        disabled={busy}
        leadingIcon={<RefreshCw className="fx-icon" aria-hidden />}
        onClick={() => void onReconnect()}
      >
        {busy ? t('view.projectRecovery.busy') : t('view.projectRecovery.action')}
      </Button>
    );

    return (
      <HeaderPersistentStatusTooltip
        resetKey={error ?? 'workspace-recovery'}
        statusAriaLabel={t('view.projectRecovery.short')}
        title={error ?? t('view.projectRecovery.short')}
        description={error ? undefined : t('view.projectRecovery.description')}
        action={visible ? reconnectButton : undefined}
      >
        <span className="fx-view-header__status-dot fx-view-header__status-dot--failed" aria-hidden />
      </HeaderPersistentStatusTooltip>
    );
  }

  return <HostConnectionIndicator connection={connection} />;
}
