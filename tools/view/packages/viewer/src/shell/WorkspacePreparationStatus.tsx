import { IconButton } from '@forgeax/view-components';
import { createWorkspaceStateReader, type WorkspaceStateClient } from '@forgeax/view-workspace-core/workspace-state';
import { AlertTriangle, Check, ChevronDown, ChevronUp, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../i18n';
import type { HostConnection } from './HostConnectionIndicator';

/** Shell-owned feedback remains visible before the project document exists. */
export function WorkspacePreparationStatus({ client, connection }: {
  client?: WorkspaceStateClient;
  connection: HostConnection;
}) {
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const status = workspace?.projectStatus;
  const progress = status?.preparation;
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(Date.now);
  const connected = connection.phase === 'connected';
  const active = status?.phase !== 'failed' && progress !== undefined && progress.operation !== 'scene-connection'
    && !['ready', 'failed', 'cancelled'].includes(progress.stage);
  const clockActive = connected && active;
  const visible = status !== undefined && status !== null && (
    status.phase === 'preparing' || status.phase === 'starting' || status.phase === 'failed' || active
  );

  useEffect(() => () => reader.dispose(), [reader]);
  useEffect(() => { setExpanded(true); }, [status?.sessionId]);
  useEffect(() => {
    if (!visible || !clockActive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, clockActive, status?.sessionId]);

  if (!visible || !status || progress?.stage === 'cancelled') return null;
  const failed = status.phase === 'failed' || progress?.stage === 'failed';
  const stage = !connected ? 'offline' : failed ? 'failed' : progress?.stage === 'ready' || progress?.operation === 'scene-connection' || (!progress && status.phase === 'starting')
    ? 'connecting' : progress?.stage ?? 'preparing';
  const elapsed = progress && (active || failed) ? Math.max(0, Math.floor(((
    clockActive ? now : progress.updatedAt
  ) - progress.startedAt) / 1000)) : undefined;
  const failure = status.phase === 'failed' ? status.failure : undefined;
  const failureReason = typeof failure?.detail?.reason === 'string' ? failure.detail.reason : undefined;
  const failureMessages = [...new Set([failure?.expected, failure?.hint, failureReason])]
    .filter((message): message is string => typeof message === 'string' && message.length > 0);
  const tasks = progress?.active ?? [];
  const title = t(`view.preparation.${stage}`);
  const operation = progress?.operation ? t(`view.preparation.operation.${progress.operation}`) : t('view.preparation.waiting');

  return (
    <aside className="fx-workspace-preparation" data-failed={failed || undefined}
      data-expanded={expanded}
      data-active={connected && active || undefined} aria-label={t('view.preparation.label')}>
      <div className="fx-workspace-preparation__header">
        {failed ? <AlertTriangle className="fx-icon" aria-hidden /> : <LoaderCircle className="fx-icon fx-workspace-preparation__spinner" aria-hidden />}
        <span className="fx-workspace-preparation__title" role="status" aria-live="polite" title={title}>{title}</span>
        {elapsed !== undefined && <span className="fx-workspace-preparation__elapsed">{t('view.preparation.elapsed', { seconds: elapsed })}</span>}
        <IconButton variant="quiet" size="compact" label={t(expanded ? 'view.preparation.collapse' : 'view.preparation.expand')}
          icon={expanded ? <ChevronDown className="fx-icon" /> : <ChevronUp className="fx-icon" />}
          onClick={() => setExpanded(!expanded)} aria-expanded={expanded} />
      </div>
      {expanded && <div className="fx-workspace-preparation__body">
      {tasks[0] && <div className="fx-workspace-preparation__current" title={tasks[0].source}>
        <span>{t(`view.preparation.task.${tasks[0].phase}`)}</span> {tasks[0].source}
      </div>}
      {!tasks[0] && <div className="fx-workspace-preparation__current">{operation}</div>}
      {tasks[0]?.progress && <div className="fx-workspace-preparation__count">
        {t('view.preparation.variants', tasks[0].progress)}
      </div>}
      {progress && progress.activeCount > 1 && <div className="fx-workspace-preparation__count">
        {t('view.preparation.active', { count: progress.activeCount })}
      </div>}
      {failure && <div className="fx-workspace-preparation__failure">
        {failureMessages.map(message => <p key={message}>{message}</p>)}
      </div>}
      <div className="fx-workspace-preparation__details">
        {tasks.map(task => <div className="fx-workspace-preparation__task" key={task.source}>
          <span>{t(`view.preparation.task.${task.phase}`)}</span><span>{task.source}</span>
        </div>)}
        {(progress?.recent ?? []).map(task => <div className="fx-workspace-preparation__task" key={task.source}>
          <Check className="fx-icon" aria-hidden /><span>{task.source}</span>
          {task.cacheHit && <span>{t('view.preparation.cached')}</span>}
        </div>)}
        {failure && <code>{failure.code}</code>}
      </div>
      </div>}
    </aside>
  );
}
