import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { Button, Dialog, Field, Text, TextInput } from '@forgeax/view-components';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';

import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import {
  adoptRemoteWorkspaceProject,
  reopenWorkspaceProject,
  navigateToWorkspaceProjectTarget,
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
export type WorkspaceRecoveryClient = Pick<ViewWorkspaceClient, 'projectSession' | 'subscribe' | 'getState' | 'reopenProject' | 'openProject' | 'listAssets'>;

const EMPTY_PROJECT_SESSION = { snapshot: {}, busy: false, error: null, restoring: false } as const;

export function useProjectSessionState(client?: WorkspaceRecoveryClient) {
  const session = client?.projectSession;
  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => {}), [session]);
  const getSnapshot = useCallback(() => session?.getSnapshot() ?? EMPTY_PROJECT_SESSION, [session]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PROJECT_SESSION);
}

function useWorkspaceRecovery(client?: WorkspaceRecoveryClient, { adoptRemote = false } = {}) {
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

  // A project opened outside this page (for example `view project open`) is
  // adopted here for clients without a projectSession projection; the
  // projectSession path adopts through its own record-preserving navigation.
  // This hook stays mounted while the dialog branch returns null, so the
  // effect still runs after a remote open.
  useEffect(() => {
    if (!adoptRemote || client?.projectSession) return;
    adoptRemoteWorkspaceProject(snapshot);
  }, [adoptRemote, client, snapshot]);

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
      await reopenWorkspaceProject(client, { tabId: VIEW_WORKSPACE_TAB_ID, window: globalThis });
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
      .then(state => navigateToWorkspaceProjectTarget(state))
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

const PROJECT_OPEN_FORM_ID = 'fx-view-project-open';

export function WorkspaceProjectRecovery({ client, required }: { client: WorkspaceRecoveryClient; required: boolean }) {
  const { t } = useTranslation();
  const {
    snapshot,
    visible,
    busy,
    error,
    restoring,
    projectRoot,
    setProjectRoot,
    onOpenProject,
  } = useWorkspaceRecovery(client, { adoptRemote: true });
  const inputRef = useRef<HTMLInputElement>(null);
  const pathId = useId();
  const descriptionId = useId();

  if ((!required && !error) || (restoring && busy && !error) ||
      (snapshot.project?.root && (!error || !visible)) || !client.openProject) return null;

  return (
    <Dialog
      open
      modal={false}
      dismissible={false}
      className="fx-view-project-open"
      title={t('view.projectOpen.title')}
      initialFocusRef={inputRef}
      footer={(
        <Button
          form={PROJECT_OPEN_FORM_ID}
          type="submit"
          variant="primary"
          loading={busy}
          disabled={busy || !projectRoot.trim()}
        >
          {busy ? t('view.projectOpen.busy') : t('view.projectOpen.action')}
        </Button>
      )}
    >
      <form id={PROJECT_OPEN_FORM_ID} onSubmit={onOpenProject}>
        <Text id={descriptionId} variant="body" tone="secondary">
          {t('view.projectOpen.description')}
        </Text>
        <Field label={t('view.projectOpen.pathLabel')} htmlFor={pathId} error={error}>
          <TextInput
            id={pathId}
            ref={inputRef}
            value={projectRoot}
            placeholder={t('view.projectOpen.pathPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={descriptionId}
            onChange={(event) => setProjectRoot(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
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
