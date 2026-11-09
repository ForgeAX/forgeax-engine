import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';
import captureEntry from './webgl2-capture-bootstrap';

/** Retain only the real presentation GL context; capability probes are smaller. */
const entry: ExecutionBootstrapEntry = async (data) => {
  const channel = new BroadcastChannel(String(data));
  const prototype = OffscreenCanvas.prototype;
  const original = prototype.getContext;
  let gl: WebGL2RenderingContext | undefined;
  const intercept = function (this: OffscreenCanvas, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    if (args[0] === 'webgl2' && this.width === 64 && this.height === 64 && result)
      gl = result as WebGL2RenderingContext;
    return result;
  };
  Object.defineProperty(prototype, 'getContext', { configurable: true, writable: true, value: intercept });
  const prepared = await captureEntry(data);
  return {
    ...prepared,
    configureRenderer(renderer) {
      Object.defineProperty(prototype, 'getContext', { configurable: true, writable: true, value: original });
      channel.onmessage = (event) => {
        if (event.data !== 'lose') return;
        const extension = gl?.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('Actual presentation WebGL context loss required');
        channel.postMessage({ kind: 'losing', backend: renderer.inspect().capabilities.backendKind });
        extension.loseContext();
      };
      let completed = 0;
      renderer.subscribe((event) => {
        if (event.kind === 'frame-submitted' && event.receipt.presentation === 'ready') {
          void event.receipt.completed.then((result) => {
            if (result.ok && renderer.state() === 'alive' && ++completed === 60)
              channel.postMessage({ kind: 'qualified', completed });
          });
        }
        if (event.kind === 'state-changed') {
          channel.postMessage({ kind: 'state', state: event.current });
          if (event.current === 'disposed') channel.close();
        }
      });
      channel.postMessage({ kind: 'ready', backend: renderer.inspect().capabilities.backendKind });
    },
    plugins: [...(prepared.plugins ?? []), {
      name: 'webgl2-loss-mesh', inject: ['world', 'assets'],
      apply(ctx) {
        if (!ctx.assets) throw new Error('Fixture assets required');
        const mesh = ctx.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
        const material = ctx.assets.create(Materials.unlit([0.8, 0.1, 0.2, 1])).unwrap();
        ctx.world.spawn(
          { component: Transform },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        ).unwrap();
      },
    }],
  };
};
export default entry;
