import { Update } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';

const entry: ExecutionBootstrapEntry = () => ({
  plugins: [
    {
      name: 'asset-owner-loss-proof',
      inject: ['world', 'assets', 'executionBootstrapHost'],
      apply(ctx) {
        const assets = ctx.assets;
        const port = ctx.executionBootstrapHost.port;
        if (assets === undefined || port === undefined)
          throw new Error('Missing asset loss fixture owner');
        const mesh = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
        const material = assets.create(Materials.unlit([0, 0, 1, 1])).unwrap();
        ctx.world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 3] } },
            {
              component: Camera,
              data: {
                ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20 }),
                tonemap: 0,
                antialias: 0,
                clearColor: [0, 0, 0, 1],
              },
            },
          )
          .unwrap();
        ctx.world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
        const evidence = (kind: string) => {
          const snapshot = assets.snapshot(material).unwrap();
          try {
            port.postMessage({
              kind,
              worldIdentity: ctx.world.identity,
              owner: assets.identity,
              handle: material,
              revision: snapshot.version(material).unwrap(),
              color: assets.read(material).unwrap().values?.baseColor,
            });
          } finally {
            snapshot.dispose();
          }
        };
        let armed = false;
        port.onmessage = (event) => {
          if (event.data === 'commit-before-publication') armed = true;
        };
        port.start();
        evidence('initial');
        const system = {
          name: 'commit-before-owner-loss',
          queries: [],
          fn() {
            if (!armed) return;
            armed = false;
            assets.update(material, { values: { baseColor: [1, 0, 0, 1] } }).unwrap();
            evidence('committed');
            // This real Update cannot return to SourceRenderWorker publication.
            // The Host terminates this actual Worker after receiving the commit witness.
            const gate = new Int32Array(new SharedArrayBuffer(4));
            while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);
          },
        };
        ctx.world.addSystem(Update, system).unwrap();
        return () => {
          ctx.world.removeSystem(Update, system.name).unwrap();
          port.close();
        };
      },
    },
  ],
});

export default entry;
