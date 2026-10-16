import { AlertCircle, Check, Copy, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { useClipboard } from './clipboard';
import { Button, IconButton, Text } from './components';

export type ErrorNoticeInput = {
  title: ReactNode;
  description?: ReactNode;
  hint?: ReactNode;
  code?: string;
  details?: ReactNode;
  detailsLabel?: string;
  /** Plain text written to the clipboard when the user copies details. */
  copyText?: string;
  copyLabel?: string;
  copiedLabel?: string;
  /** Default true: stays until the user clicks close. */
  persistent?: boolean;
  /** Used only when persistent is false. */
  duration?: number;
  closeLabel?: string;
  onDismiss?: () => void;
};

export type ErrorNoticeItem = ErrorNoticeInput & {
  id: number;
  persistent: boolean;
};

export type ErrorNoticeProps = ErrorNoticeInput & {
  id?: number;
  onClose: () => void;
};

type Listener = () => void;

let nextId = 0;
let notices: ErrorNoticeItem[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeErrorNotices(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getErrorNotices() {
  return notices;
}

export function showErrorNotice(input: ErrorNoticeInput): number {
  const id = ++nextId;
  const persistent = input.persistent !== false;
  notices = [...notices, { ...input, id, persistent }];
  emit();
  if (!persistent) {
    const duration = input.duration ?? 8000;
    if (duration > 0) {
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          dismissErrorNotice(id);
        }, duration),
      );
    }
  }
  return id;
}

export function dismissErrorNotice(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const current = notices.find((notice) => notice.id === id);
  if (!current) return;
  notices = notices.filter((notice) => notice.id !== id);
  emit();
  current.onDismiss?.();
}

function resolveCopyText(copyText?: string, details?: ReactNode) {
  if (typeof copyText === 'string' && copyText.trim() !== '') return copyText;
  if (typeof details === 'string' && details.trim() !== '') return details;
  return undefined;
}

export function ErrorNotice({
  title,
  description,
  hint,
  code,
  details,
  detailsLabel = '详细信息',
  copyText,
  copyLabel = '复制详细信息',
  copiedLabel = '已复制',
  closeLabel = '关闭错误提示',
  onClose,
}: ErrorNoticeProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const writeClipboard = useClipboard();
  const clipboardText = resolveCopyText(copyText, details);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopyDetails() {
    if (!clipboardText) return;
    try {
      await writeClipboard(clipboardText);
      setCopyError(null);
      setCopied(true);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="fx-error-notice fx-status--error" role="alert">
      <AlertCircle className="fx-icon fx-error-notice__icon" aria-hidden />
      <div className="fx-error-notice__body">
        {copyError ? <Text role="status" tone="secondary">{copyError}</Text> : null}
        <strong className="fx-error-notice__title">{title}</strong>
        {code ? (
          <Text as="code" variant="code" className="fx-error-notice__code">
            {code}
          </Text>
        ) : null}
        {description ? (
          <Text variant="body" className="fx-error-notice__description">
            {description}
          </Text>
        ) : null}
        {hint ? (
          <Text variant="caption" className="fx-error-notice__hint">
            {hint}
          </Text>
        ) : null}
        {details ? (
          <details className="fx-error-notice__details" open>
            <summary className="fx-error-notice__details-summary">
              <span>{detailsLabel}</span>
              {clipboardText ? (
                <Button
                  type="button"
                  variant="quiet"
                  size="compact"
                  className="fx-error-notice__copy"
                  leadingIcon={
                    copied ? (
                      <Check className="fx-icon" aria-hidden />
                    ) : (
                      <Copy className="fx-icon" aria-hidden />
                    )
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleCopyDetails();
                  }}
                >
                  {copied ? copiedLabel : copyLabel}
                </Button>
              ) : null}
            </summary>
            <pre className="fx-error-notice__details-body">{details}</pre>
          </details>
        ) : null}
      </div>
      <IconButton
        label={closeLabel}
        icon={<X className="fx-icon" />}
        variant="quiet"
        size="compact"
        onClick={onClose}
      />
    </div>
  );
}

const STACK_PEEK = 8;
const STACK_GAP = 8;
const STACK_MAX_BEHIND = 2;

function stackMetrics(items: ErrorNoticeItem[], heights: Record<number, number>, expanded: boolean) {
  const heightOf = (id: number) => heights[id] ?? 0;
  const frontHeight = items[0] ? heightOf(items[0].id) : 0;
  let y = 0;
  const slots = items.map((item, index) => {
    const height = heightOf(item.id);
    const peekIndex = Math.min(index, STACK_MAX_BEHIND);
    const slotY = expanded ? y : Math.max(0, frontHeight - height + peekIndex * STACK_PEEK);
    if (expanded) y += height + STACK_GAP;
    return {
      id: item.id,
      y: slotY,
      z: items.length - index,
      interactive: expanded || index === 0,
    };
  });
  const stackHeight = expanded
    ? items.reduce((sum, item, index) => sum + heightOf(item.id) + (index > 0 ? STACK_GAP : 0), 0)
    : frontHeight + Math.min(Math.max(items.length - 1, 0), STACK_MAX_BEHIND) * STACK_PEEK;
  return { slots, stackHeight };
}

export function ErrorNoticeStack({
  items,
  inline = false,
  onClose,
}: {
  items: ErrorNoticeItem[];
  inline?: boolean;
  onClose: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const slotNodes = useRef(new Map<number, HTMLDivElement>());
  const stacked = items.length > 1;
  const open = stacked && expanded;

  const measure = useCallback(() => {
    setHeights((current) => {
      let changed = Object.keys(current).length !== items.length;
      const next: Record<number, number> = {};
      for (const item of items) {
        const height = slotNodes.current.get(item.id)?.offsetHeight ?? 0;
        next[item.id] = height;
        if (current[item.id] !== height) changed = true;
      }
      return changed ? next : current;
    });
  }, [items]);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    for (const item of items) {
      const node = slotNodes.current.get(item.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [items, measure]);

  const { slots, stackHeight } = useMemo(
    () => stackMetrics(items, heights, open),
    [items, heights, open],
  );

  if (items.length === 0) return null;

  return (
    <div
      className={['fx-error-notice-region', 'fx-ui', inline && 'fx-error-notice-region--inline']
        .filter(Boolean)
        .join(' ')}
      aria-live="assertive"
      data-count={items.length}
      data-expanded={open ? '' : undefined}
      data-ready={items.every((item) => (heights[item.id] ?? 0) > 0) ? '' : undefined}
      onMouseEnter={stacked ? () => setExpanded(true) : undefined}
      onMouseLeave={stacked ? () => setExpanded(false) : undefined}
      onFocus={stacked ? () => setExpanded(true) : undefined}
      onBlur={
        stacked
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setExpanded(false);
              }
            }
          : undefined
      }
      style={
        {
          '--fx-error-notice-stack-height': `${stackHeight}px`,
        } as CSSProperties
      }
    >
      {items.map((notice) => {
        const slot = slots.find((entry) => entry.id === notice.id)!;
        return (
          <div
            className="fx-error-notice-slot"
            key={notice.id}
            ref={(node) => {
              if (node) slotNodes.current.set(notice.id, node);
              else slotNodes.current.delete(notice.id);
            }}
            data-inert={slot.interactive ? undefined : ''}
            style={
              {
                '--fx-error-notice-y': `${slot.y}px`,
                '--fx-error-notice-z': slot.z,
              } as CSSProperties
            }
          >
            <ErrorNotice
              {...notice}
              {...(notice.closeLabel === undefined ? {} : { closeLabel: notice.closeLabel })}
              onClose={() => onClose(notice.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

export function ErrorNoticeHost() {
  const items = useSyncExternalStore(subscribeErrorNotices, getErrorNotices, getErrorNotices);
  const ordered = useMemo(() => [...items].reverse(), [items]);
  if (typeof document === 'undefined' || ordered.length === 0) return null;
  return createPortal(
    <ErrorNoticeStack items={ordered} onClose={dismissErrorNotice} />,
    document.body,
  );
}
