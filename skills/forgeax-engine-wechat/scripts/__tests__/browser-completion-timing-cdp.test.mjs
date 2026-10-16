import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { browserCompletionTimingSource } from '../browser_completion_timing.mjs';

const modulePath = process.env.FORGEAX_PLAYWRIGHT_MODULE;

test('real CDP preserves WebGL2, timer and rAF behavior and restores native hooks', {
  skip: !modulePath,
}, async () => {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.FORGEAX_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.FORGEAX_CHROMIUM_EXECUTABLE }
      : {}),
    // A contract fixture, never hardware performance evidence.
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    chromiumSandbox: true,
  });
  const evidence = {
    browser: browser.version(),
    kind: 'real-cdp-software-webgl2-contract',
    errors: [],
  };
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => evidence.errors.push(error.message));
    await page.addInitScript({
      content: `
      globalThis.__glCalls={fenceSync:0,getSyncParameter:0,flush:0,deleteSync:0};
      globalThis.__beforeTiming={setTimeout,requestAnimationFrame};
      for(const name of Object.keys(__glCalls)) {
        const original=WebGL2RenderingContext.prototype[name];
        const spy=function(...args){__glCalls[name]++;return Reflect.apply(original,this,args)};
        WebGL2RenderingContext.prototype[name]=spy;
        __beforeTiming[name]=spy;
      }
      ${browserCompletionTimingSource({ capacity: 1024 })}
    `,
    });
    await page.goto('data:text/html,<canvas width="4" height="4"></canvas>');
    const cdp = await page.context().newCDPSession(page);
    const result = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{
        const trace=globalThis.__forgeaxCompletionTiming;
        const gl=document.querySelector('canvas').getContext('webgl2');
        if(!gl) throw new Error('Actual WebGL2 context unavailable');
        const start=trace.start();
        const sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
        if(!sync) throw new Error('Native fenceSync failed');
        gl.flush();
        const statusBefore=gl.getSyncParameter(sync,gl.SYNC_STATUS);
        let timerThis=false,timerArgs=false,rafTimestamp=null;
        await new Promise(resolve=>setTimeout(function(a,b){timerThis=this===globalThis;timerArgs=a==='unchanged'&&b===42;resolve()},5,'unchanged',42));
        await new Promise(resolve=>requestAnimationFrame(function(timestamp){rafTimestamp=timestamp;resolve()}));
        const statusAfter=gl.getSyncParameter(sync,gl.SYNC_STATUS);
        let originalError,wrappedError;
        try{__beforeTiming.getSyncParameter.call({},sync,gl.SYNC_STATUS)}catch(e){originalError=e.name}
        try{gl.getSyncParameter.call({},sync,gl.SYNC_STATUS)}catch(e){wrappedError=e.name}
        gl.deleteSync(sync);
        const cancelled=setTimeout(()=>{throw new Error('cancelled timer fired')},100);
        clearTimeout(cancelled);
        const cancelledRaf=requestAnimationFrame(()=>{throw new Error('cancelled rAF fired')});
        cancelAnimationFrame(cancelledRaf);
        globalThis.__pendingRan=0;
        setTimeout(()=>{globalThis.__pendingRan++},0);
        const stopped=trace.stop(),count=stopped.events.length;
        gl.flush();
        const noEventsAfterStop=trace.snapshot().events.length===count;
        const restored=trace.restore();
        const originalsRestored=setTimeout===__beforeTiming.setTimeout&&requestAnimationFrame===__beforeTiming.requestAnimationFrame&&WebGL2RenderingContext.prototype.flush===__beforeTiming.flush;
        await new Promise(resolve=>__beforeTiming.setTimeout.call(globalThis,resolve,20));
        return {start,stopped,restored,noEventsAfterStop,originalsRestored,
          timerThis,timerArgs,rafTimestamp,originalError,wrappedError,statusBefore,statusAfter,
          pendingRan:__pendingRan,glCalls:__glCalls,globalRemoved:!('__forgeaxCompletionTiming' in globalThis)};
      })()`,
    });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    Object.assign(evidence, result.result.value);
    assert.equal(evidence.timerThis, true);
    assert.equal(evidence.timerArgs, true);
    assert.equal(typeof evidence.rafTimestamp, 'number');
    assert.equal(evidence.originalError, 'TypeError');
    assert.equal(evidence.wrappedError, evidence.originalError);
    assert.deepEqual(evidence.glCalls, {
      fenceSync: 1,
      getSyncParameter: 4,
      flush: 2,
      deleteSync: 1,
    });
    assert.equal(evidence.pendingRan, 1, 'Restoration must not cancel pending application work');
    assert.equal(evidence.noEventsAfterStop, true);
    assert.equal(evidence.originalsRestored, true);
    assert.equal(evidence.globalRemoved, true);
    assert.equal(evidence.stopped.overflow.droppedEvents, 0);
    assert.equal(evidence.stopped.coverage.unavailableHooks.length, 0);
    assert.equal(evidence.restored.coverage.restoreConflicts.length, 0);
    const records = evidence.stopped.events;
    assert.equal(records.filter((e) => e.kind === 'fenceSync').length, 1);
    assert.equal(records.filter((e) => e.kind === 'getSyncParameter').length, 3);
    assert.equal(records.filter((e) => e.kind === 'getSyncParameter' && e.threw).length, 1);
    assert.equal(
      records.find((e) => e.kind === 'timer-fire').scheduledAtMs,
      records.find((e) => e.kind === 'timer-schedule').atMs,
    );
    assert.equal(records.find((e) => e.kind === 'raf-fire').rafTimestampMs, evidence.rafTimestamp);
    assert.ok(records.every((e) => e.atMs >= evidence.start.startMs && e.endMs >= e.atMs));
    assert.deepEqual(evidence.errors, []);
  } finally {
    await browser.close();
    if (process.env.FORGEAX_COMPLETION_TIMING_EVIDENCE)
      await writeFile(
        process.env.FORGEAX_COMPLETION_TIMING_EVIDENCE,
        JSON.stringify(evidence, null, 2),
      );
  }
});
