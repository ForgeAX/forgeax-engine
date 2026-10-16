import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  cloneElement,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type ElementType,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import {
  resolveFloatingMenuPosition,
  resolveMenuDropdownPosition,
  type AnchorRect,
} from './menuPlacement';

const OverlayRootContext = createContext<HTMLElement | null>(null);
/** The embedding owner supplies the lifetime and document of all View overlays. */
export function OverlayRootProvider({ root, children }: { root: HTMLElement; children: ReactNode }) {
  return <OverlayRootContext.Provider value={root}>{children}</OverlayRootContext.Provider>;
}
export function useOverlayRoot() { return useContext(OverlayRootContext); }

function classes(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ');
}

export type TextVariant =
  | 'title'
  | 'heading'
  | 'body'
  | 'ui'
  | 'label'
  | 'compact'
  | 'caption'
  | 'code';

export type TextProps = HTMLAttributes<HTMLElement> & {
  as?: ElementType;
  variant?: TextVariant;
  tone?: 'primary' | 'secondary' | 'muted';
};

export function Text({
  as: Component = 'p',
  variant = 'ui',
  tone = 'primary',
  className,
  ...props
}: TextProps) {
  return (
    <Component
      {...props}
      className={classes(
        'fx-text',
        `fx-text--${variant}`,
        tone !== 'primary' && `fx-text--${tone}`,
        className,
      )}
    />
  );
}

export type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  tone?: 'canvas' | 'sidebar' | 'raised' | 'inset';
  card?: boolean;
};

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { tone = 'canvas', card = false, className, ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={classes('fx-surface', `fx-surface--${tone}`, card && 'fx-surface--card', className)}
    />
  );
});

export function Divider(props: ComponentPropsWithoutRef<'hr'>) {
  return <hr {...props} className={classes('fx-divider', props.className)} />;
}

export function Icon({
  icon: Glyph,
  label,
  className,
}: {
  icon: LucideIcon;
  label?: string;
  className?: string;
}) {
  return (
    <Glyph
      className={classes('fx-icon', className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}

export const Link = forwardRef<HTMLAnchorElement, ComponentPropsWithoutRef<'a'>>(function Link(
  { className, ...props },
  ref,
) {
  return <a {...props} ref={ref} className={classes('fx-link', className)} />;
});

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ControlSize = 'compact' | 'default' | 'large';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'default',
    loading = false,
    leadingIcon,
    trailingIcon,
    disabled,
    className,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes(
        'fx-button',
        `fx-button--${variant}`,
        size !== 'default' && `fx-button--${size}`,
        className,
      )}
    >
      {loading ? <LoaderCircle className="fx-icon fx-button__spinner" aria-hidden /> : leadingIcon}
      {children}
      {!loading && trailingIcon}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonProps, 'children' | 'leadingIcon' | 'trailingIcon'> & {
  label: string;
  icon: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, ...props },
  ref,
) {
  return (
    <Button
      {...props}
      ref={ref}
      aria-label={label}
      title={props.title ?? label}
      className={classes('fx-button--icon', className)}
    >
      {icon}
    </Button>
  );
});

export type FieldProps = HTMLAttributes<HTMLDivElement> & {
  label: ReactNode;
  htmlFor?: string;
  note?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
};

export function Field({ label, htmlFor, note, error, children, className, ...props }: FieldProps) {
  return (
    <div {...props} className={classes('fx-field', className)}>
      <label className="fx-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {(error || note) && (
        <p className={classes('fx-field__note', Boolean(error) && 'fx-field__error')} role={error ? 'alert' : undefined}>
          {error ?? note}
        </p>
      )}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...props }, ref) {
    return <input {...props} ref={ref} className={classes('fx-input', className)} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select {...props} ref={ref} className={classes('fx-input', className)}>
        {children}
      </select>
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...props }, ref) {
    return <textarea {...props} ref={ref} className={classes('fx-input', className)} />;
  },
);

export type ChoiceTextProps = {
  label: ReactNode;
  description?: ReactNode;
  hideLabel?: boolean;
};

function ChoiceText({ label, description, hideLabel }: ChoiceTextProps) {
  return (
    <span className="fx-choice__text">
      <span className={classes('fx-choice__label', hideLabel && 'fx-visually-hidden')}>{label}</span>
      {description ? (
        <span className={classes('fx-choice__description', hideLabel && 'fx-visually-hidden')}>{description}</span>
      ) : null}
    </span>
  );
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> &
  ChoiceTextProps & {
    indeterminate?: boolean;
  };

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, hideLabel, className, indeterminate, ...props },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);

  return (
    <label className={classes('fx-choice', 'fx-choice--checkbox', className)}>
      <input {...props} ref={inputRef} type="checkbox" />
      <ChoiceText label={label} description={description} {...(hideLabel === undefined ? {} : { hideLabel })} />
    </label>
  );
});

export type CheckboxGroupOption = {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
};

// `Omit<...HTMLAttributes...>` drops the template index signature JSX grants
// intrinsic elements, so prop bags that forward to host elements re-declare
// `data-*` support explicitly.
type DataAttributes = { [attribute: `data-${string}`]: unknown };

export type CheckboxGroupProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  name?: string;
  value?: string[];
  defaultValue?: string[];
  options: CheckboxGroupOption[];
  onChange?: (value: string[]) => void;
  layout?: 'horizontal' | 'vertical';
  legend?: ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
};

export function CheckboxGroup({
  name,
  value,
  defaultValue,
  options,
  onChange,
  layout = 'horizontal',
  legend,
  disabled,
  className,
  'aria-label': ariaLabel,
  ...props
}: CheckboxGroupProps) {
  const legendId = useId();
  const fallbackName = useId();
  const [internalValue, setInternalValue] = useState<string[]>(defaultValue ?? []);
  const selected = value ?? internalValue;
  const setSelected = (next: string[]) => {
    if (value === undefined) setInternalValue(next);
    onChange?.(next);
  };
  const groupName = name ?? fallbackName;

  return (
    <div
      {...props}
      role="group"
      aria-labelledby={legend ? legendId : undefined}
      aria-label={legend ? undefined : ariaLabel}
      className={classes('fx-choice-set', className)}
    >
      {legend ? (
        <span id={legendId} className="fx-choice-set__legend">
          {legend}
        </span>
      ) : null}
      <div className={classes('fx-choice-group', layout === 'vertical' && 'fx-choice-group--vertical')}>
        {options.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <Checkbox
              key={option.value}
              name={groupName}
              value={option.value}
              label={option.label}
              description={option.description}
              checked={checked}
              disabled={disabled || option.disabled}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selected, option.value]
                  : selected.filter((entry) => entry !== option.value);
                setSelected(next);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & ChoiceTextProps;

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, description, hideLabel, className, ...props },
  ref,
) {
  return (
    <label className={classes('fx-choice', 'fx-choice--radio', className)}>
      <input {...props} ref={ref} type="radio" />
      <ChoiceText label={label} description={description} {...(hideLabel === undefined ? {} : { hideLabel })} />
    </label>
  );
});

export type RadioOption = {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
};

export type RadioGroupProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  name: string;
  value?: string;
  defaultValue?: string;
  options: RadioOption[];
  onChange?: (value: string) => void;
  layout?: 'horizontal' | 'vertical';
  legend?: ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
};

export function RadioGroup({
  name,
  value,
  defaultValue,
  options,
  onChange,
  layout = 'horizontal',
  legend,
  disabled,
  className,
  'aria-label': ariaLabel,
  ...props
}: RadioGroupProps) {
  const legendId = useId();
  const controlled = value !== undefined;

  return (
    <div
      {...props}
      role="radiogroup"
      aria-labelledby={legend ? legendId : undefined}
      aria-label={legend ? undefined : ariaLabel}
      className={classes('fx-choice-set', className)}
    >
      {legend ? (
        <span id={legendId} className="fx-choice-set__legend">
          {legend}
        </span>
      ) : null}
      <div className={classes('fx-choice-group', layout === 'vertical' && 'fx-choice-group--vertical')}>
        {options.map((option) => (
          <Radio
            key={option.value}
            name={name}
            value={option.value}
            label={option.label}
            description={option.description}
            checked={controlled ? value === option.value : undefined}
            defaultChecked={controlled ? undefined : defaultValue === option.value}
            disabled={disabled || option.disabled}
            onChange={() => onChange?.(option.value)}
          />
        ))}
      </div>
    </div>
  );
}

export const RangeInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function RangeInput({ className, type, ...props }, ref) {
    return <input {...props} ref={ref} type={type ?? 'range'} className={classes('fx-range', className)} />;
  },
);

export type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
  hideLabel?: boolean;
  layout?: 'inline' | 'row';
};

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked,
    defaultChecked,
    onCheckedChange,
    label,
    hideLabel,
    layout = 'inline',
    className,
    disabled,
    onClick,
    ...props
  },
  ref,
) {
  const [internalChecked, setInternalChecked] = useState(Boolean(defaultChecked));
  const isChecked = checked ?? internalChecked;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || disabled) return;
    const next = !isChecked;
    if (checked === undefined) setInternalChecked(next);
    onCheckedChange?.(next);
  };

  return (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={isChecked}
      disabled={disabled}
      className={classes('fx-switch', layout === 'row' && 'fx-switch--row', className)}
      onClick={handleClick}
    >
      {label ? (
        <span className={classes('fx-switch__label', hideLabel && 'fx-visually-hidden')}>{label}</span>
      ) : null}
      <span className="fx-switch__track" aria-hidden="true">
        <span className="fx-switch__thumb" />
      </span>
    </button>
  );
});

export function Spinner({ label = '正在加载', className }: { label?: string; className?: string }) {
  return <span className={classes('fx-spinner', className)} role="status" aria-label={label} />;
}

export type StatusTone = 'success' | 'warning' | 'error' | 'info';

const statusIcons: Record<StatusTone, LucideIcon> = {
  success: CircleCheck,
  warning: CircleAlert,
  error: AlertCircle,
  info: Info,
};

export type StatusProps = HTMLAttributes<HTMLSpanElement> & {
  tone: StatusTone;
  pill?: boolean;
  icon?: ReactNode;
  showIcon?: boolean;
};

export function Status({
  tone,
  pill = false,
  icon,
  showIcon = true,
  children,
  className,
  ...props
}: StatusProps) {
  const Icon = statusIcons[tone];
  return (
    <span
      {...props}
      className={classes('fx-status', `fx-status--${tone}`, pill && 'fx-status--pill', className)}
    >
      {showIcon ? (icon ?? <Icon className="fx-icon" aria-hidden />) : null}
      {children}
    </span>
  );
}

export type InlineFeedbackProps = HTMLAttributes<HTMLDivElement> & {
  tone: StatusTone;
  title: ReactNode;
  action?: ReactNode;
};

export function InlineFeedback({
  tone,
  title,
  action,
  children,
  className,
  ...props
}: InlineFeedbackProps) {
  const Icon = statusIcons[tone];
  return (
    <div
      {...props}
      role={tone === 'error' ? 'alert' : 'status'}
      className={classes('fx-feedback', `fx-status--${tone}`, className)}
    >
      <Icon className="fx-icon" aria-hidden />
      <div className="fx-feedback__body">
        <strong>{title}</strong>
        {children}
      </div>
      {action}
    </div>
  );
}

export type EmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode;
  description: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
};

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div {...props} className={classes('fx-empty', className)}>
      {icon}
      <Text as="strong" variant="heading">{title}</Text>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function LoadingState({
  title = '正在加载',
  description,
}: {
  title?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="fx-empty" role="status" aria-live="polite">
      <Spinner label={typeof title === 'string' ? title : '正在加载'} />
      <Text as="strong" variant="heading">{title}</Text>
      {description && <p>{description}</p>}
    </div>
  );
}

export type PanelHeaderProps = HTMLAttributes<HTMLElement> & {
  start?: ReactNode;
  center?: ReactNode;
  end?: ReactNode;
};

export function PanelHeader({ start, center, end, className, ...props }: PanelHeaderProps) {
  return (
    <header {...props} className={classes('fx-panel-header', className)}>
      <div className="fx-panel-header__slot">{start}</div>
      <div className="fx-panel-header__slot">{center}</div>
      <div className="fx-panel-header__slot">{end}</div>
    </header>
  );
}

export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} role={props.role ?? 'toolbar'} className={classes('fx-toolbar', className)} />;
}

export type SearchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label?: string;
  onClear?: () => void;
};

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { label = '搜索', onClear, value, className, ...props },
  ref,
) {
  const hasValue = value != null && String(value).length > 0;
  return (
    <div className={classes('fx-search', className)}>
      <Search className="fx-icon fx-search__leading" aria-hidden />
      <TextInput {...props} ref={ref} type="search" value={value} aria-label={label} />
      {hasValue && onClear && (
        <IconButton
          className="fx-search__clear"
          label="清除搜索"
          icon={<X className="fx-icon" />}
          variant="quiet"
          size="compact"
          onClick={onClear}
        />
      )}
    </div>
  );
});

export type MenuItem =
  | { type: 'title'; label: ReactNode }
  | { type: 'separator' }
  | {
      type?: 'item';
      id: string;
      label: ReactNode;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      selected?: boolean;
      onSelect?: () => void;
      buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'disabled' | 'onClick'> & DataAttributes;
    };

export function Menu({
  items,
  label = '菜单',
  className,
}: {
  items: MenuItem[];
  label?: string;
  className?: string;
}) {
  return (
    <div className={classes('fx-menu', className)} role="menu" aria-label={label}>
      {items.map((item, index) => {
        if (item.type === 'separator') {
          return <div className="fx-menu__separator" role="separator" key={`separator-${index}`} />;
        }
        if (item.type === 'title') {
          return <div className="fx-menu__title" key={`title-${index}`}>{item.label}</div>;
        }
        const { className: itemClassName, ...buttonProps } = item.buttonProps ?? {};
        return (
          <button
            {...buttonProps}
            type="button"
            role="menuitem"
            key={item.id}
            disabled={item.disabled}
            aria-selected={item.selected || undefined}
            className={classes(
              'fx-menu__item',
              item.selected && 'fx-menu__item--selected',
              item.danger && 'fx-menu__item--danger',
              itemClassName,
            )}
            onClick={item.onSelect}
          >
            <span className="fx-menu__leading" aria-hidden>
              {item.selected ? <Check className="fx-icon" /> : item.icon}
            </span>
            <span className="fx-menu__label">{item.label}</span>
            {item.shortcut && <kbd className="fx-menu__shortcut">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

export type FloatingMenuProps = {
  open: boolean;
  anchorRect: AnchorRect | null;
  onClose?: () => void;
  gap?: number;
  className?: string;
  ignorePointerWithin?: RefObject<HTMLElement | null>[];
  containerProps?: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & DataAttributes;
  children: ReactNode;
};

export function FloatingMenu({
  open,
  anchorRect,
  onClose,
  gap = 8,
  className,
  ignorePointerWithin,
  containerProps,
  children,
}: FloatingMenuProps) {
  const overlayRoot = useOverlayRoot();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  const updatePosition = useCallback(() => {
    if (!open || !anchorRect || !menuRef.current) return;
    const { width, height } = menuRef.current.getBoundingClientRect();
    const resolved = resolveFloatingMenuPosition(anchorRect, width, height, { gap });
    setPosition({ x: resolved.x, y: resolved.y });
    setVisible(true);
  }, [anchorRect, gap, open]);

  useLayoutEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    setVisible(false);
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition, children]);

  useEffect(() => {
    if (!open || !onClose) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (ignorePointerWithin?.some((ref) => ref.current?.contains(target))) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [ignorePointerWithin, onClose, open]);

  if (!open || !anchorRect || typeof document === 'undefined') return null;
  const {
    className: containerClassName,
    style: containerStyle,
    onPointerDown,
    ...restContainerProps
  } = containerProps ?? {};
  return createPortal(
    <div
      {...restContainerProps}
      ref={menuRef}
      className={classes('fx-menu-position', 'fx-ui', className, containerClassName)}
      style={{
        ...containerStyle,
        left: position.x,
        top: position.y,
        visibility: visible ? 'visible' : 'hidden',
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
    >
      {children}
    </div>,
    overlayRoot ?? document.body,
  );
}

export type ContextMenuProps = {
  open: boolean;
  items: MenuItem[];
  onClose: () => void;
  label?: string;
  containerProps?: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & DataAttributes;
  x?: number;
  y?: number;
  anchorRect?: AnchorRect | null;
  gap?: number;
};

export type MenuDropdownProps = {
  label?: string;
  items: MenuItem[];
  align?: 'start' | 'end';
  className?: string;
  trigger: ReactElement<{
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
    'aria-expanded'?: boolean;
    'aria-haspopup'?: boolean | 'menu';
  }>;
};

export function MenuDropdown({ label = '菜单', items, align = 'end', className, trigger }: MenuDropdownProps) {
  const overlayRoot = useOverlayRoot();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  const menuItems = useMemo(
    () =>
      items.map((item) =>
        item.type === undefined || item.type === 'item'
          ? {
              ...item,
              onSelect: () => {
                item.onSelect?.();
                setOpen(false);
              },
            }
          : item,
      ),
    [items],
  );

  const repositionMenu = useCallback(() => {
    if (!open || !anchorRef.current || !menuRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const { width, height } = menuRef.current.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const resolved = resolveMenuDropdownPosition(anchor, width, height, align, { gap: 4 });
    setPosition(resolved);
    setVisible(true);
  }, [align, open]);

  useLayoutEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    setVisible(false);
    repositionMenu();
    const menuEl = menuRef.current;
    const observer = menuEl ? new ResizeObserver(() => repositionMenu()) : null;
    if (menuEl && observer) observer.observe(menuEl);
    const onLayout = () => repositionMenu();
    window.addEventListener('resize', onLayout);
    window.addEventListener('scroll', onLayout, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onLayout);
      window.removeEventListener('scroll', onLayout, true);
    };
  }, [open, repositionMenu, menuItems]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerElement = cloneElement(trigger, {
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      trigger.props.onClick?.(event);
      if (event.defaultPrevented) return;
      setOpen((current) => !current);
    },
  });

  return (
    <>
      <span className="fx-menu-dropdown__anchor" ref={anchorRef}>
        {triggerElement}
      </span>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            className={classes('fx-menu-position', 'fx-ui', className)}
            style={{
              left: position.x,
              top: position.y,
              visibility: visible ? 'visible' : 'hidden',
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Menu label={label} items={menuItems} />
          </div>,
          overlayRoot ?? document.body,
        )}
    </>
  );
}

export function ContextMenu({
  open,
  x = 0,
  y = 0,
  anchorRect = null,
  gap = 8,
  items,
  onClose,
  label,
  containerProps,
}: ContextMenuProps) {
  const overlayRoot = useOverlayRoot();
  useEffect(() => {
    if (!open || anchorRect) return;
    const close = () => onClose();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [anchorRect, onClose, open]);

  if (anchorRect) {
    return (
      <FloatingMenu
        open={open}
        anchorRect={anchorRect}
        onClose={onClose}
        gap={gap}
        {...(containerProps === undefined ? {} : { containerProps })}
      >
        <Menu
          {...(label === undefined ? {} : { label })}
          items={items.map((item) =>
            item.type === undefined || item.type === 'item'
              ? { ...item, onSelect: () => { item.onSelect?.(); onClose(); } }
              : item,
          )}
        />
      </FloatingMenu>
    );
  }

  if (!open || typeof document === 'undefined') return null;
  const {
    className: containerClassName,
    style: containerStyle,
    onPointerDown,
    ...positionProps
  } = containerProps ?? {};
  return createPortal(
    <div
      {...positionProps}
      className={classes('fx-menu-position', 'fx-ui', containerClassName)}
      style={{ ...containerStyle, left: x, top: y }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
    >
      <Menu
        items={items.map((item) =>
          item.type === undefined || item.type === 'item'
            ? { ...item, onSelect: () => { item.onSelect?.(); onClose(); } }
            : item,
        )}
        {...(label === undefined ? {} : { label })}
      />
    </div>,
    overlayRoot ?? document.body,
  );
}

type DialogBaseProps = {
  open: boolean;
  /** Keep the surrounding workspace interactive when false. */
  modal?: boolean;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeLabel?: string;
};

export type DialogProps =
  | (DialogBaseProps & { dismissible?: true; onClose: () => void })
  | (DialogBaseProps & { dismissible: false; onClose?: () => void });

export function Dialog({
  open,
  modal = true,
  title,
  children,
  footer,
  className,
  dismissible = true,
  onClose,
  initialFocusRef,
  closeLabel = '关闭弹窗',
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      if (modal) dialog.showModal();
      else dialog.show();
      requestAnimationFrame(() => initialFocusRef?.current?.focus());
    }
    if (!open && dialog.open) {
      dialog.close();
      returnFocusRef.current?.focus();
    }
  }, [initialFocusRef, modal, open]);

  return (
    <dialog
      ref={ref}
      className={classes('fx-dialog', 'fx-ui', className)}
      aria-labelledby={titleId}
      data-dismissible={dismissible ? 'true' : 'false'}
      closedby={dismissible ? 'closerequest' : 'none'}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose?.();
      }}
      onClose={() => {
        if (dismissible) {
          onClose?.();
          return;
        }
        requestAnimationFrame(() => {
          const dialog = ref.current;
          if (open && dialog && !dialog.open) {
            if (modal) dialog.showModal();
            else dialog.show();
            initialFocusRef?.current?.focus();
          }
        });
      }}
    >
      <div className="fx-dialog__header">
        <Text as="h2" id={titleId} variant="heading">{title}</Text>
        {dismissible ? (
          <IconButton label={closeLabel} icon={<X className="fx-icon" />} variant="quiet" onClick={onClose} />
        ) : null}
      </div>
      <div className="fx-dialog__body">{children}</div>
      {footer && <div className="fx-dialog__footer">{footer}</div>}
    </dialog>
  );
}

export type TooltipProps = {
  /** Free-form body when title/description are not used. */
  content?: ReactNode;
  /** Primary line; pairs with description for the standard two-line pattern. */
  title?: ReactNode;
  /** Secondary line in muted caption tone. */
  description?: ReactNode;
  children: ReactNode;
  /** Default opens above the anchor; use bottom for top-of-viewport controls. */
  placement?: 'top' | 'bottom';
  /** Render in the supplied overlay root, or document.body for standalone use. */
  portaled?: boolean;
  /** When true, keeps the tooltip visible until unmounted (not dismissed by hover/focus leave). */
  open?: boolean;
};

function TooltipBody({ title, description, content }: Pick<TooltipProps, 'title' | 'description' | 'content'>) {
  if (title != null || description != null) {
    return (
      <div className="fx-tooltip__content">
        {title != null && <div className="fx-tooltip__title">{title}</div>}
        {description != null && <div className="fx-tooltip__description">{description}</div>}
      </div>
    );
  }
  return <div className="fx-tooltip__content">{content}</div>;
}

const TOOLTIP_VIEWPORT_MARGIN = 12;
const TOOLTIP_ANCHOR_GAP = 10;

function clampTooltipPosition(
  anchor: DOMRect,
  tip: DOMRect,
  placement: 'top' | 'bottom',
): { x: number; y: number; placement: 'top' | 'bottom' } {
  let x = anchor.left + anchor.width / 2;
  const half = tip.width / 2;
  const minX = TOOLTIP_VIEWPORT_MARGIN + half;
  const maxX = window.innerWidth - TOOLTIP_VIEWPORT_MARGIN - half;
  x = Math.min(Math.max(x, minX), maxX);

  let resolved = placement;
  let y =
    placement === 'top'
      ? anchor.top - TOOLTIP_ANCHOR_GAP
      : anchor.bottom + TOOLTIP_ANCHOR_GAP;

  if (placement === 'bottom') {
    if (y + tip.height > window.innerHeight - TOOLTIP_VIEWPORT_MARGIN) {
      resolved = 'top';
      y = anchor.top - TOOLTIP_ANCHOR_GAP;
    }
  } else if (y - tip.height < TOOLTIP_VIEWPORT_MARGIN) {
    resolved = 'bottom';
    y = anchor.bottom + TOOLTIP_ANCHOR_GAP;
  }

  return { x, y, placement: resolved };
}

export function Tooltip({
  content,
  title,
  description,
  children,
  placement = 'top',
  portaled = false,
  open = false,
}: TooltipProps) {
  const overlayRoot = useOverlayRoot();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [hoverVisible, setHoverVisible] = useState(false);
  const visible = open || hoverVisible;
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const [resolvedPlacement, setResolvedPlacement] = useState(placement);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateCoords = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const tip = tooltipRef.current?.getBoundingClientRect();
    if (tip && tip.width > 0) {
      const next = clampTooltipPosition(anchor, tip, placement);
      setCoords({ x: next.x, y: next.y });
      setResolvedPlacement(next.placement);
      return;
    }
    setCoords({
      x: anchor.left + anchor.width / 2,
      y: placement === 'top' ? anchor.top - TOOLTIP_ANCHOR_GAP : anchor.bottom + TOOLTIP_ANCHOR_GAP,
    });
    setResolvedPlacement(placement);
  }, [placement]);

  useLayoutEffect(() => {
    if (!visible) return;
    updateCoords();
    if (!portaled) return;
    const onLayout = () => updateCoords();
    window.addEventListener('resize', onLayout);
    window.addEventListener('scroll', onLayout, true);
    return () => {
      window.removeEventListener('resize', onLayout);
      window.removeEventListener('scroll', onLayout, true);
    };
  }, [portaled, updateCoords, visible]);

  const show = () => {
    if (open) return;
    timer.current = setTimeout(() => {
      setHoverVisible(true);
    }, 400);
  };
  const hide = () => {
    if (open) return;
    if (timer.current) clearTimeout(timer.current);
    setHoverVisible(false);
    setResolvedPlacement(placement);
  };

  const effectivePlacement = portaled ? resolvedPlacement : placement;

  const tooltipStyle = portaled
    ? {
        left: coords.x,
        top: coords.y,
        transform:
          effectivePlacement === 'top'
            ? 'translate(-50%, -100%)'
            : 'translate(-50%, 0)',
      }
    : undefined;

  const tooltip = visible ? (
    <span
      ref={tooltipRef}
      className={classes(
        'fx-tooltip',
        effectivePlacement === 'bottom' ? 'fx-tooltip--bottom' : 'fx-tooltip--top',
        portaled && 'fx-tooltip--fixed',
        open && 'fx-tooltip--interactive',
      )}
      style={tooltipStyle}
      role="tooltip"
    >
      <TooltipBody title={title} description={description} content={content} />
    </span>
  ) : null;

  return (
    <span
      ref={anchorRef}
      className="fx-tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {portaled && typeof document !== 'undefined'
        ? tooltip && createPortal(tooltip, overlayRoot ?? document.body)
        : tooltip}
    </span>
  );
}

type Toast = {
  id: number;
  tone: StatusTone;
  title: ReactNode;
  description?: ReactNode;
  /** When true, or when duration is 0, the toast stays until the user closes it. */
  persistent?: boolean;
  duration?: number;
};

type ToastContextValue = {
  notify: (toast: Omit<Toast, 'id'>) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children, duration = 4000 }: { children: ReactNode; duration?: number }) {
  const overlayRoot = useOverlayRoot();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const id = useRef(0);
  const dismiss = useCallback((toastId: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, []);
  const notify = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const toastId = ++id.current;
      setToasts((current) => [...current, { ...toast, id: toastId }]);
      const persist = toast.persistent === true || toast.duration === 0;
      if (!persist) {
        window.setTimeout(() => dismiss(toastId), toast.duration ?? duration);
      }
    },
    [dismiss, duration],
  );
  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="fx-toast-region fx-ui" aria-live="polite">
            {toasts.map((toast) => (
              <div
                className={classes('fx-toast', toast.tone === 'error' && 'fx-toast--error')}
                key={toast.id}
              >
                <Status tone={toast.tone} aria-label={toast.tone} />
                <div className="fx-toast__body">
                  <strong>{toast.title}</strong>
                  {toast.description && <Text variant="caption">{toast.description}</Text>}
                </div>
                <IconButton
                  label="关闭通知"
                  icon={<X className="fx-icon" />}
                  variant="quiet"
                  size="compact"
                  onClick={() => dismiss(toast.id)}
                />
              </div>
            ))}
          </div>,
          overlayRoot ?? document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}

export type NavigationItem = {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
};

export function NavigationRail({
  items,
  activeId,
  onSelect,
  label = '主导航',
}: {
  items: NavigationItem[];
  activeId: string;
  onSelect: (id: string) => void;
  label?: string;
}) {
  return (
    <nav className="fx-navigation-rail" aria-label={label}>
      {items.map((item) => (
        <button
          type="button"
          className="fx-navigation-rail__item"
          key={item.id}
          aria-label={item.label}
          title={item.label}
          aria-current={activeId === item.id ? 'page' : undefined}
          disabled={item.disabled}
          onClick={() => onSelect(item.id)}
        >
          {item.icon}
        </button>
      ))}
    </nav>
  );
}

export function ConfigPreviewLayout({
  config,
  action,
  preview,
  className,
}: {
  config: ReactNode;
  action: ReactNode;
  preview: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes('fx-config-preview', className)}>
      <aside className="fx-config-preview__config">
        <div className="fx-config-preview__scroll">{config}</div>
        <div className="fx-config-preview__action">{action}</div>
      </aside>
      <main className="fx-config-preview__preview">{preview}</main>
    </div>
  );
}

export function FileRow({
  icon,
  name,
  status,
  action,
  selected,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  icon: ReactNode;
  name: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  selected?: boolean;
}) {
  return (
    <div
      {...props}
      className={classes('fx-file-row', className)}
      aria-selected={selected || undefined}
    >
      <span className="fx-file-row__icon">{icon}</span>
      <span className="fx-file-row__body">
        <span className="fx-file-row__name">{name}</span>
        {status && <Text as="span" variant="caption">{status}</Text>}
      </span>
      {action}
    </div>
  );
}

export function PropertyRow({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes('fx-property-row', className)}>
      <span className="fx-property-row__label">{label}</span>
      <span className="fx-property-row__control">{children}</span>
    </div>
  );
}

export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  open,
  onOpenChange,
  trailing,
  className,
  triggerProps,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trailing?: ReactNode;
  triggerProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & DataAttributes;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const expanded = open ?? internalOpen;
  const contentId = useId();
  const toggle = () => {
    const next = !expanded;
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const {
    className: triggerClassName,
    onClick: onTriggerClick,
    ...buttonProps
  } = triggerProps ?? {};
  return (
    <section {...props} className={classes('fx-collapsible', className)}>
      <div className="fx-collapsible__heading">
      <button
        {...buttonProps}
        type="button"
        className={classes('fx-collapsible__trigger', triggerClassName)}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={(event) => {
          onTriggerClick?.(event);
          if (!event.defaultPrevented) toggle();
        }}
      >
        {expanded ? <ChevronDown className="fx-icon" /> : <ChevronRight className="fx-icon" />}
        <span className="fx-collapsible__title">{title}</span>
      </button>
      {trailing && <div className="fx-collapsible__actions">{trailing}</div>}
      </div>
      {expanded && <div className="fx-collapsible__content" id={contentId}>{children}</div>}
    </section>
  );
}

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: ReactNode;
};

export function Conversation({ messages, label = '对话' }: { messages: Message[]; label?: string }) {
  return (
    <div className="fx-conversation" aria-label={label}>
      {messages.map((message) => (
        <article className={classes('fx-message', `fx-message--${message.role}`)} key={message.id}>
          <Text as="span" variant="caption">
            {message.role === 'user' ? '你' : 'ForgeaX'}
          </Text>
          <div className="fx-message__bubble">{message.content}</div>
        </article>
      ))}
    </div>
  );
}

export type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  tools?: ReactNode;
  submitLabel?: string;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder = '描述你想做什么…',
  disabled,
  tools,
  submitLabel = '发送',
}: ComposerProps) {
  return (
    <div className="fx-composer">
      <TextArea
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="消息"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (value.trim() && !disabled) onSubmit();
          }
        }}
      />
      <div className="fx-composer__footer">
        <Toolbar>{tools}</Toolbar>
        <Button variant="primary" disabled={disabled || !value.trim()} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export const icons = {
  check: Check,
  close: X,
  search: Search,
};
