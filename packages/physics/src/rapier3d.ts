// Keep the preset on the package root's module instance.  The root entry owns
// the physics component tokens; importing it here prevents this secondary
// entrypoint from bundling a second copy of components.ts.
import { physicsPlugin } from '@forgeax/engine-physics';

export default physicsPlugin('rapier-3d');
