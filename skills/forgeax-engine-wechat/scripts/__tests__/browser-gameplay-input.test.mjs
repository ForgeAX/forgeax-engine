import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  browserGameplayInputSource,
  installBrowserGameplayInput,
} from '../browser_gameplay_input.mjs';

const modulePath = process.env.FORGEAX_PLAYWRIGHT_MODULE;

test('input observer rejects non-Browser and invalid installation options', () => {
  assert.throws(() => installBrowserGameplayInput(), /Browser Window/);
  assert.throws(() => installBrowserGameplayInput({ capacity: 1000000 }), /capacity/);
  assert.throws(() => installBrowserGameplayInput({ globalName: 'not.a.global' }), /identifier/);
});

test('real Browser pointer and MessageChannel observation preserves application calls', {
  skip: !modulePath,
}, async (t) => {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.FORGEAX_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.FORGEAX_CHROMIUM_EXECUTABLE }
      : {}),
    chromiumSandbox: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  await page.addInitScript({
    content: `
    globalThis.__inputSentinel = new Error('original exception identity');
    const nativePost = MessagePort.prototype.postMessage;
    globalThis.__beforeInputPost = function(...args) {
      if (args[0]?.fixtureThrow) throw __inputSentinel;
      const value = Reflect.apply(nativePost, this, args);
      return args[0]?.fixtureReturn ? 17 : value;
    };
    MessagePort.prototype.postMessage = __beforeInputPost;
    ${browserGameplayInputSource({ capacity: 1024 })}
  `,
  });
  await page.goto(
    'data:text/html,<style>body{margin:0;touch-action:none}</style><div id="surface" style="width:320px;height:200px">Input contract</div>',
  );
  await page.evaluate(() => {
    const channel = new MessageChannel();
    globalThis.__inputPort = channel.port1;
    globalThis.__inputPeer = channel.port2;
    globalThis.__receivedInput = [];
    channel.port2.onmessage = (event) => __receivedInput.push(event.data);
    let previous;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      document.addEventListener(
        type,
        (event) => {
          if (event.pointerType !== 'touch') return;
          event.stopPropagation();
          const base = { channel: 'game-3d/player-controls' };
          if (type === 'pointerdown') {
            previous = event.clientX;
            channel.port1.postMessage({ ...base, kind: 'move', horizontal: 0, vertical: 1 });
          } else if (type === 'pointermove') {
            channel.port1.postMessage({ ...base, kind: 'look', x: event.clientX - previous, y: 0 });
            previous = event.clientX;
          } else channel.port1.postMessage({ ...base, kind: 'reset' });
        },
        { capture: true },
      );
    }
    __forgeaxGameplayInput.start();
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 5, x: 40, y: 80 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ id: 5, x: 90, y: 80 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => __receivedInput.length >= 3);
  const result = await page.evaluate(async () => {
    const port = __inputPort,
      probe = __forgeaxGameplayInput;
    const channel = 'game-3d/player-controls';
    const buffer = new ArrayBuffer(8);
    const returned = port.postMessage(
      {
        channel,
        kind: 'look',
        x: 12.5,
        y: -2.25,
        buffer,
        secret: 'not-recorded-payload',
        fixtureReturn: true,
      },
      [buffer],
    );
    port.postMessage({ channel: 'unrelated', secret: 'not-recorded-other-channel' });
    let getterCalls = 0;
    port.postMessage({
      channel,
      kind: 'look',
      get x() {
        getterCalls++;
        return 3;
      },
      y: 4,
    });
    let sameException = false;
    try {
      port.postMessage({ channel, kind: 'jump', fixtureThrow: true });
    } catch (error) {
      sameException = error === __inputSentinel;
    }
    let originalError, observedError;
    try {
      __beforeInputPost.call({}, { channel, kind: 'reset' });
    } catch (error) {
      originalError = error.name;
    }
    try {
      port.postMessage.call({}, { channel, kind: 'reset' });
    } catch (error) {
      observedError = error.name;
    }
    document.querySelector('#surface').dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 77,
        pointerType: 'pen',
        clientX: 171.5,
        clientY: 99.25,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopped = probe.stop(),
      count = stopped.recordedEvents;
    port.postMessage({ channel, kind: 'run', held: true });
    const noEventsAfterStop = probe.snapshot().recordedEvents === count;
    const restored = probe.restore();
    const originalsRestored = MessagePort.prototype.postMessage === __beforeInputPost;
    port.postMessage({ channel, kind: 'run', held: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const received = __receivedInput.map((value) => ({
      kind: value.kind ?? null,
      x: value.x ?? null,
      bytes: value.buffer?.byteLength ?? null,
    }));
    __inputPort.close();
    __inputPeer.close();
    return {
      stopped,
      restored,
      returned,
      detachedBytes: buffer.byteLength,
      getterCalls,
      sameException,
      originalError,
      observedError,
      noEventsAfterStop,
      originalsRestored,
      globalRemoved: !('__forgeaxGameplayInput' in globalThis),
      received,
    };
  });
  assert.equal(result.returned, 17);
  assert.equal(result.detachedBytes, 0);
  assert.ok(result.received.some((row) => row.bytes === 8 && row.x === 12.5));
  assert.equal(result.getterCalls, 1, 'Observation must not invoke a native-cloned accessor again');
  assert.equal(result.sameException, true);
  assert.equal(result.originalError, 'TypeError');
  assert.equal(result.observedError, result.originalError);
  assert.equal(result.noEventsAfterStop, true);
  assert.equal(result.originalsRestored, true);
  assert.equal(result.globalRemoved, true);
  assert.deepEqual(result.restored.coverage.restoreConflicts, []);
  assert.deepEqual(result.stopped.coverage.unavailableHooks, []);
  assert.equal(result.stopped.coverage.unreadableControlMessages, 1);
  assert.equal(result.stopped.overflow.droppedEvents, 0);
  const pointers = result.stopped.events.filter((row) => row.kind === 'pointer');
  const trusted = pointers.filter((row) => row.trusted);
  assert.deepEqual(
    trusted.map((row) => row.type),
    ['pointerdown', 'pointermove', 'pointerup'],
  );
  assert.ok(trusted.every((row) => row.pointerType === 'touch'));
  assert.equal(new Set(trusted.map((row) => row.pointerId)).size, 1);
  assert.equal(trusted.at(-1).clientX - trusted[0].clientX, 50);
  assert.ok(
    pointers.some((row) => !row.trusted && row.type === 'pointerup' && row.clientX === 171.5),
  );
  const messages = result.stopped.events.filter((row) => row.kind === 'control-message');
  assert.deepEqual(
    messages.filter((row) => row.control.kind === 'look').map((row) => row.control.x),
    [50, 12.5],
  );
  assert.equal(messages.filter((row) => row.threw).length, 2);
  assert.ok(
    result.stopped.events.every(
      (row) => row.atMs >= result.stopped.startMs && row.atMs <= result.stopped.stopMs,
    ),
  );
  assert.doesNotMatch(JSON.stringify(result.stopped), /not-recorded/);
});

test('real Browser observation is bounded and restoration preserves later hooks', {
  skip: !modulePath,
}, async (t) => {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.FORGEAX_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.FORGEAX_CHROMIUM_EXECUTABLE }
      : {}),
    chromiumSandbox: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(installBrowserGameplayInput, { capacity: 8 });
  await page.goto('data:text/html,<div>Bounded input contract</div>');
  const result = await page.evaluate(async () => {
    const probe = __forgeaxGameplayInput,
      channel = new MessageChannel();
    let received = 0;
    channel.port2.onmessage = () => received++;
    probe.start();
    for (let index = 0; index < 12; index++) {
      document.body.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: index,
          pointerId: 8,
          pointerType: 'mouse',
        }),
      );
      channel.port1.postMessage({
        channel: 'game-3d/player-controls',
        kind: 'run',
        held: index % 2 === 0,
      });
    }
    const stopped = probe.stop();
    const owned = MessagePort.prototype.postMessage;
    const later = function (...args) {
      return Reflect.apply(owned, this, args);
    };
    MessagePort.prototype.postMessage = later;
    const restored = probe.restore();
    channel.port1.postMessage({ channel: 'game-3d/player-controls', kind: 'reset' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const laterPreserved = MessagePort.prototype.postMessage === later;
    channel.port1.close();
    channel.port2.close();
    return {
      stopped,
      restored,
      laterPreserved,
      received,
      finalCount: probe.snapshot().recordedEvents,
    };
  });
  assert.equal(result.stopped.recordedEvents, 8);
  assert.equal(result.stopped.overflow.droppedEvents, 16);
  assert.equal(result.stopped.overflow.droppedPointers, 8);
  assert.equal(result.stopped.overflow.droppedMessages, 8);
  assert.deepEqual(result.stopped.observed, { pointerEvents: 12, controlMessages: 12 });
  assert.equal(result.laterPreserved, true);
  assert.equal(result.received, 13, 'Restoration must not close or stop application ports');
  assert.equal(result.finalCount, 8);
  assert.deepEqual(result.restored.coverage.restoreConflicts, [
    { name: 'MessagePort.prototype.postMessage', reason: 'replaced-after-install' },
  ]);
});
