import { getImports, finishInit, render_html } from './blitz-probe.mjs';

const canvas = wx.createCanvas();
const info = wx.getWindowInfo();
canvas.width = info.windowWidth;
canvas.height = info.windowHeight;
const context = canvas.getContext('2d');
const started = wx.getPerformance().now();
context.fillStyle = '#102334';
context.fillRect(0, 0, canvas.width, canvas.height);
wx.loadSubpackage({
  name: 'ui',
  success: async () => {
    try {
      const loaded = await WXWebAssembly.instantiate('ui/blitz.wasm', getImports());
      finishInit(loaded.instance, loaded.module);
      const ready = wx.getPerformance().now();
      const source = '<style>body{margin:0;display:grid;grid-template-columns:1fr 1fr;height:100px}section{background:red}aside{background:blue}</style><section></section><aside></aside>';
      const rgba = render_html(source, 100, 100, new Uint8Array());
      const drawn = wx.getPerformance().now();
      const pixels = [25, 75].map(x => [...rgba.slice(4 * (50 * 100 + x), 4 * (50 * 100 + x) + 4)]);
      const image = context.createImageData(100, 100);
      image.data.set(rgba);
      context.putImageData(image, 20, 100);
      context.fillStyle = '#e4edf3';
      context.font = '18px sans-serif';
      context.fillText('Blitz WASM Grid kernel probe', 20, 45);
      context.fillText('Not Engine UI acceptance', 20, 75);
      const passed = JSON.stringify(pixels) === JSON.stringify([[255, 0, 0, 255], [0, 0, 255, 255]]);
      context.fillText(passed ? 'Grid pixels: PASS' : 'Grid pixels: FAIL', 20, 240);
      console.log('FORGEAX_BLITZ_KERNEL', JSON.stringify({ passed, pixels, rgbaBytes: rgba.length,
        loadNativeUnits: ready - started, renderNativeUnits: drawn - ready,
        platform: wx.getDeviceInfo().platform, wasmBytes: __FORGEAX_BLITZ_WASM_BYTES__ }));
    } catch (error) {
      console.error('FORGEAX_BLITZ_FAILURE', String(error), error?.stack);
    }
  },
  fail: error => console.error('FORGEAX_BLITZ_SUBPACKAGE_FAILURE', JSON.stringify(error)),
});
