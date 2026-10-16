import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRhiDebug } from '../../shared/src/rhi-debug-vite-preset';

const here = dirname(fileURLToPath(import.meta.url));

export default withRhiDebug({
  here,
  rootDepth: 3,
  port: 4173,
  materialPackages: [resolve(here, 'src/ssr-reflection.pack.json')],
});
