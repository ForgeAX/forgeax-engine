import { Box, ChevronDown, Crosshair, Focus, Folder, Image, Paintbrush } from 'lucide-react';

import { MenuDropdown } from './components';
import { useClipboardAction } from './clipboard';

export type AssetReferenceLabels = {
  none: string;
  missing: string;
  open: string;
  useSelection: string;
  browse: string;
  reveal: string;
  more: string;
  clear: string;
  copyGuid: string;
};

const DEFAULT_LABELS: AssetReferenceLabels = {
  none: 'None',
  missing: 'Missing asset',
  open: 'Open asset',
  useSelection: 'Use selected asset',
  browse: 'Browse assets',
  reveal: 'Reveal in Content Browser',
  more: 'More reference actions',
  clear: 'Clear',
  copyGuid: 'Copy GUID',
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
}: {
  value: unknown;
  labels?: Partial<AssetReferenceLabels>;
  onUseSelection?: () => void;
  onOpen?: () => void;
  openAction?: string;
  onBrowse?: () => void;
  onReveal?: () => void;
  onClear?: () => void;
}) {
  const writeClipboard = useClipboardAction();
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
  const ThumbnailIcon = /texture|image/i.test(kind) ? Image
    : /material/i.test(kind) ? Paintbrush : Box;

  return (
    <div className="fx-asset-ref asset-ref" data-testid="asset-reference-field">
      <div className="asset-ref-thumb" aria-hidden="true">
        {bound && !missing ? <ThumbnailIcon size={18} strokeWidth={1.6} />
          : <span className="asset-ref-thumb-empty" />}
      </div>
      <div className="asset-ref-body">
        <button type="button" className="asset-ref-combo" disabled={!onOpen && !onBrowse}
          title={onOpen ? labels.open : labels.browse} data-action={openAction} onClick={onOpen ?? onBrowse}>
          <span className={`asset-ref-combo-label${bound && !missing ? '' : ' empty'}`}>{displayName}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        <div className="asset-ref-actions">
          <button type="button" className="asset-ref-act" disabled={!onUseSelection}
            title={labels.useSelection} aria-label={labels.useSelection} onClick={onUseSelection}>
            <Crosshair size={13} />
          </button>
          <button type="button" className="asset-ref-act" disabled={!onBrowse}
            title={labels.browse} aria-label={labels.browse} onClick={onBrowse}>
            <Folder size={13} />
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
