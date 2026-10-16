import { mountUi, type UiAsset, type UiInstance } from '@forgeax/engine-ui';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { required } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const host: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const settings = await (
  await fetch(
    new URL('../../../../apps/game-capability-lab/assets/ui/settings.pack.json', import.meta.url),
  )
).json();
const font = new Uint8Array(
  await (
    await fetch(
      new URL(
        '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
        import.meta.url,
      ),
    )
  ).arrayBuffer(),
);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function pair() {
  const native = document.createElement('section');
  native.style.cssText =
    'position:absolute;left:0;top:0;width:500px;height:500px;background:white;z-index:100';
  document.body.append(native);
  cleanup.push(() => native.remove());
  const ui = await createBlitzUi({
    wasm: host,
    html: '<style>body{margin:0}</style>',
    width: 500,
    height: 500,
    font,
    onError: (cause) => {
      throw cause;
    },
  });
  cleanup.push(() => ui.dispose());
  return { native, ui };
}

function properties(document: Document) {
  const range = document.createElement('input');
  range.type = 'range';
  const rows: unknown[] = [];
  const snapshot = () =>
    rows.push([range.value, range.valueAsNumber, range.defaultValue, range.validity.valid]);
  snapshot();
  for (const value of ['', 'bad', '25.5', '1e1', '-1', '101', '.5', '+1', '1.', '1e999']) {
    range.value = value;
    snapshot();
  }
  range.value = '23';
  range.defaultValue = '70';
  snapshot();
  rows.push([(range.cloneNode(true) as HTMLInputElement).value]);
  range.min = '30';
  snapshot();
  range.max = '20';
  snapshot();
  range.min = '0';
  range.max = '1';
  range.step = '.2';
  range.value = '.3';
  snapshot();
  range.value = '.9';
  snapshot();
  range.min = '';
  range.step = '.25';
  range.defaultValue = '.1';
  range.value = '.2';
  snapshot();
  range.step = 'any';
  range.value = '.35';
  snapshot();
  range.valueAsNumber = Number.NaN;
  snapshot();
  range.min = '-1';
  range.max = '1';
  range.step = '.1';
  range.value = '0';
  range.stepUp(3);
  snapshot();
  range.stepDown(2);
  snapshot();
  range.max = '0.25';
  snapshot();
  range.removeAttribute('max');
  snapshot();
  range.readOnly = true;
  rows.push([range.willValidate, range.checkValidity()]);
  return rows;
}

it('matches Chromium range value sanitization, dirty defaults, clones and step arithmetic before layout', async () => {
  const { ui } = await pair();
  expect(properties(ui.document)).toEqual(properties(document));
});

it('runs the actual settings controller in both documents and restores its focus', async () => {
  const behavior = new URL(
    '../../../../apps/game-capability-lab/assets/plugins/settings.ts',
    import.meta.url,
  );
  const { createGameSettingsState, mountSettings, SETTINGS_UI_GUID } = (await import(
    /* @vite-ignore */ behavior.href
  )) as {
    SETTINGS_UI_GUID: string;
    createGameSettingsState(): { music: number; bloom: boolean; antialias: string };
    mountSettings(
      asset: UiAsset,
      root: HTMLElement,
      state: unknown,
      fallback: HTMLElement,
    ): {
      error?: unknown;
      instance: UiInstance | null;
      open(): void;
      dispose(): void;
    };
  };
  const { native, ui } = await pair();
  for (const body of [native, required(ui.document.body)]) {
    const owner = body.ownerDocument;
    const trigger = owner.createElement('button');
    body.append(trigger);
    trigger.focus();
    const state = createGameSettingsState();
    const settingsUi = mountSettings(
      { guid: SETTINGS_UI_GUID, ...settings.assets['ui/settings'].payload },
      body,
      state,
      trigger,
    );
    expect(settingsUi.error).toBeUndefined();
    cleanup.push(() => settingsUi.dispose());
    settingsUi.open();
    const shadow = required(required(settingsUi.instance).host.shadowRoot);
    const field = required(shadow.querySelector<HTMLInputElement>('[data-ui-setting="music"]'));
    const bloom = required(shadow.querySelector<HTMLInputElement>('[data-ui-setting="bloom"]'));
    const select = required(
      shadow.querySelector<HTMLSelectElement>('[data-ui-setting="antialias"]'),
    );
    const key = async (name: string) => {
      if (body === native) await userEvent.keyboard(`{${name}}`);
      else {
        ui.input.key({ type: 'keydown', key: name });
        ui.input.key({ type: 'keyup', key: name });
      }
    };
    field.focus();
    await key('Home');
    expect(state.music).toBe(0);
    await key('Tab');
    await key('Tab');
    expect(shadow.activeElement).toBe(select);
    bloom.click();
    expect(state.bloom).toBe(false);
    select.focus();
    await key('Home');
    expect(state.antialias).toBe('none');
    required(shadow.querySelector<HTMLButtonElement>('button')).click();
    expect(required(shadow.querySelector<HTMLElement>('[role="dialog"]')).hidden).toBe(true);
    expect(trigger.inert).toBe(false);
    expect(owner.activeElement).toBe(trigger);
  }
});

it('isolates inert shadow descendants from focus and real pointer input, then restores interaction', async () => {
  const { native, ui } = await pair();
  for (const body of [native, required(ui.document.body)]) {
    const owner = body.ownerDocument;
    const region = owner.createElement('section');
    body.append(region);
    const shadow = region.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button style="width:160px;height:40px">Action</button>';
    const button = required(shadow.querySelector<HTMLButtonElement>('button'));
    let clicks = 0;
    button.addEventListener('click', () => clicks++);
    const tap = async () => {
      if (body === native) await userEvent.click(button, { force: true });
      else {
        const rect = button.getBoundingClientRect();
        for (const phase of ['down', 'up'] as const)
          ui.input.pointer({
            phase,
            pointerId: 1,
            pointerType: 'touch',
            x: rect.x + 10,
            y: rect.y + 10,
          });
      }
    };
    expect(region.inert).toBe(false);
    button.focus();
    expect(shadow.activeElement).toBe(button);
    region.inert = true;
    expect(region.hasAttribute('inert')).toBe(true);
    // Observe Chromium's rendering-boundary retirement instead of guessing its timing.
    // Blitz must still retire focus synchronously when the attribute changes.
    if (body === native) await expect.poll(() => shadow.activeElement).not.toBe(button);
    else expect(shadow.activeElement).not.toBe(button);
    button.focus();
    expect(shadow.activeElement).not.toBe(button);
    await tap();
    expect(clicks).toBe(0);
    region.inert = false;
    await tap();
    expect(clicks).toBe(1);
    button.addEventListener(
      'pointerdown',
      () => {
        region.inert = true;
      },
      { once: true },
    );
    await tap();
    expect(clicks).toBe(1);
    region.inert = false;
    await tap();
    expect(clicks).toBe(2);
    region.remove();
  }
});

it('retires a held native contact across inert activation and restoration', async () => {
  const { ui } = await pair();
  const region = ui.document.createElement('section');
  required(ui.document.body).append(region);
  const shadow = region.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<input type="range" min="0" max="100" value="20">';
  const field = required(shadow.querySelector<HTMLInputElement>('input'));
  const rect = field.getBoundingClientRect();
  const trace: string[] = [];
  for (const kind of ['input', 'change']) field.addEventListener(kind, () => trace.push(kind));
  ui.input.pointer({
    phase: 'down',
    pointerId: 1,
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  const value = field.value;
  const before = [...trace];
  region.inert = true;
  region.inert = false;
  for (const phase of ['move', 'up'] as const)
    ui.input.pointer({ phase, pointerId: 1, x: rect.right - 8, y: rect.y + rect.height / 2 });
  expect(field.value).toBe(value);
  expect(trace).toEqual(before);
  expect(ui.input.ownsInput()).toBe(false);
});

it('mounts the actual settings UiAsset and matches pointer, keyboard and canceled defaults', async () => {
  const { native, ui } = await pair();
  const payload = settings.assets['ui/settings'].payload;
  const roots = [native, required(ui.document.body)].map((root) => {
    const result = mountUi({ guid: 'settings-range-consumer', ...payload }, { root, layer: 1 });
    if (!result.ok) throw result.error;
    cleanup.push(() => result.value.dispose());
    const shadow = required(result.value.host.shadowRoot);
    required(shadow.querySelector<HTMLElement>('[role="dialog"]')).hidden = false;
    return shadow;
  });
  const fields = roots.map((root) =>
    required(root.querySelector<HTMLInputElement>('[data-ui-setting="music"]')),
  );
  async function run(
    field: HTMLInputElement,
    tap: (fraction: number) => Promise<void>,
    key: (key: string) => Promise<void>,
    drag: () => Promise<void>,
  ) {
    field.min = '0';
    field.max = '100';
    field.step = '3';
    field.value = '0';
    const trace: unknown[] = [];
    for (const kind of ['input', 'change'])
      field.addEventListener(kind, () => trace.push([kind, field.value]));
    for (const fraction of [0.25, 0.75, 0.5]) await tap(fraction);
    for (const value of [
      'ArrowRight',
      'ArrowUp',
      'ArrowLeft',
      'ArrowDown',
      'Home',
      'End',
      'PageDown',
      'PageUp',
    ])
      await key(value);
    field.value = '0';
    await drag();
    field.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    await key('Home');
    field.addEventListener('pointerdown', (event) => event.preventDefault(), { once: true });
    await tap(0.25);
    field.disabled = true;
    await tap(0.5);
    field.disabled = false;
    return { trace, value: field.value };
  }
  const nativeField = required(fields[0]);
  const expected = await run(
    nativeField,
    async (fraction) => {
      const rect = nativeField.getBoundingClientRect();
      await userEvent.click(nativeField, {
        force: nativeField.disabled,
        position: { x: rect.width * fraction, y: rect.height / 2 },
      });
    },
    (key) => userEvent.keyboard(`{${key}}`),
    async () => {
      const rect = nativeField.getBoundingClientRect();
      await userEvent.dragAndDrop(nativeField, nativeField, {
        sourcePosition: { x: 8, y: rect.height / 2 },
        targetPosition: { x: rect.width - 8, y: rect.height / 2 },
      });
    },
  );
  const blitzField = required(fields[1]);
  const actual = await run(
    blitzField,
    async (fraction) => {
      const rect = blitzField.getBoundingClientRect();
      for (const phase of ['down', 'up'] as const)
        ui.input.pointer({
          phase,
          pointerId: 1,
          pointerType: 'mouse',
          x: rect.x + rect.width * fraction,
          y: rect.y + rect.height / 2,
        });
    },
    async (key) => {
      ui.input.key({ type: 'keydown', key });
      ui.input.key({ type: 'keyup', key });
    },
    async () => {
      const rect = blitzField.getBoundingClientRect();
      for (const phase of ['down', 'move', 'up'] as const)
        ui.input.pointer({
          phase,
          pointerId: 1,
          pointerType: 'mouse',
          x: rect.x + (phase === 'down' ? 8 : rect.width - 8),
          y: rect.y + rect.height / 2,
        });
    },
  );
  expect(actual).toEqual(expected);
  expect(ui.input.focusedText()).toBeNull();
  expect(ui.paint(0)?.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
});
