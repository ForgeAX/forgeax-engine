export * from './identity.ts';
export { default as frontendPlugin } from './frontend.ts';

import frontendPlugin from './frontend.ts';
import * as identity from './identity.ts';

export default { ...identity, frontendPlugin };
