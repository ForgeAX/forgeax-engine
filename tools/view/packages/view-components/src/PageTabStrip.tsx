import {
  ChevronsRight,
  Minus,
  Pin,
  Plus,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { ContextMenu, type MenuItem } from './components';
import { iconForPage } from './page-tab-icons';

export type PageTabItem = {
  id: string;
  title: string;
  typeId: string;
  icon?: LucideIcon;
  resourcePath?: string;
  closable?: boolean;
  dirty?: boolean;
  tooltip?: string;
};

export type PageTabNewTypeOption = {
  typeId: string;
  title: string;
};

export type PageTabStripLabels = {
  tabList: string;
  newPage: string;
  allPages: string;
  noOpenableTypes: string;
  closeTab: string;
  contextClose: string;
  contextCloseOthers: string;
  contextCloseToRight: string;
};

const DEFAULT_LABELS: PageTabStripLabels = {
  tabList: '已打开的页面',
  newPage: '新建页面',
  allPages: '全部页面',
  noOpenableTypes: '没有可新建的类型',
  closeTab: '关闭标签页',
  contextClose: '关闭',
  contextCloseOthers: '关闭其他',
  contextCloseToRight: '关闭右侧',
};

function classes(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ');
}

function useAnchoredMenu(anchorRef: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const openAtAnchor = useCallback(
    (align: 'start' | 'end' = 'start') => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPosition({
        x: align === 'end' ? rect.right : rect.left,
        y: rect.bottom + 4,
      });
      setOpen(true);
    },
    [anchorRef],
  );

  return { open, setOpen, position, openAtAnchor };
}

export type PageTabStripProps = {
  leading?: ReactNode;
  trailing?: ReactNode;
  pages: readonly PageTabItem[];
  activePageId: string | null;
  onSelect: (pageId: string) => void;
  onClose?: (pageId: string) => void;
  onCloseOthers?: (pageId: string) => void;
  onCloseToRight?: (pageId: string) => void;
  onReorder?: (pageId: string, toIndex: number) => void;
  newPageTypes?: readonly PageTabNewTypeOption[];
  onNewPage?: (typeId: string) => void;
  labels?: Partial<PageTabStripLabels>;
  className?: string;
};

export function PageTabStrip({
  leading,
  trailing,
  pages,
  activePageId,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onReorder,
  newPageTypes = [],
  onNewPage,
  labels: labelOverrides,
  className,
}: PageTabStripProps): ReactElement | null {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const listRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const dragKeyRef = useRef<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pageId: string } | null>(
    null,
  );
  const newMenu = useAnchoredMenu(newButtonRef);
  const overflowMenu = useAnchoredMenu(overflowButtonRef);
  const menuId = useId();

  useEffect(() => {
    if (!activePageId) return;
    listRef.current
      ?.querySelector(`[data-page-id="${CSS.escape(activePageId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activePageId]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth - el.clientWidth > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages.length]);

  useEffect(() => {
    const end = () => {
      dragKeyRef.current = null;
      setDraggingKey(null);
    };
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, []);

  const handleTabClick = useCallback(
    (pageId: string) => {
      if (pageId === activePageId) return;
      onSelect(pageId);
    },
    [activePageId, onSelect],
  );

  const handlePointerDown = useCallback((event: ReactPointerEvent, pageId: string) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-page-close]')) return;
    dragKeyRef.current = pageId;
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const dragKey = dragKeyRef.current;
      if (!dragKey || event.buttons !== 1 || !onReorder) return;
      const overId = (event.target as HTMLElement)
        .closest('[data-page-id]')
        ?.getAttribute('data-page-id');
      if (!overId || overId === dragKey) return;
      const toIndex = pages.findIndex((page) => page.id === overId);
      if (toIndex < 0) return;
      setDraggingKey(dragKey);
      onReorder(dragKey, toIndex);
    },
    [onReorder, pages],
  );

  const closePage = useCallback(
    (pageId: string) => {
      onClose?.(pageId);
    },
    [onClose],
  );

  if (pages.length === 0 && !leading && !trailing) return null;

  const contextPage = contextMenu
    ? pages.find((page) => page.id === contextMenu.pageId)
    : undefined;
  const contextItems: MenuItem[] = contextMenu && contextPage
    ? [
        {
          id: 'close',
          label: labels.contextClose,
          icon: <X className="fx-icon" aria-hidden />,
          disabled: !contextPage.closable,
          onSelect: () => closePage(contextMenu.pageId),
        },
        {
          id: 'close-others',
          label: labels.contextCloseOthers,
          icon: <Minus className="fx-icon" aria-hidden />,
          onSelect: () => {
            onCloseOthers?.(contextMenu.pageId);
            onSelect(contextMenu.pageId);
          },
        },
        {
          id: 'close-right',
          label: labels.contextCloseToRight,
          icon: <ChevronsRight className="fx-icon" aria-hidden />,
          onSelect: () => onCloseToRight?.(contextMenu.pageId),
        },
      ]
    : [];

  const newPageMenuItems: MenuItem[] =
    newPageTypes.length === 0
      ? [{ id: 'empty', label: labels.noOpenableTypes, disabled: true }]
      : newPageTypes.map((type) => {
          const Icon = iconForPage({ typeId: type.typeId });
          return {
            id: type.typeId,
            label: type.title,
            icon: <Icon className="fx-icon" aria-hidden />,
            onSelect: () => onNewPage?.(type.typeId),
          };
        });

  const overflowMenuItems: MenuItem[] = pages.map((page) => {
    const Icon = page.icon ?? iconForPage({ typeId: page.typeId, ...(page.resourcePath === undefined ? {} : { resourcePath: page.resourcePath }) });
    const mark = activePageId === page.id ? '●' : '○';
    const label = page.dirty ? `${page.title} *` : page.title;
    return {
      id: page.id,
      label: (
        <>
          <span className="fx-page-tab-menu__mark">{mark}</span>
          <span className="fx-page-tab-menu__label">{label}</span>
        </>
      ),
      icon: <Icon className="fx-icon" aria-hidden />,
      selected: activePageId === page.id,
      onSelect: () => onSelect(page.id),
    };
  });

  return (
    <div className={classes('fx-page-tab-strip', 'fx-ui', className)} data-fx-slot="PageTabs">
      {leading}
      <div className="fx-page-tab-strip__scope">
        <div
          ref={listRef}
          className="fx-page-tab-strip__list"
          role="tablist"
          aria-label={labels.tabList}
          onPointerMove={handlePointerMove}
        >
          {pages.map((page) => {
            const active = activePageId === page.id;
            const Icon =
              page.icon ?? iconForPage({ typeId: page.typeId, ...(page.resourcePath === undefined ? {} : { resourcePath: page.resourcePath }) });
            const closable = page.closable !== false;
            const tabClass = classes(
              'fx-page-tab',
              active && 'is-active',
              !closable && 'is-pinned',
              page.dirty && 'is-dirty',
              draggingKey === page.id && 'is-drag',
            );
            return (
              <button
                key={page.id}
                type="button"
                className={tabClass}
                role="tab"
                aria-selected={active}
                data-page-id={page.id}
                data-dirty={page.dirty ? '1' : undefined}
                title={page.tooltip ?? page.resourcePath ?? page.title}
                onClick={() => handleTabClick(page.id)}
                onAuxClick={(event) => {
                  if (event.button === 1 && closable) {
                    event.preventDefault();
                    closePage(page.id);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ x: event.clientX, y: event.clientY, pageId: page.id });
                }}
                onPointerDown={(event) => handlePointerDown(event, page.id)}
              >
                <Icon className="fx-page-tab__icon" aria-hidden />
                <span className="fx-page-tab__label">{page.title}</span>
                {page.dirty ? <span className="fx-page-tab__dirty" aria-hidden>*</span> : null}
                {closable ? (
                  <span
                    className="fx-page-tab__close"
                    role="button"
                    aria-label={labels.closeTab}
                    data-page-close={page.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      closePage(page.id);
                    }}
                  >
                    <X className="fx-page-tab__close-icon" aria-hidden />
                  </span>
                ) : (
                  <Pin className="fx-page-tab__pin" aria-hidden />
                )}
              </button>
            );
          })}
        </div>

        <button
          ref={newButtonRef}
          type="button"
          className="fx-page-tab-btn fx-page-tab-btn--new"
          title={labels.newPage}
          aria-label={labels.newPage}
          aria-haspopup="menu"
          aria-expanded={newMenu.open}
          aria-controls={`${menuId}-new`}
          onClick={() => {
            if (newMenu.open) newMenu.setOpen(false);
            else newMenu.openAtAnchor('start');
          }}
        >
          <Plus className="fx-page-tab-btn__icon" aria-hidden />
        </button>

        <div className="fx-page-tab-strip__actions">
          {overflowing ? (
            <button
              ref={overflowButtonRef}
              type="button"
              className="fx-page-tab-btn"
              title={labels.allPages}
              aria-haspopup="menu"
              aria-expanded={overflowMenu.open}
              aria-controls={`${menuId}-overflow`}
              onClick={() => {
                if (overflowMenu.open) overflowMenu.setOpen(false);
                else overflowMenu.openAtAnchor('end');
              }}
            >
              <ChevronsRight className="fx-page-tab-btn__icon" aria-hidden />
              <span>{pages.length}</span>
            </button>
          ) : null}
        </div>
      </div>

      {trailing}
      <ContextMenu
        open={contextMenu !== null}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={contextItems}
        onClose={() => setContextMenu(null)}
        label={contextPage?.title ?? labels.tabList}
      />

      <ContextMenu
        open={newMenu.open}
        x={newMenu.position.x}
        y={newMenu.position.y}
        items={newPageMenuItems}
        onClose={() => newMenu.setOpen(false)}
        label={labels.newPage}
        containerProps={{ id: `${menuId}-new` }}
      />

      <ContextMenu
        open={overflowMenu.open}
        x={overflowMenu.position.x}
        y={overflowMenu.position.y}
        items={overflowMenuItems}
        onClose={() => overflowMenu.setOpen(false)}
        label={labels.allPages}
        containerProps={{ id: `${menuId}-overflow` }}
      />
    </div>
  );
}
