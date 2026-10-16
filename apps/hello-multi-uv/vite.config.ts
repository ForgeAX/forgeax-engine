import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { withRhiDebug } from '../shared/src/rhi-debug-vite-preset';

// Mount the dev-only tape endpoint while keeping capture activation in the
// browser smoke's FORGEAX_ENGINE_RHI_DEBUG=1 environment.
const here = dirname(fileURLToPath(import.meta.url));
export default withRhiDebug({
  here,
  rootDepth: 2,
  port: 5198,
  materialPackages: [
    resolve(here, 'src/multi-uv-demo.pack.json'),
    resolve(here, 'src/multi-uv-demo-false.pack.json'),
  ],
});
