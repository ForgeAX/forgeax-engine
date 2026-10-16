import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createGameplayTimeline } from '../fixtures/gameplay-benchmark/timeline.mjs';
import {
  createCdpContacts,
  executeTimeline,
  waitForReleasedPlayer,
} from '../run_gameplay_benchmark.mjs';

const modulePath = process.env.FORGEAX_PLAYWRIGHT_MODULE;

test('real CDP ends only removed contacts in two, three and four-finger snapshots', {
  skip: !modulePath,
}, async () => {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
    await page.setContent(
      '<style>body{margin:0;touch-action:none}</style><div style="width:320px;height:200px">Independent contacts</div>',
    );
    await page.evaluate(() => {
      globalThis.__touchContacts = [];
      for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
        document.addEventListener(
          type,
          (event) => {
            const points = (list) =>
              [...list].map((point) => ({ id: point.identifier, x: point.clientX }));
            __touchContacts.push({
              type,
              trusted: event.isTrusted,
              changed: points(event.changedTouches),
              active: points(event.touches),
            });
          },
          { passive: true },
        );
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const dispatch = createCdpContacts(cdp),
      samples = [];
    for (const count of [2, 3, 4]) {
      const contacts = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        role: ['move', 'look', 'run', 'jump'][index],
        x: 40 + index * 60,
        y: 80,
      }));
      await dispatch(contacts);
      await dispatch(contacts.slice(0, -1));
      samples.push({ count, event: await page.evaluate(() => __touchContacts.at(-1)) });
      await dispatch.release();
    }
    assert.deepEqual(
      samples.map(({ count, event }) => ({
        count,
        type: event.type,
        trusted: event.trusted,
        ended: event.changed.map((point) => point.x),
        retained: event.active.map((point) => point.x),
      })),
      [2, 3, 4].map((count) => ({
        count,
        type: 'touchend',
        trusted: true,
        ended: [40 + (count - 1) * 60],
        retained: Array.from({ length: count - 1 }, (_, index) => 40 + index * 60),
      })),
      JSON.stringify({ browser: browser.version(), samples }),
    );
  } finally {
    await browser.close();
  }
});

test('real CDP cleanup distinguishes acknowledged release from active or unknown touch', {
  skip: !modulePath,
}, async () => {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const evidence = {
    browser: browser.version(),
    kind: 'plain-dom-cdp-no-game-no-webgl',
    samples: [],
  };
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent(
      '<style>body{margin:0;touch-action:none}</style><div style="width:400px;height:300px">Touch protocol fixture</div>',
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.evaluate(() => {
      globalThis.touchEvidence = [];
      for (const kind of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
        document.addEventListener(kind, (event) =>
          globalThis.touchEvidence.push({
            kind,
            trusted: event.isTrusted,
            remaining: event.touches.length,
          }),
        );
    });
    const point = { id: 1, x: 100, y: 100 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    let duplicateError;
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    } catch (error) {
      duplicateError = error.message;
    }
    evidence.duplicateError = duplicateError;
    assert.match(
      duplicateError,
      /Must send a TouchStart/,
      'Native duplicate cleanup is a real protocol error',
    );
    const wire = [],
      dispatch = createCdpContacts({
        send(method, params) {
          wire.push(params.type);
          return cdp.send(method, params);
        },
      });
    await dispatch([{ ...point, role: 'move' }]);
    await dispatch([]);
    await assert.doesNotReject(
      dispatch.release(),
      'Acknowledged all-up must not send duplicate native cancel',
    );
    await dispatch.release();
    evidence.samples.push({ name: 'known-released', wire: [...wire] });
    assert.deepEqual(wire, ['touchStart', 'touchEnd']);
    await dispatch([{ ...point, role: 'move' }]);
    await dispatch.release();
    await dispatch.release();
    assert.equal(wire.at(-1), 'touchCancel');
    evidence.samples.push({
      name: 'active-cancel',
      releaseConfirmed: dispatch.wireMetrics().releaseConfirmed,
    });

    const lostDown = createCdpContacts({
      async send(method, params) {
        const result = await cdp.send(method, params);
        if (params.type === 'touchStart') throw new Error('simulated lost DOWN acknowledgement');
        return result;
      },
    });
    await assert.rejects(lostDown([{ ...point, role: 'move' }]), /simulated lost DOWN/);
    await lostDown.release();
    evidence.samples.push({
      name: 'lost-down-ack-cancel',
      releaseConfirmed: lostDown.wireMetrics().releaseConfirmed,
    });
    assert.equal(lostDown.wireMetrics().releaseConfirmed, true);

    const lostEnd = createCdpContacts({
      async send(method, params) {
        const result = await cdp.send(method, params);
        if (params.type === 'touchEnd') throw new Error('simulated lost END acknowledgement');
        return result;
      },
    });
    await lostEnd([{ ...point, role: 'move' }]);
    await assert.rejects(lostEnd([]), /simulated lost END/);
    await assert.rejects(lostEnd.release(), /Must send a TouchStart/);
    evidence.samples.push({
      name: 'lost-end-ack-error-preserved',
      releaseConfirmed: lostEnd.wireMetrics().releaseConfirmed,
    });
    assert.equal(lostEnd.wireMetrics().releaseConfirmed, false);

    await page.evaluate(() => {
      globalThis.player = { controls: { horizontal: 0, vertical: 0, run: false }, grounded: false };
      setTimeout(() => {
        globalThis.player.grounded = true;
      }, 80);
    });
    const began = performance.now();
    const player = await waitForReleasedPlayer(
      () =>
        page.evaluate(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return globalThis.player;
        }),
      { timeoutMs: 2000, intervalMs: 10 },
    );
    assert.equal(player.grounded, true);
    assert.ok(performance.now() - began >= 60);
    evidence.samples.push({
      name: 'resolved-landing-witness',
      player,
      elapsedMs: performance.now() - began,
    });

    const timeline = createGameplayTimeline({
      coordinateSpace: { unit: 'css-px', width: 400, height: 300 },
      phaseMs: 1000,
      geometry: {
        move: { x: 0, y: 200, width: 80, height: 80 },
        look: { x: 100, y: 0, width: 180, height: 140 },
        run: { x: 280, y: 200, width: 40, height: 40 },
        jump: { x: 340, y: 200, width: 40, height: 40 },
      },
    });
    const timelineResult = await executeTimeline(timeline, createCdpContacts(cdp), {
      startAt: performance.now() + 50,
    });
    evidence.timeline = timelineResult;
    assert.equal(timelineResult.success, true, timelineResult.failure);
    assert.equal(timelineResult.acknowledgedEvents, 241);
    assert.equal(timelineResult.wireMetrics.releaseConfirmed, true);
    assert.equal(timelineResult.unsettledEvents, 0);
    evidence.touchEvents = await page.evaluate(() => globalThis.touchEvidence);
    assert.ok(evidence.touchEvents.every((event) => event.trusted));
    evidence.success = true;
  } finally {
    await browser.close();
    if (process.env.FORGEAX_CDP_EVIDENCE)
      await writeFile(process.env.FORGEAX_CDP_EVIDENCE, JSON.stringify(evidence, null, 2));
  }
});
