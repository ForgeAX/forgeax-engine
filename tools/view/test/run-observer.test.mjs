import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setLocale } from '../packages/view-plugin-display/src/i18n/index.ts';
setLocale('en');
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
  const project = { id: 'project', root: '/project', name: 'Project' };
  const dispose = mountRunObserver({ document: { createElement: () => new Element() }, surface, status, client: {
    subscribe(listener) { listener({ revision: 1, project }); return () => {}; }, ...client,
  } });
  const [toolbar, summary, metadata, picture, hint, logDetails, identityDetails] = surface.children;
  const [label, context, connect, disconnect] = toolbar.children;
  const [, source] = label.children;
  const [, logs] = logDetails.children;
  const [, identity] = identityDetails.children;
  const choose = value => { source.value = value; source.dispatchEvent(new Event('change')); };
  return { status, dispose, summary, metadata, picture, hint, logs, logDetails, identity, source, context, connect, disconnect, choose };
}

it('presents exact snapshots and folded diagnostics without authoring identity fields', () => {
  assert.equal(PublicDisplayStatus, ViewDisplayStatus);
  const ui = mount();
  try {
    assert.match(ui.summary.textContent, /No Play session/);
    ui.choose('run');
    assert.equal(ui.picture.hidden, true);
    ui.status.update({ binding: { root: '/project', runId: 'run-1234' }, observation: {
      status: { phase: 'ready', runId: 'run-1234', revision: 1 },
      image: { png: 'data:image/png;base64,test', capturedAt: '2000-01-01T00:00:00.000Z', revision: 1, frameId: 42 },
      droppedLogs: 2, logs: [{ sequence: 3, level: 'info', text: '<script>not markup</script>' }],
    } });
    assert.equal(ui.context.textContent, 'Project');
    assert.match(ui.identity.textContent, /Run: run-1234/);
    assert.match(ui.metadata.textContent, /Frame 42.*Last captured image/);
    assert.equal(ui.picture.getAttribute('src'), 'data:image/png;base64,test');
    assert.match(ui.logs.textContent, /2 earlier log entries omitted.*\n\[3\] info: <script>not markup<\/script>/);
    assert.notEqual(ui.logDetails.open, true);
    ui.status.update({ status: 'unavailable', error: 'Run replaced', binding: { root: '/project', runId: 'run-1234' }, observation: ui.status.snapshot().observation });
    assert.equal(ui.summary.textContent, 'Run replaced');
    assert.equal(ui.picture.hidden, false, 'the last exact snapshot survives the run ending');
    ui.status.update({ binding: { root: '/project', runId: 'another' }, observation: null });
    assert.equal(ui.picture.getAttribute('src'), null, 'a different identity never inherits old pixels');
  } finally { ui.dispose(); }
  assert.equal(ui.status.listeners.size, 0);
});

it('binds from accepted project context and ignores a reply after disposal', async () => {
  const calls = [];
  let complete;
  const ui = mount({ call(operation, args) {
    calls.push([operation, args]);
    return new Promise(resolve => { complete = resolve; });
  } });
  ui.choose('run');
  ui.connect.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, [['display.bind', { root: '/project' }]]);
  assert.equal(ui.connect.disabled, true);
  const before = ui.status.snapshot();
  ui.dispose();
  complete({ status: 'running', binding: { root: '/project', runId: 'exact-run' } });
  await Promise.resolve();
  assert.equal(ui.status.snapshot(), before);
  ui.connect.dispatchEvent(new Event('click'));
  ui.disconnect.dispatchEvent(new Event('click'));
  assert.equal(calls.length, 1);
});

it('captures only the selected Play source and retains its last frame after Stop', async () => {
  const calls = [];
  let publish;
  const project = { id: 'project', root: '/project', name: 'Project' };
  const play = { phase: 'running', target: { targetId: 'play-target', generation: 3 } };
  const ui = mount({
    subscribe(listener) { publish = listener; listener({ revision: 1, project, play }); return () => {}; },
    capture(args) { calls.push(args); return { png: 'data:image/png;base64,play', frameId: 7 }; },
    call() { throw new Error('No game control operation is allowed'); },
  });
  try {
    await Promise.resolve();
    assert.equal(ui.source.value, 'play');
    assert.equal(ui.connect.hidden, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].targetGeneration, 3);
    assert.equal(ui.picture.getAttribute('src'), 'data:image/png;base64,play');
    ui.choose('run');
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(ui.picture.getAttribute('src'), null);
    ui.choose('play');
    await Promise.resolve();
    publish({ revision: 2, project, play: null });
    assert.match(ui.summary.textContent, /Run ended/);
    assert.equal(ui.picture.getAttribute('src'), 'data:image/png;base64,play');
    publish({ revision: 3, project: { ...project, root: '/other' }, play: null });
    assert.equal(ui.picture.getAttribute('src'), null);
  } finally { ui.dispose(); }
});

it('keeps the last Play frame when capture is busy with the camera', async () => {
  const calls = [];
  const play = { phase: 'running', target: { targetId: 'play-target', generation: 3 } };
  const ui = mount({
    subscribe(listener) { listener({ revision: 1, play }); return () => {}; },
    capture(args) {
      calls.push(args);
      if (calls.length === 1) return { png: 'data:image/png;base64,play', frameId: 4 };
      throw Object.assign(new Error('Engine workspace preview capture is busy'), { code: 'view-workspace-target-busy' });
    },
    call() { throw new Error('display.bind must not run during Play'); },
  });
  try {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(calls.length >= 2, true);
    assert.equal(ui.picture.getAttribute('src'), 'data:image/png;base64,play');
    assert.match(ui.metadata.textContent, /Frame 4/);
    assert.equal(ui.summary.textContent.includes('busy'), false);
  } finally { ui.dispose(); }
});

it('requires an accepted project and disconnects without stopping any run', async () => {
  const calls = [];
  const ui = mount({ call: async (...args) => { calls.push(args.slice(0, 2)); return { binding: null }; } });
  try {
    ui.choose('run');
    ui.disconnect.dispatchEvent(new Event('click'));
    await Promise.resolve();
    assert.deepEqual(calls, [['display.bind', { root: null }]]);
    assert.equal(ui.disconnect.disabled, false);
  } finally { ui.dispose(); }
  const empty = mount({ subscribe(listener) { listener({ revision: 1 }); return () => {}; }, call: async () => ({}) });
  try { empty.choose('run'); assert.equal(empty.connect.disabled, true); }
  finally { empty.dispose(); }
});
