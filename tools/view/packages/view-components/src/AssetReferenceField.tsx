import { Box, ChevronDown, Crosshair, ExternalLink, Focus, Folder, Image, Paintbrush } from 'lucide-react';
import { useState } from 'react';

import { MenuDropdown } from './components';
import { useClipboardAction } from './clipboard';

export type AssetReferenceLabels = {
  none: string;
  missing: string;
  open: string;
  openUnavailable: string;
  identityUnavailable: string;
  readOnly: string;
  useSelection: string;
  browse: string;
  reveal: string;
  more: string;
  clear: string;
  copyGuid: string;
  previewLoading: string;
  previewFailed: string;
  previewUnsupported: string;
};

export type AssetReferenceThumbnail = {
  state: 'loading' | 'ready' | 'failed' | 'unsupported';
  src?: string;
  hint?: string;
};

const DEFAULT_LABELS: AssetReferenceLabels = {
  none: 'None',
  missing: 'Missing asset',
  open: 'Open asset viewer',
  openUnavailable: 'Asset viewer unavailable',
  identityUnavailable: 'Asset identity unavailable',
  readOnly: 'Read-only asset reference',
  useSelection: 'Use selected asset',
  browse: 'Browse to Asset',
  reveal: 'Reveal in Content Browser',
  more: 'More reference actions',
  clear: 'Clear',
  copyGuid: 'Copy GUID',
  previewLoading: 'Loading asset preview',
  previewFailed: 'Asset preview failed',
  previewUnsupported: 'Asset preview unavailable',
};

export function AssetReferenceField({
  value,
  labels: customLabels,
  onUseSelection,
  onOpen,
  openAction,
  onBrowse,
  onReveal,
  onClear,
  thumbnail,
}: {
  value: unknown;
  labels?: Partial<AssetReferenceLabels>;
  onUseSelection?: () => void;
  onOpen?: () => void;
  openAction?: string;
  onBrowse?: () => void;
  onReveal?: () => void;
  onClear?: () => void;
  thumbnail?: AssetReferenceThumbnail;
}) {
  const writeClipboard = useClipboardAction();
  const [failedSrc, setFailedSrc] = useState<string>();
  const labels = { ...DEFAULT_LABELS, ...customLabels };
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const guid = typeof record?.guid === 'string' ? record.guid
    : typeof record?.id === 'string' ? record.id : undefined;
  const name = typeof value === 'string' ? value
    : typeof record?.name === 'string' ? record.name : '';
  const kind = typeof record?.kind === 'string' ? record.kind : '';
  const missing = record?.missing === true;
  const bound = Boolean(guid || name);
  const displayName = missing ? labels.missing : bound ? name || guid : labels.none;
  const canOpen = Boolean(guid && !missing && onOpen);
  const openLabel = `${labels.open}: ${name || guid || displayName}`;
  const openTitle = canOpen ? openLabel : `${openLabel} · ${missing ? labels.missing : !guid ? bound ? labels.identityUnavailable : labels.none : labels.openUnavailable}`;
  const ThumbnailIcon = /texture|image/i.test(kind) ? Image
    : /material/i.test(kind) ? Paintbrush : Box;
  const previewState = thumbnail?.state === 'ready' && (!thumbnail.src || failedSrc === thumbnail.src)
    ? 'failed' : thumbnail?.state;
  const previewTitle = previewState && previewState !== 'ready'
    ? `${labels[previewState === 'loading' ? 'previewLoading' : previewState === 'failed' ? 'previewFailed' : 'previewUnsupported']}${thumbnail?.hint ? `: ${thumbnail.hint}` : ''}` : '';

  return (
    <div className="fx-asset-ref asset-ref" data-testid="asset-reference-field">
      <button type="button" className="asset-ref-thumb" disabled={!canOpen}
        aria-label={openLabel} title={[openTitle, previewTitle].filter(Boolean).join(' · ')}
        data-testid="asset-reference-thumbnail" data-preview-state={previewState}
        aria-busy={previewState === 'loading' || undefined}
        onDoubleClick={event => { event.stopPropagation(); if (canOpen) onOpen?.(); }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.repeat && canOpen) {
            event.preventDefault(); event.stopPropagation(); onOpen?.();
          }
        }}>
        {bound && !missing && previewState === 'ready' && thumbnail?.src
          ? <img src={thumbnail.src} alt="" draggable={false} onError={() => setFailedSrc(thumbnail.src)} />
          : bound && !missing ? <ThumbnailIcon size={24} strokeWidth={1.6} aria-hidden="true" />
          : <span className="asset-ref-thumb-empty" />}
      </button>
      <div className="asset-ref-body">
        <div className="asset-ref-combo" role="textbox" aria-readonly="true" tabIndex={0}
          aria-label={labels.readOnly} title={`${name || guid || displayName} · ${labels.readOnly}`}>
          <span className={`asset-ref-combo-label${bound && !missing ? '' : ' empty'}`}>{displayName}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </div>
        <div className="asset-ref-actions">
          <button type="button" className="asset-ref-act" disabled={!onUseSelection}
            title={labels.useSelection} aria-label={labels.useSelection} onClick={onUseSelection}>
            <Crosshair size={13} />
          </button>
          <button type="button" className="asset-ref-act" disabled={!onBrowse}
            title={labels.browse} aria-label={labels.browse} onClick={onBrowse}>
            <Folder size={13} />
          </button>
          <button type="button" className="asset-ref-act" disabled={!canOpen}
            title={openTitle} aria-label={openLabel} data-action={openAction} data-testid="asset-reference-open" onClick={onOpen}>
            <ExternalLink size={13} />
          </button>
          <button type="button" className="asset-ref-act" disabled={!guid || !onReveal}
            title={labels.reveal} aria-label={labels.reveal} onClick={onReveal}>
            <Focus size={13} />
          </button>
          <MenuDropdown label={labels.more} items={[
            { id: 'clear', label: labels.clear, disabled: !bound || !onClear, ...(onClear ? { onSelect: onClear } : {}) },
            { id: 'copy-guid', label: labels.copyGuid, disabled: !guid,
              onSelect: () => { if (guid) void writeClipboard(guid); } },
            { type: 'separator' },
            { id: 'reveal', label: labels.reveal, disabled: !guid || !onReveal, ...(onReveal ? { onSelect: onReveal } : {}) },
          ]} trigger={
            <button type="button" className="asset-ref-act" title={labels.more} aria-label={labels.more}>
              <ChevronDown size={12} />
            </button>
          } />
        </div>
      </div>
    </div>
  );
}
