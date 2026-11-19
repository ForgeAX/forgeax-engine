async page => {
 const config = __CONFIG__;
 const errors=[];const onError=e=>errors.push(String(e));page.on('pageerror',onError);const cdp=await page.context().newCDPSession(page);
 try {
  await page.goto(config.url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>window.__looty?.ready||window.__looty?.errors.length,undefined,{timeout:120000});
  await page.keyboard.press('KeyN');
  const reset=async()=>{await page.evaluate(()=>{const d=window.__looty;d.teleport(30,50,-40);d.player.fly=true;d.view.yaw=.6;d.view.pitch=.25;d.view.dist=d.view.cur=7;});await page.waitForTimeout(5000);await page.waitForFunction(()=>window.__looty.stats().pending===0&&window.__looty.native.stats().completed>=60,undefined,{timeout:120000});};
  await reset();
  await page.evaluate(()=>{
   const d=window.__looty;window.__motion={label:'',draws:{},ready:{}};const m=window.__motion;const renderer=d.native.app.renderer;const original=renderer.draw.bind(renderer);renderer.draw=(...args)=>{const t=performance.now();const value=original(...args);if(m.label)m.draws[m.label].push(performance.now()-t);return value;};
   d.native.domElement.addEventListener('forgeax:frame-completed',e=>{if(m.label&&e.detail.presentation==='ready')m.ready[m.label]++;});
  });
  const begin=async(label)=>page.evaluate(label=>{const m=window.__motion;m.label=label;m.draws[label]=[];m.ready[label]=0;return {at:performance.now(),stats:window.__looty.stats(),inspect:window.__looty.native.inspect().renderScene,completed:window.__looty.native.stats().completed};},label);
  const end=async()=>page.evaluate(()=>{const m=window.__motion;const label=m.label;m.label='';return {at:performance.now(),draws:m.draws[label],ready:m.ready[label],stats:window.__looty.stats(),inspect:window.__looty.native.inspect().renderScene,completed:window.__looty.native.stats().completed};});
  const move=async()=>{try{await page.keyboard.down('ShiftLeft');for(let i=0;i<config.roundTrips;i++){await page.keyboard.down('KeyW');await page.waitForTimeout(3000);await page.keyboard.up('KeyW');await page.keyboard.down('KeyS');await page.waitForTimeout(3000);await page.keyboard.up('KeyS');}}finally{for(const k of ['KeyW','KeyS','ShiftLeft'])await page.keyboard.up(k);}};
  const phaseBefore=await begin('phases');
  const started=await page.evaluate(()=>{const p=window.__looty.native.profiler;if(!p)throw Error('Profiler unavailable');const r=p.startCapture({frameLimit:1024,eventLimit:131072,detail:'nested'});if(!r.ok)throw Error(JSON.stringify(r.error));window.__phaseSession=r.value;return {ok:r.ok,catalog:p.phaseCatalog};});
  await move();const phaseAfter=await end();
  const capture=await page.evaluate(()=>window.__phaseSession.finish());
  await reset();const cpuBefore=await begin('sampling');
  await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});await cdp.send('Profiler.start');await move();const movingProfile=await cdp.send('Profiler.stop');const cpuAfter=await end();
  const runtimeErrors=await page.evaluate(()=>window.__looty.errors.slice());
  const failed=!capture.ok?'CPU capture failed':capture.value.completeness.droppedEventCount>0?'CPU capture overflow':errors.length||runtimeErrors.length?'Runtime errors during CPU capture':undefined;
  return {config,started,capture,phaseBefore,phaseAfter,cpuBefore,cpuAfter,movingProfile,errors,runtimeErrors,failed};
 } finally {page.off('pageerror',onError);await cdp.detach();}
}