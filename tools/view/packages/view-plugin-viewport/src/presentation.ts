import { viewPlayPresentationPlugin } from './play-presentation.ts';
import { PRESENTATION_PLUGIN_ID } from './presentation-identity.ts';
export { PRESENTATION_PLUGIN_ID, PRESENTATION_MODULE } from './presentation-identity.ts';

/** The connection owns Play resources; page panels only borrow their placement. */
export default {
  ...viewPlayPresentationPlugin,
  name: PRESENTATION_PLUGIN_ID,
};
