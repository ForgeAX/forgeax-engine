import {
  CollapsibleSection, EmptyState, FloatingMenu, IconButton, Menu,
  PanelHeader, PropertyRow, SearchField, Text, Toolbar, useClipboardAction, type AnchorRect,
} from '@forgeax/view-components';
import { Box, Copy, Crosshair, Layers, Maximize2, Minimize2, Move3d, SlidersHorizontal } from 'lucide-react';
import { useRef, useState, type MouseEvent } from 'react';
import { compactInspectorDisplay, inspectorComponentDisplayName, type InspectorEntity, type InspectorField, type InspectorResourceReference } from '../inspection.ts';
import { useTranslation } from '../i18n/useTranslation';
import { INSPECTOR_ACTIONS } from '../schema.ts';
import { InspectorAssetReference } from './InspectorAssetReference';
import { InspectorFieldView } from './InspectorFieldView';
import { InspectorTypeIcon } from './InspectorTypeIcon';

function InspectorMaterials({ references, truncated, openAsset }: {
  references: readonly InspectorResourceReference[] | null;
  truncated: boolean;
  openAsset: (guid: string) => void;
}) {
  const { t } = useTranslation();
  return <div className="insp-material-list">
    {references?.map((reference, index) => <div className="insp-material-item" key={index} data-testid={`insp-material-slot-${index}`}>
      <span className="insp-material-index">{index}</span>
      <InspectorAssetReference reference={reference} openAsset={openAsset} inline />
    </div>)}
    {references?.length === 0 ? <Text as="div" tone="muted" className="insp-section-status">{t('inspector.noMaterials')}</Text> : null}
    {references === null ? <Text as="div" tone="muted" className="insp-section-status" role="status">{t('inspector.materialsUnavailable')}</Text> : null}
    {truncated ? <Text as="div" tone="muted" className="insp-section-status" role="status">{t('inspector.collectionTruncated', { count: references?.length ?? 0 })}</Text> : null}
  </div>;
}

export function EntityInspectorBody({ source, selectionCount = 1, focus, openAsset }: {
  source: InspectorEntity;
  selectionCount?: number;
  focus?: () => void;
  openAsset: (guid: string) => void;
}) {
  const writeClipboard = useClipboardAction();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [menu, setMenu] = useState<{ anchor: AnchorRect; value?: unknown; settings?: boolean } | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const queryText = query.trim().toLowerCase();
  const nameFor = (name: string) => inspectorComponentDisplayName(name, t);
  const labelFor = (component: string, field: InspectorField) => component === 'Transform' && ['pos', 'quat', 'scale'].includes(field.key)
    ? t(`inspector.transformFields.${field.key}`) : field.label;
  const shown = source.components.map(component => ({
    ...component,
    fields: component.fields.filter(field => !queryText || [field.key, labelFor(component.name, field), field.resource?.asset?.name, field.resource?.guid]
      .some(value => String(value ?? '').toLowerCase().includes(queryText))),
  })).filter(component => !queryText || nameFor(component.name).toLowerCase().includes(queryText) || component.name.toLowerCase().includes(queryText) || component.fields.length > 0);
  const copy = (value: unknown) => { if (value !== undefined) void writeClipboard(JSON.stringify(value, null, 2)); };
  const showContext = (event: MouseEvent, value: unknown) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ anchor: { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 }, value });
  };
  const componentIcon = (name: string) => name === 'Transform' ? <Move3d size={13} />
    : name === 'MeshRenderer' ? <Layers size={13} /> : <Box size={13} />;

  return <div className="fx-inspector__body insp-flat-body" data-testid="insp-entity-body" data-entity-kind={source.kind}>
    <PanelHeader className="insp-header" onContextMenu={event => showContext(event, source.raw)} start={
      <span className="insp-header-identity"><span className="tico"><InspectorTypeIcon kind={source.kind} size={15} /></span>
        <span className="insp-header-copy"><Text as="span" variant="label" className="insp-header-name" title={source.name}>{source.name}</Text>
          {selectionCount > 1 ? <Text as="span" variant="caption" tone="muted" className="insp-selection-count">{t('inspector.selectionCount', { count: selectionCount })}</Text> : null}
        </span></span>
    } end={<span className="insp-header-end">
      <span className="badge" title={t(`inspector.types.${source.kind}`)}>{t(`inspector.types.${source.kind}`)}</span>
      <IconButton variant="quiet" size="compact" icon={<Crosshair size={15} />} label={t('inspector.focusObject')} data-action={INSPECTOR_ACTIONS.focus} disabled={!focus} onClick={focus} />
      <IconButton variant="quiet" size="compact" icon={<Copy size={15} />} label={t('inspector.copyJson')} data-action={INSPECTOR_ACTIONS.copyEntity} onClick={() => copy(source.raw)} />
    </span>} />
    <Toolbar className="insp-toolbar">
      <SearchField value={query} onChange={event => setQuery(event.target.value)} onClear={() => setQuery('')} label={t('inspector.searchLabel')} placeholder={t('inspector.searchPlaceholder')} data-testid="insp-search" data-action={INSPECTOR_ACTIONS.search} />
      <IconButton variant="secondary" size="compact" icon={<SlidersHorizontal size={15} />} label={t('inspector.displaySettings')} data-testid="insp-settings" onClick={event => setMenu({ anchor: event.currentTarget.getBoundingClientRect(), settings: true })} />
    </Toolbar>
    <div className="insp-scroll" data-testid="insp-scroll">
      <div className="dp-comp">
        <div className="ch"><Text as="span" variant="caption" tone="muted">{t('inspector.components')}</Text></div>
        {source.components.map(component => <button type="button" className="comp-row" key={component.name}
          data-testid={`insp-comprow-${component.name}`} onClick={() => {
            setCollapsed(current => { const next = new Set(current); next.delete(component.name); return next; });
            sectionRefs.current[component.name]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }}>
          <span className="ci">{componentIcon(component.name)}</span><span className="comp-name">{nameFor(component.name)}</span>
        </button>)}
      </div>
      <div className="dp-body">
        {shown.length === 0 ? <EmptyState className="no-match" title={t('inspector.noMatchTitle')} description={t('inspector.noMatchDescription')} />
          : shown.map(component => <div className="cat dim-all" key={component.name} ref={element => { sectionRefs.current[component.name] = element; }}
            data-testid={`insp-section-${component.name}`} onContextMenu={event => showContext(event, source.raw.components.find(item => item.name === component.name))}>
            <CollapsibleSection open={!collapsed.has(component.name) || Boolean(queryText)} onOpenChange={open => setCollapsed(current => {
              const next = new Set(current); if (open) next.delete(component.name); else next.add(component.name); return next;
            })} triggerProps={{ 'data-action': INSPECTOR_ACTIONS.toggleComponent }}
              title={<span className="cat-title"><span className="cat-icon">{componentIcon(component.name)}</span>{nameFor(component.name)}</span>}
              trailing={<IconButton className="cact" variant="quiet" size="compact" icon={<Copy size={13} />} label={t('inspector.menu.copyComponentJson')}
                data-action={INSPECTOR_ACTIONS.copyComponent} onClick={() => copy(source.raw.components.find(item => item.name === component.name))} />}>
              <div className="cat-fields">
                {component.fields.length === 0 ? <Text as="div" tone="muted" className="insp-section-status">{t('inspector.noFields')}</Text>
                  : component.fields.map(field => <div className={`f-row-wrap${field.kind === 'angle3' ? ' f-row-wrap--angle' : ''}${component.name === 'MeshRenderer' && field.key === 'materials' ? ' f-row-wrap--materials' : ''}`} key={field.key} data-testid={`insp-field-${component.name}-${field.key}`}
                    onContextMenu={event => showContext(event, field.rawValue)}>
                    <PropertyRow className={`f-row${field.kind === 'angle3' ? ' f-row--angle' : ''}`} label={<span title={field.key}>{labelFor(component.name, field)}</span>}>
                      {component.name === 'MeshRenderer' && field.key === 'materials'
                        ? <InspectorMaterials references={source.materialOverrides} truncated={source.materialOverridesTruncated} openAsset={openAsset} />
                        : <InspectorFieldView field={compactInspectorDisplay(field)} openAsset={openAsset} />}
                    </PropertyRow>
                    <IconButton className="insp-field-copy" variant="quiet" size="compact" icon={<Copy size={12} />} label={t('inspector.menu.copyValue')}
                      data-action={INSPECTOR_ACTIONS.copyField} disabled={field.rawValue === undefined} onClick={() => copy(field.rawValue)} />
                  </div>)}
              </div>
            </CollapsibleSection>
          </div>)}
      </div>
    </div>
    <FloatingMenu open={Boolean(menu)} anchorRect={menu?.anchor ?? null} onClose={() => setMenu(null)}>
      <Menu label={menu?.settings ? t('inspector.displaySettings') : t('inspector.contextMenu')} items={menu?.settings ? [
        { id: 'expand', label: t('inspector.expandAll'), icon: <Maximize2 size={14} />, buttonProps: { 'data-action': INSPECTOR_ACTIONS.expandAll }, onSelect: () => { setCollapsed(new Set()); setMenu(null); } },
        { id: 'collapse', label: t('inspector.collapseAll'), icon: <Minimize2 size={14} />, buttonProps: { 'data-action': INSPECTOR_ACTIONS.collapseAll }, onSelect: () => { setCollapsed(new Set(source.components.map(component => component.name))); setMenu(null); } },
      ] : [
        { id: 'copy', label: t('inspector.menu.copyValue'), icon: <Copy size={14} />, onSelect: () => { copy(menu?.value); setMenu(null); } },
      ]} />
    </FloatingMenu>
  </div>;
}
