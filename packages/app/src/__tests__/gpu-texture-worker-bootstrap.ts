import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { prepareRuntimePackContent } from '@forgeax/engine-import';
import { AssetGuid, definePackageId, gpuTextureOutputs } from '@forgeax/engine-pack/source';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { TextureGeneratorPrograms } from '@forgeax/engine-types';
import type { ExecutionBootstrapEntry } from '../execution/bootstrap-entry';

const packageId = definePackageId('01900000-0000-7000-8000-000000000010');
const shape = { viewDimension: '2d', extent: { width: 16, height: 16 } } as const;
const output = {
  shape,
  format: 'rgba8unorm',
  colorSpace: 'linear',
  mips: { kind: 'generate' },
} as const;
const entry: ExecutionBootstrapEntry = (data) => ({
  pluginPrograms: {
    sessionId: 'gpu-texture-worker-fixture',
    contextId: 'gpu-texture-worker-fixture',
    sessionGeneration: 1,
    target: 'engine',
    definitions: new Map(),
    programs: new Map(),
    tools: new Map(),
  },
  runtimePacks: { scopeId: 'browser-tests' },
  plugins: [
    {
      name: 'gpu-texture-worker-fixture',
      inject: ['world', 'assets', 'runtimePacks', 'executionBootstrapHost'],
      async apply(ctx) {
        const assets = ctx.assets;
        const packs = ctx.runtimePacks;
        const port = ctx.executionBootstrapHost.port;
        if (!assets || !packs || !port || typeof data !== 'string')
          throw new Error('Missing GPU texture fixture inputs');
        try {
          const programs = JSON.parse(data) as TextureGeneratorPrograms;
          const prepared = (
            await prepareRuntimePackContent(
              '01900000-0000-7000-8000-000000000010',
              gpuTextureOutputs(packageId, 'worker', {
                values: { seed: 42, wear: 0 },
                inputs: {},
                programs,
                outputs: {
                  albedo: { ...output, format: 'rgba8unorm-srgb', colorSpace: 'srgb' },
                  orm: output,
                  normal: output,
                },
                transient: { height: { shape, format: 'r16float' } },
                passes: [
                  {
                    kind: 'raster',
                    program: { module: 'test::gpu-paint', fragmentEntry: 'paint' },
                    reads: {},
                    writes: ['albedo', 'orm', 'height'],
                  },
                  {
                    kind: 'raster',
                    program: { module: 'test::gpu-normal', fragmentEntry: 'normal' },
                    reads: { height: { kind: 'local', name: 'height' } },
                    writes: ['normal'],
                  },
                ],
              }),
            )
          ).unwrap();
          (await packs.producer.admit(prepared)).unwrap();
          const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
          const texture = (
            await assets.load(guid('gpu-texture/worker/orm'), 'gpu-texture')
          ).unwrap();
          const generator = (
            await assets.load(guid('generator/worker'), 'texture-generator')
          ).unwrap();
          const mesh = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
          const material = assets
            .create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: { texture } }))
            .unwrap();
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
          port.onmessage = (event) => {
            if (event.data !== 'wear') return;
            assets.update(generator, { values: { seed: 42, wear: 0.5 } }).unwrap();
            port.postMessage({ updated: true, cpuPixels: 'data' in assets.read(texture).unwrap() });
          };
          port.start();
          port.postMessage({ ready: true, cpuPixels: 'data' in assets.read(texture).unwrap() });
          return () => port.close();
        } catch (cause) {
          port.postMessage({
            error: JSON.stringify(cause, Object.getOwnPropertyNames(Object(cause))),
          });
          throw cause;
        }
      },
    },
  ],
});
export default entry;
