import { useCallback, useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, t as translate } from './index.ts';

export function useTranslation() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(key, vars), [locale]);
  return { t, locale };
}
