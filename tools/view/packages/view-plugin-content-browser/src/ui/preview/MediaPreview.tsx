import {
  isBrowserMediaPreviewKind,
  isFontPreviewInfo,
  mediaPreviewBlockedReason,
  svgMarkupSrc,
} from './media-preview-policy';
import type { PreviewFileInfo } from '../types';

export function MediaPreview({
  info,
  fileName,
  t,
}: {
  info: PreviewFileInfo;
  fileName: string;
  t: (key: string) => string;
}) {
  if (isFontPreviewInfo(info)) {
    return <FontPreview info={info} sample={fileName} t={t} />;
  }
  if (!isBrowserMediaPreviewKind(info.kind)) {
    return <div className="cb-preview-note">{t('contentBrowser.preview.noMediaPreview')}</div>;
  }

  const blocked = mediaPreviewBlockedReason(info);
  if (blocked === 'too-large') {
    return <div className="cb-preview-note">{t('contentBrowser.preview.previewTooLarge')}</div>;
  }
  if (blocked === 'unavailable') {
    return <div className="cb-preview-note">{t('contentBrowser.preview.noMediaPreview')}</div>;
  }

  const src = info.dataUrl ?? (info.content ? svgMarkupSrc(info.content) : undefined);
  if (!src) {
    return <div className="cb-preview-note">{t('contentBrowser.preview.noMediaPreview')}</div>;
  }

  if (info.kind === 'audio') {
    return (
      <div className="cb-preview-media">
        <audio className="cb-preview-audio" controls preload="metadata" src={src} aria-label={fileName} />
      </div>
    );
  }
  if (info.kind === 'video') {
    return (
      <div className="cb-preview-media">
        <video className="cb-preview-video" controls preload="metadata" src={src} aria-label={fileName} />
      </div>
    );
  }
  return (
    <div className="cb-preview-media">
      <img className="cb-preview-image" src={src} alt={fileName} decoding="async" />
    </div>
  );
}

function FontPreview({
  info,
  sample,
  t,
}: {
  info: PreviewFileInfo;
  sample: string;
  t: (key: string) => string;
}) {
  const blocked = mediaPreviewBlockedReason(info);
  if (blocked === 'too-large') {
    return <div className="cb-preview-note">{t('contentBrowser.preview.previewTooLarge')}</div>;
  }
  if (!info.dataUrl) {
    return <div className="cb-preview-note">{t('contentBrowser.preview.noMediaPreview')}</div>;
  }
  const fontId = `cb-preview-font-${info.path.replace(/[^\w-]+/g, '-')}`;
  return (
    <div className="cb-preview-media cb-preview-font">
      <style>{`@font-face{font-family:${fontId};src:url(${info.dataUrl});font-display:swap;}`}</style>
      <p className="cb-preview-font-sample" style={{ fontFamily: fontId }}>
        {t('contentBrowser.preview.fontSample')}
      </p>
      <p className="cb-preview-font-meta">{sample}</p>
    </div>
  );
}
