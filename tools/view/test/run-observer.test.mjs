import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ViewDisplayStatus } from '../packages/view-plugin-display/src/status.ts';
import { ViewDisplayStatus as PublicDisplayStatus } from '../packages/view-plugin-display/src/frontend.ts';
import { mountRunObserver } from '../packages/view-plugin-display/src/ui/run-observer.ts';

class Element extends EventTarget {
  isConnected = true;
  ownerDocument = Object.assign(new EventTarget(), { visibilityState: 'visible', defaultView: {
    ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ visibility: 'visible' }),
  } });
  closest() { return null; }
  getClientRects() { return [{}]; }
  children = [];
  attributes = new Map();
  textContent = '';
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
}

function mount(client = { call: async () => ({}) }) {
  const surface = new Element();
  const status = new ViewDisplayStatus();
  const dispose = mountRunObserver({ document: { createElement: () => new Element() }, surface, status, client });
  const [form, summary, picture, logs] = surface.children;
  const [project, run, connect, disconnect] = form.children;
  return { status, dispose, form, summary, picture, logs, project, run, connect, disconnect };
}

it('preserves the public status class and renders only exact observed run snapshots', () => {
  assert.equal(PublicDisplayStatus, ViewDisplayStatus);
  const ui = mount();
  try {
    assert.equal(ui.summary.textContent, 'No Engine run is connected.');
    assert.equal(ui.picture.hidden, true);
    ui.status.update({ binding: { root: '/project', runId: 'run-1234' }, observation: {
      status: { phase: 'ready', runId: 'run-1234', revision: 1 },
      image: { png: 'data:image/png;base64,test', capturedAt: '2000-01-01T00:00:00.000Z', revision: 1, frameId: 42 },
      droppedLogs: 2, logs: [{ sequence: 3, level: 'info', text: '<script>not markup</script>' }],
    } });
    assert.equal(ui.project.value, '/project');
    assert.equal(ui.run.value, 'run-1234');
    assert.match(ui.summary.textContent, /Run run-1234.*Frame 42.*Stale image/);
    assert.equal(ui.picture.hidden, false);
    assert.equal(ui.picture.getAttribute('src'), 'data:image/png;base64,test');
    assert.match(ui.logs.textContent, /2 earlier log entries omitted.*\n\[3\] info: <script>not markup<\/script>/);
    const previousLogs = ui.logs.textContent;
    const logsWrites = [];
    Object.defineProperty(ui.logs, 'textContent', {
      configurable: true,
      get() { return this._text ?? ''; },
      set(value) { logsWrites.push(value); this._text = value; },
    });
    ui.logs._text = previousLogs;
    ui.status.update({ binding: { root: '/project', runId: 'run-1234' }, observation: {
      status: { phase: 'ready', runId: 'run-1234', revision: 1 },
      image: { png: 'data:image/png;base64,test', capturedAt: '2000-01-01T00:00:00.000Z', revision: 1, frameId: 42 },
      droppedLogs: 2, logs: [{ sequence: 3, level: 'info', text: '<script>not markup</script>' }],
    } });
    assert.equal(logsWrites.length, 0);
    ui.status.update({ error: 'Observation unavailable' });
    assert.equal(ui.summary.textContent, 'Observation unavailable');
    assert.equal(ui.picture.hidden, true);
    assert.equal(ui.picture.getAttribute('src'), null);
  } finally { ui.dispose(); }
  assert.equal(ui.status.listeners.size, 0);
});

it('submits binding only and ignores late replies after its owning Fiber disposes the mount', async () => {
  const calls = [];
  let complete;
  const ui = mount({ call(operation, args) {
    calls.push([operation, args]);
    return new Promise(resolve => { complete = resolve; });
  } });
  ui.project.value = '/project';
  ui.run.value = 'exact-run';
  ui.form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.deepEqual(calls, [['display.bind', { root: '/project', runId: 'exact-run' }]]);
  assert.equal(ui.connect.disabled, true);
  const before = ui.status.snapshot();
  ui.dispose();
  complete({ status: 'running', binding: { root: '/project', runId: 'exact-run' } });
  await Promise.resolve();
  assert.equal(ui.status.snapshot(), before);
  ui.form.dispatchEvent(new Event('submit'));
  ui.disconnect.dispatchEvent(new Event('click'));
  assert.equal(calls.length, 1);
  assert.equal(ui.status.listeners.size, 0);
});

it('captures the running Play target instead of binding an independent run', async () => {
  const calls = [];
  const play = { phase: 'running', target: { targetId: 'play-target', generation: 3 } };
  const ui = mount({
    subscribe(listener) {
      listener({ revision: 1, play });
      return () => {};
    },
    getState: async () => ({ revision: 1, play }),
    capture(args) {
      calls.push(['preview.capture', args]);
      return { png: 'data:image/png;base64,play', frameId: 7, width: 8, height: 8 };
    },
    call(...args) { calls.push(args); return {}; },
  });
  try {
    await Promise.resolve();
    assert.equal(ui.form.hidden, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'preview.capture');
    assert.equal(calls[0][1].targetId, 'play-target');
    assert.equal(calls[0][1].targetGeneration, 3);
    assert.equal(calls[0][1].reportError, false);
    assert.equal(calls[0][1].signal.aborted, false);
    assert.equal(ui.picture.hidden, false);
    assert.equal(ui.picture.getAttribute('src'), 'data:image/png;base64,play');
    assert.match(ui.summary.textContent, /Play · running · Frame 7/);
    ui.form.dispatchEvent(new Event('submit', { cancelable: true }));
    ui.disconnect.dispatchEvent(new Event('click'));
    assert.equal(calls.length, 1);
  } finally { ui.dispose(); }
});

it('keeps the last Play frame when capture is busy with the camera', async () => {
  const calls = [];
  const play = { phase: 'running', target: { targetId: 'play-target', generation: 3 } };
  const ui = mount({
    subscribe(listener) {
      listener({ revision: 1, play });
      return () => {};
    },
    capture(args) {
      calls.push(args);
      if (calls.length === 1) return { png: 'data:image/png;base64,play', frameId: 4, width: 8, height: 8 };
      const error = new Error('view-workspace-target-busy: Engine workspace preview capture is busy');
      error.code = 'view-workspace-target-busy';
      throw error;
    },
    call() { throw new Error('display.bind must not run during Play'); },
  });
  try {
    await Promise.resolve();
    assert.equal(ui.picture.getAttribute('src'), 'data:image/png;base64,play');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(calls.length >= 2, true);
    assert.equal(ui.picture.getAttribute('src'), 'data:image/png;base64,play');
    assert.match(ui.summary.textContent, /Play · running · Frame 4/);
    assert.equal(ui.summary.textContent.includes('busy'), false);
  } finally { ui.dispose(); }
});

it('keeps the independent run form until Play is running', async () => {
  const calls = [];
  const ui = mount({ call: async (...args) => { calls.push(args); return {}; } });
  try {
    ui.form.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.deepEqual(calls, []);
    assert.match(ui.summary.textContent, /Provide root and exact runId/);
    assert.equal(ui.summary.textContent.includes('Play'), false);
  } finally { ui.dispose(); }
});

it('disconnects observation without issuing game control operations', async () => {
  const calls = [];
  const ui = mount({ call: async (...args) => { calls.push(args); return { binding: null }; } });
  try {
    ui.disconnect.dispatchEvent(new Event('click'));
    await Promise.resolve();
    assert.deepEqual(calls, [['display.bind', { root: null }]]);
    assert.equal(ui.disconnect.disabled, false);
  } finally { ui.dispose(); }
});
