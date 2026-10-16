import {
  createWechatPlatform,
  createWechatInputBackend,
  createWechatWasmHost,
  createWechatWgpuHost,
} from '@forgeax/engine/platform-wechat';
import * as nativeWgpu from '@probe/native-wgpu';

const source = { wx, WXWebAssembly };
const platform = createWechatPlatform({ wx, requestAnimationFrame, cancelAnimationFrame }).unwrap();
const canvas = platform.canvas;
// The first native canvas is the visible surface. The CPU oracle owns an
// auxiliary 2D canvas and never replaces that surface or creates another device.
const referenceCanvas = wx.createCanvas();
referenceCanvas.width = 2532;
referenceCanvas.height = 1170;
const display = platform.display().unwrap();
let resources;

export const benchmarkHost = {
  referenceCanvas,
  display: () => platform.display().unwrap(),
  attachInput: (ui, onError) => {
    const input = createWechatInputBackend(wx, platform, { ui: ui.input, onError }).unwrap();
    return () => input.detach();
  },
  performance: { now: () => platform.now().unwrap() },
  requestAnimationFrame: (callback) => platform.requestFrame(callback).unwrap(),
  facts: {
    kind: 'wechat',
    clock: 'createWechatPlatform milliseconds',
    devicePlatform: wx.getDeviceInfo().platform,
    display,
    get menuButton() {
      return wx.getMenuButtonBoundingClientRect?.();
    },
  },
  get resources() {
    return (resources ??= new Promise((resolve, reject) =>
      wx.getFileSystemManager().readFile({
        filePath: 'ui/font.bin',
        success: ({ data }) => {
          try {
            if (!(data instanceof ArrayBuffer))
              throw new TypeError('Font read did not return binary bytes');
            resolve({
              font: new Uint8Array(data),
              wasm: createWechatWasmHost(source, 'ui/ui.wasm.br').unwrap(),
            });
          } catch (error) {
            reject(error);
          }
        },
        fail: reject,
      }),
    ));
  },
  createGpuCanvas: () => canvas,
  initializeWgpu: (backend) =>
    backend.ensureReady({
      initFn: async () => {
        await nativeWgpu.initializeNativeWgpu(
          createWechatWgpuHost(source, 'ui/wgpu.wasm.br', [canvas]).unwrap(),
        );
        return nativeWgpu;
      },
    }),
  showGpuCanvas(target) {
    if (target !== canvas) throw new Error('Benchmark must retain the first native canvas');
  },
  dispose: () => platform.dispose(),
};
