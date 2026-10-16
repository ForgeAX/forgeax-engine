import { ChevronLeft, ChevronRight, Folder, RefreshCw } from 'lucide-react';
import { IconButton, MenuDropdown, Toolbar } from '@forgeax/view-components';
import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from '../i18n/useTranslation';
import { CONTENT_BROWSER_ACTIONS } from '../schema.ts';
import { normalizePathInput } from './format';

function immediateChildren(allDirs: readonly string[], path: string): { name: string; path: string }[] {
  const prefix = path ? `${path}/` : '';
  const depth = path ? path.split('/').length : 0;
  const out: { name: string; path: string }[] = [];
  for (const dir of allDirs) {
    if (path && dir === path) continue;
    if (!dir.startsWith(prefix)) continue;
    if (dir.split('/').length !== depth + 1) continue;
    out.push({ name: dir.split('/').pop() ?? dir, path: dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function LevelChevron({
  levelPath,
  activeNextSeg,
  allDirs,
  onNavigate,
  label,
}: {
  levelPath: string;
  activeNextSeg: string | null;
  allDirs: readonly string[];
  onNavigate: (path: string) => void;
  label: string;
}) {
  const children = immediateChildren(allDirs, levelPath);
  if (children.length === 0) {
    return (
      <span className="cb-crumb-chevron" aria-hidden="true">
        <ChevronRight size={12} />
      </span>
    );
  }
  return (
    <span className="cb-crumb-chevron" onClick={(event) => event.stopPropagation()}>
      <MenuDropdown
        label={label}
        align="start"
        className="cb-crumb-menu"
        trigger={
          <button
            type="button"
            className="cb-crumb-chevron-btn"
            aria-label={label}
            title={label}
            onClick={(event) => event.stopPropagation()}
          >
            <ChevronRight size={12} />
          </button>
        }
        items={children.map((child) => ({
          id: child.path,
          label: child.name,
          icon: <Folder size={14} />,
          buttonProps: child.name === activeNextSeg ? { 'data-active': '' } : undefined,
          onSelect: () => onNavigate(child.path),
        }))}
      />
    </span>
  );
}

export function CBNavigationBar({
  currentPath,
  projectLabel,
  allDirs,
  canGoBack,
  canGoForward,
  refreshDisabled,
  onBack,
  onForward,
  onRefresh,
  onNavigate,
}: {
  currentPath: string;
  projectLabel: string;
  allDirs: readonly string[];
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const beginEdit = useCallback(() => {
    setDraft(currentPath);
    setEditing(true);
  }, [currentPath]);

  const commit = useCallback(() => {
    onNavigate(normalizePathInput(draft));
    setEditing(false);
  }, [draft, onNavigate]);

  const onInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
    }
  }, [commit]);

  const onAddressKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      beginEdit();
    }
  }, [beginEdit]);

  const stopAndNavigate = (event: MouseEvent<HTMLButtonElement>, path: string) => {
    event.stopPropagation();
    onNavigate(path);
  };

  return (
    <Toolbar className="cb-navigation-bar">
      <IconButton
        size="compact"
        variant="quiet"
        label={t('contentBrowser.back')}
        icon={<ChevronLeft size={14} />}
        data-action={CONTENT_BROWSER_ACTIONS.navigateBack}
        disabled={!canGoBack}
        onClick={onBack}
      />
      <IconButton
        size="compact"
        variant="quiet"
        label={t('contentBrowser.forward')}
        icon={<ChevronRight size={14} />}
        data-action={CONTENT_BROWSER_ACTIONS.navigateForward}
        disabled={!canGoForward}
        onClick={onForward}
      />
      <IconButton
        size="compact"
        variant="quiet"
        label={t('contentBrowser.refresh')}
        disabled={refreshDisabled}
        icon={<RefreshCw size={13} />}
        data-action={CONTENT_BROWSER_ACTIONS.refresh}
        onClick={onRefresh}
      />
      <div className="cb-address-slot">
        {editing ? (
          <input
            autoFocus
            spellCheck={false}
            className="cb-address-input"
            value={draft}
            placeholder={t('contentBrowser.actions.editPathPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onInputKeyDown}
            onBlur={() => setEditing(false)}
            onFocus={(event) => event.currentTarget.select()}
          />
        ) : (
          <div
            className="cb-address"
            role="button"
            tabIndex={0}
            title={t('contentBrowser.actions.editPath')}
            onClick={beginEdit}
            onKeyDown={onAddressKeyDown}
          >
            <div className="cb-address-crumb">
              <button
                type="button"
                className={segments.length ? 'cb-crumb-item' : 'cb-crumb-item cb-crumb-current'}
                aria-current={segments.length === 0 ? 'page' : undefined}
                data-action={CONTENT_BROWSER_ACTIONS.navigate}
                onClick={(event) => stopAndNavigate(event, '')}
              >
                {projectLabel}
              </button>
              {segments.map((segment, index) => {
                const path = segments.slice(0, index + 1).join('/');
                const parentPath = segments.slice(0, index).join('/');
                const parentLabel = index === 0 ? projectLabel : (segments[index - 1] ?? projectLabel);
                const isCurrent = index === segments.length - 1;
                return (
                  <span className="cb-crumb-segment" key={path}>
                    <LevelChevron
                      levelPath={parentPath}
                      activeNextSeg={segment}
                      allDirs={allDirs}
                      onNavigate={onNavigate}
                      label={t('contentBrowser.actions.openSubfolders', { name: parentLabel })}
                    />
                    <button
                      type="button"
                      className={isCurrent ? 'cb-crumb-item cb-crumb-current' : 'cb-crumb-item'}
                      aria-current={isCurrent ? 'page' : undefined}
                      data-action={CONTENT_BROWSER_ACTIONS.navigate}
                      onClick={(event) => stopAndNavigate(event, path)}
                    >
                      {segment}
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Toolbar>
  );
}
