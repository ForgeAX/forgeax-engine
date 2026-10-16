import { Button, Tooltip } from '@forgeax/view-components';
import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';

import { useTranslation } from '../i18n';
import { sanitizeHostConnectionDetail } from './host-connection-detail';
import { HeaderPersistentStatusTooltip } from './header-persistent-status-tooltip';

export type HostConnectionPhase = 'connecting' | 'connected' | 'unconfigured' | 'disconnected';

export type HostConnection = {
  phase: HostConnectionPhase;
  detail?: string;
  onReconnect?: () => void;
  reconnectBusy?: boolean;
};

function connectionClasses(phase: HostConnectionPhase) {
  const variant =
    phase === 'disconnected' || phase === 'unconfigured' ? 'failed' : phase;
  return `fx-view-header__status-dot fx-view-header__status-dot--${variant}`;
}

function HostReconnectButton({ connection }: { connection: HostConnection }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="secondary"
      size="compact"
      disabled={connection.reconnectBusy}
      leadingIcon={<RefreshCw className="fx-icon" aria-hidden />}
      onClick={() => connection.onReconnect?.()}
    >
      {connection.reconnectBusy ? t('view.connection.retryBusy') : t('view.connection.retry')}
    </Button>
  );
}

export function HostConnectionAnchoredStatus({ connection }: { connection: HostConnection }) {
  const { t } = useTranslation();
  const detail = sanitizeHostConnectionDetail(connection.detail);
  const unconfigured = connection.phase === 'unconfigured';
  const tooltipBody = detail ?? (unconfigured
    ? t('view.connection.unconfigured')
    : t('view.hostConnection.failedHint'));
  const title = unconfigured
    ? t('view.hostConnection.unconfiguredTitle')
    : t('view.hostConnection.notConnected');

  return (
    <HeaderPersistentStatusTooltip
      resetKey={`${connection.phase}:${connection.detail ?? ''}`}
      statusAriaLabel={unconfigured ? t('view.hostConnection.unconfiguredTitle') : t('view.hostConnection.failed')}
      title={title}
      description={tooltipBody}
      action={unconfigured ? undefined : <HostReconnectButton connection={connection} />}
    >
      <span className={connectionClasses(connection.phase)} aria-hidden />
    </HeaderPersistentStatusTooltip>
  );
}

export function HostConnectionIndicator({ connection }: { connection: HostConnection }) {
  const { t } = useTranslation();
  const { ariaLabel, tooltip } = useMemo(() => {
    const detail = sanitizeHostConnectionDetail(connection.detail);
    switch (connection.phase) {
      case 'connecting':
        return {
          ariaLabel: t('view.hostConnection.connecting'),
          tooltip: {
            title: t('view.hostConnection.connecting'),
            body: t('view.hostConnection.connectingHint'),
          },
        };
      case 'connected':
        return {
          ariaLabel: t('view.hostConnection.connected'),
          tooltip: {
            title: t('view.hostConnection.connected'),
            body: t('view.hostConnection.connectedHint'),
          },
        };
      case 'disconnected':
        return {
          ariaLabel: t('view.hostConnection.failed'),
          tooltip: {
            title: t('view.hostConnection.notConnected'),
            body: detail ?? t('view.hostConnection.failedHint'),
          },
        };
      case 'unconfigured':
        return {
          ariaLabel: t('view.hostConnection.unconfiguredTitle'),
          tooltip: {
            title: t('view.hostConnection.unconfiguredTitle'),
            body: detail ?? t('view.connection.unconfigured'),
          },
        };
    }
  }, [connection.detail, connection.phase, t]);

  return (
    <Tooltip
      placement="bottom"
      portaled
      title={tooltip.title}
      description={tooltip.body}
    >
      <span
        className="fx-view-header__status-slot"
        role="status"
        aria-live="polite"
        aria-label={ariaLabel}
        tabIndex={0}
      >
        <span className={connectionClasses(connection.phase)} aria-hidden />
      </span>
    </Tooltip>
  );
}
