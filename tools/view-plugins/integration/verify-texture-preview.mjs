import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { parseImage } from '@forgeax/engine/image/parse-image';
import { connectViewWorkspace } from '../../view/dist/modules/workspace/resident.mjs';
import { writeProofGameAssets } from '../../view/scripts/fixtures/plugin-assets.mjs';

const checkout = resolve(import.meta.dirname, '../../..');
const root = resolve(process.env.FORGEAX_TEXTURE_PREVIEW_PROJECT ?? join(checkout, 'artifacts/texture-preview/project'));
const output = resolve(checkout, 'artifacts/texture-preview');
const view = resolve(checkout, 'tools/view');
await mkdir(join(root, 'assets'), { recursive: true });
await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
for (const [name, target] of [['engine', join(checkout, 'packages/engine')], ['view', view]]) {
  try { await symlink(target, join(root, 'node_modules/@forgeax', name)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
await cp(join(view, 'scripts/fixtures/workspace-proof.pack.ts'), join(root, 'assets/proof.pack.ts'));
await cp(join(view, 'scripts/fixtures/workspace-proof.plugin.ts'), join(root, 'assets/game.plugin.ts'));
const roots = await writeProofGameAssets(root);
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'texture-preview-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
await writeFile(join(root, 'forge.json'), JSON.stringify({ schemaVersion: '3.0.0', id: 'texture-preview-proof', name: 'Texture preview', assetRoots: ['assets'], roots }));
await cp(join(import.meta.dirname, 'fixtures/texture-inspection.pack.ts'), join(root, 'assets/textures.pack.ts'));
const command = async (...args) => {
 const result = await runUnifiedCli([...args, '--root', root, '--json']);
 assert.equal(result.ok, true, JSON.stringify(result));
 return result.value;
};
await command('project','engine','use-local',checkout);
await command('backend','start','--host-pack',join(view,'host.pack.json'));
const start = await command('view','start','--input',JSON.stringify({ root, frontendConfig:{layout:{responsiveAutoTuck:false}} }));
await writeFile(join(output,'entry.json'),JSON.stringify({url:start.url,root},null,2));
console.log('View URL',start.url);
const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap',start.url)).then(r=>r.json());
const client = await connectViewWorkspace({endpoint:bootstrap.endpoint,token:bootstrap.token,clientId:'texture-preview-proof'});
const launch = JSON.parse(await readFile(join(checkout, 'scripts/ci/browser-launch.json'), 'utf8'));
const browser = await chromium.launch({ ...launch, headless:false,
 args: [...launch.args, '--use-angle=swiftshader'],
 ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE, channel: undefined } : {}),
 chromiumSandbox:true,
});
const page = await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];
const readCounts = new Map();
page.on('websocket', socket => socket.on('framesent', frame => {
 const text = String(frame.payload);
 if (text.includes('preview.texture.get')) for (const id of readCounts.keys()) {
   if (text.includes(id)) readCounts.set(id, readCounts.get(id) + 1);
 }
}));
page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message);});
page.on('console',m=>{if(m.type()==='error') console.error('CONSOLE',m.text());});
await page.addInitScript(()=>{try{localStorage.setItem('forgeax.view.locale','en');}catch{}});
try {
 await page.goto(start.url);
 await page.waitForURL(url=>url.searchParams.has('forgeaxWorkspaceTarget'),{timeout:120000});
 await page.waitForFunction(()=>{
   const failure = document.querySelector('#forgeax-fatal-details')?.textContent;
   if (failure) throw new Error(failure);
   return globalThis.__forgeaxViewReady?.mounted;
 },undefined,{timeout:120000});
 let state=await client.getState();
 const {assets}=await client.listAssets(state.project.id,{targetId:state.projectTarget.targetId});
 assert.equal(assets.some(asset => asset.guid.startsWith('019e7600-0000-7000-8000-00000000000')), false,
   'preview implementation materials must not enter the project asset Catalog');
 const evidence=[];
 const saveEvidence = passed => writeFileSync(join(output,'result.json'),JSON.stringify({passed,evidence,errors},null,2));
 saveEvidence(false);
 const srgb = value => Math.round(255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
 const near = (actual, expected, label) => {
   assert.ok(actual.every((v,i)=>Math.abs(v-expected[i])<=6),`${label}: ${actual} expected ${expected}`);
   evidence.push({label,actual,expected});
   saveEvidence(false);
 };
 const pixel = (image,x=.5,y=.5) => [...image.bytes.slice((Math.floor(y*image.height)*image.width+Math.floor(x*image.width))*4,(Math.floor(y*image.height)*image.width+Math.floor(x*image.width))*4+3)];
 const chartPixel = (image, u=.5625, v=.5625, aspect=1) => {
   const height = Math.min(image.width/aspect, image.height) * .9;
   return pixel(image, .5+(u-.5)*height*aspect/image.width, .5+(v-.5)*height/image.height);
 };
 const waitOptions = async (args, expected) => {
   const deadline = Date.now() + 15000;
   while (Date.now() < deadline) {
     const {options} = await client.call('preview.texture.get', args);
     if (Object.entries(expected).every(([key,value]) => JSON.stringify(options[key]) === JSON.stringify(value))) return;
     await new Promise(resolve => setTimeout(resolve, 50));
   }
   assert.fail(`texture controls did not commit ${JSON.stringify(expected)}`);
 };
 const open = async sourceKey => {
   const asset=assets.find(a=>a.sourceKey===sourceKey);
   assert.ok(asset,`${sourceKey} is catalogued`);
   state=await client.openAsset(asset.guid,{projectId:state.project.id});
   const target=state.openRequest.preview.target;
   const args={targetId:target.targetId,targetGeneration:target.generation};
   readCounts.set(target.targetId, 0);
   const panel=page.getByTestId('panel-texture-preview').filter({visible:true});
   await panel.getByRole('toolbar').waitFor({timeout:120000});
   await panel.locator('canvas').waitFor({state:'visible'});
   return {args,panel,info:await client.call('preview.texture.get',args)};
 };
 const capture = async (args,name) => {
   const result = await client.capture(args);
   const bytes = Buffer.from(result.png.split(',')[1],'base64');
   await writeFile(join(output,`${name}.png`),bytes);
   return parseImage(bytes,'image/png',{mipmap:false}).unwrap();
 };
 const set = (args,options) => client.call('preview.texture.set',{...args,options});
 const rgba = await open('texture/rgba-mips');
 assert.equal(rgba.info.mipCount,4);
 await capture(rgba.args,'rgba-checker');
 await page.screenshot({path:join(output,'rgba.png')});
 // Drive real controls, then verify Engine source pixels through its submitted-frame capture.
 await rgba.panel.getByLabel('Mip',{exact:true}).selectOption('1');
 await waitOptions(rgba.args,{mip:1});
 near(chartPixel(await capture(rgba.args,'mip-1')),[0,srgb(220/255),0],'source mip 1');
 await rgba.panel.getByLabel('Mip',{exact:true}).selectOption('2');
 await waitOptions(rgba.args,{mip:2});
 near(chartPixel(await capture(rgba.args,'mip-2')),[0,0,srgb(230/255)],'source mip 2');
 await set(rgba.args,{mip:0,channels:[true,false,false,false],background:'black'});
 near(chartPixel(await capture(rgba.args,'red-channel')),Array(3).fill(srgb(200/255)),'R isolation is grayscale');
 await set(rgba.args,{channels:[false,true,false,false]});
 near(chartPixel(await capture(rgba.args,'green-channel')),Array(3).fill(srgb(80/255)),'G isolation is grayscale');
 await set(rgba.args,{channels:[false,false,true,false]});
 near(chartPixel(await capture(rgba.args,'blue-channel')),Array(3).fill(srgb(20/255)),'B isolation is grayscale');
 await set(rgba.args,{channels:[false,false,false,true]});
 near(chartPixel(await capture(rgba.args,'alpha-channel')),Array(3).fill(srgb(128/255)),'A isolation');
 await set(rgba.args,{channels:[true,false,true,false]});
 near(chartPixel(await capture(rgba.args,'red-blue')),[srgb(200/255),0,srgb(20/255)],'independent RGBA toggles');
 await set(rgba.args,{channels:[true,true,true,true]});
 near(chartPixel(await capture(rgba.args,'alpha-black')),[200,80,20].map(v=>srgb(v/255*128/255)),'alpha over black');
 await assert.rejects(set(rgba.args,{mip:4}));
 assert.equal((await client.call('preview.texture.get',rgba.args)).options.mip,0);
 // API updates must reach the mounted form, without reload or a second state owner.
 await set(rgba.args,{mip:3});
 await page.waitForFunction(()=>[...document.querySelectorAll('[aria-label="Mip"]')].some(e=>e.value==='3'));
 await rgba.panel.getByRole('button',{name:'100%',exact:true}).click();
 await capture(rgba.args,'one-to-one');
 assert.equal((await client.call('preview.texture.get',rgba.args)).options.zoom,1);
 await rgba.panel.getByRole('button',{name:'Fit',exact:true}).click();
 const canvas=rgba.panel.locator('canvas'), bounds=await canvas.boundingBox();
 await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
 await page.mouse.down(); await page.mouse.move(bounds.x+bounds.width/2+30,bounds.y+bounds.height/2+20); await page.mouse.up();
 await capture(rgba.args,'pan');
 assert.ok((await client.call('preview.texture.get',rgba.args)).options.pan[0]>0);
 await page.mouse.wheel(0,-100); await capture(rgba.args,'zoom');
 assert.equal(typeof (await client.call('preview.texture.get',rgba.args)).options.zoom,'number');
 for (const [key,color] of [['array',[0,0,srgb(230/255)]],['volume',[0,srgb(220/255),0]]]) {
   const item=await open(`texture/${key}`);
   assert.equal(item.info.depth,2);
   await item.panel.getByLabel('Slice',{exact:true}).fill('1');
   await waitOptions(item.args,{layer:1});
   near(chartPixel(await capture(item.args,key)),color,`${key} slice 1`);
 }
 await page.waitForTimeout(600);
 const hiddenReads = readCounts.get(rgba.args.targetId);
 assert.ok(hiddenReads > 0, 'active texture page reads the Engine owner');
 await page.waitForTimeout(1100);
 assert.equal(readCounts.get(rgba.args.targetId),hiddenReads,'hidden texture pages stop polling');
 const hdr=await open('texture/hdr');
 await set(hdr.args,{exposure:-2});
 near(pixel(await capture(hdr.args,'hdr')),[.5,.0625,.03125].map(srgb),'HDR exposure uses linear stops');
 const filter=await open('texture/filter');
 await set(filter.args,{filter:'nearest'});
 const nearest=pixel(await capture(filter.args,'nearest'),.49,.5);
 await set(filter.args,{filter:'linear'});
 const linear=pixel(await capture(filter.args,'linear'),.49,.5);
 assert.ok(nearest[0]>240 && nearest[2]<10 && linear[0]>100 && linear[2]>100,'nearest and bilinear preserve distinct source sampling');
 const env=await open('equirect/environment');
 assert.equal(env.info.mipCount,1);
 assert.equal(env.info.options.projection,'environment');
 await assert.rejects(set(env.args,{mip:1}));
 const original=pixel(await capture(env.args,'environment'));
 await set(env.args,{rotation:[120,0]});
 const rotated=pixel(await capture(env.args,'environment-rotated'));
 assert.notDeepEqual(original,rotated,'environment rotation samples a different direction');
 await env.panel.getByLabel('View',{exact:true}).selectOption('flat');
 await waitOptions(env.args,{projection:'flat'});
 await capture(env.args,'panorama');
 await env.panel.getByLabel('View',{exact:true}).selectOption('cross');
 await waitOptions(env.args,{projection:'cross'});
 await set(env.args,{filter:'nearest'});
 const cross = await capture(env.args,'cube-cross');
 const expectedFaces = [[156,20,20],[13,137,137],[30,230,30],[165,15,150],[20,39,156],[150,124,13]].map(rgb=>rgb.map(v=>srgb(v/255)));
 // Sample away from grid lines in each DDS-order face, then its matching cross cell.
 const crossCells = [[2,1],[0,1],[1,0],[1,2],[1,1],[3,1]];
 for (let face=0;face<6;face++) {
   const [x,y]=crossCells[face];
   near(chartPixel(cross,(x+.58)/4,(y+.37)/3,4/3),expectedFaces[face],`cube cross face ${face} orientation`);
 }
 await env.panel.getByLabel('View',{exact:true}).selectOption('face');
 await waitOptions(env.args,{projection:'face'});
 const faces=[];
 for(let face=0;face<6;face++) {
   await env.panel.getByLabel('Cube face',{exact:true}).selectOption(String(face));
   await waitOptions(env.args,{face});
   const actual=chartPixel(await capture(env.args,`cube-face-${face}`),.58,.37);
   near(actual,expectedFaces[face],`cube face ${face} orientation`);
   faces.push(actual);
 }
 assert.ok(new Set(faces.map(x=>x.join(','))).size>=4,'cube face directions must not repeat a flat source image');
 evidence.push({label:'cube-faces',faces});
 await set(env.args,{projection:'cross'});
 await waitOptions(env.args,{projection:'cross'});
 await capture(env.args,'cube-cross');
 await page.screenshot({path:join(output,'environment-ui.png')});
 // Earlier pages retain their own Engine settings; closing invalidates the exact target.
 assert.equal((await client.call('preview.texture.get',rgba.args)).options.mip,3);
 await client.closePreview(env.args);
 await assert.rejects(set(env.args,{exposure:1}));
 const reopened=await open('equirect/environment');
 assert.equal(reopened.info.options.exposure,0);
 await capture(reopened.args,'environment-reopened');
 const checker = await open('texture/color-checker');
 await capture(checker.args,'color-checker');
 await page.screenshot({path:join(output,'color-checker-ui.png')});
 assert.deepEqual(errors,[]);
 saveEvidence(true);
 console.log('Texture preview pixel and lifecycle checks passed',evidence.length);
} catch(error) {
 await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
 await writeFile(join(output,'failure.txt'),String(error.stack)+'\n'+await page.locator('body').textContent());
 throw error;
} finally {
 await client.close(); await browser.close();
 if(process.env.FORGEAX_TEXTURE_PREVIEW_KEEP!=='1') await command('backend','stop');
}
