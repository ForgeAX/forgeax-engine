import type { ViewLocale } from './locale-bridge.ts';

type Catalog = { readonly [key: string]: string | Catalog };

/** Product plugins retain their catalogs; lookup and subscription semantics are shared. */
export function createPluginI18n(catalogs: Record<ViewLocale, Catalog>) {
  let current: ViewLocale = 'zh';
  const listeners = new Set<() => void>();
  const lookup = (catalog: Catalog, key: string): string | undefined => {
    let value: string | Catalog | undefined = catalog;
    for (const part of key.split('.')) value = typeof value === 'object' ? value[part] : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  const t = (key: string, vars?: Record<string, unknown>): string => {
    const message = lookup(catalogs[current], key) ?? lookup(catalogs.en, key) ?? key;
    return vars ? message.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(vars[name] ?? '')) : message;
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const setLocale = (next: ViewLocale) => {
    if (next !== 'en' && next !== 'zh') return;
    current = next;
    for (const listener of listeners) listener();
  };
  return { t, subscribe, getLocale: () => current, setLocale };
}
