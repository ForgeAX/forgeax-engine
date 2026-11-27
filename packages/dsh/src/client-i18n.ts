import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export function clientLabels(locale: string): Record<keyof typeof en, string> {
  return /^zh(?:-(?:cn|sg|hans)(?:-|$)|$)/i.test(locale) ? zhCN : en;
}
