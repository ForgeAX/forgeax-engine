import { mountUi } from '@forgeax/engine/ui';
import { createBlitzUi } from '@forgeax/engine/ui-blitz';
import { installWechatStandards } from '@forgeax/engine/platform-wechat/standards';
import { createWechatWasmHost } from '@forgeax/engine/platform-wechat';

// This diagnostic deliberately qualifies the UI owner on a native 2D canvas.
// It exercises ordinary mountUi/ShadowRoot, but not Engine composition or a complete game.
async function main() {
  installWechatStandards().unwrap();
  const canvas = wx.createCanvas();
  const info = wx.getWindowInfo();
  canvas.width = info.windowWidth;
  canvas.height = info.windowHeight;
  const context = canvas.getContext('2d');
  const read = (path) =>
    new Promise((resolve, reject) =>
      wx.getFileSystemManager().readFile({
        filePath: path,
        success: (value) => resolve(new Uint8Array(value.data)),
        fail: reject,
      }),
    );
  const started = wx.getPerformance().now();
  const ui = await createBlitzUi({
    wasm: createWechatWasmHost({ wx, WXWebAssembly }, 'ui/ui.wasm').unwrap(),
    width: canvas.width,
    height: canvas.height,
    font: await read('ui/font.ttf'),
    html: '<!doctype html><style>body{margin:0}</style>',
    onError: (error) => console.error('FORGEAX_UI_DOM_ERROR', String(error), error?.stack),
  });
  const mounted = mountUi(
    {
      guid: 'ui-dom-contract',
      css: `
      :host { display:block; box-sizing:border-box; margin:0; padding:${Math.max(24, info.safeArea?.top ?? 0) + 12}px 24px 24px; background:#102334; color:#e5edf5; font:16px 'DejaVu Sans'; }
      h1 { font-size:22px; margin:0 0 12px; }
      #grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; height:80px; margin:20px 0; }
      #grid section { background:#e25042; } #grid aside { background:#317fc5; }
      #grid.changed { grid-template-columns:3fr 1fr; }
      form { pointer-events:auto; display:grid; gap:14px; } label { display:flex; justify-content:space-between; }
      input { width:140px; background:#fff; color:#102334; padding:8px; }
      button { padding:14px; background:#5cd0b2; color:#102334; border:0; border-radius:8px; }
      #status { margin-top:18px; }
    `,
      html: `<h1>Persistent HTML/CSS</h1><p>UI kernel diagnostic</p>
      <div id="grid"><section></section><aside></aside></div>
      <form><label>Radius<input type="number" min="0.1" max="2" step="0.05" required value="0.35"></label>
      <button>Change Grid</button></form><p id="status">Tap to update the same nodes</p>`,
    },
    { root: ui.document.body, layer: 1 },
  );
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
  const root = mounted.value.host.shadowRoot;
  const document = ui.document;
  const form = root.querySelector('form');
  const field = form.querySelector('input');
  const button = form.querySelector('button');
  const grid = root.querySelector('#grid');
  const first = grid.firstElementChild;
  let submissions = 0;
  let paints = 0;
  let lastPixels;
  function paint() {
    const rgba = ui.paint(wx.getPerformance().now() - started);
    if (!rgba) return;
    lastPixels = rgba;
    const pixels = context.createImageData(canvas.width, canvas.height);
    pixels.data.set(rgba);
    context.putImageData(pixels, 0, 0);
    paints++;
  }
  const checks = {
    shadowIsolation: document.querySelector('form') === null,
    rootIdentity: root === mounted.value.host.shadowRoot,
  };
  field.value = '0.12';
  checks.invalidStep = field.validity.stepMismatch && !form.checkValidity();
  field.value = '';
  checks.required = field.validity.valueMissing;
  field.value = '0.35';
  checks.valid = form.checkValidity();
  const old = document.createElement('span');
  old.textContent = 'retained';
  const holder = document.createElement('div');
  holder.append(old);
  holder.innerHTML = '<b>new</b>';
  checks.detachedIdentity = old.textContent === 'retained' && old.parentNode === null;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submissions++;
    grid.classList.toggle('changed');
    root.querySelector('#status').textContent = `Updates: ${submissions} / value: ${field.value}`;
    checks.sameNode = grid.firstElementChild === first;
    paint();
    console.log(
      'FORGEAX_UI_DOM_ACTION',
      JSON.stringify({
        submissions,
        paints,
        checks,
        left: first.getBoundingClientRect(),
        right: grid.lastElementChild.getBoundingClientRect(),
      }),
    );
  });
  paint();
  function ink(element) {
    const rect = element.getBoundingClientRect();
    let count = 0;
    for (let y = Math.ceil(rect.y + 4); y < Math.floor(rect.bottom - 4); y++) {
      for (let x = Math.ceil(rect.x + 4); x < Math.floor(rect.right - 4); x++) {
        const offset = 4 * (y * canvas.width + x);
        if (
          lastPixels[offset] < 60 &&
          lastPixels[offset + 1] < 90 &&
          lastPixels[offset + 2] < 110 &&
          lastPixels[offset + 3] > 200
        )
          count++;
      }
    }
    return count;
  }
  checks.buttonGlyphs = ink(button);
  checks.inputGlyphs = ink(field);
  checks.inheritedColor =
    ui.getComputedStyle(root.querySelector('h1')).getPropertyValue('color') ===
    'rgb(229, 237, 245)';
  const buttonRect = button.getBoundingClientRect();
  checks.buttonHit =
    ui.elementFromPoint(
      buttonRect.x + buttonRect.width / 2,
      buttonRect.y + buttonRect.height / 2,
    ) === button;
  if (!checks.inheritedColor || !checks.buttonHit)
    throw new Error('Shadow host inheritance or control hit failed');
  if (checks.buttonGlyphs < 30 || checks.inputGlyphs < 12)
    throw new Error('Prepared control glyphs are missing');
  checks.staticCached = ui.paint(wx.getPerformance().now() - started) === null;
  console.log(
    'FORGEAX_UI_DOM_READY',
    JSON.stringify({
      checks,
      paints,
      button: button.getBoundingClientRect(),
      globals: { WebAssembly: typeof WebAssembly, document: typeof globalThis.document },
      platform: wx.getDeviceInfo().platform,
      loadNativeUnits: wx.getPerformance().now() - started,
    }),
  );
  wx.onTouchEnd((event) => {
    const touch = event.changedTouches[0];
    const target = ui.elementFromPoint(touch.clientX, touch.clientY);
    if (target?.closest('button')) button.click();
  });
}
main().catch((error) =>
  console.error('FORGEAX_UI_DOM_FAILURE', JSON.stringify(error), String(error), error?.stack),
);
