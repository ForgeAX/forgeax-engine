import { Time, Update } from '@forgeax/engine-ecs';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';
import { BarrelDistortion, Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const entry: ExecutionBootstrapEntry = () => ({
  plugins: [
    {
      name: 'worker-resize-probe',
      inject: ['world', 'executionBootstrapHost'],
      apply(ctx) {
        const camera = ctx.world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 3] } },
            { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
            {
              component: BarrelDistortion,
              data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
            },
          )
          .unwrap();
        const system = {
          name: 'worker-resize-probe',
          queries: [],
          fn: () => {
            const current = ctx.world.get(camera, Camera);
            if (current.ok) {
              ctx.executionBootstrapHost.port?.postMessage({
                kind: 'camera-aspect',
                aspect: current.value.aspect,
                deltaSeconds: ctx.world.getResource(Time).delta,
              });
            }
          },
        };
        ctx.world.addSystem(Update, system).unwrap();
        return () => ctx.world.removeSystem(Update, system.name).unwrap();
      },
    },
  ],
});

export default entry;
