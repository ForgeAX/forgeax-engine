import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';

const entry: ExecutionBootstrapEntry = () => ({
  plugins: [{
    name: 'webgl2-capture-fixture',
    inject: ['world'],
    apply(ctx) {
      ctx.world.spawn({ component: Transform, data: { pos: [0, 0, 4] } }, {
        component: Camera,
        data: perspective({ fov: Math.PI / 4, aspect: 1, near: 0.1, far: 20 }),
      }).unwrap();
    },
  }],
});
export default entry;
