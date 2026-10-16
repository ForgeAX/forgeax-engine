import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { isPnpmSqliteStoreArtifact } from '../../../../scripts/forgeax/sdk-lib.mjs';
import { watchNativeStages } from './native-stage.mjs';
import { retainNativeEvidence } from './retain-native-evidence.mjs';
import { readSdkNpmArtifacts, startSdkNpmArtifactRegistry } from './sdk-package-registry.mjs';
import { siteHashes } from './inputs.mjs';

// The SDK is installed through its ordinary CLI into an external author project.
// Only author fixtures are copied. No workspace engine module enters its Vite graph.
const value=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const prepareOnly=process.argv.includes('--prepare-only'),nativeOnly=process.argv.includes('--native-only');
if(prepareOnly===nativeOnly)throw new Error('select --prepare-only outside the lease or --native-only through the maintained bounded lease CLI');
if(nativeOnly&&(process.env.FORGEAX_LOCAL_GPU_LEASE!=='1'||process.env.FORGEAX_LOCAL_GPU_LEASE_HELD!=='1'))
  throw new Error('native music requires the maintained local-gpu-lease.mjs --timeout-ms process owner');
for(const name of ['--sdk','--project','--output','--expected-head']) if(!process.argv.includes(name)||!value(name))throw new Error(`required ${name}`);
const sdk=await realpath(value('--sdk')), project=resolve(value('--project')), output=resolve(value('--output'));
const under=(parent,child)=>{const path=relative(parent,child);return path===''||(!path.startsWith(`..${sep}`)&&path!=='..'&&!isAbsolute(path));};
if(under(sdk,project)||under(project,sdk))throw new Error('music author project must be separate from SDK');
const bench=dirname(fileURLToPath(import.meta.url));
const workspace=resolve(bench,'../../../..');
if(under(workspace,project))throw new Error('installed music witness must be external to workspace');
await mkdir(output,{recursive:true});
const manifestBytes=await readFile(resolve(sdk,'sdk-manifest.json'));
const manifest=JSON.parse(manifestBytes);
const expectedHead=value('--expected-head');
if(!/^[0-9a-f]{40}$/.test(expectedHead)||manifest.engineCommit!==expectedHead)throw new Error('installed SDK does not match the frozen feature HEAD');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const mutableStoreIndexes=manifest.artifacts.filter(artifact=>isPnpmSqliteStoreArtifact(artifact.path)).map(artifact=>artifact.path).sort();
const packageArchives=value('--package-archives')?resolve(value('--package-archives')):undefined;
const packageChecksums=value('--package-checksums')?resolve(value('--package-checksums')):undefined;
if((packageArchives===undefined)!==(packageChecksums===undefined))throw new Error('package archives and checksum manifest must be supplied together');
const preparedPath=resolve(output,'prepared-native.json'),site=resolve(project,'artifacts/roi-23/site');
const author=resolve(project,'music-witness');
const report=nativeOnly?JSON.parse(await readFile(preparedPath,'utf8')):{engineCommit:manifest.engineCommit,sdkVersion:manifest.sdkVersion,manifestSha256:digest(manifestBytes),
  startedAt:new Date().toISOString(),sdk,project,commands:[],mutableStoreIndexes,scope:'installed public SDK music witness; original SDK/Engine gates remain required'};
const packageArtifactInventory=packageArchives?await readSdkNpmArtifacts({packageArchives,checksumsFile:packageChecksums,expectedVersion:manifest.sdkVersion}):undefined;
const packageArtifactReceipt=packageArtifactInventory?.map(({path,manifest:packageManifest,...row})=>row);
if(nativeOnly&&(report.engineCommit!==expectedHead||report.manifestSha256!==digest(manifestBytes)||report.sdk!==sdk||report.project!==project||JSON.stringify(report.mutableStoreIndexes)!==JSON.stringify(mutableStoreIndexes)||report.packageArchives!==packageArchives||report.packageChecksums!==packageChecksums||JSON.stringify(report.packageArtifacts)!==JSON.stringify(packageArtifactReceipt)||JSON.stringify(report.siteHashes)!==JSON.stringify(await siteHashes(project,site))||JSON.stringify(report.authorHashes)!==JSON.stringify(await siteHashes(project,author))||JSON.stringify(report.runnerHashes)!==JSON.stringify(await siteHashes(workspace,bench))))
  throw new Error('prepared SDK native inputs do not match this immutable SDK and external author project');
async function verifyArtifacts() {
  for(const artifact of manifest.artifacts) {
    if(isPnpmSqliteStoreArtifact(artifact.path))continue;
    const file=resolve(sdk,artifact.path);
    if(!under(sdk,file))throw new Error(`SDK artifact escaped: ${artifact.path}`);
    const bytes=await readFile(file);
    if(bytes.byteLength!==artifact.bytes||digest(bytes)!==artifact.sha256)throw new Error(`SDK artifact changed: ${artifact.path}`);
  }
}
async function command(file,args,cwd,env=process.env) {
  const index=report.commands.length, row={file,args,cwd,startedAt:new Date().toISOString()};report.commands.push(row);
  const lines=[], stdout=[];
  const code=await new Promise((accept,reject)=>{
    const child=spawn(file,args,{cwd,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>{stdout.push(bytes);lines.push(bytes);process.stdout.write(bytes);});
    child.stderr.on('data',bytes=>{lines.push(bytes);process.stderr.write(bytes);});
    child.once('error',reject);child.once('exit',accept);
  });
  row.finishedAt=new Date().toISOString();row.exitCode=code;
  await writeFile(resolve(output,`command-${index}.log`),Buffer.concat(lines));
  if(code!==0)throw new Error(`music SDK command exited ${code}: ${file}`);
  return Buffer.concat(stdout).toString('utf8');
}
let browser,server,stages,packageRegistry;
try {
  await verifyArtifacts();
  const env={...process.env,FORGEAX_SDK_ROOT:sdk,FORGEAX_DISABLE_UPDATE_CHECK:'1',CI:'true',
    FORGEAX_PACKAGE_BUILD_CONCURRENCY:'1',FORGEAX_SHADER_COMPILE_WORKERS:'1',CARGO_BUILD_JOBS:'1'};
  if(prepareOnly) {
  const cli=resolve(sdk,'bin/forgeax.mjs');
  const init=JSON.parse((await command(process.execPath,[cli,'project','init','--json'],sdk,env)).trim());
  const created=JSON.parse((await command(process.execPath,[cli,'project','new',project,'--template','empty','--json'],sdk,env)).trim());
  report.onboarding=[];
  for(const paths of [init.value?.onboarding?.read,created.value?.onboarding?.read]) {
    if(!Array.isArray(paths)||paths.length!==3)throw new Error('missing ordinary SDK onboarding');
    for(const path of paths) {const bytes=await readFile(path);report.onboarding.push({path,sha256:digest(bytes)});}
  }
  const sdkPackage=JSON.parse(await readFile(resolve(sdk,'package.json'),'utf8'));
  const devkit=manifest.packages.find(entry=>entry.name==='@forgeax/engine-devkit');
  if(!devkit||!under(sdk,resolve(sdk,devkit.root)))throw new Error('SDK DevKit package identity missing');
  const toolingBytes=await readFile(resolve(sdk,devkit.root,'package.json'));
  const tooling=JSON.parse(toolingBytes);
  if(tooling.name!==devkit.name||tooling.version!==devkit.version||
    typeof tooling.dependencies?.vite!=='string'||typeof tooling.dependencies?.typescript!=='string')throw new Error('SDK author tooling versions missing');
  // Resolve unpublished Engine packages from this build's tarballs, and let
  // the local registry forward ordinary third-party packages to npmjs.
  if(packageArchives&&value('--registry'))throw new Error('choose the immutable SDK artifact registry or an explicit registry');
  if(packageArchives)packageRegistry=await startSdkNpmArtifactRegistry({packageArchives,checksumsFile:packageChecksums,expectedVersion:manifest.sdkVersion});
  const registry=packageRegistry?.url??value('--registry')??'https://registry.npmjs.org';
  if(packageRegistry) {
    report.packageArchives=packageArchives;report.packageChecksums=packageChecksums;report.packageArtifacts=packageRegistry.artifacts;
  }
  report.tooling={manifestSha256:digest(toolingBytes),vite:tooling.dependencies.vite,typescript:tooling.dependencies.typescript,registry,installScripts:'ignored'};
  await command('corepack',[sdkPackage.packageManager,'add','--save-dev',`vite@${report.tooling.vite}`,`typescript@${report.tooling.typescript}`,'--ignore-scripts','--registry',registry],project,env);
  await command('corepack',[sdkPackage.packageManager,'install','--offline','--frozen-lockfile','--ignore-scripts'],project,env);
  await mkdir(author,{recursive:true});
  const copies=['index.html','evidence.ts','app-bootstrap.ts','saved-score.ts','build-site.mjs','shader-manifest.mjs','recorder.worklet.js','retain-native-pcm.ts'];
  report.authorInputs={};
  for(const name of copies) {
    let bytes=await readFile(resolve(bench,name));
    if(name==='evidence.ts')bytes=Buffer.from(bytes.toString().replace("../../src/__tests__/support-tone","./pcm"));
    if(name==='app-bootstrap.ts')bytes=Buffer.from(bytes.toString().replace('../stream/app-kernel','./app-kernel'));
    await writeFile(resolve(author,name),bytes);report.authorInputs[name]=digest(bytes);
  }
  for(const [name,source] of [['app-kernel.ts',resolve(bench,'../stream/app-kernel.ts')],['pcm.ts',resolve(bench,'../../src/__tests__/support-tone.ts')]]) {
    let bytes=await readFile(source);
    if(name==='app-kernel.ts')bytes=Buffer.from(bytes.toString().replace('@forgeax/engine-ecs','@forgeax/engine/ecs'));
    await writeFile(resolve(author,name),bytes);report.authorInputs[name]=digest(bytes);
  }
  const prepare=resolve(author,'prepare.mjs');
  await writeFile(prepare,`import {buildMusicSite} from './build-site.mjs';\nawait buildMusicSite({root:${JSON.stringify(project)},authorRoot:${JSON.stringify(author)},kernelEntry:${JSON.stringify(resolve(author,'app-kernel.ts'))},site:${JSON.stringify(resolve(project,'artifacts/roi-23/site'))}});\n`);
  const identity=resolve(author,'installed-identity.mjs');
  await writeFile(identity,`import {readFile,realpath} from 'node:fs/promises';\nimport {fileURLToPath} from 'node:url';\nconst entry=await realpath(fileURLToPath(import.meta.resolve('@forgeax/engine/audio')));\nconst packageJson=JSON.parse(await readFile(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')),'utf8'));\nconsole.log(JSON.stringify({entry,version:packageJson.version}));\n`);
  report.installed=JSON.parse((await command(process.execPath,[identity],project,env)).trim());
  if((!under(sdk,report.installed.entry)&&!under(project,report.installed.entry))||under(workspace,report.installed.entry)||report.installed.version!==manifest.sdkVersion)throw new Error('installed Engine identity/version mismatch');
  await command('corepack',[sdkPackage.packageManager,'exec','tsc','--ignoreConfig','--noEmit','--strict','--skipLibCheck','--moduleResolution','Bundler','--module','ESNext','--target','ES2022','--lib','ES2022,DOM',...['evidence.ts','app-bootstrap.ts','app-kernel.ts'].map(name=>resolve(author,name))],project,env);
  await command(process.execPath,[prepare],project,env);
  // Preview itself is resolved from the installed author project, just like build.
  const previewEntry=resolve(author,'preview.mjs');
  await writeFile(previewEntry,`import {preview} from 'vite';\nconst server=await preview({configFile:false,root:${JSON.stringify(resolve(project,'artifacts/roi-23/site'))},build:{outDir:${JSON.stringify(resolve(project,'artifacts/roi-23/site'))}},preview:{port:5324,strictPort:true,headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}});\nconsole.log('music-installed-preview-ready');\nprocess.on('SIGTERM',()=>server.httpServer.close());\n`);
  await verifyArtifacts();
  if(packageRegistry)report.packageRegistryRequests=packageRegistry.requests;
  report.siteHashes=await siteHashes(project,site);report.authorHashes=await siteHashes(project,author);report.runnerHashes=await siteHashes(workspace,bench);report.preparedAt=new Date().toISOString();
  await writeFile(preparedPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({prepared:preparedPath,scope:'installed SDK CPU preparation only; no native acceptance'}));
  } else {
  const previewEntry=resolve(project,'music-witness/preview.mjs');
  report.nativeStartedAt=new Date().toISOString();
  server=spawn(process.execPath,[previewEntry],{cwd:project,env,stdio:['ignore','pipe','pipe']});
  await new Promise((accept,reject)=>{let text='';server.stdout.on('data',data=>{text+=data;if(text.includes('music-installed-preview-ready'))accept();});server.stderr.on('data',data=>process.stderr.write(data));server.once('error',reject);server.once('exit',code=>reject(new Error(`preview exited ${code}`)));});
  report.lease=await(async()=>{
    try {
    browser=await chromium.launch({...browserLaunch,headless:true,args:[...(browserLaunch.args??[]),'--autoplay-policy=no-user-gesture-required'],chromiumSandbox:true});
    const page=await browser.newPage({viewport:{width:1500,height:1100}});
    report.browser=browser.version();report.errors=[];
    page.on('pageerror',error=>report.errors.push(String(error)));
    page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
    page.on('crash',()=>{report.failure??='native browser page crashed';report.ok=false;void browser?.close().catch(error=>{report.crashCleanupFailure=String(error);});});
    await page.exposeFunction('__musicRetain',async(name,row)=>{
      await retainNativeEvidence(output,name,row);
    });
    stages=watchNativeStages(async row=>{report.lastStage=row;await appendFile(resolve(output,'stages.jsonl'),JSON.stringify(row)+'\n');},async row=>{
      report.stageDeadline=row;report.failure=`native installed music stage exceeded ${row.budgetMs}ms: ${row.probe}/${row.stage}`;report.ok=false;
      try {await appendFile(resolve(output,'stages.jsonl'),JSON.stringify(row)+'\n');}
      finally {await browser?.close();}
    });
    await page.exposeFunction('__musicStage',row=>stages.receive(row));
    await page.goto('http://localhost:5324');await page.waitForFunction(()=>globalThis.__musicEvidence);
    try {report.result=JSON.parse(await page.evaluate(async()=>JSON.stringify(await globalThis.__musicEvidence.runInstalledSdk())));
      for(const row of [report.result.signal,report.result.disabled,...report.result.apps,...report.result.immediate])delete row.wav;
      report.ok=report.result.pass&&report.errors.length===0;
    }catch(error){report.failure??=String(error);report.ok=false;}
    if(browser.isConnected()) {
      await page.screenshot({path:resolve(output,'installed-native.png'),fullPage:true});
      const cdp=await browser.newBrowserCDPSession();report.backend=await cdp.send('SystemInfo.getInfo');
    }
    return {label:'ROI23 installed SDK music consumer'};
    } finally {stages?.dispose();await browser?.close();browser=undefined;await stages?.settled();}
  })();
  await verifyArtifacts();report.immutableSdkArtifactsUnchanged=true;
  report.finalSiteHashes=await siteHashes(project,site);report.finalAuthorHashes=await siteHashes(project,author);report.finalRunnerHashes=await siteHashes(workspace,bench);
  if(JSON.stringify(report.siteHashes)!==JSON.stringify(report.finalSiteHashes)||JSON.stringify(report.authorHashes)!==JSON.stringify(report.finalAuthorHashes)||JSON.stringify(report.runnerHashes)!==JSON.stringify(report.finalRunnerHashes))throw new Error('installed Music inputs changed during native execution');
  }
} catch(error) {report.failure??=String(error);report.ok=false;} finally {
  if(packageRegistry) {
    report.packageRegistryRequests=packageRegistry.requests;
    await packageRegistry.close();
  }
  await browser?.close();
  if(server&&server.exitCode===null) {server.kill('SIGTERM');await new Promise(accept=>server.once('exit',accept));}
  report.finishedAt=new Date().toISOString();
  await writeFile(resolve(output,prepareOnly?'preparation-receipt.json':'receipt.json'),JSON.stringify(report,null,2));
}
if(prepareOnly?report.failure:!report.ok)process.exitCode=1;
console.log(JSON.stringify({prepared:prepareOnly&&!report.failure,ok:report.ok,output,failure:report.failure}));
