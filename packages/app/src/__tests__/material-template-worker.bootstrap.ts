import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Camera, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '../execution/bootstrap-entry';
import type { produceWorkerMaterialTemplate } from './material-template-worker.commands.js';

const entry: ExecutionBootstrapEntry = (data) => ({
  plugins: [
    {
      name: 'worker-material-template-fixture',
      inject: ['assets', 'world', 'executionBootstrapHost'],
      async apply({ assets, world, executionBootstrapHost }) {
        if (assets === undefined || typeof data !== 'string')
          throw new Error('Worker material template inputs are missing');
        const product = JSON.parse(data) as Awaited<
          ReturnType<typeof produceWorkerMaterialTemplate>
        >;
        assets.setCatalogSource(
          createCatalogSource({
            entries: [product.row],
            fetch: async (input) => {
              const path = new URL(String(input), globalThis.location.href).pathname;
              const body = path === product.row.packageUrl ? product.pack : product.artifacts[path];
              return body === undefined ? new Response('', { status: 404 }) : new Response(body);
            },
          }),
        );
        const material = (await assets.load(product.row.guid, 'material')).unwrap();
        const projection = assets.getMaterialProjection(material).unwrap();
        if (projection?.sourceTemplate === undefined)
          throw new Error('Asset loader did not admit the Pack source template');
        const mesh = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
        world
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
        world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
        executionBootstrapHost.port?.postMessage({
          materialLoaded: true,
          hasReadyPrograms: projection.passes.some(({ programs }) => programs.length !== 0),
        });
      },
    },
  ],
});
export default entry;
