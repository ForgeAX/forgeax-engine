import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';

// This untextured demo needs only the shared shader/capture preset.
// Capture stays gated behind FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5183,
});
