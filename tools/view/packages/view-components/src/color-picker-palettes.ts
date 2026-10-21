import type { ColorValue } from './color-picker-model';

export type ColorTheme = { id: string; name: string; colors: ColorValue[] };
export type ColorPickerPalettes = {
  recent: ColorValue[];
  themes: ColorTheme[];
  selectedThemeId: string | null;
};

const STORAGE_KEY = 'forgeax-view-color-picker-palettes';
const empty: ColorPickerPalettes = { recent: [], themes: [], selectedThemeId: null };
const listeners = new Set<() => void>();
let snapshot: ColorPickerPalettes | undefined;

const sameColor = (left: ColorValue, right: ColorValue) => left.every((channel, index) => channel === right[index]);

function isColor(value: unknown): value is ColorValue {
  return Array.isArray(value) && value.length === 4
    && value.every(channel => typeof channel === 'number' && Number.isFinite(channel) && channel >= 0 && channel <= 1);
}

function readStored(): ColorPickerPalettes {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ColorPickerPalettes> | null;
    if (!raw || !Array.isArray(raw.themes)) return empty;
    const themes = raw.themes.filter((theme): theme is ColorTheme =>
      typeof theme?.id === 'string' && typeof theme.name === 'string' && Array.isArray(theme.colors))
      .slice(0, 24).map(theme => ({
        id: theme.id, name: theme.name.slice(0, 48), colors: theme.colors.filter(isColor).slice(0, 24),
      }));
    return {
      recent: Array.isArray(raw.recent) ? raw.recent.filter(isColor).slice(0, 12) : [],
      themes,
      selectedThemeId: themes.some(theme => theme.id === raw.selectedThemeId) ? raw.selectedThemeId! : null,
    };
  } catch { return empty; }
}

export function getColorPickerPalettes(): ColorPickerPalettes {
  return snapshot ??= typeof window === 'undefined' ? empty : readStored();
}

export function getServerColorPickerPalettes(): ColorPickerPalettes { return empty; }

export function subscribeColorPickerPalettes(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    snapshot = readStored();
    listeners.forEach(notify => notify());
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

function publish(next: ColorPickerPalettes) {
  snapshot = next;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* In-memory themes still work without storage. */ }
  listeners.forEach(listener => listener());
}

function uniqueName(base: string, themes: readonly ColorTheme[]): string {
  let name = base;
  for (let index = 1; themes.some(theme => theme.name === name); index++) name = `${base} ${index}`;
  return name;
}

export function selectColorTheme(id: string | null) {
  const state = getColorPickerPalettes();
  if (id !== null && !state.themes.some(theme => theme.id === id)) return;
  publish({ ...state, selectedThemeId: id });
}

export function createColorTheme(): string | null {
  const state = getColorPickerPalettes();
  if (state.themes.length >= 24) return null;
  const id = crypto.randomUUID();
  const theme = { id, name: uniqueName('New Theme', state.themes), colors: [] };
  publish({ ...state, themes: [...state.themes, theme], selectedThemeId: id });
  return id;
}

export function renameColorTheme(id: string, name: string) {
  const trimmed = name.trim().slice(0, 48);
  if (!trimmed) return;
  const state = getColorPickerPalettes();
  publish({ ...state, themes: state.themes.map(theme => theme.id === id ? { ...theme, name: trimmed } : theme) });
}

export function duplicateColorTheme(id: string): string | null {
  const state = getColorPickerPalettes();
  const original = state.themes.find(theme => theme.id === id);
  if (!original || state.themes.length >= 24) return null;
  const copy = { ...original, id: crypto.randomUUID(), name: uniqueName(`${original.name} Copy`, state.themes), colors: [...original.colors] };
  publish({ ...state, themes: [...state.themes, copy], selectedThemeId: copy.id });
  return copy.id;
}

export function deleteColorTheme(id: string) {
  const state = getColorPickerPalettes();
  publish({ ...state, themes: state.themes.filter(theme => theme.id !== id),
    selectedThemeId: state.selectedThemeId === id ? null : state.selectedThemeId });
}

export function addColorToTheme(id: string, color: ColorValue) {
  const state = getColorPickerPalettes();
  publish({ ...state, themes: state.themes.map(theme => theme.id === id ? {
    ...theme, colors: theme.colors.some(item => sameColor(item, color)) ? theme.colors : [...theme.colors, color].slice(-24),
  } : theme) });
}

export function recordRecentColor(color: ColorValue) {
  const state = getColorPickerPalettes();
  publish({ ...state, recent: [color, ...state.recent.filter(item => !sameColor(item, color))].slice(0, 12) });
}
