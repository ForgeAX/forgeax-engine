import { createBlitzUi } from '@forgeax/engine/ui-blitz';
import { installWechatStandards } from '@forgeax/engine/platform-wechat/standards';
import {
  createWechatPlatform,
  createWechatInputBackend,
  createWechatWasmHost,
} from '@forgeax/engine/platform-wechat';
import { installGuideUiFixture } from '../../../../packages/platform-wechat/__tests__/guide-ui-fixture.ts';
import html from '../../../../templates/game-3d/assets/guide.ui.html';
import css from '../../../../templates/game-3d/assets/guide.ui.css';

// Actual authored HTML/CSS/controls on the native UI owner. Game replies are
// explicit fixture state; this page does not claim 3D or ordinary-build acceptance.
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
  const { safeArea } = display;
  const ui = await createBlitzUi({
    wasm: createWechatWasmHost({ wx, WXWebAssembly }, 'ui/ui.wasm').unwrap(),
    width: canvas.width,
    height: canvas.height,
    font,
    html: `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#263746}#game-ui{position:absolute;left:${safeArea.x}px;top:${safeArea.y}px;width:${safeArea.width}px;height:${safeArea.height}px}</style><div id="game-ui"></div>`,
    onError: (error) => console.error('FORGEAX_GUIDE_UI_ERROR', String(error), error?.stack),
  });
  const input = createWechatInputBackend(wx, platform, {
    ui: ui.input,
    keyboard: wx,
    onError: (error) => console.error('FORGEAX_GUIDE_UI_INPUT_ERROR', JSON.stringify(error)),
  }).unwrap();
  const channel = new MessageChannel();
  let generated = 0;
  const fixture = await installGuideUiFixture(
    ui.document.querySelector('#game-ui'),
    {
      guid: 'guide-ui-contract',
      html,
      css,
    },
    channel,
    (values) => {
      generated++;
      console.log('FORGEAX_GUIDE_UI_GENERATE', JSON.stringify({ generated, values }));
      setTimeout(() => fixture.setState({ values, error: 'diagnostic-generation-failure' }), 2500);
    },
  );
  let paints = 0;
  let live = true;
  let frame;
  const started = platform.now().unwrap();
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
    } catch (error) {
      live = false;
      console.error('FORGEAX_GUIDE_UI_PAINT_FAILURE', String(error), error?.stack);
    }
  }
  paint();
  setTimeout(() => {
    const shadow = fixture.host.shadowRoot;
    console.log(
      'FORGEAX_GUIDE_UI_READY',
      JSON.stringify({
        width: canvas.width,
        height: canvas.height,
        paints,
        button: shadow.querySelector('button[type="submit"]').getBoundingClientRect(),
        inputs: [...shadow.querySelectorAll('input')].map((field) => ({
          name: field.name,
          value: field.value,
          rect: field.getBoundingClientRect(),
        })),
        status: shadow.querySelector('[data-ui-part="vase-status"]').textContent,
        generatedState: 'fixture',
        composition: 'native-2d-canvas',
      }),
    );
  }, 300);
  const dispose = () => {
    if (!live) return;
    live = false;
    frame?.();
    input.detach();
    fixture.dispose();
    channel.port1.close();
    channel.port2.close();
    ui.dispose();
    platform.dispose();
  };
  // The simulator refresh owns the realm. Keep teardown callable by the
  // diagnostic without creating another App lifecycle or global DOM facade.
  globalThis.forgeaxGuideUiDiagnostic = { dispose };
}
main().catch((error) =>
  console.error('FORGEAX_GUIDE_UI_FAILURE', String(error), JSON.stringify(error), error?.stack),
);
