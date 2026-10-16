import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import { themeNames, type ThemeName } from './tokens';

export const themePreferences = ['system', ...themeNames] as const;
export type ThemePreference = typeof themePreferences[number];

const THEME_STORAGE_KEY = 'forgeax-view-theme';

type ThemeContextValue = {
  theme: ThemeName;
  preference: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export type ThemeProviderProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  children: ReactNode;
  defaultTheme?: ThemePreference;
  /** Host appearance used by the system preference; otherwise follows the OS. */
  systemTheme?: ThemeName;
  theme?: ThemeName;
  onThemeChange?: (theme: ThemePreference) => void;
  persist?: boolean;
  applyToDocument?: boolean;
  /** Skip the layout wrapper `div` when it would break viewport flex/height chains. */
  unstyled?: boolean;
};

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && themeNames.includes(value as ThemeName);
}

export function getStoredThemePreference(fallback: ThemePreference = 'system'): ThemePreference {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'system' || isThemeName(stored) ? stored : fallback;
  } catch { return fallback; }
}

function readSystemTheme(): ThemeName {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function subscribeSystemTheme(listener: () => void) {
  const query = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: dark)');
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

export function getStoredTheme(fallback: ThemePreference = 'system', systemTheme?: ThemeName): ThemeName {
  const preference = getStoredThemePreference(fallback);
  return preference === 'system' ? systemTheme ?? readSystemTheme() : preference;
}

export function applyTheme(theme: ThemeName, target?: HTMLElement) {
  const element = target ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  if (element) element.dataset.theme = theme;
}

export function initializeTheme(fallback: ThemePreference = 'system', systemTheme?: ThemeName) {
  const theme = getStoredTheme(fallback, systemTheme);
  applyTheme(theme);
  return theme;
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  systemTheme,
  theme: controlledTheme,
  onThemeChange,
  persist = false,
  applyToDocument = true,
  unstyled = false,
  className,
  ...props
}: ThemeProviderProps) {
  const [internalTheme, setInternalTheme] = useState<ThemePreference>(() =>
    persist ? getStoredThemePreference(defaultTheme) : defaultTheme,
  );
  const osTheme = useSyncExternalStore(subscribeSystemTheme, readSystemTheme, () => 'light' as const);
  const theme = controlledTheme ?? (internalTheme === 'system' ? systemTheme ?? osTheme : internalTheme);

  const setTheme = useCallback(
    (nextTheme: ThemePreference) => {
      if (!controlledTheme) setInternalTheme(nextTheme);
      if (persist && typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
        } catch {
          // Theme changes remain available when storage is unavailable.
        }
      }
      onThemeChange?.(nextTheme);
    },
    [controlledTheme, onThemeChange, persist],
  );

  useEffect(() => {
    if (applyToDocument) applyTheme(theme);
  }, [applyToDocument, theme]);

  const value = useMemo(
    () => ({
      theme,
      preference: internalTheme,
      setTheme,
      toggleTheme: () => setTheme(theme === 'light' ? 'dark' : 'light'),
    }),
    [internalTheme, setTheme, theme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {unstyled ? (
        children
      ) : (
        <div
          {...props}
          className={['fx-ui', className].filter(Boolean).join(' ')}
          data-theme={applyToDocument ? undefined : theme}
        >
          {children}
        </div>
      )}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
