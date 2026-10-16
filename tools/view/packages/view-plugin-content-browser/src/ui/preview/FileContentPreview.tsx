import type { CBFile, PreviewFileInfo } from '../types';
import { familySuggestsEnginePreview, familySuggestsMediaPreview, isBrowserMediaPreviewKind, isFontPreviewInfo } from './media-preview-policy';
import { MediaPreview } from './MediaPreview';
import { CodePreview } from './CodePreview';
import { resolveLanguage } from './ext-language';

export function FileContentPreview({
  file,
  previewInfo,
  status,
  pendingRemote,
  t,
}: {
  file: CBFile;
  previewInfo: PreviewFileInfo | null;
  status: 'idle' | 'loading' | 'ready';
  pendingRemote?: boolean;
  t: (key: string) => string;
}) {
  if (status === 'loading' || pendingRemote) {
    return <div className="cb-preview-note">{t('contentBrowser.preview.loadingSource')}</div>;
  }

  if (previewInfo && (isBrowserMediaPreviewKind(previewInfo.kind) || isFontPreviewInfo(previewInfo))) {
    return <MediaPreview info={previewInfo} fileName={file.name} t={t} />;
  }
  if (previewInfo?.kind === 'model' || familySuggestsEnginePreview(file.family)) {
    return <div className="cb-preview-note">{t('contentBrowser.preview.previewEngineRequired')}</div>;
  }
  if (!previewInfo && familySuggestsMediaPreview(file.family)) {
    return <div className="cb-preview-note">{t('contentBrowser.preview.noMediaPreview')}</div>;
  }

  const content = previewInfo?.content ?? file.sourcePreview;
  if (content == null) {
    return <div className="cb-preview-note">{t('contentBrowser.preview.noTextPreview')}</div>;
  }
  const dotIndex = file.name.lastIndexOf('.');
  const ext = dotIndex >= 0 ? file.name.slice(dotIndex + 1).toLowerCase() : '';
  if (resolveLanguage(ext)) {
    return (
      <CodePreview
        name={file.name}
        ext={ext}
        size={previewInfo?.size ?? file.estimatedSize ?? 0}
        content={content}
      />
    );
  }
  return (
    <pre className="cb-preview-source">
      <code>{content}</code>
    </pre>
  );
}
