export * from './identity.ts';
export * from './schema.ts';
export { viewViewportFrontendPlugin as frontendPlugin } from './frontend.ts';

import frontendPlugin from './frontend.ts';
import * as identity from './identity.ts';

export default { ...identity, frontendPlugin };
