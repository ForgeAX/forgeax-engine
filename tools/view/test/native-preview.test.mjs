import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createNativePreviewPresentation, installNativePreviewHost, bindWorkspacePreviewSurface,
  dedicatedPreviewPresentation } from '../packages/view-workspace-core/src/preview-surface.ts';

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    fire(name, event) { for (const listener of listeners.get(name) ?? []) listener(event); },
    count(name) { return listeners.get(name)?.size ?? 0; },
  });
}
function element(document, tagName = 'DIV') {
  const node = events({ tagName, ownerDocument: document, dataset: {}, children: [], isConnected: true,
    style: { setProperty(key, value) { this[key] = value; }, getPropertyValue(key) { return this[key] ?? ''; } },
    clientWidth: 640, clientHeight: 480,
    getBoundingClientRect() { return { left: 20, top: 30, width: this.clientWidth, height: this.clientHeight }; },
    getAttribute() { return 'original-style'; }, setAttribute(name, value) { this.restored = value; }, removeAttribute() {},
    closest() { return this.dock ?? null; }, querySelector() { return null; },
    append(child) { child.parentNode?.removeChild(child); this.children.push(child); child.parentNode = this; },
    replaceChildren(...children) { for (const child of [...this.children]) this.removeChild(child); for (const child of children) this.append(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    remove() { this.parentNode?.removeChild(this); }, contains(child) { return child === this || this.children.includes(child); },
  });
  return node;
}
function realm() {
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} unobserve() {} disconnect() { this.disconnected = true; }
  }
  const window = events({ MessageChannel, setTimeout, clearTimeout, crypto, ResizeObserver: Observer, MutationObserver: Observer });
  const document = { defaultView: window, getElementById: () => undefined };
  document.createElement = tag => element(document, tag.toUpperCase());
  document.body = element(document); document.documentElement = element(document);
  window.document = document;
  return { window, document, observers, update: () => observers.filter(o => !o.disconnected).forEach(o => o.callback()) };
}
function fixture() {
  const outer = realm(), inner = realm();
  inner.window.parent = outer.window;
  outer.window.parent = outer.window;
  outer.window.location = new URL('http://view.test/?forgeaxWorkspaceTarget=scene');
  const scene = { targetId: 'scene', generation: 1, sessionId: 'session', worldId: 'scene-world', headed: true };
  const mesh = { targetId: 'mesh', generation: 2, sessionId: 'session', worldId: 'mesh-world', headed: true };
  const material = { targetId: 'material', generation: 3, sessionId: 'session', worldId: 'material-world', headed: true };
  let state = { project: { id: 'project' }, projectPhase: 'running', projectTarget: scene, browserGeneration: 1,
    previews: [mesh, material].map(target => ({ target })), targetBinding: 'preview' };
  const subscribers = new Set(), calls = [];
  const client = { subscribe(fn) { subscribers.add(fn); fn(state); return () => subscribers.delete(fn); }, getState: async () => state };
  const frame = element(outer.document, 'IFRAME');
  outer.document.body.append(frame);
  frame.contentWindow = { postMessage(data, origin, ports) { calls.push(data); inner.window.fire('message', { source: outer.window, data, ports }); } };
  const canvases = new Map([scene, mesh, material].map(target => [target.targetId, element(inner.document, 'CANVAS')]));
  for (const canvas of canvases.values()) inner.document.body.append(canvas);
  const local = { createSurface: ({ target }) => canvases.get(target.targetId),
    resolveTarget: id => state.previews.find(p => p.target.targetId === id), attach() {} };
  const stopHost = installNativePreviewHost({ ...inner, presentation: local, client, createContainer: () => inner.document.createElement('div') });
  const native = createNativePreviewPresentation({ ...outer, presentation: {
    surfacePlacement: 'owner', createSurface: () => frame,
    attach() { throw new Error('The native adapter must replace the Scene-only positioning lifecycle'); },
  }, client });
  const sceneContainer = element(outer.document);
  const stopScene = native.presentation.attachScene({ target: scene, container: sceneContainer });
  function bind(target, pageType) {
    const container = element(outer.document);
    container.dock = element(outer.document);
    const presentation = dedicatedPreviewPresentation(native.presentation, { panelId: `${pageType}-preview`, pageType });
    const bound = bindWorkspacePreviewSurface({ presentation, target, container, sceneTargetId: scene.targetId });
    assert.equal(bound.ok, true);
    return { container, bound, presentation };
  }
  return { outer, inner, frame, scene, mesh, material, canvases, calls, bind, native, stopHost, stopScene, client,
    snapshot: () => state,
    publish(patch) { state = { ...state, ...patch }; for (const listener of subscribers) listener(state); },
    publishParentOnly(patch) { state = { ...state, ...patch }; [...subscribers].at(-1)(state); },
    async dispose() { stopScene(); await native.dispose(); await stopHost(); },
  };
}

it('switches isolated asset surfaces while retaining the iframe and restores Scene on close', { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    f.outer.document.documentElement.dataset.forgeaxViewActivePage = 'mesh';
    const mesh = f.bind(f.mesh, 'mesh');
    await mesh.bound.ready;
    assert.equal(f.canvases.get('mesh').parentNode.dataset.forgeaxDocumentPreview, 'mesh');
    assert.equal(f.frame.parentNode, f.outer.document.body);
    assert.equal(f.frame.style['pointer-events'], 'none', 'outer panel input remains usable');
    assert.equal(f.canvases.get('scene').style.visibility, 'hidden');
    assert.ok(mesh.container.dock.dataset.forgeaxViewDocumentSurface);
    f.outer.document.documentElement.dataset.forgeaxViewActivePage = 'material';
    const material = f.bind(f.material, 'material');
    await material.bound.ready;
    assert.equal(f.canvases.get('mesh').parentNode, f.inner.document.body);
    assert.equal(f.canvases.get('material').parentNode.dataset.forgeaxDocumentPreview, 'material');
    await mesh.presentation.releaseSurface(f.mesh);
    assert.equal(f.canvases.get('material').parentNode.dataset.forgeaxDocumentPreview, 'material', 'closing a hidden asset retains the selected asset');
    f.outer.document.documentElement.dataset.forgeaxViewActivePage = 'scene';
    await material.bound.dispose();
    await material.bound.dispose();
    assert.equal(f.canvases.get('material').parentNode, f.inner.document.body);
    assert.equal(f.canvases.get('scene').style.visibility, '');
    assert.equal(f.frame.style['pointer-events'], 'auto');
    assert.equal(f.frame.style.width, '640px');
    assert.equal(material.container.dock.dataset.forgeaxViewDocumentSurface, undefined);
  } finally { await f.dispose(); }
  assert.equal(f.frame.restored, 'original-style');
  assert.equal(f.inner.window.count('message'), 0);
});

it('rejects an unadmitted target and retires mounted surfaces on browser generation change', { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    f.outer.document.documentElement.dataset.forgeaxViewActivePage = 'mesh';
    const stale = f.bind({ ...f.mesh, generation: 1 }, 'mesh');
    await assert.rejects(stale.bound.ready, /target-stale/);
    await stale.bound.dispose();
    const mesh = f.bind(f.mesh, 'mesh');
    await mesh.bound.ready;
    f.publish({ browserGeneration: 2, previews: [] });
    await mesh.bound.dispose();
    assert.equal(f.canvases.get('mesh').parentNode, f.inner.document.body);
    assert.equal(f.inner.document.body.children.filter(e => e.dataset.forgeaxDocumentPreview).length, 0);
  } finally { await f.dispose(); }
});

it('ignores a sibling window even when it supplies the current project identity', { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    f.outer.document.documentElement.dataset.forgeaxViewActivePage = 'mesh';
    const mesh = f.bind(f.mesh, 'mesh');
    await mesh.bound.ready;
    const channel = new MessageChannel();
    f.inner.window.fire('message', { source: {}, data: { ...f.calls.at(-1), hidden: true }, ports: [channel.port2] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.canvases.get('mesh').parentNode.dataset.forgeaxDocumentPreview, 'mesh');
    channel.port1.close(); channel.port2.close();
    await mesh.bound.dispose();
  } finally { await f.dispose(); }
});

it('reads the committed open state when the child subscription lags behind the parent', { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    f.publish({ previews: [] });
    f.publishParentOnly({ previews: [{ target: f.mesh }] });
    f.outer.document.documentElement.dataset.forgeaxViewActivePage = 'mesh';
    const mesh = f.bind(f.mesh, 'mesh');
    await mesh.bound.ready;
    assert.equal(f.canvases.get('mesh').parentNode.dataset.forgeaxDocumentPreview, 'mesh');
    await mesh.bound.dispose();
  } finally { await f.dispose(); }
});

it('does not mount an old target when browser retirement overtakes its state read', { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    let release;
    f.client.getState = () => new Promise(resolve => { release = () => resolve(before); });
    f.outer.document.documentElement.dataset.forgeaxViewActivePage = 'mesh';
    const mesh = f.bind(f.mesh, 'mesh');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    f.publish({ browserGeneration: 2, previews: [] });
    const disposing = mesh.bound.dispose();
    release();
    await disposing;
    assert.equal(f.canvases.get('mesh').parentNode, f.inner.document.body);
    assert.equal(f.inner.document.body.children.filter(e => e.dataset.forgeaxDocumentPreview).length, 0);
  } finally { await f.dispose(); }
});
