/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { mountUi } from '@forgeax/engine-ui';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlitzUi, UiDomError, type UiWasmHost } from '../index.js';
import { checkableHtml, checkableTrace } from './checkable-fixture.js';
import { required } from './fixture.js';

const bytes = await readFile(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url));
const host: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const live: Awaited<ReturnType<typeof createBlitzUi>>[] = [];
async function create(html: string) {
  const ui = await createBlitzUi({
    wasm: host,
    html,
    width: 100,
    height: 100,
    onError: (cause) => {
      throw cause;
    },
  });
  live.push(ui);
  return ui;
}
afterEach(() => {
  for (const ui of live.splice(0)) ui.dispose();
});
describe('persistent real Blitz document', () => {
  it('rejects browser-authored CSS before mutating the real native document', async () => {
    const ui = await create('<p>Existing UI</p>');
    const root = required(ui.document.body);
    const before = root.innerHTML;
    const result = mountUi(
      {
        guid: 'browser-css',
        sourcePath: 'hud.ui.html',
        html: '<p class="hud">HUD</p>',
        css: '.hud { text-overflow: ellipsis; position: sticky; }',
        browserExtensions: ['css'],
      },
      { root, layer: 1 },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-environment',
        detail: {
          diagnostics: [expect.objectContaining({ actual: 'css', sourcePath: 'hud.ui.css' })],
        },
      },
    });
    expect(root.innerHTML).toBe(before);
  });
  it('keeps reset silent on focused editors without suppressing canceled or unrelated edits', async () => {
    const ui = await create('<form id=f></form><input form=f value=Initial><form id=other></form>');
    const form = required(ui.document.querySelector<HTMLFormElement>('#f'));
    const other = required(ui.document.querySelector<HTMLFormElement>('#other'));
    const input = required(ui.document.querySelector('input'));
    const events: string[] = [];
    for (const type of ['input', 'change', 'reset'])
      ui.document.addEventListener(type, () => events.push(type));
    input.value = 'Before focus';
    input.focus();
    ui.input.text('Draft');
    form.reset();
    input.blur();
    expect(input.value).toBe('Initial');
    expect(events).toEqual(['input', 'reset']);
    events.length = 0;
    input.focus();
    ui.input.text('Keep draft');
    form.addEventListener('reset', (event) => event.preventDefault(), { once: true });
    form.reset();
    input.blur();
    expect(input.value).toBe('Keep draft');
    expect(events).toEqual(['input', 'reset', 'change']);
    events.length = 0;
    input.focus();
    ui.input.text('Other draft');
    other.reset();
    input.blur();
    expect(events).toEqual(['input', 'reset', 'change']);
  });
  it('cancels recursive form resets and stops after a reset callback retires the UI', async () => {
    const ui = await create('<form><input value=Initial><button type=reset>Reset</button></form>');
    const form = required(ui.document.querySelector('form'));
    const input = required(ui.document.querySelector('input'));
    input.value = 'Edited';
    let resets = 0;
    form.addEventListener(
      'reset',
      (event) => {
        resets++;
        form.reset();
        event.preventDefault();
      },
      { once: true },
    );
    form.reset();
    expect(resets).toBe(1);
    expect(input.value).toBe('Edited');
    form.addEventListener('reset', () => ui.dispose(), { once: true });
    expect(() => form.reset()).not.toThrow();
  });
  it('blocks submission of an empty required textarea until its current value is filled', async () => {
    const ui = await create(
      '<form><textarea required></textarea><button>Send feedback</button></form>',
    );
    const form = required(ui.document.querySelector('form'));
    const details = required(ui.document.querySelector('textarea'));
    let submissions = 0;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submissions++;
    });
    form.requestSubmit();
    expect(submissions).toBe(0);
    expect(ui.document.activeElement).toBe(details);
    expect(details.checkValidity()).toBe(false);
    details.value = 'The controls respond.\nThe scene is visible.';
    form.requestSubmit();
    expect(submissions).toBe(1);
  });
  it('retains native checked state and radio scope through script and canceled activation', async () => {
    const ui = await create(checkableHtml);
    const result = checkableTrace(ui.document);
    expect(result.states[0]).toEqual({
      check: [true, true, true],
      radios: [true, false, true, true],
      peer: true,
    });
    expect(result.states.at(-1)).toEqual({
      check: [false, false, false],
      radios: [true, false, true, true],
      peer: true,
    });
    expect(result.unnamed).toEqual([true, true]);
    expect(result.booleanAttribute).toEqual([true, false]);
    expect(result.trace.filter((event) => (event as unknown[])[1] === 'input')).toHaveLength(3);
    const text = ui.document.createElement('input');
    expect(() => {
      text.checked = true;
    }).toThrow(UiDomError);
  });
  it('rejects unsupported DOM/CSS atomically with positioned diagnostics', async () => {
    const ui = await create('<style>body{margin:0}</style><main><span>kept</span></main>');
    const main = required(ui.document.querySelector('main'));
    main.style.width = '24px';
    const previous = main.innerHTML;
    for (const mutation of [
      () => {
        main.style.width = 'red';
      },
      () => main.style.setProperty('made-up-property', '1'),
      () => {
        main.style.cssText = 'width:12px;backdrop-filter:blur(4px)';
      },
      () => {
        main.innerHTML = '<input type="file">';
      },
      ...['focus-within'].map((pseudo) => () => {
        main.innerHTML = `<style>button:${pseudo}{outline:2px solid blue}</style><button>Go</button>`;
      }),
      () => ui.document.createElement('slot'),
      () => main.setAttribute('onclick', 'run()'),
    ]) {
      let error: unknown;
      try {
        mutation();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(UiDomError);
      if (!(error instanceof UiDomError)) throw new Error('Expected UiDomError');
      expect(error.diagnostics[0]?.hint).toBeTruthy();
      expect(error.diagnostics[0]?.sourceRange.end).toBeGreaterThan(
        error.diagnostics[0]?.sourceRange.start ?? 0,
      );
      expect(main.innerHTML).toBe(previous);
      expect(main.style.width).toBe('24px');
    }
    const style = ui.document.createElement('style');
    style.textContent = 'main{width:30px}';
    ui.document.head.append(style);
    expect(() => {
      style.textContent = 'main{width:red}';
    }).toThrow(UiDomError);
    expect(style.textContent).toBe('main{width:30px}');
    expect(() => style.appendChild(ui.document.createTextNode('main{width:red}'))).toThrow(
      UiDomError,
    );
    expect(style.textContent).toBe('main{width:30px}');
    const table = ui.document.createElement('table');
    table.innerHTML = '<tbody><tr><td>Cell</td></tr></tbody>';
    required(table.querySelector('tbody')).innerHTML = '<tr><td>Replacement</td></tr>';
    expect(table.textContent).toBe('Replacement');
    const input = ui.document.createElement('input');
    input.type = 'number';
    expect(() => {
      input.type = 'file';
    }).toThrow(UiDomError);
    expect(input.type).toBe('number');
  });

  it('validates the initial document before creating its native state', async () => {
    await expect(create('<style>main{width:red}</style><main></main>')).rejects.toMatchObject({
      code: 'ui-dom-operation-failed',
      operation: 'createBlitzUi',
      diagnostics: [
        expect.objectContaining({ code: 'css-invalid-value', sourcePath: '<ui-document>' }),
      ],
    });
  });
  it('mounts the ordinary UiAsset and delegates actions without browser globals', async () => {
    const ui = await create('<style>body{margin:0}</style>');
    const actions: string[] = [];
    const result = mountUi(
      {
        guid: 'mounted-ui',
        html: '<button data-ui-action="save">Save</button>',
        css: ':host{display:block}button{pointer-events:auto;width:80px;height:30px}',
      },
      { root: ui.document.body, layer: 1, onAction: (name) => actions.push(name) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const { host, signal } = result.value;
    const button = required(required(host.shadowRoot).querySelector('button'));
    expect(button.getBoundingClientRect().width).toBe(80);
    expect(ui.document.querySelector('button')).toBeNull();
    expect(ui.elementFromPoint(10, 10)).toBe(button);
    button.click();
    expect(actions).toEqual(['save']);
    result.value.dispose();
    result.value.dispose();
    expect(signal.aborted).toBe(true);
    expect(host.isConnected).toBe(false);
    button.click();
    expect(actions).toEqual(['save']);
  });
  it('owns open shadow trees, isolates styles and applies dynamic :host state', async () => {
    const ui = await create(
      '<style>body{margin:0}span{display:block;width:90px;height:10px;background:red}</style><section></section><aside></aside><span>outside</span>',
    );
    const host = required(ui.document.querySelector('section'));
    const other = required(ui.document.querySelector('aside'));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>:host{display:block;width:60px}span{display:block;width:20px;height:10px;background:blue}:host(.wide) span{width:40px}</style><span>inside</span>';
    const second = other.attachShadow({ mode: 'open' });
    second.innerHTML =
      '<style>:host{display:block}span{display:block;width:30px;height:10px;background:green}</style><span>other</span>';
    const child = required(shadow.querySelector('span'));
    expect(shadow).toBe(host.shadowRoot);
    expect(shadow.host).toBe(host);
    expect(shadow.parentNode).toBeNull();
    expect(child.parentNode).toBe(shadow);
    expect(child.getRootNode()).toBe(shadow);
    expect(child.getRootNode({ composed: true })).toBe(ui.document);
    expect(child.isConnected).toBe(true);
    expect(ui.document.querySelectorAll('span')).toHaveLength(1);
    expect(child.getBoundingClientRect().width).toBe(20);
    expect(required(second.querySelector('span')).getBoundingClientRect().width).toBe(30);
    expect(required(ui.document.querySelector('span')).getBoundingClientRect().width).toBe(90);
    host.classList.add('wide');
    expect(child.getBoundingClientRect().width).toBe(40);
    host.remove();
    expect(child.isConnected).toBe(false);
    ui.document.body.append(host);
    expect(child.isConnected).toBe(true);
    expect(shadow.querySelector('span')).toBe(child);
  });
  it('reads changed Grid tracks immediately and returns owned pixels only when changed', async () => {
    const ui = await create(
      '<style>body{margin:0;display:grid;grid-template-columns:1fr 1fr;height:100px}section{background:red}aside{background:blue}</style><section></section><aside></aside>',
    );
    const section = required(ui.document.querySelector('section'));
    expect(section.ownerDocument).toBe(ui.document);
    expect(section.getRootNode()).toBe(ui.document);
    const aside = required(ui.document.querySelector('aside'));
    expect(aside.getBoundingClientRect().x).toBe(50);
    const first = required(ui.paint(0));
    expect(Array.from(first.slice(4 * 2525, 4 * 2525 + 4))).toEqual([255, 0, 0, 255]);
    expect(ui.paint(1)).toBeNull();
    ui.document.body.style.gridTemplateColumns = '3fr 1fr';
    expect(aside.getBoundingClientRect().x).toBe(75);
    expect(ui.document.querySelector('section')).toBe(section);
    expect(ui.paint(2)).not.toBeNull();
    expect(Array.from(first.slice(4 * 2525, 4 * 2525 + 4))).toEqual([255, 0, 0, 255]);
    ui.dispose();
    expect(() => section.getBoundingClientRect()).toThrow('UI DOM operation failed');
  });
  it('stops rasterizing a hidden loading animation and restarts it when shown', async () => {
    const ui = await create(
      '<style>body{margin:0}#loading{position:absolute;inset:0}#spinner{position:absolute;left:30px;top:30px;width:30px;height:10px;background:red;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><canvas></canvas><section id="loading"><div id="spinner"></div></section>',
    );
    const loading = required(ui.document.querySelector<HTMLElement>('#loading'));
    const spinner = required(ui.document.querySelector('#spinner'));
    const first = required(ui.paint(0));
    expect(required(ui.paint(250))).not.toEqual(first);
    loading.style.display = 'none';
    required(ui.paint(300));
    expect(ui.paint(400) === null).toBe(true);
    expect(ui.paint(1400) === null).toBe(true);
    expect(ui.document.querySelector('#spinner')).toBe(spinner);
    loading.style.display = 'block';
    const restarted = required(ui.paint(1500));
    expect(required(ui.paint(1750))).not.toEqual(restarted);
  });
  it('preserves detached references and source attributes across dynamic replacement', async () => {
    const ui = await create('<main><span>retained</span></main>');
    const main = required(ui.document.querySelector('main'));
    const span = required(main.firstElementChild);
    main.innerHTML = '<b>new</b>';
    expect(span.textContent).toBe('retained');
    expect(span.parentNode).toBeNull();
    main.append(span);
    expect(main.textContent).toBe('newretained');
    expect(main.querySelector('span')).toBe(span);
    const input = ui.document.createElement('input');
    input.type = 'number';
    input.value = '3.25';
    input.setAttribute('value', '8');
    main.append(input);
    expect(input.value).toBe('3.25');
    expect(input.getAttribute('value')).toBe('8');
  });
  it('supports required/range/step validity and cancellable default submit', async () => {
    const ui = await create('<form><button>Generate</button></form>');
    const form = required(ui.document.querySelector('form'));
    const button = required(form.querySelector('button'));
    const input = ui.document.createElement('input');
    input.type = 'number';
    input.name = 'radius';
    input.required = true;
    input.min = '0.1';
    input.max = '2';
    input.step = '0.05';
    form.insertBefore(input, button);
    const submitted: number[] = [];
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted.push(input.valueAsNumber);
    });
    for (const [value, invalid] of [
      ['', 'valueMissing'],
      ['0.05', 'rangeUnderflow'],
      ['3', 'rangeOverflow'],
      ['0.12', 'stepMismatch'],
    ] as const) {
      input.value = value;
      expect(input.validity[invalid]).toBe(true);
      button.click();
      expect(submitted).toEqual([]);
    }
    input.value = '0.35';
    expect(form.reportValidity()).toBe(true);
    button.click();
    expect(submitted).toEqual([0.35]);
    button.disabled = true;
    button.click();
    expect(submitted).toEqual([0.35]);
    input.value = 'Infinity';
    expect(input.value).toBe('');
    expect(input.valueAsNumber).toBeNaN();
  });
  it('snapshots event paths, runs nested dispatch separately and preserves event identity', async () => {
    const ui = await create('<main><button>Go</button></main>');
    const main = required(ui.document.querySelector('main'));
    const button = required(main.querySelector('button'));
    const event = new Event('work', { bubbles: true, cancelable: true });
    const observed: string[] = [];
    main.addEventListener(
      'work',
      () => {
        observed.push('capture');
        button.remove();
      },
      { capture: true },
    );
    button.addEventListener('nested', () => {
      button.textContent = 'nested';
      observed.push('nested');
    });
    button.addEventListener('work', (current) => {
      expect(current).toBe(event);
      expect(current.composedPath()).toContain(main);
      button.dispatchEvent(new Event('nested'));
      expect(button.textContent).toBe('nested');
      current.preventDefault();
      observed.push('target');
    });
    main.addEventListener('work', () => observed.push('bubble'));
    expect(button.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(observed).toEqual(['capture', 'nested', 'target', 'bubble']);
  });
  it('removes abort and once listeners before later and nested dispatch', async () => {
    const ui = await create('<button>Go</button>');
    const button = required(ui.document.querySelector('button'));
    const abort = new AbortController();
    let count = 0;
    button.addEventListener(
      'work',
      () => {
        count++;
        button.dispatchEvent(new Event('work'));
      },
      { once: true },
    );
    button.addEventListener('work', () => count++, { signal: abort.signal });
    abort.abort();
    button.dispatchEvent(new Event('work'));
    expect(count).toBe(1);
  });
});

it('runs native pointer, string editing, default submit, label focus and disabled controls', async () => {
  const ui = await create(
    '<style>body{margin:0}section{width:100px}button,input,label{display:block;width:80px;height:20px}</style><section></section>',
  );
  const shadow = required(ui.document.querySelector('section')).attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>label,input,button{display:block;width:80px;height:20px}</style><form><label for="radius">Radius</label><input id="radius" type="number" required min="0.1" max="2" step="0.05"><button>Generate</button></form>';
  const label = required(shadow.querySelector('label'));
  const field = required(shadow.querySelector('input'));
  const button = required(shadow.querySelector('button'));
  const form = required(shadow.querySelector('form'));
  const submissions: number[] = [];
  const edits: string[] = [];
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submissions.push(field.valueAsNumber);
  });
  field.addEventListener('input', () => {
    edits.push(field.value);
  });
  const tap = (node: Element) => {
    const rect = node.getBoundingClientRect();
    ui.input.pointer({ phase: 'down', pointerId: 1, x: rect.x + 5, y: rect.y + 5 });
    ui.input.pointer({ phase: 'up', pointerId: 1, x: rect.x + 5, y: rect.y + 5 });
  };
  tap(label);
  expect(shadow.activeElement).toBe(field);
  expect(ui.input.focusedText()).toMatchObject({ type: 'number', value: '' });
  ui.input.text('1e');
  expect(field.value).toBe('');
  expect(field.validity.badInput).toBe(true);
  ui.input.confirm();
  expect(submissions).toEqual([]);
  ui.input.text('0.35');
  ui.input.confirm();
  expect(submissions).toEqual([0.35]);
  expect(edits).toEqual(['', '0.35']);
  button.disabled = true;
  tap(button);
  expect(submissions).toEqual([0.35]);
  button.disabled = false;
  button.focus();
  ui.input.key({ type: 'keydown', key: 'Enter' });
  ui.input.key({ type: 'keydown', key: ' ' });
  expect(submissions).toEqual([0.35, 0.35]);
  ui.input.key({ type: 'keyup', key: ' ' });
  expect(submissions).toEqual([0.35, 0.35, 0.35]);
  ui.input.cancel();
  expect(ui.input.ownsInput()).toBe(false);
});

it('cancels a touch click when dragging an overflow panel and dispatches scroll changes', async () => {
  const ui = await create(
    '<style>body{margin:0}section{width:90px;height:80px;overflow:auto}button{display:block;width:80px;height:40px}div{height:200px}</style><section><button>Generate</button><div></div></section>',
  );
  const section = required(ui.document.querySelector('section'));
  const button = required(ui.document.querySelector('button'));
  let clicks = 0,
    scrolls = 0,
    cancels = 0;
  button.addEventListener('click', () => {
    clicks++;
  });
  button.addEventListener('pointercancel', () => {
    cancels++;
  });
  section.addEventListener('scroll', () => {
    scrolls++;
  });
  ui.input.pointer({ phase: 'down', pointerId: 1, x: 20, y: 30 });
  ui.input.pointer({ phase: 'move', pointerId: 1, x: 20, y: 10 });
  ui.input.pointer({ phase: 'up', pointerId: 1, x: 20, y: 10 });
  expect(section.scrollTop).toBe(20);
  expect([clicks, scrolls, cancels]).toEqual([0, 1, 1]);
  expect(ui.input.wheel({ x: 20, y: 60, deltaX: 0, deltaY: 30 })).toBe(true);
  expect(section.scrollTop).toBe(50);
});
