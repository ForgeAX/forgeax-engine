import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mountOperationHistory } from '../packages/view-plugin-history/src/ui/mount.ts';
import { setLocale } from '../packages/view-plugin-history/src/i18n/index.ts';
setLocale('en');
class Element extends EventTarget {
  children = [];
  dataset = {};
  attributes = new Map();
  textContent = '';
  isConnected = true;
  ownerDocument = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    defaultView: {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      getComputedStyle: () => ({ visibility: 'visible' }),
    },
  });
  closest() {
    return null;
  }
  getClientRects() {
    return [{}];
  }
  append(...elements) {
    this.children.push(...elements);
  }
  replaceChildren(...elements) {
    this.children = elements;
  }
  setAttribute(key, value) {
    this.attributes.set(key, value);
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  get options() {
    return this.children;
  }
  get value() {
    return this.selected ?? this.children[0]?.value ?? '';
  }
  set value(value) {
    this.selected = value;
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const entry = {
  id: 'record',
  operation: 'asset.preview',
  startedAt: '2026-10-16T01:00:00Z',
  completedAt: '2026-10-16T01:00:01Z',
  state: 'succeeded',
  args: { guid: 'mesh-guid' },
  result: { mesh: 'mesh-guid' },
  artifacts: [{ kind: 'png', uri: '/capture.png', available: true }],
};
it('shows saved CLI results and reads one selected image without running any command', async () => {
  const calls = [],
    surface = new Element();
  const dispose = mountOperationHistory({
    document: { createElement: () => new Element() },
    surface,
    client: {
      subscribe(listener) {
        listener({
          revision: 1,
          project: { id: 'project', root: '/project', name: 'Project' },
        });
        return () => {};
      },
      async call(operation, args) {
        calls.push([operation, args]);
        if (operation === 'history.list') return { items: [entry], nextCursor: 'older' };
        if (operation === 'history.get') return entry;
        if (operation === 'history.artifact.read') return { mediaType: 'image/png', data: 'test' };
        throw new Error('Unexpected operation');
      },
    },
  });
  try {
    await tick();
    await tick();
    const [toolbar, , columns] = surface.children;
    assert.equal(toolbar.children[0].textContent, 'Operation history');
    const [list, detail] = columns.children;
    assert.equal(list.children[0].children[0].textContent, 'asset.preview');
    assert.equal(
      detail.children.find((element) => element.className === 'fx-history-image').src,
      'data:image/png;base64,test',
    );
    assert.deepEqual(
      calls.map(([operation]) => operation),
      ['history.list', 'history.get', 'history.artifact.read'],
    );
    toolbar.children[3].dispatchEvent(new Event('click'));
    await tick();
    assert.equal(calls.findLast(([operation]) => operation === 'history.list')[1].before, 'older');
  } finally {
    dispose();
  }
  assert.equal(surface.children.length, 0);
});
it('drops a detail response after the accepted project changes', async () => {
  const surface = new Element(),
    calls = [];
  let publish, complete;
  const dispose = mountOperationHistory({
    document: { createElement: () => new Element() },
    surface,
    client: {
      subscribe(listener) {
        publish = listener;
        listener({ revision: 1, project: { root: '/first', name: 'First' } });
        return () => {};
      },
      call(operation, args) {
        calls.push(operation);
        if (operation === 'history.list')
          return Promise.resolve({
            items: calls.filter((item) => item === 'history.list').length === 1 ? [entry] : [],
          });
        if (operation === 'history.get')
          return new Promise((resolve) => {
            complete = resolve;
          });
        throw new Error('Retired detail must not fetch an image');
      },
    },
  });
  try {
    await tick();
    publish({ revision: 2, project: { root: '/second', name: 'Second' } });
    await tick();
    complete(entry);
    await tick();
    assert.equal(calls.includes('history.artifact.read'), false);
    assert.equal(surface.children[0].children[1].textContent, 'Second');
  } finally {
    dispose();
  }
});
