import { access, readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const head = root => execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
async function files(directory) {
  let rows;
  try {
    rows=await readdir(directory,{withFileTypes:true});
  } catch(error) {
    // Packaged profiles are optional inputs; the shader plugin source-builds
    // when they are absent. A before/after inventory still detects adoption or removal.
    if(error?.code==='ENOENT')return [];
    throw error;
  }
  const nested=await Promise.all(rows.sort((a,b)=>a.name.localeCompare(b.name)).map(row=>
    row.isDirectory()?files(resolve(directory,row.name)):[resolve(directory,row.name)]));
  return nested.flat();
}
async function hashes(root, paths) {
  const result={};
  for(const file of [...new Set(paths)].sort()) result[relative(root,file)]=createHash('sha256').update(await readFile(file)).digest('hex');
  return result;
}
export async function sourceHashes(root) {
  const inputs=execFileSync('git',['ls-files','-c','-o','--exclude-standard','--',
    'packages/audio','packages/audio-webaudio','packages/app/src/execution',
    'packages/shader/src','packages/render/src','packages/shader/README.md','packages/render/README.md',
    'packages/vite-plugin-shader/src','packages/vite-plugin-shader/README.md',
    'packages/devkit/src/index.ts','packages/devkit/src/plugin-build.ts','packages/devkit/src/build/pack-program.ts',
    'scripts/ci/local-gpu-lease.mjs','scripts/ci/local-gpu-lease.py',
    'scripts/ci/run-browser-gate-with-retry.mjs','apps/shared/scripts/rhi-debug-process.mjs',
    'scripts/ci/browser-launch.json',
    'scripts/ci/__tests__/music-native-stage.test.mjs','package.json','pnpm-lock.yaml'],
    {cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean)
    .filter(file=>!file.startsWith('packages/audio-webaudio/bench/music/evidence/'))
    .map(file=>resolve(root,file));
  const generated=['packages/audio/dist/index.mjs','packages/audio-webaudio/dist/index.mjs','packages/app/dist/index.mjs',
    'packages/shader/dist/index.mjs','packages/render/dist/index.mjs',
    'packages/devkit/dist/plugin-build.mjs','packages/vite-plugin-pack/dist/index.mjs',
    'packages/vite-plugin-shader/dist/index.mjs','packages/audio-webaudio/dist/audio-importer.mjs',
    'node_modules/.cache/forgeax-build/engine-provenance.json',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm','packages/wgpu-wasm/pkg/wgpu_wasm.js','packages/wgpu-wasm/pkg/provenance.json',
];
  // Generated package/provenance outputs are platform- and build-dependent.
  // Hash present bytes; an absent output is not an input, and its later appearance
  // changes the before/after path set.
  for(const file of generated) {
    const path=resolve(root,file);
    try { await access(path); inputs.push(path); }
    catch(error) { if(error?.code!=='ENOENT')throw error; }
  }
  inputs.push(...await files(resolve(root,'packages/dawn-node/dist/native')));
  for(const profile of ['base-ssao','point-ssao']) inputs.push(...await files(resolve(root,`packages/vite-plugin-shader/dist/engine-inputs/${profile}`)));
  return hashes(root,inputs);
}
export async function siteHashes(root, site) {
  return hashes(root,(await files(site)).filter(file=>relative(site,file)!=='prepared-inputs.json'));
}
