import { createBlitzUi } from '@forgeax/engine/ui-blitz';
import { installWechatStandards } from '@forgeax/engine/platform-wechat/standards';
import {
  createWechatPlatform,
  createWechatInputBackend,
  createWechatWasmHost,
} from '@forgeax/engine/platform-wechat';
import {
  createGameSettingsState,
  mountSettings,
  SETTINGS_UI_GUID,
} from '../../../../apps/game-capability-lab/assets/plugins/settings.ts';
import source from '../../../../apps/game-capability-lab/assets/ui/settings.pack.json';

async function main() {
  installWechatStandards().unwrap();
  const platform = createWechatPlatform({
    wx,
    requestAnimationFrame,
    cancelAnimationFrame,
  }).unwrap();
  const canvas = platform.canvas;
  const display = platform.display().unwrap();
  canvas.width = display.width;
  canvas.height = display.height;
  const context = canvas.getContext('2d');
  const font = await new Promise((resolve, reject) =>
    wx.getFileSystemManager().readFile({
      filePath: 'ui/font.ttf',
      success: ({ data }) => resolve(new Uint8Array(data)),
      fail: reject,
    }),
  );
  const errors = [];
  function failure(cause, depth = 0) {
    if (cause === null || typeof cause !== 'object') return { message: String(cause) };
    if (depth >= 8) return { message: 'Cause chain exceeded eight levels' };
    const result = {};
    for (const key of ['name', 'message', 'stack', 'code', 'operation', 'errMsg', 'diagnostics'])
      if (cause[key] !== undefined) result[key] = cause[key];
    if ('cause' in cause) result.cause = failure(cause.cause, depth + 1);
    return result;
  }
  const report = (kind, cause) => {
    const error = { kind, ...failure(cause) };
    errors.push(error);
    console.error('FORGEAX_SETTINGS_CONTROLS_ERROR', JSON.stringify(error));
    let root = error;
    while (root.cause) root = root.cause;
    console.error(
      'FORGEAX_SETTINGS_CONTROLS_ROOT_FAILURE',
      kind,
      root.name,
      root.message ?? root.errMsg,
    );
  };
  const ui = await createBlitzUi({
    wasm: createWechatWasmHost({ wx, WXWebAssembly }, 'ui/ui.wasm').unwrap(),
    width: canvas.width,
    height: canvas.height,
    font,
    html: '<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#263746}#game-ui{position:absolute;inset:0}</style><div id="game-ui" tabindex="-1"></div>',
    onError: (cause) => report('ui', cause),
  });
  const input = createWechatInputBackend(wx, platform, {
    ui: ui.input,
    keyboard: wx,
    onError: (cause) => report('input', cause),
  }).unwrap();
  const root = ui.document.querySelector('#game-ui');
  const settings = mountSettings(
    { guid: SETTINGS_UI_GUID, ...source.assets['ui/settings'].payload },
    root,
    createGameSettingsState(),
    root,
  );
  if (settings.error || !settings.instance)
    throw settings.error ?? new Error('Missing settings instance');
  const shadow = settings.instance.host.shadowRoot;
  const field = (name) => shadow.querySelector(`[data-ui-setting="${name}"]`);
  let paints = 0;
  let live = true;
  let frame;
  let touches = 0;
  const trace = [];
  const started = platform.now().unwrap();
  settings.open();
  function rect(element) {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  function point(element, fraction = 0.5) {
    const r = rect(element);
    return { x: r.x + r.width * fraction, y: r.y + r.height / 2 };
  }
  function popup(select) {
    const r = select.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const ys = [];
    for (let y = 0; y < canvas.height; y++) {
      if ((y + 0.5 < r.top || y + 0.5 >= r.bottom) && ui.elementFromPoint(x, y + 0.5) === select)
        ys.push(y);
    }
    if (!ys.length) return null;
    const top = ys[0];
    const height = ys[ys.length - 1] + 1 - top;
    return {
      top,
      height,
      rows: [...select.options].map((option, index, options) => ({
        value: option.value,
        label: option.label,
        selected: option.selected,
        disabled: option.disabled,
        x,
        y: top + (height * (index + 0.5)) / options.length,
      })),
    };
  }
  function snapshot() {
    const controls = Object.fromEntries(
      [...shadow.querySelectorAll('[data-ui-setting]')].map((element) => [
        element.dataset.uiSetting,
        {
          tag: element.tagName,
          type: element.type,
          value: element.value,
          ...(element.type === 'checkbox'
            ? { checked: element.checked, defaultChecked: element.defaultChecked }
            : {}),
          ...(element.tagName === 'SELECT'
            ? { index: element.selectedIndex, popup: popup(element) }
            : {}),
          rect: rect(element),
          point: point(element),
        },
      ]),
    );
    const range = field('music').getBoundingClientRect();
    return {
      kind: 'actual-settings-controller-ui-owner',
      composition: 'native-2d-canvas',
      engineGameAcceptance: false,
      width: canvas.width,
      height: canvas.height,
      paints,
      touches,
      hidden: shadow.querySelector('[role="dialog"]').hidden,
      state: { ...settings.state },
      controls,
      points: {
        range25: { x: range.x + 8 + (range.width - 16) * 0.25, y: range.y + range.height / 2 },
        range75: { x: range.x + 8 + (range.width - 16) * 0.75, y: range.y + range.height / 2 },
        range0: { x: range.x + 8, y: range.y + range.height / 2 },
        range100: { x: range.right - 8, y: range.y + range.height / 2 },
        done: point(shadow.querySelector('button')),
      },
      trace: trace.slice(),
      errors: errors.slice(),
      focusedText: ui.input.focusedText(),
    };
  }
  for (const kind of ['input', 'change'])
    shadow.addEventListener(kind, (event) => {
      const target = event.target;
      trace.push({
        kind,
        setting: target.dataset.uiSetting,
        value: target.value,
        ...(target.type === 'checkbox' ? { checked: target.checked } : {}),
        bubbles: event.bubbles,
        composed: event.composed,
        state: { ...settings.state },
      });
      console.log('FORGEAX_SETTINGS_CONTROLS_ACTION', JSON.stringify(trace[trace.length - 1]));
    });
  function paint() {
    if (!live) return;
    try {
      const rgba = ui.paint(platform.now().unwrap() - started);
      if (rgba) {
        const pixels = context.createImageData(canvas.width, canvas.height);
        pixels.data.set(rgba);
        context.putImageData(pixels, 0, 0);
        paints++;
      }
      frame = platform.requestFrame(paint).unwrap();
    } catch (cause) {
      live = false;
      report('paint', cause);
    }
  }
  paint();
  const touchEnded = () => {
    touches++;
    setTimeout(
      () => console.log('FORGEAX_SETTINGS_CONTROLS_TOUCH', JSON.stringify(snapshot())),
      100,
    );
  };
  wx.onTouchEnd(touchEnded);
  globalThis.forgeaxSettingsControlsDiagnostic = {
    build: () => globalThis.forgeaxUiFixtureBuild,
    errors: () => errors.slice(),
    snapshot,
    open: () => settings.open(),
    cancelNext(name, kind = 'pointerdown') {
      field(name).addEventListener(kind, (event) => event.preventDefault(), { once: true });
    },
    setDisabled(name, value) {
      field(name).disabled = value;
    },
    dispose() {
      live = false;
      frame?.();
      wx.offTouchEnd(touchEnded);
      input.detach();
      settings.dispose();
      ui.dispose();
      platform.dispose();
    },
  };
  setTimeout(() => console.log('FORGEAX_SETTINGS_CONTROLS_READY', JSON.stringify(snapshot())), 300);
}
main().catch((cause) =>
  console.error(
    'FORGEAX_SETTINGS_CONTROLS_FAILURE',
    String(cause),
    JSON.stringify(cause),
    cause?.stack,
  ),
);
