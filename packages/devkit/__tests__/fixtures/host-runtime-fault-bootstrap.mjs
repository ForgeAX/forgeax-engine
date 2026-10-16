import { HANDLE_CUBE } from '@forgeax/engine/assets-runtime';
import { Update } from '@forgeax/engine/ecs';
import { Camera, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';

// Fixed test command through the existing public bootstrap-port capability.
export default function bootstrap() {
  return {
    plugins: [
      {
        name: 'host-runtime-fault-fixture',
        inject: ['world', 'executionBootstrapHost'],
        apply(ctx) {
          const world = ctx.world;
          world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 5] } },
              {
                component: Camera,
                data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
              },
            )
            .unwrap();
          world
            .spawn(
              { component: Transform, data: {} },
              { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
              { component: MeshRenderer, data: {} },
            )
            .unwrap();
          let fail = false;
          const port = ctx.executionBootstrapHost.port;
          const receive = ({ data }) => {
            if (data === 'terminal-update') fail = true;
          };
          port.addEventListener('message', receive);
          port.start();
          const system = {
            name: 'host-runtime-fault-update',
            queries: [],
            fn() {
              if (fail) throw new Error('Host runtime fault fixture Update failure');
            },
          };
          world.addSystem(Update, system).unwrap();
          return () => {
            port.removeEventListener('message', receive);
            world.removeSystem(Update, system.name).unwrap();
          };
        },
      },
    ],
  };
}
