export * from './identity.ts';
export * from './schema.ts';
export { viewPluginsListBackendPlugin as backendPlugin } from './backend.ts';
export { viewPluginsListFrontendPlugin as frontendPlugin } from './frontend.ts';
export { PLUGINS_OPERATION_DESCRIPTIONS } from './api.ts';
export { cliContributions } from './cli.ts';
export { t, subscribeLocale, getLocale, setLocale } from './i18n/index.ts';

import backendPlugin from './backend.ts';
import frontendPlugin from './frontend.ts';
import { cliContributions } from './cli.ts';
import * as identity from './identity.ts';

export default {
  ...identity,
  backendPlugin,
  frontendPlugin,
  cliContributions,
};
