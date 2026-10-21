import { Check, ChevronDown, CirclePlus, Clapperboard, Clock3, Copy, Pencil, Pipette, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Checkbox, Dialog, IconButton, Menu, Tooltip, type MenuItem } from './components';
import { clamp01, colorHex, COLOR_PICKER_DECIMALS, hsvToRgb, parseColorHex, previewColor, previewGradient, rgbToHsv, roundColorValue, toColorValue, type ColorValue } from './color-picker-model';
import { addColorToTheme, createColorTheme, deleteColorTheme, duplicateColorTheme, getColorPickerPalettes,
  getServerColorPickerPalettes, recordRecentColor, renameColorTheme, selectColorTheme, subscribeColorPickerPalettes } from './color-picker-palettes';
import './styles/color-picker.css';

export type ColorPickerProps = {
  /** Linear RGB with optional alpha; a missing alpha is treated as opaque. */
  value: readonly number[];
  /** Emits the selected color only when OK is pressed. */
  onChange: (value: ColorValue) => void;
  label: string;
};

const format = (value: number) => String(Number(value.toFixed(COLOR_PICKER_DECIMALS)));

function togglePopover(menu: HTMLDivElement | null, trigger: HTMLButtonElement | null) {
  if (!menu || !trigger) return false;
  if (menu.matches(':popover-open')) { menu.hidePopover(); return false; }
  const anchor = trigger.getBoundingClientRect();
  menu.showPopover();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(0, Math.min(anchor.left, window.innerWidth - width))}px`;
  const below = window.innerHeight - anchor.bottom;
  const top = below >= height || below >= anchor.top ? anchor.bottom : anchor.top - height;
  menu.style.top = `${Math.max(0, Math.min(top, window.innerHeight - height))}px`;
  return true;
}

function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.target instanceof HTMLInputElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'));
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
  event.preventDefault();
  items[next]?.focus();
}

function ColorRange({ label, value, max, gradient, checkerboard = false, onChange }: {
  label: string; value: number; max: number; gradient: string; checkerboard?: boolean; onChange: (value: number) => void;
}) {
  const [text, setText] = useState(format(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(format(value)); }, [value]);
  return <label className={`fx-color-picker__channel${checkerboard ? ' fx-color-picker__channel--alpha' : ''}`}>
    <span>{label}</span>
    <input type="range" min="0" max={max} step="0.001" value={value} aria-label={label}
      style={{ '--color-gradient': gradient } as CSSProperties} onChange={event => onChange(Number(event.target.value))} />
    <input className="fx-color-picker__number" type="number" min="0" max={max} step="0.001"
      aria-label={`${label} value`} value={text} onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setText(format(value)); }} onChange={event => {
        setText(event.target.value);
        const number = Number(event.target.value);
        if (event.target.value !== '' && Number.isFinite(number)) onChange(Math.min(max, Math.max(0, number)));
      }} />
  </label>;
}

export function ColorPicker({ value, onChange, label }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ColorValue>(() => toColorValue(value));
  const [srgbPreview, setSrgbPreview] = useState(true);
  const [hexMode, setHexMode] = useState<'srgb' | 'linear'>('srgb');
  const [hexMenuOpen, setHexMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [quickBarVisible, setQuickBarVisible] = useState(true);
  const [renamingTheme, setRenamingTheme] = useState(false);
  const [themeName, setThemeName] = useState('');
  const [hexText, setHexText] = useState('');
  const [spectrumOpen, setSpectrumOpen] = useState(false);
  const [sampleError, setSampleError] = useState('');
  const initial = useRef<ColorValue>(toColorValue(value));
  const wheel = useRef<HTMLDivElement>(null);
  const hexMenu = useRef<HTMLDivElement>(null);
  const hexMenuTrigger = useRef<HTMLButtonElement>(null);
  const hexMenuId = useId();
  const themeMenu = useRef<HTMLDivElement>(null);
  const themeMenuTrigger = useRef<HTMLButtonElement>(null);
  const themeNameInput = useRef<HTMLInputElement>(null);
  const themeMenuId = useId();
  const hexFocused = useRef(false);
  const palettes = useSyncExternalStore(subscribeColorPickerPalettes, getColorPickerPalettes, getServerColorPickerPalettes);
  const selectedTheme = palettes.themes.find(theme => theme.id === palettes.selectedThemeId);
  const quickColors = selectedTheme?.colors ?? palettes.recent;
  const quickColorDestination = selectedTheme?.name ?? 'Recent colors';
  const addQuickColor = (color: ColorValue) => {
    if (selectedTheme) addColorToTheme(selectedTheme.id, color);
    else recordRecentColor(color);
  };

  useEffect(() => { if (!open) setCurrent(toColorValue(value)); }, [open, value]);
  useEffect(() => { if (!hexFocused.current) setHexText(colorHex(current, hexMode === 'srgb')); }, [current, hexMode]);
  useEffect(() => {
    if (!open && hexMenu.current?.matches(':popover-open')) hexMenu.current.hidePopover();
    if (!open && themeMenu.current?.matches(':popover-open')) themeMenu.current.hidePopover();
  }, [open]);
  useEffect(() => { if (renamingTheme) { themeNameInput.current?.focus(); themeNameInput.current?.select(); } }, [renamingTheme]);
  const [hue, saturation, brightness] = rgbToHsv(current);
  const opaque: ColorValue = [current[0], current[1], current[2], 1];
  const atHue = (h: number, s = saturation, v = brightness) => {
    const [r, g, b] = hsvToRgb(h, s, v);
    update([r, g, b, current[3]]);
  };
  const update = (next: ColorValue) => { setCurrent(next); };
  const begin = () => {
    const next = toColorValue(value);
    initial.current = next;
    setCurrent(next);
    setSpectrumOpen(false);
    setSampleError('');
    setOpen(true);
  };
  const cancel = () => { setOpen(false); };
  const accept = () => {
    const selected = roundColorValue(current);
    onChange(selected);
    recordRecentColor(selected);
    setOpen(false);
  };
  const pickWheel = (event: PointerEvent<HTMLDivElement>) => {
    const rect = wheel.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const nextHue = spectrumOpen ? clamp01((event.clientX - rect.left) / rect.width) * 360
      : (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    const nextSaturation = spectrumOpen ? 1 - clamp01((event.clientY - rect.top) / rect.height)
      : clamp01(Math.hypot(dx, dy) / (Math.min(rect.width, rect.height) / 2));
    atHue(nextHue, nextSaturation);
  };
  const sample = async () => {
    const EyeDropper = (window as Window & { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!EyeDropper) { setSampleError('Screen color sampling is unavailable in this browser.'); return; }
    try {
      const picked = parseColorHex((await new EyeDropper().open()).sRGBHex);
      if (picked) update([picked[0], picked[1], picked[2], current[3]]);
      setSampleError('');
    } catch { /* The user cancelled native sampling. */ }
  };
  const hueColor = previewColor([...hsvToRgb(hue, 1, 1), 1], srgbPreview);
  const fullColor = previewColor(opaque, srgbPreview);
  const transparentColor = previewColor([current[0], current[1], current[2], 0], srgbPreview);
  const hsvGradient = (direction: 'to right' | 'to top', channel: 'saturation' | 'value') =>
    previewGradient(direction, position => {
      const [r, g, b] = hsvToRgb(hue, channel === 'saturation' ? position : saturation,
        channel === 'value' ? position : brightness);
      return [r, g, b, 1];
    }, srgbPreview);
  const rgbGradient = (channel: number) => {
    return previewGradient('to right', position => [
      channel === 0 ? position : 0, channel === 1 ? position : 0, channel === 2 ? position : 0, 1,
    ], srgbPreview);
  };
  const toggleHexMenu = () => {
    if (togglePopover(hexMenu.current, hexMenuTrigger.current))
      hexMenu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  };
  const closeThemeMenu = () => {
    themeMenu.current?.hidePopover();
    themeMenuTrigger.current?.focus();
  };
  const themeItems: MenuItem[] = [
    { id: 'recent', selection: 'radio', checked: !selectedTheme,
      label: <span className="fx-color-picker__theme-label"><Clock3 aria-hidden />Recent</span>,
      onSelect: () => { selectColorTheme(null); closeThemeMenu(); } },
    { type: 'title', label: 'Saved color themes' },
    ...palettes.themes.map(theme => ({
      id: theme.id, selection: 'radio' as const, checked: theme.id === selectedTheme?.id,
      label: <span className="fx-color-picker__theme-label"><Clapperboard aria-hidden />{theme.name}</span>,
      onSelect: () => { selectColorTheme(theme.id); closeThemeMenu(); },
    })),
    { type: 'separator' },
    { id: 'create', label: 'Create new theme', icon: <CirclePlus aria-hidden />,
      disabled: palettes.themes.length >= 24, onSelect: () => { createColorTheme(); closeThemeMenu(); } },
    { type: 'title', label: 'Edit current theme' },
    { id: 'rename', label: 'Rename', icon: <Pencil aria-hidden />, disabled: !selectedTheme,
      onSelect: () => { setThemeName(selectedTheme?.name ?? ''); setRenamingTheme(true); } },
    { id: 'duplicate', label: 'Duplicate', icon: <Copy aria-hidden />,
      disabled: !selectedTheme || palettes.themes.length >= 24,
      onSelect: () => { if (selectedTheme) duplicateColorTheme(selectedTheme.id); closeThemeMenu(); } },
    { id: 'delete', label: 'Delete', icon: <Trash2 aria-hidden />, danger: true, disabled: !selectedTheme,
      onSelect: () => { if (selectedTheme) deleteColorTheme(selectedTheme.id); closeThemeMenu(); } },
  ];
  const wheelStyle = { '--wheel-value': brightness, '--wheel-color': hueColor } as CSSProperties;
  const markerStyle = {
    left: spectrumOpen ? `${hue / 360 * 100}%` : `${50 + 50 * saturation * Math.cos(hue * Math.PI / 180)}%`,
    top: spectrumOpen ? `${(1 - saturation) * 100}%` : `${50 + 50 * saturation * Math.sin(hue * Math.PI / 180)}%`,
  };

  return <>
    <Tooltip title={`Edit ${label} color`} portaled disabled={open}>
      <button type="button" className="fx-color-picker__trigger fx-color-picker__transparent" aria-label={`${label} picker`}
        style={{ '--swatch-color': previewColor(toColorValue(value)) } as CSSProperties} onClick={begin} />
    </Tooltip>
    <Dialog open={open} onClose={cancel} title="Color Picker" closeLabel="Close color picker"
      className="fx-color-picker" footer={<><Button onClick={accept}>OK</Button><Button onClick={cancel}>Cancel</Button></>}>
      <div className="fx-color-picker__top">
        <div ref={wheel} className={`fx-color-picker__wheel${spectrumOpen ? ' fx-color-picker__wheel--spectrum' : ''}`}
          role="slider" tabIndex={0} aria-label="Hue and saturation"
          aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hue)} style={wheelStyle}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); pickWheel(event); }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pickWheel(event); }}
          onKeyDown={event => {
            const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
            if (delta) { event.preventDefault(); atHue(hue + delta); }
          }}>
          <span className="fx-color-picker__wheel-marker" style={markerStyle} />
        </div>
        <div className="fx-color-picker__verticals">
          <label className="fx-color-picker__vertical" title="Saturation"
            style={{ '--vertical-gradient': hsvGradient('to top', 'saturation') } as CSSProperties}>
            <input type="range" aria-label="Saturation" min="0" max="1" step="0.001" value={saturation}
              onChange={event => atHue(hue, Number(event.target.value))} />
          </label>
          <label className="fx-color-picker__vertical" title="Value"
            style={{ '--vertical-gradient': hsvGradient('to top', 'value') } as CSSProperties}>
            <input type="range" aria-label="Value" min="0" max="1" step="0.001" value={brightness}
              onChange={event => atHue(hue, saturation, Number(event.target.value))} />
          </label>
        </div>
        <div className="fx-color-picker__aside">
          <Tooltip title={`Add selected color to ${quickColorDestination}`} topLayer>
            <button type="button" className="fx-color-picker__preview fx-color-picker__preview-add fx-color-picker__transparent"
              aria-label={`Add selected color to ${quickColorDestination}`}
              style={{ '--swatch-color': previewColor(current, srgbPreview) } as CSSProperties}
              onClick={() => addQuickColor(current)}><Plus aria-hidden /></button>
          </Tooltip>
          <Tooltip title={`Add original color to ${quickColorDestination}`} topLayer>
            <button type="button" className="fx-color-picker__preview fx-color-picker__preview-add fx-color-picker__transparent"
              aria-label={`Add original color to ${quickColorDestination}`}
              style={{ '--swatch-color': previewColor(initial.current, srgbPreview) } as CSSProperties}
              onClick={() => addQuickColor(initial.current)}><Plus aria-hidden /></button>
          </Tooltip>
          <Checkbox label="sRGB Preview" checked={srgbPreview} onChange={event => setSrgbPreview(event.target.checked)} />
          <div className="fx-color-picker__tools">
            <Tooltip title="Toggle color spectrum" topLayer><IconButton label="Toggle color spectrum" title="" aria-pressed={spectrumOpen}
              icon={<span className="fx-color-picker__spectrum" />} onClick={() => setSpectrumOpen(!spectrumOpen)} /></Tooltip>
            <Tooltip title="Pick color from screen" topLayer><IconButton label="Pick color from screen" title="" icon={<Pipette />} onClick={() => void sample()} /></Tooltip>
            <Tooltip title={quickBarVisible ? 'Hide color shortcut bar' : 'Show color shortcut bar'} topLayer>
              <IconButton label={quickBarVisible ? 'Hide color shortcut bar' : 'Show color shortcut bar'} title=""
                aria-pressed={quickBarVisible} icon={<Clapperboard />} onClick={() => setQuickBarVisible(!quickBarVisible)} />
            </Tooltip>
          </div>
          {sampleError ? <span className="fx-color-picker__error" role="alert">{sampleError}</span> : null}
        </div>
      </div>
      <div className="fx-color-picker__channels">
        <div className="fx-color-picker__channel-group">
          {(['R', 'G', 'B'] as const).map((name, index) => <ColorRange key={name} label={name} value={current[index]!} max={1}
            gradient={rgbGradient(index)} onChange={number => update([
              index === 0 ? number : current[0], index === 1 ? number : current[1], index === 2 ? number : current[2], current[3],
            ])} />)}
          <ColorRange label="A" value={current[3]} max={1} checkerboard
            gradient={`linear-gradient(to right, ${transparentColor}, ${fullColor})`}
            onChange={number => update([current[0], current[1], current[2], number])} />
        </div>
        <div className="fx-color-picker__channel-group">
          <ColorRange label="H" value={hue} max={360} gradient="linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)" onChange={number => atHue(number)} />
          <ColorRange label="S" value={saturation} max={1} gradient={hsvGradient('to right', 'saturation')} onChange={number => atHue(hue, number)} />
          <ColorRange label="V" value={brightness} max={1} gradient={hsvGradient('to right', 'value')} onChange={number => atHue(hue, saturation, number)} />
          <div className="fx-color-picker__hex">
            <button ref={hexMenuTrigger} type="button" className="fx-color-picker__hex-mode"
              aria-label={`Hex ${hexMode === 'srgb' ? 'sRGB' : 'Linear'} color space`}
              aria-haspopup="menu" aria-expanded={hexMenuOpen} aria-controls={hexMenuId} onClick={toggleHexMenu}>
              Hex <span>{hexMode === 'srgb' ? 'sRGB' : 'Linear'}</span><ChevronDown aria-hidden />
            </button>
            <div ref={hexMenu} id={hexMenuId} popover="auto" className="fx-color-picker__popover"
              onToggle={event => setHexMenuOpen(event.currentTarget.matches(':popover-open'))}
              onKeyDown={onMenuKeyDown}>
              <Menu label="Hex color space" items={(['srgb', 'linear'] as const).map(mode => ({
                id: mode, label: `Hex ${mode === 'srgb' ? 'sRGB' : 'Linear'}`,
                selection: 'radio', checked: hexMode === mode,
                onSelect: () => { setHexMode(mode); hexMenu.current?.hidePopover(); hexMenuTrigger.current?.focus(); },
              }))} />
            </div>
            <input aria-label="Hex color" value={hexText} maxLength={9}
              onFocus={() => { hexFocused.current = true; }}
              onChange={event => {
              setHexText(event.target.value.toUpperCase());
              const parsed = parseColorHex(event.target.value, hexMode === 'srgb');
              if (parsed) update(parsed);
            }} onBlur={() => { hexFocused.current = false; setHexText(colorHex(current, hexMode === 'srgb')); }} />
          </div>
        </div>
      </div>
      {quickBarVisible ? <div className="fx-color-picker__quickbar" aria-label="Color shortcut bar">
        <Tooltip title="Choose shortcut colors" topLayer>
          <button ref={themeMenuTrigger} type="button" className="fx-color-picker__quickbar-select"
            aria-label={`Shortcut colors: ${selectedTheme?.name ?? 'Recent'}`} aria-haspopup="menu"
            aria-expanded={themeMenuOpen} aria-controls={themeMenuId} onClick={() => {
              setRenamingTheme(false);
              if (togglePopover(themeMenu.current, themeMenuTrigger.current))
                themeMenu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
            }}>
            {selectedTheme ? <Clapperboard aria-hidden /> : <Clock3 aria-hidden />}<ChevronDown aria-hidden />
          </button>
        </Tooltip>
        <div ref={themeMenu} id={themeMenuId} popover="auto" className="fx-color-picker__popover fx-color-picker__theme-popover"
          onToggle={event => {
            const shown = event.currentTarget.matches(':popover-open');
            setThemeMenuOpen(shown);
            if (!shown) setRenamingTheme(false);
          }} onKeyDown={onMenuKeyDown}>
          {renamingTheme && selectedTheme ? <form className="fx-color-picker__theme-rename" onSubmit={event => {
            event.preventDefault();
            renameColorTheme(selectedTheme.id, themeName);
            closeThemeMenu();
          }}>
            <input ref={themeNameInput} aria-label="Theme name" maxLength={48} value={themeName}
              onChange={event => setThemeName(event.target.value)} />
            <button type="submit" aria-label="Save theme name"><Check aria-hidden /></button>
            <button type="button" aria-label="Cancel rename" onClick={() => setRenamingTheme(false)}><X aria-hidden /></button>
          </form> : <Menu label="Color shortcut source" items={themeItems} />}
        </div>
        <Tooltip title={`Add selected color to ${quickColorDestination}`} topLayer>
          <button type="button" className="fx-color-picker__quickbar-add" aria-label={`Add selected color to ${quickColorDestination}`}
            onClick={() => addQuickColor(current)}><Plus aria-hidden /></button>
        </Tooltip>
        <div className="fx-color-picker__quickbar-colors">
          {quickColors.map((item, index) => <button key={`${colorHex(item)}-${index}`} type="button"
            className="fx-color-picker__quickbar-swatch fx-color-picker__transparent"
            aria-label={`${selectedTheme?.name ?? 'Recent'} color ${index + 1}`}
            style={{ '--swatch-color': previewColor(item) } as CSSProperties} onClick={() => update(item)} />)}
        </div>
      </div> : null}
    </Dialog>
  </>;
}
