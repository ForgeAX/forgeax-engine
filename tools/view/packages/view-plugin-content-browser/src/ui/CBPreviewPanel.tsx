import { X } from 'lucide-react';
import { IconButton } from '@forgeax/view-components';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n/useTranslation';
import { dirOfPath, fileSupportsDualPreview, resolveDualPreviewFile } from './format';
import { itemIcon } from './icons';
import { assetKindLabel, fileKindLabel } from './derived-view';
import { FileContentPreview } from './preview/FileContentPreview';
import { ResizeHandle } from './resize-handle';
import type { CBAsset, CBFile, CBFilePreviewMode, CBFolder, CBViewItem, PreviewFileInfo } from './types';
import type { WorkspaceThumbnail } from '@forgeax/view-workspace-core/contract';
import type { ContentBrowserDetailContribution } from '@forgeax/view-workspace-core/frontend-contract';
import { mountDetailTabContribution } from '../detail-tab-mount.ts';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';

type DetailTab = { contribution: ContentBrowserDetailContribution; sourcePath: string };

export function CBPreviewPanel({
  previewItem,
  thumbnail,
  foldersInPath,
  diskFiles,
  projectLabel,
  readPreview,
  onOpenAsset,
  onClose,
  onDrag,
  onDragEnd,
  detailTabs = [],
  client,
  addConversationReference,
}: {
  previewItem: CBViewItem | null;
  thumbnail?: WorkspaceThumbnail;
  foldersInPath: CBFolder[];
  diskFiles: CBFile[];
  projectLabel: string;
  readPreview?: (path: string, options?: { signal?: AbortSignal }) => Promise<PreviewFileInfo | null>;
  onOpenAsset?: (asset: CBAsset) => void;
  onClose: () => void;
  onDrag: (delta: number) => void;
  onDragEnd: () => void;
  detailTabs?: readonly DetailTab[];
  client?: ViewWorkspaceClient;
  addConversationReference?: (reference: { title: string; text: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [filePreviewMode, setFilePreviewMode] = useState<CBFilePreviewMode>('assets');
  const [authoringOpen, setAuthoringOpen] = useState(false);
  const [detailTabId, setDetailTabId] = useState<string | null>(null);
  const [detailTabError, setDetailTabError] = useState('');
  const detailMount = useRef<HTMLDivElement | null>(null);
  const [previewInfo, setPreviewInfo] = useState<PreviewFileInfo | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const dualPreviewFile = previewItem ? resolveDualPreviewFile(previewItem, diskFiles) : undefined;
  const showDualPreview = dualPreviewFile !== undefined && fileSupportsDualPreview(dualPreviewFile);
  const previewKey = previewItem ? (previewItem.type === 'asset' ? previewItem.guid : previewItem.path) : null;
  const previewSourcePath = dualPreviewFile?.diskPath || dualPreviewFile?.path || null;
  const defaultDetailTabId = detailTabs[0]?.contribution.id ?? null;
  const dualAssetCount = dualPreviewFile?.assets.length ?? 0;
  const dualSupportsPreview = dualPreviewFile ? fileSupportsDualPreview(dualPreviewFile) : false;
  const embeddedSourcePreview = dualPreviewFile?.sourcePreview ?? null;
  const canReadPreview = typeof readPreview === 'function';

  useEffect(() => {
    setFilePreviewMode('assets');
    setAuthoringOpen(defaultDetailTabId !== null);
    setDetailTabId(defaultDetailTabId);
  }, [previewKey, defaultDetailTabId]);

  const activeDetailTab = detailTabs.find(tab => tab.contribution.id === detailTabId);
  useEffect(() => {
    if (!authoringOpen || !activeDetailTab || !client || !detailMount.current) return undefined;
    setDetailTabError('');
    return mountDetailTabContribution(detailMount.current, activeDetailTab.contribution, {
      client,
      sourcePath: activeDetailTab.sourcePath,
      addConversationReference,
    }, error => setDetailTabError(error instanceof Error ? error.message : String(error)));
  }, [activeDetailTab?.contribution, activeDetailTab?.sourcePath, addConversationReference, authoringOpen, client]);
  useEffect(() => {
    if (authoringOpen && !detailTabs.some(tab => tab.contribution.id === detailTabId)) {
      setDetailTabId(defaultDetailTabId);
      setAuthoringOpen(defaultDetailTabId !== null);
    }
  }, [authoringOpen, defaultDetailTabId, detailTabId, detailTabs]);

  useEffect(() => {
    if (!previewSourcePath) {
      setPreviewInfo(null);
      setPreviewStatus('idle');
      return;
    }
    const needsSource = dualAssetCount === 0
      || (dualSupportsPreview && filePreviewMode === 'source');
    if (!needsSource) {
      setPreviewInfo(null);
      setPreviewStatus('idle');
      return;
    }
    if (embeddedSourcePreview != null && !canReadPreview) {
      setPreviewInfo({
        path: dualPreviewFile?.path ?? previewSourcePath,
        kind: 'text',
        mime: 'text/plain; charset=utf-8',
        size: dualPreviewFile?.estimatedSize ?? embeddedSourcePreview.length,
        mtime: dualPreviewFile?.packModifiedAt ?? 0,
        content: embeddedSourcePreview,
      });
      setPreviewStatus('ready');
      return;
    }
    if (!canReadPreview || !readPreview) {
      setPreviewInfo(null);
      setPreviewStatus('ready');
      return;
    }
    let cancelled = false;
    setPreviewInfo(null);
    setPreviewStatus('loading');
    const controller = new AbortController();
    void readPreview(previewSourcePath, { signal: controller.signal })
      .then((info) => {
        if (cancelled) return;
        setPreviewInfo(info);
        setPreviewStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewInfo(null);
        setPreviewStatus('ready');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    canReadPreview,
    dualAssetCount,
    dualSupportsPreview,
    embeddedSourcePreview,
    filePreviewMode,
    previewSourcePath,
    readPreview,
  ]);

  if (!previewItem) {
    return (
      <>
        <ResizeHandle onDrag={onDrag} onDragEnd={onDragEnd} title={t('contentBrowser.actions.resizePreview')} />
        <aside className="cb-preview-panel cb-preview-empty">
          <div className="cb-preview-body">
            <div className="cb-preview-note">{t('contentBrowser.preview.nothingSelected')}</div>
          </div>
        </aside>
      </>
    );
  }

  const Icon = itemIcon(previewItem, true);
  const meta = previewItem.type === 'folder'
    ? t('contentBrowser.preview.folderMeta', { path: previewItem.path || projectLabel })
    : previewItem.type === 'file'
      ? t('contentBrowser.preview.fileMeta', { kind: previewItem.kindLabel, path: previewItem.path })
      : t('contentBrowser.preview.assetMeta', { kind: assetKindLabel(previewItem.kind, t), path: previewItem.packPath });

  let body;
  if (previewItem.type === 'folder') {
    const kids = [
      ...foldersInPath.filter((folder) => dirOfPath(folder.path) === previewItem.path),
      ...diskFiles.filter((entry) => dirOfPath(entry.path) === previewItem.path),
    ].slice(0, 40);
    body = kids.length === 0 ? (
      <div className="cb-preview-note">{t('contentBrowser.preview.emptyFolder')}</div>
    ) : (
      <div className="cb-preview-list">
        {kids.map((child) => {
          const ChildIcon = itemIcon(child);
          return (
            <div className="cb-preview-list-item" key={child.path}>
              <span className={`cb-preview-list-ico${child.type === 'folder' ? ' cb-folder-icon' : ''}`}><ChildIcon size={15} /></span>
              <span>{child.name}</span>
              <span className="sub">
                {child.type === 'folder'
                  ? t('contentBrowser.preview.items', { count: child.childCount })
                  : child.kindLabel || fileKindLabel(child, t)}
              </span>
            </div>
          );
        })}
      </div>
    );
  } else if (previewItem.type === 'file') {
    const showSource = filePreviewMode === 'source' && showDualPreview;
    if (previewItem.assets.length > 0 && !showSource) {
      body = <FileAssetList file={previewItem} t={t} onOpenAsset={onOpenAsset} />;
    } else {
      body = (
        <FileContentPreview
          file={showDualPreview ? dualPreviewFile ?? previewItem : previewItem}
          previewInfo={previewInfo}
          status={previewStatus}
          pendingRemote={isFilePreviewPending(canReadPreview, previewStatus, previewInfo, showDualPreview ? dualPreviewFile ?? previewItem : previewItem)}
          t={t}
        />
      );
    }
    if (previewItem.diagnostic) body = <>
      <div className="cb-preview-note" role="status">{previewItem.diagnostic.code}: {previewItem.diagnostic.hint}</div>
      {body}
    </>;
  } else {
    const showSource = showDualPreview && filePreviewMode === 'source' && dualPreviewFile;
    body = showSource ? (
      <FileContentPreview
        file={dualPreviewFile}
        previewInfo={previewInfo}
        status={previewStatus}
        pendingRemote={isFilePreviewPending(canReadPreview, previewStatus, previewInfo, dualPreviewFile)}
        t={t}
      />
    ) : (
      <>
        <div className="cb-preview-media cb-preview-asset-hero">
          {thumbnail?.state === 'ready' && thumbnail.dataUrl
            ? <img className="cb-preview-image" src={thumbnail.dataUrl} alt={previewItem.name} />
            : <span className="cb-preview-hero-icon"><Icon size={64} /></span>}
        </div>
        <div className="cb-preview-asset-list">
          <div className="cb-preview-asset-row">
            <span className="cb-preview-list-ico"><Icon size={15} /></span>
            <div className="cb-preview-asset-main" title={previewItem.packPath}>
              <div title={previewItem.name}>{previewItem.name}</div>
              <div className="kind" title={previewItem.packPath}>{previewItem.packPath}</div>
            </div>
            <span className="guid" title={previewItem.guid}>{previewItem.guid}</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <ResizeHandle onDrag={onDrag} onDragEnd={onDragEnd} title={t('contentBrowser.actions.resizePreview')} />
      <aside className="cb-preview-panel" data-subject-id={previewItem.type === 'asset' ? previewItem.guid : previewItem.path}>
        <div className="cb-preview-head">
          <span className={`cb-preview-ico${previewItem.type === 'folder' ? ' cb-folder-icon' : ''}`}><Icon size={15} /></span>
          <div className="cb-preview-title">
            <div className="name">{previewItem.name}</div>
            <div className="meta">{meta}</div>
          </div>
          <IconButton
            size="compact"
            variant="quiet"
            className="cb-preview-close"
            label={t('contentBrowser.preview.close')}
            icon={<X size={14} />}
            onClick={onClose}
          />
        </div>
        {showDualPreview || detailTabs.length ? (
          <div className="cb-preview-mode-bar" role="tablist" aria-label={t('contentBrowser.preview.modeAssets')}>
            {detailTabs.map(tab => <button key={tab.contribution.id} type="button" role="tab" className={`cb-preview-mode-btn${authoringOpen && detailTabId === tab.contribution.id ? ' is-active' : ''}`} aria-selected={authoringOpen && detailTabId === tab.contribution.id} onClick={() => { setDetailTabId(tab.contribution.id); setAuthoringOpen(true); }}>{t(tab.contribution.titleKey)}</button>)}
            <button type="button" role="tab" className={`cb-preview-mode-btn${!authoringOpen && filePreviewMode === 'assets' ? ' is-active' : ''}`} aria-selected={!authoringOpen && filePreviewMode === 'assets'} onClick={() => { setAuthoringOpen(false); setFilePreviewMode('assets'); }}>
              {t('contentBrowser.preview.modeAssets')}
            </button>
            <button type="button" role="tab" className={`cb-preview-mode-btn${!authoringOpen && filePreviewMode === 'source' ? ' is-active' : ''}`} aria-selected={!authoringOpen && filePreviewMode === 'source'} onClick={() => { setAuthoringOpen(false); setFilePreviewMode('source'); }}>
              {t('contentBrowser.preview.modeSource')}
            </button>
          </div>
        ) : null}
        <div className="cb-preview-body">{authoringOpen ? <><div ref={detailMount} className="cb-preview-detail-contribution" />{detailTabError ? <p role="alert">{detailTabError}</p> : null}</> : body}</div>
      </aside>
    </>
  );
}

function FileAssetList({ file, t, onOpenAsset }: { file: CBFile; t: (key: string, vars?: Record<string, string | number>) => string; onOpenAsset?: (asset: CBAsset) => void }) {
  return (
    <div className="cb-preview-asset-list">
      {file.assets.map((asset) => {
        const Icon = itemIcon(asset);
        return (
          <button type="button" className="cb-preview-asset-row cb-preview-asset-action" key={asset.guid} onClick={() => onOpenAsset?.(asset)} disabled={!onOpenAsset}>
            <span className="cb-preview-list-ico"><Icon size={15} /></span>
            <div className="cb-preview-asset-main">
              <div title={asset.name}>{asset.name}</div>
              <div className="kind" title={assetKindLabel(asset.kind, t)}>{assetKindLabel(asset.kind, t)}</div>
            </div>
            <span className="guid" title={asset.guid}>{asset.guid}</span>
          </button>
        );
      })}
    </div>
  );
}

function isFilePreviewPending(
  canReadPreview: boolean,
  status: 'idle' | 'loading' | 'ready',
  previewInfo: PreviewFileInfo | null,
  file: CBFile,
): boolean {
  if (!canReadPreview || status !== 'idle') return false;
  if (previewInfo) return false;
  return file.sourcePreview == null;
}
