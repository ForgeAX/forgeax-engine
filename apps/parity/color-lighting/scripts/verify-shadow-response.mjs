import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import launch from '../../../../scripts/ci/browser-launch.json' with {type:'json'};
const url=process.argv[2]??'http://127.0.0.1:4282/shadow-response.html?capture';
const directory=process.argv[3]??'artifacts/rendering-parity/shadows';
const record=process.argv.includes('--record'), capture=process.argv.includes('--capture');
mkdirSync(directory,{recursive:true});
const browser=await chromium.launch({...launch,args:[...launch.args,'--use-angle=swiftshader'],chromiumSandbox:true});
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}), errors=[];
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(url);await page.waitForFunction(()=>globalThis.shadowResponse?.initial,null,{timeout:180000});
 const reports=[];
 for(const path of ['forward','deferred']) for(const kind of ['point','spot']) {
  let previous;
  const variants=[...[1,3,5].map(kernel=>({kernel})),{kernel:3,cameraX:.3},{kernel:3,distance:2},...(kind==='spot'?[{kernel:3,normalBias:.05},{kernel:3,normalBias:.2}]:[])];
  for(const [index,variant] of variants.entries()) {
   const download=capture?page.waitForEvent('download'):undefined;
   const result=await page.evaluate(({options,capture})=>globalThis.shadowResponse.run(options,capture),{options:{path,kind,...variant},capture});
   if(download)await(await download).saveAs(`${directory}/${kind}-${path}-${index}.rhitape`);
   await page.screenshot({path:`${directory}/${kind}-${path}-${index}.png`});
   result.changedFromPrevious=previous?result.actual.reduce((s,x,i)=>s+Math.abs(x-previous[i]),0):null;
   previous=result.actual;reports.push(result);console.log(JSON.stringify({...result.report,changedFromPrevious:result.changedFromPrevious}));
  }
 }
 writeFileSync(`${directory}/results.json`,JSON.stringify({url,reports,errors}));assert.deepEqual(errors,[]);
 if(!record) for(const result of reports){assert.ok(result.report.shadowPixels>100,'shadow disappeared');assert.ok(result.report.mean<(result.report.kernel===1?.01:.001),'receiver visibility disagrees');assert.ok(result.report.self.pixels>100,'missing caster interior');assert.ok(result.report.self.meanError<.01,'caster self-shadow disagrees');if(result.changedFromPrevious!==null)assert.ok(result.changedFromPrevious>1,'parameter or motion had no observable effect');}
}finally{await browser.close();}
