// Build one immutable browser artifact against its own source checkout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const here=path.dirname(fileURLToPath(import.meta.url));
const sourceRoot=path.resolve(process.argv[2]??path.join(here,'../../../..'));
const output=path.resolve(process.argv[3]??'/tmp/managed-assets-macro/current');
const arm=process.argv[4]??'current';
const observation=process.argv[5]??'completion';
if(!['completion','gpu-timing'].includes(observation))throw new Error('Observation must be completion or gpu-timing');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:sourceRoot,encoding:'utf8',maxBuffer:64*1024*1024});
const sourceSnapshot=()=>{
const sourceFiles = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages', 'scripts', 'pnpm-lock.yaml', 'package.json').trim().split('\n'))].filter(file => fs.existsSync(path.join(sourceRoot, file)) && fs.statSync(path.join(sourceRoot,file)).isFile());
const sourceInventory = sourceFiles.sort().map(file => ({path:file,sha256:hash(fs.readFileSync(path.join(sourceRoot,file)))}));
return sourceInventory;
};
const sourceInventory=sourceSnapshot();
const carrierSnapshot=()=>fs.readdirSync(here).filter(file => file.endsWith('.mjs')).sort().map(file => ({path:file,sha256:hash(fs.readFileSync(path.join(here,file)))}));
const carrierInventory=carrierSnapshot();
const {build}=await import(path.join(sourceRoot,'node_modules/vite/dist/node/index.js'));
const aliases=[{find:'managed-assets-adapter',replacement:path.join(here,`adapter-${arm}.mjs`)}];
for(const dir of fs.readdirSync(path.join(sourceRoot,'packages'))){
 const manifest=path.join(sourceRoot,'packages',dir,'package.json');if(!fs.existsSync(manifest))continue;
 const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
 for(const [key,value] of Object.entries(pkg.exports??{})){
  const typed=value?.types;if(typeof typed!=='string'||!typed.endsWith('.d.ts'))continue;
  const source=path.join(sourceRoot,'packages',dir,typed.replace('./dist/','./src/').replace(/\.d\.ts$/,'.ts'));
  if(fs.existsSync(source))aliases.push({find:new RegExp(`^${pkg.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}${key==='.'?'':key.slice(1).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`),replacement:source});
 }
}
// Source checkouts name package-built worker siblings .mjs. This build resolves
// those names to the same TypeScript entries, without changing runtime policy.
const sourceWorkers={name:'managed-assets-source-workers',enforce:'pre',transform(code,id){if(!id.startsWith(sourceRoot+'/packages/app/src/'))return;return code.replace(/new URL\('\.\/(engine|render|kernel)-worker-runtime\.mjs', import\.meta\.url\)/g,"new URL('/$1-worker.js', globalThis.location.href)");}};
const viteRequire=createRequire(fs.realpathSync(path.join(sourceRoot,'node_modules/vite/package.json')));
const esbuild=await import(viteRequire.resolve('esbuild'));
const schemaBundle=await esbuild.build({entryPoints:[path.join(sourceRoot,'packages/pack/src/schema-compiled.ts')],bundle:true,format:'esm',platform:'browser',write:false,external:['@forgeax/engine-types']});
const schema={name:'managed-assets-source-schema',enforce:'pre',load(id){if(id.split('?')[0]===sourceRoot+'/packages/pack/src/schema-compiled.ts')return schemaBundle.outputFiles[0].text;}};
const shader=await import(path.join(sourceRoot,'packages/vite-plugin-shader/dist/index.mjs'));
const executionEntries=Object.fromEntries(['engine','render','kernel'].map(realm=>[`${realm}-worker`,path.join(sourceRoot,`packages/app/src/execution/${realm}-worker-runtime.ts`)]));
await build({root:here,configFile:false,define:{__MANAGED_ASSETS_GPU_DIAGNOSTIC__:JSON.stringify(observation==='gpu-timing')},resolve:{alias:aliases},plugins:[sourceWorkers,schema,shader.forgeaxShader()],worker:{format:'es',plugins:()=>[sourceWorkers,schema]},build:{outDir:output,emptyOutDir:true,target:'esnext',minify:true,sourcemap:'hidden',rollupOptions:{preserveEntrySignatures:'strict',input:{index:path.join(here,'index.mjs'),bootstrap:path.join(here,'bootstrap.mjs'),...executionEntries},output:{entryFileNames:'[name].js'}}}});
fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#222}canvas{width:512px;height:512px}</style><script type="module" src="/index.js"></script>');
if(JSON.stringify(sourceSnapshot())!==JSON.stringify(sourceInventory))throw new Error('Source inputs changed during carrier build; reject this artifact and rebuild from frozen inputs');
const inventory=[];
function visit(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,item.name);if(item.isDirectory())visit(file);else inventory.push({path:path.relative(output,file),bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))});}}
visit(output);
if(JSON.stringify(carrierSnapshot())!==JSON.stringify(carrierInventory))throw new Error('Carrier inputs changed during build; reject this artifact and rebuild');
fs.writeFileSync(path.join(output,'build-identity.json'),JSON.stringify({sourceRoot,arm,observation:{mode:observation,gpuPassTiming:observation==='gpu-timing',gpuCounters:observation==='gpu-timing',completion:'FrameReceipt.completed'},builtAt:new Date().toISOString(),commit:git('rev-parse','HEAD').trim(),diffSha256:hash(git('diff','HEAD','--','packages','scripts','pnpm-lock.yaml','package.json')),sourceSha256:hash(JSON.stringify(sourceInventory)),carrierSha256:hash(JSON.stringify(carrierInventory)),carrierInventory,artifactSha256:hash(JSON.stringify(inventory)),inventory},null,2));
