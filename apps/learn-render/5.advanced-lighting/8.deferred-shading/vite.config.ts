import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';

// RHI-debug frame capture wired via the shared preset (forgeaxShader +
// vitePluginRhiDebug + fs.allow). This demo has no LearnOpenGL asset pack, so
// extraPlugins stays empty. Capture stays gated behind FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5179,
  extraPlugins: [],
});
