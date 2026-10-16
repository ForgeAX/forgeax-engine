import { useEffect, useRef } from 'react';
import { ErrorNoticeHost, showErrorNotice } from '@forgeax/view-components';
import {
  formatWorkspaceCommandError,
  subscribeWorkspaceCommandErrors,
} from '@forgeax/view-workspace-core/command-error';
import { useTranslation } from '../i18n';

function noticeKey(formatted: { code?: string; description: string }, operation?: string) {
  return `${operation ?? ''}|${formatted.code ?? ''}|${formatted.description}`;
}

function formatErrorCopyText(
  formatted: {
    code?: string;
    description: string;
    hint?: string;
    detailsText?: string;
  },
  operation?: string,
) {
  const lines: string[] = [];
  if (operation) lines.push(`operation: ${operation}`);
  if (formatted.code) lines.push(`code: ${formatted.code}`);
  lines.push(`description: ${formatted.description}`);
  if (formatted.hint) lines.push(`hint: ${formatted.hint}`);
  if (formatted.detailsText) {
    if (lines.length > 0) lines.push('');
    lines.push(formatted.detailsText);
  }
  return lines.join('\n');
}

export function WorkspaceCommandErrorHost() {
  const { t } = useTranslation();
  const openKeys = useRef(new Set<string>());

  useEffect(() => {
    return subscribeWorkspaceCommandErrors((error: unknown, context: { operation?: string } = {}) => {
      const formatted = formatWorkspaceCommandError(error);
      const operation = typeof context?.operation === 'string' ? context.operation : undefined;
      const key = noticeKey(formatted, operation);
      if (openKeys.current.has(key)) return;
      openKeys.current.add(key);
      showErrorNotice({
        title: operation
          ? t('view.commandError.titleWithOperation', { operation })
          : t('view.commandError.title'),
        code: formatted.code,
        description: formatted.description,
        hint: formatted.hint,
        details: formatted.detailsText,
        detailsLabel: t('view.commandError.details'),
        copyText: formatErrorCopyText(formatted, operation),
        copyLabel: t('view.commandError.copy'),
        copiedLabel: t('view.commandError.copied'),
        closeLabel: t('view.commandError.close'),
        persistent: true,
        onDismiss: () => {
          openKeys.current.delete(key);
        },
      });
    });
  }, [t]);

  return <ErrorNoticeHost />;
}
