import { existsSync } from 'node:fs';
import { build, createServer, preview } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const shared = resolve(root, '../../shared-build-inputs/manifest.json');
if (existsSync(shared) && !process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST) process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = shared;
await build({ configFile: resolve(root, 'vite.config.mjs') });
