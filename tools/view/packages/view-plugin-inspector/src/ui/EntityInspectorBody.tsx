import {
  CollapsibleSection, EmptyState, FloatingMenu, IconButton, Menu,
  PanelHeader, PropertyRow, SearchField, Text, Toolbar, useClipboardAction, type AnchorRect,
} from '@forgeax/view-components';
import { Box, Copy, Crosshair, Layers, Maximize2, Minimize2, Move3d, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  compactInspectorDisplay, inspectorComponentDisplayName,
  inspectorFieldMatches, inspectorGroups, inspectorSectionMatches, inspectorSections,
  type InspectorEntity, type InspectorField, type InspectorGroup, type InspectorResourceReference,
} from '../inspection.ts';
import { useTranslation } from '../i18n/useTranslation';
import { INSPECTOR_ACTIONS } from '../schema.ts';
import { InspectorAssetReference } from './InspectorAssetReference';
import { InspectorFieldView } from './InspectorFieldView';
import { InspectorTypeIcon } from './InspectorTypeIcon';

function InspectorMaterials({ references, truncated, openAsset, browseAsset, query = '' }: {
  references: readonly InspectorResourceReference[] | null;
  truncated: boolean;
  openAsset: (guid: string) => void;
  browseAsset?: (guid: string) => void;
  query?: string;
}) {
  const { t } = useTranslation();
  return <div className="insp-material-list">
    {references?.map((reference, index) => ({ reference, index }))
      .filter(({ reference, index }) => !query || `${index} ${JSON.stringify(reference)}`.toLowerCase().includes(query))
      .map(({ reference, index }) => <div className="insp-material-slot" key={index} data-testid={`insp-material-slot-${index}`}>
      {reference.slotName ? <div className="insp-material-heading"><span title={reference.slotName}>{index} · {reference.slotName}</span>
        {reference.bindingSource ? <Text as="span" variant="caption" tone="muted">{t(`inspector.materialSource.${reference.bindingSource}`)}</Text> : null}</div> : null}
      <div className="insp-material-item">
      <span className="insp-material-index" title={reference.slotName}>{index}</span>
      <InspectorAssetReference reference={reference} openAsset={openAsset} browseAsset={browseAsset} inline />
      </div></div>)}
    {references?.length === 0 ? <Text as="div" tone="muted" className="insp-section-status">{t('inspector.noMaterials')}</Text> : null}
    {references === null ? <Text as="div" tone="muted" className="insp-section-status" role="status">{t('inspector.materialsUnavailable')}</Text> : null}
    {truncated ? <Text as="div" tone="muted" className="insp-section-status" role="status">{t('inspector.collectionTruncated', { count: references?.length ?? 0 })}</Text> : null}
  </div>;
}

export function EntityInspectorBody({ source, selectionCount = 1, focus, openAsset, browseAsset, renderAuthorField }: {
  renderAuthorField?: (component: string, field: InspectorField, fallback: ReactNode) => ReactNode;
  source: InspectorEntity;
  selectionCount?: number;
  focus?: () => void;
  openAsset: (guid: string) => void;
  browseAsset?: (guid: string) => void;
}) {
  const writeClipboard = useClipboardAction();
  const { t } = useTranslation();
  const groups = inspectorGroups(source);
  const defaultGroup = groups.includes('common') ? 'common' : groups[0] ?? 'all';
  const [componentNavigation, setComponentNavigation] = useState<{ name: string } | null>(null);
  const [chosenGroup, setGroup] = useState<InspectorGroup>('common');
  const group = groups.includes(chosenGroup) ? chosenGroup : defaultGroup;
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [menu, setMenu] = useState<{ anchor: AnchorRect; value?: unknown; settings?: boolean } | null>(null);
  const detailScroll = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const queryText = query.trim().toLowerCase();
  const sections = inspectorSections(source, group);
  const title = (section: (typeof sections)[number]) => section.titleKey
    ? t(`inspector.${section.titleKey}`) : inspectorComponentDisplayName(section.component, t);
  const labelFor = (component: string, field: InspectorField) => component === 'Transform' && ['pos', 'quat', 'scale'].includes(field.key)
    ? t(`inspector.transformFields.${field.key}`) : field.label;
  const shown = sections.filter(section => inspectorSectionMatches(section, source, query, title(section),
    field => labelFor(section.component, field)));
  const sectionMatches = (section: (typeof sections)[number]) => !queryText
    || `${title(section)} ${section.component}`.toLowerCase().includes(queryText);
  const materialsMatch = () => JSON.stringify(source.materialOverrides).toLowerCase().includes(queryText);
  useEffect(() => {
    if (componentNavigation && !source.components.some(component => component.name === componentNavigation.name)) {
      setComponentNavigation(null);
      setGroup(defaultGroup);
      setQuery('');
      setCollapsed(new Set());
      setMenu(null);
    }
  }, [source.components, componentNavigation, defaultGroup]);
  useEffect(() => {
    if (componentNavigation && group === 'all') {
      const details = detailScroll.current;
      const section = sectionRefs.current[componentNavigation.name];
      if (details && section) details.scrollTo({
        top: details.scrollTop + section.getBoundingClientRect().top - details.getBoundingClientRect().top,
        behavior: 'smooth',
      });
    }
  }, [componentNavigation, group]);
  const browseComponent = (name: string) => {
    setComponentNavigation({ name });
    setGroup('all');
    setQuery('');
    setCollapsed(current => { const next = new Set(current); next.delete(name); return next; });
    setMenu(null);
  };
  const chooseGroup = (next: InspectorGroup) => {
    setComponentNavigation(null);
    setGroup(next);
  };
  const copy = (value: unknown) => { if (value !== undefined) void writeClipboard(JSON.stringify(value, null, 2)); };
  const showContext = (event: MouseEvent, value: unknown) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ anchor: { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 }, value });
  };
  return <div className="fx-inspector__body insp-entity-body" data-testid="insp-entity-body" data-group={group} data-entity-kind={source.kind}>
    <div className="insp-components-card" data-testid="insp-components-card">
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
    <nav className="insp-component-browser" data-testid="insp-component-list" aria-label={t('inspector.components')}>
      <Text as="div" variant="caption" tone="muted" className="insp-component-browser-heading">{t('inspector.components')}</Text>
      <ul>{source.components.map(component => <li key={component.name}>
        <button type="button" className="insp-component-browser-row" data-testid={`insp-comprow-${component.name}`}
          data-action={INSPECTOR_ACTIONS.selectComponent} aria-current={componentNavigation?.name === component.name ? 'location' : undefined}
          title={component.name} onClick={() => browseComponent(component.name)}>
          {component.name === 'Transform' ? <Move3d size={13} /> : component.name === 'MeshRenderer' ? <Layers size={13} /> : <Box size={13} />}
          <span>{inspectorComponentDisplayName(component.name, t)}</span>
        </button>
      </li>)}</ul>
    </nav>
    </div>
    <Toolbar className="insp-toolbar">
      <SearchField value={query} onChange={event => setQuery(event.target.value)} onClear={() => setQuery('')} label={t('inspector.searchLabel')} placeholder={t('inspector.searchPlaceholder')} data-testid="insp-search" data-action={INSPECTOR_ACTIONS.search} />
      <IconButton variant="secondary" size="compact" icon={<SlidersHorizontal size={15} />} label={t('inspector.displaySettings')} data-testid="insp-settings" onClick={event => setMenu({ anchor: event.currentTarget.getBoundingClientRect(), settings: true })} />
    </Toolbar>
    <div className="insp-group-switch" role="radiogroup" aria-label={t('inspector.groups')}>
      {groups.map((item, index) => <button key={item} role="radio" aria-checked={group === item}
        tabIndex={group === item ? 0 : -1} data-action={INSPECTOR_ACTIONS.selectGroup}
        data-testid={`insp-group-${item}`} onClick={() => chooseGroup(item)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length;
          chooseGroup(groups[next]!);
          (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
        }}>{t(`inspector.group.${item}`)}</button>)}
    </div>
    <div ref={detailScroll} className="insp-scroll insp-entity-details" data-testid="insp-scroll">
      {shown.length === 0 ? <EmptyState title={t('inspector.noMatchTitle')} description={t('inspector.noMatchDescription')} />
        : shown.map(section => <div className="insp-detail-section" key={section.key} data-testid={`insp-section-${section.key}`}
          ref={element => { sectionRefs.current[section.key] = element; }}
          onContextMenu={event => showContext(event, source.raw.components.find(component => component.name === section.component))}>
          <CollapsibleSection open={!collapsed.has(section.key) || Boolean(queryText)} onOpenChange={open => setCollapsed(current => {
            const next = new Set(current); if (open) next.delete(section.key); else next.add(section.key); return next;
          })} triggerProps={{ 'data-action': INSPECTOR_ACTIONS.toggleComponent }}
            title={<span className="cat-title">{section.key === 'Transform' ? <Move3d size={13} />
              : section.kind === 'materials' ? <Layers size={13} /> : <Box size={13} />}{title(section)}</span>}
            trailing={<IconButton className="insp-component-copy" variant="quiet" size="compact" icon={<Copy size={13} />} label={t('inspector.menu.copyComponentJson')}
              data-action={INSPECTOR_ACTIONS.copyComponent} onClick={() => copy(source.raw.components.find(component => component.name === section.component))} />}>
            {section.kind === 'mesh' ? <InspectorAssetReference reference={source.meshReference} openAsset={openAsset} browseAsset={browseAsset} />
              : section.kind === 'materials' ? <InspectorMaterials references={source.materialOverrides}
                truncated={source.materialOverridesTruncated} openAsset={openAsset} browseAsset={browseAsset} query={sectionMatches(section) ? '' : queryText} />
                : section.fields.length === 0 ? <Text as="div" tone="muted" className="insp-section-status">{t('inspector.noFields')}</Text>
                  : section.fields.filter(field => sectionMatches(section)
                    || inspectorFieldMatches(field, query, labelFor(section.component, field))
                    || (section.component === 'MeshRenderer' && field.key === 'materials' && materialsMatch()))
                    .map(field => <div className={`insp-detail-field${section.component === 'Transform' && ['pos', 'quat', 'scale'].includes(field.key) ? ' insp-detail-field--transform' : ''}`}
                      key={field.key} data-testid={`insp-field-${section.component}-${field.key}`} onContextMenu={event => showContext(event, field.rawValue)}>
                      <PropertyRow label={<span title={field.key}>{labelFor(section.component, field)}</span>}>
                        <span className="insp-field-value">{section.component === 'MeshRenderer' && field.key === 'materials'
                          ? <InspectorMaterials references={source.materialOverrides} truncated={source.materialOverridesTruncated}
                            openAsset={openAsset} browseAsset={browseAsset} query={sectionMatches(section) || inspectorFieldMatches(field, query, labelFor(section.component, field)) ? '' : queryText} />
                          : renderAuthorField ? renderAuthorField(section.component, field, <InspectorFieldView field={compactInspectorDisplay(field)} openAsset={openAsset} browseAsset={browseAsset} />) : <InspectorFieldView field={compactInspectorDisplay(field)} openAsset={openAsset} browseAsset={browseAsset} />}</span>
                      </PropertyRow>
                      <IconButton className="insp-field-copy" variant="quiet" size="compact" icon={<Copy size={12} />} label={t('inspector.menu.copyValue')}
                        data-action={INSPECTOR_ACTIONS.copyField} disabled={field.rawValue === undefined} onClick={() => copy(field.rawValue)} />
                    </div>)}
          </CollapsibleSection>
        </div>)}
    </div>
    <FloatingMenu open={Boolean(menu)} anchorRect={menu?.anchor ?? null} onClose={() => setMenu(null)}>
      <Menu label={menu?.settings ? t('inspector.displaySettings') : t('inspector.contextMenu')} items={menu?.settings ? [
        { id: 'expand', label: t('inspector.expandAll'), icon: <Maximize2 size={14} />, buttonProps: { 'data-action': INSPECTOR_ACTIONS.expandAll }, onSelect: () => { setCollapsed(new Set()); setMenu(null); } },
        { id: 'collapse', label: t('inspector.collapseAll'), icon: <Minimize2 size={14} />, buttonProps: { 'data-action': INSPECTOR_ACTIONS.collapseAll }, onSelect: () => { setCollapsed(new Set(sections.map(section => section.key))); setMenu(null); } },
      ] : [
        { id: 'copy', label: t('inspector.menu.copyValue'), icon: <Copy size={14} />, onSelect: () => { copy(menu?.value); setMenu(null); } },
      ]} />
    </FloatingMenu>
  </div>;
}
