import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
const root = resolve(import.meta.dirname, '../../..');
const view = resolve(root, 'tools/view');
const require = createRequire(resolve(view, 'package.json'));
const vite = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const scratch = await mkdtemp(resolve(tmpdir(), 'view-build-measure-'));
const output = resolve(root, 'artifacts/view-integration');
const samples = [];
async function sizes(directory) {
 let bytes=0, gzipBytes=0;
 for(const entry of await readdir(directory, {withFileTypes:true})) {
  const path=resolve(directory,entry.name);
  if(entry.isDirectory()) { const nested=await sizes(path); bytes+=nested.bytes; gzipBytes+=nested.gzipBytes; }
  else if(/\.(?:js|css)$/.test(entry.name)) { const value=await readFile(path); bytes+=value.length; gzipBytes+=gzipSync(value).length; }
 }
 return {bytes,gzipBytes};
}
try {
 await cp(view,scratch,{recursive:true,filter:path=> !['node_modules','dist','.git','.forgeax-harness','.agents','storybook-static'].includes(basename(path))});
 await symlink(resolve(view,'node_modules'),resolve(scratch,'node_modules'));
 for(const entry of await readdir(resolve(view,'packages'))) {
  try { await symlink(resolve(view,'packages',entry,'node_modules'),resolve(scratch,'packages',entry,'node_modules')); } catch(error) { if(error.code!=='EEXIST') throw error; }
 }
 for(const mode of ['generic','engine-plugins']) for(let iteration=0;iteration<3;iteration++) {
  const env={...process.env};
  for(const key of ['FORGEAX_VIEW_INPUT_ROOTS','FORGEAX_VIEW_PANELS_ENTRY','FORGEAX_VIEW_FRONTEND_PLUGINS_ENTRY']) delete env[key];
  if(mode==='engine-plugins') Object.assign(env, {
   FORGEAX_VIEW_INPUT_ROOTS:JSON.stringify([resolve(root,'tools/view-plugins'),resolve(root,'apps/rhi-debug-viewer/src')]),
   FORGEAX_VIEW_PANELS_ENTRY:resolve(import.meta.dirname,'panels.tsx'),
   FORGEAX_VIEW_FRONTEND_PLUGINS_ENTRY:resolve(import.meta.dirname,'frontend-plugins.ts'),
  });
  await rm(resolve(scratch,'dist'),{recursive:true,force:true});
  const start=performance.now();
  for(const [file,args,cwd] of [[vite,['build','--config',resolve(scratch,'packages/viewer/vite.config.ts')],resolve(scratch,'packages/viewer')],[resolve(scratch,'scripts/build-package.mjs'),[],scratch]]) {
   const result=spawnSync(process.execPath,[file,...args],{cwd,env,encoding:'utf8',maxBuffer:16*1024*1024});
   assert.equal(result.status,0,result.stderr);
  }
  const sample={mode,iteration,milliseconds:performance.now()-start,...await sizes(resolve(scratch,'dist/viewer'))};
  samples.push(sample); console.log(JSON.stringify(sample));
 }
 await mkdir(output,{recursive:true});
 await writeFile(resolve(output,'build-performance.json'),JSON.stringify({samples,platform:process.platform,arch:process.arch,node:process.version,method:'Three clean tool builds per product on identical copied source inputs and shared installed dependencies; JS/CSS bytes exclude maps and native host modules.'},null,2));
} finally { await rm(scratch,{recursive:true,force:true}); }
