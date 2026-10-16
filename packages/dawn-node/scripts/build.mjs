import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}/dist`, { recursive: true });
await copyFile(`${root}/src/index.mjs`, `${root}/dist/index.mjs`);
await copyFile(`${root}/src/index.d.ts`, `${root}/dist/index.d.ts`);
