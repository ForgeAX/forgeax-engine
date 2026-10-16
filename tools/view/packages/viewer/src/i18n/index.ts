/**
 * Viewer shell i18n — catalogs live here; locale state lives in view-workspace-core/locale-bridge.
 */
import {
  getViewLocale,
  setViewLocale,
  subscribeViewLocale,
} from '@forgeax/view-workspace-core/locale-bridge';
import { useCallback, useSyncExternalStore } from 'react';
import en from './locales/en.json';
import zh from './locales/zh.json';

export type Locale = 'en' | 'zh';

export const SUPPORTED_LOCALES = [
  { code: 'en' as Locale, label: 'English', nativeLabel: 'English' },
  { code: 'zh' as Locale, label: 'Chinese', nativeLabel: '简体中文' },
];

export const DEFAULT_LOCALE: Locale = 'zh';

const STORAGE_KEY = 'forgeax.view.locale';
const CATALOGS: Record<Locale, Record<string, unknown>> = { en, zh };

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh';
}

function readPersisted(): Locale {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_LOCALE;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isLocale(raw)) return raw;
  } catch {
    /* Storage may be unavailable in private or sandboxed documents. */
  }
  return DEFAULT_LOCALE;
}

/** Hydrate locale once at app boot (do not call during React render). */
export function initI18n(): void {
  setViewLocale(readPersisted());
}

export function getLocale(): Locale {
  return getViewLocale();
}

export function setLocale(next: Locale): void {
  if (!isLocale(next)) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  setViewLocale(next);
}

export function subscribe(listener: () => void): () => void {
  return subscribeViewLocale(listener);
}

function lookup(catalog: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split('.');
  let node: unknown = catalog;
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = getViewLocale();
  const primary = lookup(CATALOGS[locale], key) ?? lookup(CATALOGS.en, key) ?? key;
  if (!vars) return primary;
  return primary.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ''));
}

export function useTranslation() {
  const language = useSyncExternalStore(subscribe, getLocale, getLocale);
  const translate = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(key, vars),
    [language],
  );
  return {
    t: translate,
    i18n: { language, changeLanguage: setLocale },
  };
}
