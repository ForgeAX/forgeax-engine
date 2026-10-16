import { IconButton } from '@forgeax/view-components';
import { enableViewTrace, downloadViewTraceTxtFile } from '@forgeax/view-workspace-core/view-trace';
import { FileDown } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from '../i18n';

export function ViewTraceExportButton() {
  const { t } = useTranslation();

  useEffect(() => {
    enableViewTrace();
  }, []);

  return (
    <IconButton
      variant="quiet"
      size="compact"
      label={t('view.traceExport')}
      title={t('view.traceExportHint')}
      icon={<FileDown className="fx-icon" aria-hidden />}
      onClick={() => {
        downloadViewTraceTxtFile();
      }}
    />
  );
}
