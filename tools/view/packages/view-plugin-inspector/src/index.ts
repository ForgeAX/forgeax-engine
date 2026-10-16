export * from './identity.ts';
export * from './schema.ts';
export { viewObjectInspectorFrontendPlugin as frontendPlugin } from './frontend.ts';
export { t, subscribeLocale, getLocale, setLocale } from './i18n/index.ts';

import frontendPlugin from './frontend.ts';
import * as identity from './identity.ts';

export default {
  ...identity,
  frontendPlugin,
};
