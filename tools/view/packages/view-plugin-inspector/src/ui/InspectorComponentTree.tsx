import { IconButton } from '@forgeax/view-components';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { inspectorComponentDisplayName, type InspectorComponentNode, type InspectorEntity } from '../inspection.ts';
import { useTranslation } from '../i18n/useTranslation';
import { INSPECTOR_ACTIONS } from '../schema.ts';
import { InspectorTypeIcon } from './InspectorTypeIcon';

export function InspectorComponentTree({ source, nodes, selectedKey, expanded, onSelect, onToggleExpanded }: {
  source: InspectorEntity;
  nodes: readonly InspectorComponentNode[];
  selectedKey: string | null;
  expanded: boolean;
  onSelect: (key: string | null) => void;
  onToggleExpanded: () => void;
}) {
  const { t } = useTranslation();
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const labelFor = (node: InspectorComponentNode) => node.titleKey ? t(node.titleKey) : inspectorComponentDisplayName(node.components[0]!, t);
  const labels = [source.name, ...nodes.map(labelFor)];
  const selectAt = (index: number) => {
    const clamped = Math.max(0, Math.min(index, labels.length - 1));
    rows.current[clamped]?.focus();
    onSelect(clamped === 0 ? null : nodes[clamped - 1]!.key);
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (index === 0 && event.key === 'ArrowDown' && !expanded) {
        onToggleExpanded();
        return;
      }
      selectAt(index + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      selectAt(event.key === 'Home' || !expanded ? 0 : labels.length - 1);
    } else if (event.key === 'ArrowLeft' && index === 0 && expanded) {
      event.preventDefault();
      onToggleExpanded();
    } else if (event.key === 'ArrowRight' && index === 0 && !expanded) {
      event.preventDefault();
      onToggleExpanded();
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      selectAt(0);
    }
  };
  return <div className="insp-component-tree" data-testid="insp-component-tree">
    <ul role="tree" aria-label={t('inspector.componentTree')}>
      <li role="none">
        <div className={`insp-tree-row${selectedKey === null ? ' is-selected' : ''}`}>
          <IconButton variant="quiet" size="compact" label={t(expanded ? 'inspector.collapseComponents' : 'inspector.expandComponents')}
            aria-expanded={expanded} data-action={INSPECTOR_ACTIONS.toggleComponentTree}
            icon={expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} onClick={() => {
              if (expanded && selectedKey !== null) onSelect(null);
              onToggleExpanded();
            }} />
          <button ref={element => { rows.current[0] = element; }} type="button" role="treeitem" aria-selected={selectedKey === null}
            aria-expanded={expanded}
            className="insp-tree-item" data-testid="insp-root-node" data-action={INSPECTOR_ACTIONS.selectEntityRoot}
            onClick={() => onSelect(null)} onKeyDown={event => onRowKeyDown(event, 0)} title={source.name}>
            <InspectorTypeIcon kind={source.kind} /><span>{source.name}</span>
          </button>
        </div>
        {expanded && nodes.length > 0 ? <ul role="group">
          {nodes.map((node, index) => {
            const label = labelFor(node);
            const key = index + 1;
            return <li role="none" key={node.key}>
              <button ref={element => { rows.current[key] = element; }} type="button" role="treeitem" aria-selected={selectedKey === node.key}
                className={`insp-tree-component${selectedKey === node.key ? ' is-selected' : ''}`}
                data-testid={`insp-component-node-${node.key}`} data-action={INSPECTOR_ACTIONS.selectComponent}
                onClick={() => onSelect(node.key)} onKeyDown={event => onRowKeyDown(event, key)}
                title={`${label}${node.components.length > 1 ? ` (${node.components.join(', ')})` : ` (${node.components[0]})`}`}>
                <InspectorTypeIcon kind={node.kind} /><span>{label}</span>
                {node.components.length > 1 ? <small>{node.components.join(' · ')}</small> : null}
              </button>
            </li>;
          })}
        </ul> : null}
      </li>
    </ul>
  </div>;
}
