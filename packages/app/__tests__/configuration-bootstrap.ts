import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';

const entry: ExecutionBootstrapEntry = (data) => {
  const NativeWorker = globalThis.Worker;
  let renderWorker: Worker | undefined;
  if (data === 'recover') globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (options?.name === 'forgeax-render') renderWorker = this;
    }
  };
  return ({
  plugins: [{
    name: 'configuration-picture',
    inject: ['world', 'assets', 'executionBootstrapHost'],
    apply(ctx) {
      const assets = ctx.assets;
      if (assets === undefined) throw new Error('Configuration acceptance requires assets');
      const mesh = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
      const material = assets.create(Materials.standard({ baseColor: [0.1, 0.8, 0.2, 1] })).unwrap();
      ctx.world.spawn({ component: Transform, data: {} }, { component: MeshFilter, data: { assetHandle: mesh } }, { component: MeshRenderer, data: { materials: [material] } }).unwrap();
      ctx.world.spawn({ component: Transform, data: { pos: [0, 0, 6] } }, { component: Camera, data: perspective({ fov: Math.PI / 3, near: 0.1, far: 40, aspect: 1 }) }).unwrap();
      ctx.world.spawn({ component: DirectionalLight, data: { castShadow: true, mapSize: 1024, cascadeCount: 3, direction: [0.3, -1, -1] } }).unwrap();
      const port = ctx.executionBootstrapHost.port;
      const receive = (event: MessageEvent) => { if (event.data === 'terminate-render') renderWorker?.terminate(); };
      port?.addEventListener('message', receive);
      port?.start();
      return () => {
        port?.removeEventListener('message', receive);
        globalThis.Worker = NativeWorker;
      };
    },
  }],
});
};
export default entry;
