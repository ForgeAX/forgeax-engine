import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMusicSite } from './build-site.mjs';
import { head, sourceHashes, siteHashes } from './inputs.mjs';

process.env.FORGEAX_SHADER_COMPILE_WORKERS ??= '1';
process.env.CARGO_BUILD_JOBS ??= '1';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const preparedHead=head(root), before=await sourceHashes(root);
const site=resolve(root,process.env.FORGEAX_MUSIC_SITE??'artifacts/roi-23/site');
await buildMusicSite({root,authorRoot:fileURLToPath(new URL('.',import.meta.url)),
  kernelEntry:fileURLToPath(new URL('../stream/app-kernel.ts',import.meta.url)),site});
const after=await sourceHashes(root);
if(head(root)!==preparedHead||JSON.stringify(before)!==JSON.stringify(after))throw new Error('prepared source epoch changed during Vite build');
await writeFile(resolve(site,'prepared-inputs.json'),JSON.stringify({head:preparedHead,sourceHashes:after,siteHashes:await siteHashes(root,site)},null,2));
