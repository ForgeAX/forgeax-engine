export type ViewLocale = 'en' | 'zh';

const pluginSinks = new Set<(locale: ViewLocale) => void>();
const shellListeners = new Set<() => void>();

/** @type {ViewLocale} */
let viewLocale: ViewLocale = 'zh';

function notifyPlugins(locale: ViewLocale) {
  for (const sink of pluginSinks) {
    try {
      sink(locale);
    } catch {
      /* isolated plugin failure */
    }
  }
}

function notifyShell() {
  for (const listener of shellListeners) listener();
}

/**
 * Active UI locale for the entire View shell (single source of truth).
 */
export function getViewLocale() {
  return viewLocale;
}

export function subscribeViewLocale(listener: () => void) {
  if (typeof listener !== 'function') {
    throw new TypeError('subscribeViewLocale requires a listener function');
  }
  shellListeners.add(listener);
  return () => shellListeners.delete(listener);
}

/**
 * Change locale for shell React trees and every registered product-plugin i18n sink.
 */
export function setViewLocale(locale: unknown) {
  if (locale !== 'en' && locale !== 'zh') return;
  if (viewLocale === locale) return;
  viewLocale = locale;
  notifyPlugins(locale);
  notifyShell();
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

/**
 * @param {(locale: ViewLocale) => void} setLocale
 * @returns {() => void} unregister
 */
export function registerViewLocaleSink(setLocale: (locale: ViewLocale) => void) {
  if (typeof setLocale !== 'function') {
    throw new TypeError('registerViewLocaleSink requires a setLocale function');
  }
  pluginSinks.add(setLocale);
  setLocale(viewLocale);
  return () => pluginSinks.delete(setLocale);
}
