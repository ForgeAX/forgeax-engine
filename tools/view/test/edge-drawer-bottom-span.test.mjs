import assert from 'node:assert/strict';
import { it } from 'node:test';

import { installEdgeDrawer } from '../packages/viewer/src/shell/workbench-layout/edge-drawer.ts';

class FakeElement {
  constructor(rect = { left: 0, top: 0, right: 1440, bottom: 1000, width: 1440, height: 32 }) {
    const classes = new Set();
    this.observers = new Set();
    this.children = [];
    this.parentElement = null;
    this.rect = rect;
    this.style = {
      values: new Map(),
      getPropertyValue(name) { return this.values.get(name) ?? ''; },
      setProperty(name, value) { this.values.set(name, String(value)); },
      removeProperty(name) { this.values.delete(name); },
    };
    const changed = () => {
      for (const observer of this.observers) observer.callback([{ attributeName: 'class', target: this }], observer);
    };
    this.classList = {
      add: (...names) => {
        let dirty = false;
        for (const name of names) {
          if (!classes.has(name)) {
            classes.add(name);
            dirty = true;
          }
        }
        if (dirty) changed();
      },
      remove: (...names) => {
        let dirty = false;
        for (const name of names) dirty = classes.delete(name) || dirty;
        if (dirty) changed();
      },
      contains: (name) => classes.has(name),
      toggle: (name, force = !classes.has(name)) => {
        if (force) this.classList.add(name);
        else this.classList.remove(name);
        return force;
      },
    };
  }

  getBoundingClientRect() { return this.rect; }
  getAttribute() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  removeEventListener() {}
  appendChild(child) {
    child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  remove() {
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  contains() { return false; }
}

class FakeMutationObserver {
  constructor(callback) { this.callback = callback; this.targets = new Set(); }
  observe(target) { target.observers.add(this); this.targets.add(target); }
  disconnect() {
    for (const target of this.targets) target.observers.delete(this);
    this.targets.clear();
  }
}

it('keeps an empty Shell bottom edge spanning during preview and clears it afterward', () => {
  const names = ['document', 'HTMLElement', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'window'];
  const saved = new Map(names.map((name) => [name, globalThis[name]]));
  const pendingFrames = [];
  let nextFrame = 0;
  globalThis.HTMLElement = FakeElement;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.ResizeObserver = undefined;
  globalThis.requestAnimationFrame = (callback) => {
    pendingFrames.push(callback);
    return ++nextFrame;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { innerHeight: 1000, innerWidth: 1440 };
  globalThis.document = {
    body: new FakeElement(),
    documentElement: new FakeElement(),
    createElement: () => new FakeElement(),
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    const slot = new FakeElement({ left: 0, top: 968, right: 1440, bottom: 1000, width: 1440, height: 32 });
    const groupElement = new FakeElement({ left: 0, top: 1072, right: 1440, bottom: 1104, width: 1440, height: 32 });
    groupElement.parentElement = slot;
    const group = {
      id: 'edge-bottom',
      panels: [],
      element: groupElement,
      api: { location: { type: 'edge', position: 'bottom' }, collapse() {} },
    };
    const api = {
      groups: [group],
      getEdgeGroup: () => group,
      setEdgeGroupVisible() {},
      onDidLayoutChange: () => ({ dispose() {} }),
      onDidRemovePanel: () => ({ dispose() {} }),
      onDidAddPanel: () => ({ dispose() {} }),
    };
    const root = new FakeElement({ left: 0, top: 0, right: 1440, bottom: 1000, width: 1440, height: 1000 });
    const drawer = installEdgeDrawer(api, root, { edges: ['bottom'] });
    const flushFrames = () => pendingFrames.splice(0).forEach((callback) => callback?.());
    flushFrames();

    groupElement.classList.add('fx-edge-drop-preview');
    flushFrames();
    assert.equal(slot.classList.contains('fx-bottom-edge-spanning'), true);
    assert.equal(root.style.getPropertyValue('--fx-bottom-edge-bottom'), '0px');

    groupElement.classList.remove('fx-edge-drop-preview');
    groupElement.classList.add('fx-edge-empty');
    flushFrames();
    assert.equal(slot.classList.contains('fx-bottom-edge-spanning'), false);
    assert.equal(root.style.getPropertyValue('--fx-bottom-edge-bottom'), '');

    drawer.dispose();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});
