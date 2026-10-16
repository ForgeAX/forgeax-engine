import { Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { captureCanvasPixels } from '../../../shared/src/canvas-capture';
import { buildScreenshotWorld, stepScreenshot } from './screenshot.js';

let screenshotDue = false;

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[screenshot] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;

  buildScreenshotWorld(app.world);

  app.world.addSystem(Update, {
    name: 'screenshot-detect',
    queries: [],
    fn: (world) => {
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (stepScreenshot(world, snapshot)) {
        screenshotDue = true;
      }
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[screenshot] app.start() failed:', started.error);
    return;
  }

  // Poll screenshotDue after each frame and capture the host canvas.
  let counter = 0;
  const poll = async () => {
    if (screenshotDue) {
      screenshotDue = false;
      const pixelsResult = await captureCanvasPixels(target);
      if (pixelsResult.ok) {
        const pixels = pixelsResult.value;
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = target.width;
        tmpCanvas.height = target.height;
        const ctx = tmpCanvas.getContext('2d');
        if (ctx) {
          const imgData = ctx.createImageData(target.width, target.height);
          imgData.data.set(pixels);
          ctx.putImageData(imgData, 0, 0);
          const url = tmpCanvas.toDataURL('image/png');
          const a = document.createElement('a');
          a.href = url;
          a.download = `screenshot-${counter}.png`;
          counter++;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          console.log(`[screenshot] saved screenshot-${counter - 1}.png`);
        }
      } else {
        console.error('[screenshot] canvas capture failed:', pixelsResult.error);
      }
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('screenshot: missing <canvas id="app"> in index.html');
bootstrap(canvas);
