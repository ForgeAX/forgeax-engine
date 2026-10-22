import assert from 'node:assert/strict';
import test from 'node:test';

import { capturePresentation, restorePresentation, tuckPeripheralGridGroups } from '../packages/viewer/src/shell/workbench-layout/grid-layout-migration.ts';

class FakeElement {
  constructor(rect) {
    this.rect = rect;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  querySelector() { return null; }
}

function group(id, location, rect) {
  return {
    id,
    panels: [],
    element: new FakeElement(rect),
    api: {
      location,
      isCollapsed: () => true,
      collapse() {},
      setSize() {},
    },
  };
}

function panel(id, ownerGroup, api) {
  const item = { id, group: ownerGroup };
  item.api = {
    location: ownerGroup.api.location,
    setActive() {
      item.group.activePanel = item;
      api.activePanel = item;
    },
    moveTo({ group: destination, index }) {
      const previous = item.group;
      previous.panels.splice(previous.panels.indexOf(item), 1);
      if (previous.activePanel === item) previous.activePanel = previous.panels[0];
      destination.panels.splice(index ?? destination.panels.length, 0, item);
      item.group = destination;
      item.api.location = destination.api.location;
      item.api.setActive();
    },
  };
  ownerGroup.panels.push(item);
  api.panels.push(item);
  return item;
}

test('tucks all tabs in a peripheral group and leaves a fill group in the grid', () => {
  const host = new FakeElement({ left: 0, top: 0, width: 1000, height: 700 });
  const peripheral = group('right-tools', { type: 'grid' }, { left: 800, top: 100, width: 200, height: 500 });
  const primary = group('main', { type: 'grid' }, { left: 100, top: 100, width: 700, height: 500 });
  const api = {
    groups: [peripheral, primary],
    panels: [],
    addEdgeGroup(position, { id }) {
      const edge = group(id, { type: 'edge', position }, { left: 0, top: 0, width: 0, height: 0 });
      this.groups.push(edge);
      return edge;
    },
    setEdgeGroupVisible() {},
  };
  const inspector = panel('inspector', peripheral, api);
  const parameters = panel('parameters', peripheral, api);
  const scene = panel('scene', primary, api);

  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = FakeElement;
  let tucked;
  try {
    tucked = tuckPeripheralGridGroups(api, host, ['right'], {}, {
      primaryPanelIds: new Set(['scene']),
    });
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }

  const right = api.groups.find((item) => item.api.location.type === 'edge' && item.api.location.position === 'right');
  assert.ok(right);
  assert.deepEqual(right.panels, [inspector, parameters]);
  assert.equal(inspector.api.location.type, 'edge');
  assert.equal(parameters.api.location.type, 'edge');
  assert.equal(scene.group, primary);
  assert.equal(scene.api.location.type, 'grid');
  assert.deepEqual(Object.keys(tucked).sort(), ['inspector', 'parameters']);
});

test('restores the inspector as the active right tab after auto-tuck reverses', () => {
  const host = new FakeElement({ left: 0, top: 0, width: 1000, height: 700 });
  const primary = group('main', { type: 'grid' }, { left: 0, top: 0, width: 800, height: 700 });
  const right = group('right-tools', { type: 'grid' }, { left: 800, top: 0, width: 200, height: 700 });
  const api = {
    groups: [primary, right], panels: [],
    getPanel(id) { return this.panels.find(item => item.id === id); },
    addEdgeGroup(position, { id }) {
      const edge = group(id, { type: 'edge', position }, { left: 0, top: 0, width: 0, height: 0 });
      this.groups.push(edge);
      return edge;
    },
    setEdgeGroupVisible() {}, layout() {},
  };
  const scene = panel('scene', primary, api);
  const inspector = panel('inspector', right, api);
  panel('parameters', right, api);
  inspector.api.setActive();
  scene.api.setActive();

  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = FakeElement;
  try {
    const snapshot = capturePresentation(api, host);
    tuckPeripheralGridGroups(api, host, ['right'], {}, { primaryPanelIds: new Set(['scene']) });
    assert.equal(api.getPanel('parameters').group.activePanel.id, 'parameters');
    restorePresentation(api, snapshot, { layoutHost: host });
    assert.equal(inspector.group.activePanel.id, 'inspector');
    assert.equal(api.activePanel.id, 'scene');
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }
});

test('tucks a wide bottom group to bottom even when it touches the left edge', () => {
  const host = new FakeElement({ left: 0, top: 0, width: 1000, height: 700 });
  const bottomGroup = group('bottom-tools', { type: 'grid' }, { left: 0, top: 490, width: 1000, height: 210 });
  const leftGroup = group('left-tools', { type: 'grid' }, { left: 0, top: 0, width: 220, height: 490 });
  const primary = group('main', { type: 'grid' }, { left: 220, top: 0, width: 780, height: 490 });
  const api = {
    groups: [bottomGroup, leftGroup, primary],
    panels: [],
    addEdgeGroup(position, { id }) {
      const edge = group(id, { type: 'edge', position }, { left: 0, top: 0, width: 0, height: 0 });
      this.groups.push(edge);
      return edge;
    },
    setEdgeGroupVisible() {},
  };
  const bottomPanel = panel('bottom-panel', bottomGroup, api);
  const leftPanel = panel('left-panel', leftGroup, api);
  panel('main-panel', primary, api);

  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = FakeElement;
  try {
    tuckPeripheralGridGroups(api, host, ['left', 'right', 'bottom'], {}, {
      primaryPanelIds: new Set(['main-panel']),
    });
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }

  assert.equal(bottomPanel.api.location.position, 'bottom');
  assert.equal(leftPanel.api.location.position, 'left');
});
