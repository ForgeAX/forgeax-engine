import { createContext, useContext, useMemo } from 'react';
import en from './locales/en.json';
import zh from './locales/zh.json';

export type ViewerLocale = 'en' | 'zh';
export type MessageKey = keyof typeof en;
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;
export const ViewerLocaleContext = createContext<ViewerLocale>('en');

export function viewerTranslation(locale: ViewerLocale): Translate {
  const catalog: Record<MessageKey, string> = locale === 'zh' ? zh : en;
  return (key, vars) => {
    const message = catalog[key];
    return vars
      ? message.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ''))
      : message;
  };
}

export function useViewerTranslation(): Translate {
  const locale = useContext(ViewerLocaleContext);
  return useMemo(() => viewerTranslation(locale), [locale]);
}
