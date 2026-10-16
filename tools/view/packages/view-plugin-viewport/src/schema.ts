import { VIEWPORT_TARGET_ROLE } from './identity.ts';

export const VIEWPORT_UI_SCHEMA_VERSION = 'forgeax.view.viewport.ui/1';
export const VIEWPORT_CAPABILITIES = Object.freeze({
  targetRole: VIEWPORT_TARGET_ROLE,
  authoredState: 'read-only',
});
