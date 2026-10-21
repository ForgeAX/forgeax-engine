import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdirSync,writeFileSync} from 'node:fs';
import launch from '../../../../scripts/ci/browser-launch.json' with {type:'json'};
const url=process.argv[2]??'http://127.0.0.1:4282/transparency-response.html?capture';
const directory=process.argv[3]??'artifacts/rendering-parity/transparency';
const record=process.argv.includes('--record'), capture=process.argv.includes('--capture');
mkdirSync(directory,{recursive:true});
const browser=await chromium.launch({...launch,args:[...launch.args,'--use-angle=swiftshader'],chromiumSandbox:true});
try {
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];
 page.on('pageerror',e=>{errors.push(String(e));console.error(String(e));});page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text());}});
 await page.goto(url);await page.waitForFunction(()=>globalThis.transparencyResponse?.initial,null,{timeout:180000});
 const reports=[];
 for(const path of ['forward','deferred'])for(const blend of ['straight','premultiplied'])for(const fog of [false,true])for(const tone of ['linear','reinhard'])for(const transparent of [false,true]){
  const options={path,blend,fog,tone,transparent};const download=capture?page.waitForEvent('download'):undefined;
  const report=await page.evaluate(({options,capture})=>globalThis.transparencyResponse.run(options,capture),{options,capture});reports.push(report);console.log(JSON.stringify(report));
  const name=`${path}-${blend}-${fog}-${tone}-${transparent}`;
  if(download)await(await download).saveAs(`${directory}/${name}.rhitape`);
  await page.screenshot({path:`${directory}/${name}.png`});
 }
 writeFileSync(`${directory}/report.json`,JSON.stringify({url,reports,errors},null,2));assert.deepEqual(errors,[]);
 if(!record)for(const report of reports){assert.ok(report.linear.max<.01);assert.ok(report.offscreen.max<.01);assert.ok(report.outputOrder.max<.01);}
}finally{await browser.close();}
