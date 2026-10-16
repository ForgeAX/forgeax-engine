export * from './identity.ts';
export * from './schema.ts';
export { default as backendPlugin } from './backend.ts';
export { default as frontendPlugin } from './frontend.ts';
export { createDisplayApiTools } from './api.ts';
export { t, subscribeLocale, getLocale, setLocale } from './i18n/index.ts';

import backendPlugin from './backend.ts';
import frontendPlugin from './frontend.ts';
import * as identity from './identity.ts';

export default {
  ...identity,
  backendPlugin,
  frontendPlugin,
};
