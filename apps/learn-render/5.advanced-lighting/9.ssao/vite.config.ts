import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';

// Procedural plane + cube: no private asset or optional shader prerequisite.
export default withRhiDebug({
  here: dirname(fileURLToPath(import.meta.url)),
  rootDepth: 4,
  port: 5180,
});
