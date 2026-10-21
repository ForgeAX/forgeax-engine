import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mountPlayToolbar } from '../packages/view-plugin-viewport/src/play-toolbar.ts';

function fixture({ state = { project: { id: 'project' }, play: null }, call } = {}) {
  const createElement = () => ({
    children: [], style: {}, dataset: {}, listeners: {}, attributes: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    remove() {},
    click() { return this.listeners.click(); },
  });
  const element = createElement();
  let signal;
  let released = false;
  const mounted = mountPlayToolbar({
    document: { createElement }, element,
    client: {
      subscribe(listener) { listener(state); return () => { released = true; }; },
      getState: async () => state,
      call: call ?? function(operation, _args, options) {
        assert.equal(operation, 'play.start');
        signal = options?.signal;
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    },
  });
  const toolbar = element.children[0];
  return {
    mounted,
    toolbar,
    element,
    button: label => toolbar.children.find(child => child.attributes['aria-label'] === label && child.style.display !== 'none'),
    status: toolbar.children.at(-1),
    get signal() { return signal; },
    get released() { return released; },
  };
}

it('places the shared viewport toolbar before the independently sized render surface', () => {
  const view = fixture();
  assert.equal(view.toolbar.className, 'fx-toolbar fx-toolbar--viewport');
  assert.equal(view.toolbar.attributes.role, 'toolbar');
  assert.equal(view.toolbar.attributes['aria-label'], 'Scene execution');
  assert.deepEqual(view.element.children, [view.toolbar, view.mounted.surface]);
  assert.equal(view.toolbar.style.position, undefined);
  view.mounted.dispose();
});

it('allows Stop to cancel preparation before Engine has published a Play target', async () => {
  const view = fixture();
  const toggle = view.button('Play');
  assert.equal(view.status.hidden, true);
  assert.match(toggle.innerHTML, /<svg/);
  assert.equal(toggle.title, 'Play');
  assert.equal(view.button('Stop'), undefined);
  const starting = toggle.click();
  assert.equal(view.button('Stop'), toggle);
  assert.match(toggle.innerHTML, /<rect/);
  assert.equal(toggle.disabled, false);
  assert.match(view.status.textContent, /Preparing Play/);
  assert.equal(view.status.hidden, false);
  await view.button('Stop').click();
  await starting;
  assert.equal(view.signal.aborted, true);
  assert.equal(view.button('Play'), toggle);
  assert.match(toggle.innerHTML, /<polygon/);
  assert.equal(toggle.disabled, false);
  assert.equal(view.status.textContent, '');
  assert.equal(view.status.hidden, true);
  view.mounted.dispose();
  assert.equal(view.released, true);
});

it('releases an unfinished preparation request with the owning panel', async () => {
  const view = fixture();
  const starting = view.button('Play').click();
  view.mounted.dispose();
  assert.equal(view.signal?.aborted, true);
  await starting;
  assert.equal(view.released, true);
});


it('uses the same button to stop the exact running target and returns to Play', async () => {
  const state = { project: { id: 'project' }, play: { phase: 'running', target: { targetId: 'play-target', generation: 7 } }, targetBinding: 'play' };
  let stop;
  const view = fixture({ state, call(operation, args) {
    assert.equal(operation, 'play.stop');
    assert.deepEqual(args, { targetId: 'play-target', targetGeneration: 7 });
    return new Promise(resolve => { stop = () => { state.play = null; state.targetBinding = 'scene'; resolve(); }; });
  } });
  const toggle = view.button('Stop');
  assert.equal(view.button('Play'), undefined);
  const stopping = toggle.click();
  assert.equal(toggle.disabled, true);
  stop();
  await stopping;
  assert.equal(view.button('Play'), toggle);
  assert.equal(toggle.attributes['data-action'], 'scene.play');
  assert.equal(toggle.disabled, false);
  view.mounted.dispose();
});

it('shows only the actions available for the current Play view', () => {
  const state = {
    project: { id: 'project' },
    scenePreview: { target: { targetId: 'scene-target' } },
    play: { phase: 'running', target: { targetId: 'play-target', generation: 7 } },
    targetBinding: 'play',
    preview: { camera: { control: 'player' } },
  };
  const view = fixture({ state });
  assert.equal(view.button('Play'), undefined);
  assert.ok(view.button('Stop'));
  assert.ok(view.button('Eject'));
  assert.equal(view.button('Possess'), undefined);
  assert.ok(view.button('Scene'));
  assert.equal(view.button('Game'), undefined);
  view.mounted.dispose();
});

it('keeps an actionable Play failure visible while idle labels stay hidden', async () => {
  const view = fixture({ call() { throw new Error('Project assets could not be prepared'); } });
  await view.button('Play').click();
  assert.equal(view.status.hidden, false);
  assert.equal(view.status.textContent, 'Project assets could not be prepared');
  assert.equal(view.button('Play').disabled, false);
  view.mounted.dispose();
});
