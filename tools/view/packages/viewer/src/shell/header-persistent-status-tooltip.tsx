import { IconButton, Tooltip } from '@forgeax/view-components';
import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { useTranslation } from '../i18n';

export function HeaderPersistentStatusTooltip({
  title,
  description,
  action,
  statusAriaLabel,
  resetKey,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  statusAriaLabel: string;
  /** When this value changes, the banner opens again. */
  resetKey?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setOpen(true);
  }, [resetKey]);

  if (!open) {
    return (
      <div className="fx-view-header__connection-status">
        <Tooltip
          placement="bottom"
          portaled
          title={title}
          description={description}
        >
          <span
            className="fx-view-header__status-slot"
            role="status"
            aria-live="polite"
            aria-label={statusAriaLabel}
            tabIndex={0}
          >
            {children}
          </span>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="fx-view-header__connection-status">
      <Tooltip
        open
        placement="bottom"
        portaled
        content={(
          <div className="fx-tooltip__content">
            <div className="fx-tooltip__header">
              <div className="fx-tooltip__title">{title}</div>
              <IconButton
                className="fx-tooltip__close"
                variant="quiet"
                size="compact"
                label={t('view.close')}
                icon={<X className="fx-icon" aria-hidden />}
                onClick={() => setOpen(false)}
              />
            </div>
            {description != null && description !== '' ? (
              <div className="fx-tooltip__description">{description}</div>
            ) : null}
            {action ? <div className="fx-tooltip__actions">{action}</div> : null}
          </div>
        )}
      >
        <span
          className="fx-view-header__status-slot"
          role="status"
          aria-live="polite"
          aria-label={statusAriaLabel}
          tabIndex={0}
        >
          {children}
        </span>
      </Tooltip>
    </div>
  );
}
