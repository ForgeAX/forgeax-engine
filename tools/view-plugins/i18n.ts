import { getViewLocale, subscribeViewLocale } from '@forgeax/view-workspace-core/locale-bridge';
import { useSyncExternalStore } from 'react';
import en from './locales/en.json';
import zh from './locales/zh.json';

type MessageKey = keyof typeof en;
export function diagnosticText(key: MessageKey, vars?: Record<string, string | number>): string {
  const catalog: Record<MessageKey, string> = getViewLocale() === 'zh' ? zh : en;
  const message = catalog[key];
  return vars ? message.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? '')) : message;
}

export function useDiagnosticTranslation() {
  useSyncExternalStore(subscribeViewLocale, getViewLocale, getViewLocale);
  return diagnosticText;
}

export { getViewLocale, subscribeViewLocale };
