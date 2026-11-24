import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../native-sponza.mjs', import.meta.url), 'utf8');
function statements(start, end) {
  const first = source.indexOf(start),
    last = source.indexOf(end, first);
  assert(first >= 0 && last > first, 'Actual main-loop observation block required');
  return source.slice(first, last);
}

test('completed frames retain initial Surface identity and publish fresh current facts', () => {
  // Execute the actual main-loop statements. No Renderer/GPU emulation or copy
  // of the assignment policy: only the already-produced observation is supplied.
  const script = new vm.Script(
    statements('    if (observedSurface !== undefined) {', '    const frameReadiness ='),
  );
  const context = vm.createContext({
    report: { adapter: {}, renderer: {} },
    surfaceSnapshot: undefined,
  });
  const frames = [
    {
      configuredFrameId: 1,
      rendererDevice: { info: 'same-device' },
      surface: { extent: { width: 1600, height: 900, scaleFactor: 2 } },
    },
    {
      configuredFrameId: 2,
      rendererDevice: { info: 'same-device' },
      surface: { extent: { width: 801, height: 451, scaleFactor: 1 } },
    },
  ];
  for (const frame of frames) {
    context.observedSurface = frame;
    context.currentWindowFacts = { ...frame.surface.extent, visible: true };
    context.receipt = { frameId: frame.configuredFrameId };
    script.runInContext(context);
  }
  assert.equal(context.report.renderer.surfaceConfiguredFrameId, 1);
  assert.equal(context.report.renderer.surface, frames[0].surface);
  assert.equal(context.report.renderer.currentSurface, frames[1].surface);
  assert.equal(context.report.renderer.currentSurfaceFrameId, 2);
  assert.equal(context.report.renderer.currentWindow.width, 801);
  context.observedSurface = undefined;
  context.receipt.frameId = 3;
  script.runInContext(context);
  assert.equal(context.report.renderer.currentSurface.state, 'unconfigured-after-completed-frame');
  assert.equal(context.report.renderer.surfaceConfiguredFrameId, 1);
});

test('display details retain original fields in a bounded ring with explicit overflow', () => {
  const script = new vm.Script(
    `${statements('const recordWindowEvents = ', '\n};')}\n};`,
  );
  const context = vm.createContext({
    report: { completedFrames: 7, inputEvents: { displayChanged: 0 } },
    lastCompletedFrameId: 23,
    sessionStartedAt: 1000,
    performance: { now: () => 1500 },
    structuredClone,
  });
  script.runInContext(context);
  const record = (events, facts = { width: 1600, height: 900, scaleFactor: 2 }) => {
    context.events = events;
    context.windowFacts = facts;
    vm.runInContext('recordWindowEvents(events, windowFacts)', context);
  };
  record([{ kind: 'redraw' }]);
  for (let i = 0; i < 35; i++)
    record([{ kind: 'display' }], { width: 1600 + i, height: 900, scaleFactor: i === 0 ? 2 : 1 });
  const history = context.report.displayEvents;
  assert.equal(context.report.inputEvents.displayChanged, 35);
  assert.equal(history.entries.length, 32);
  assert.equal(history.overflow, 3);
  assert.equal(history.entries[0].window.width, 1603);
  assert.equal(history.entries[31].window.width, 1634);
  assert.equal(history.entries[31].event.kind, 'display');
  assert.equal(history.entries[31].event.width, undefined);
  assert.equal(history.entries[31].frameId, 23);
  assert.equal(history.entries[31].elapsedSeconds, 0.5);
  const event = { kind: 'display' },
    facts = { width: 800, height: 450, scaleFactor: 1 };
  record([event], facts);
  event.kind = 'redraw';
  facts.width = 99;
  assert.equal(history.entries[31].window.width, 800);
  assert.equal(history.entries[31].event.kind, 'display');
  assert.equal(history.overflow, 4);
});
