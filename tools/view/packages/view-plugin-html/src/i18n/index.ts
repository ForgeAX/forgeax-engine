import { createPluginI18n } from '@forgeax/view-workspace-core/plugin-i18n';
import { registerViewLocaleSink } from '@forgeax/view-workspace-core/locale-bridge';
import en from './locales/en.json' with { type: 'json' };
import zh from './locales/zh.json' with { type: 'json' };
const i18n = createPluginI18n({ en, zh });
export const t = i18n.t;
export const subscribeLocale = i18n.subscribe;
export const getLocale = i18n.getLocale;
registerViewLocaleSink(i18n.setLocale);
