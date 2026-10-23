import assert from 'node:assert/strict';
import { it } from 'node:test';

import { clearEdgeDropPreview, syncEdgeDropPreview } from '../packages/viewer/src/shell/workbench-layout/edge-drop-preview.ts';

class FakeElement {
  constructor() {
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    };
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
  }

  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, width: 320, height: 32 };
  }

  querySelectorAll() {
    return [];
  }

  insertBefore(child, reference) {
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentElement = this;
  }

  remove() {
    const index = this.parentElement?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute() {}
}

it('marks an empty edge preview before revealing the edge group', () => {
  const savedDocument = globalThis.document;
  const savedHTMLElement = globalThis.HTMLElement;
  globalThis.document = { createElement: () => new FakeElement() };
  globalThis.HTMLElement = FakeElement;

  try {
    const group = { id: 'edge-bottom', panels: [], element: new FakeElement() };
    const tabsEl = new FakeElement();
    const visibilityEvents = [];
    const api = {
      groups: [group],
      setEdgeGroupVisible(side, visible) {
        visibilityEvents.push({ side, visible, previewing: group.element.classList.contains('fx-edge-drop-preview') });
      },
    };

    syncEdgeDropPreview(api, {
      edgeSide: 'bottom',
      group,
      tabsEl,
      rect: { x: 0, y: 0, width: 320, height: 32 },
      pointer: { x: 160, y: 16 },
      title: 'Content Browser',
    });

    assert.deepEqual(visibilityEvents, [{ side: 'bottom', visible: true, previewing: true }]);

    clearEdgeDropPreview(api);
    assert.deepEqual(visibilityEvents.at(-1), { side: 'bottom', visible: false, previewing: false });
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = savedHTMLElement;
  }
});
