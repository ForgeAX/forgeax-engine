import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  type BarrelRendererFixture,
  createBarrelRendererFixture,
} from './barrel-distortion-gpu-fixture';
import { startGeneratedLodServer } from './generated-lod.server';
import { renderValue } from './standard-gbuffer-replay.fixture';

const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];
it.skipIf(process.env.MESH_LOD_PERF !== '1')(
  'measures native GPU/CPU ABBA cost of generated LODs without a recorder',
  async () => {
    const server = await startGeneratedLodServer();
    let fixture: BarrelRendererFixture | undefined;
    try {
      fixture = await createBarrelRendererFixture({ width: 128, height: 128, gpuPassTiming: {} });
      const { renderer, assets } = fixture;
      assets.configurePackIndex(server.url);
      const meshes = await Promise.all(
        server.guids.map(async (text) => {
          const guid = AssetGuid.parse(text);
          if (!guid.ok) throw guid.error;
          const mesh = renderValue(await assets.loadByGuid<MeshAsset>(guid.value));
          return { ...mesh, lods: undefined };
        }),
      );
      const world = new World();
      const material = world.allocSharedRef(
        'MaterialAsset',
        Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.8 }),
      );
      const objects = [];
      for (let i = 0; i < 64; i++)
        objects.push(
          world
            .spawn(
              {
                component: Transform,
                data: {
                  pos: [((i % 8) - 3.5) * 0.3, (Math.floor(i / 8) - 3.5) * 0.3, 0],
                  scale: [0.14, 0.14, 0.14],
                },
              },
              {
                component: MeshFilter,
                data: { assetHandle: world.allocSharedRef('MeshAsset', meshes[0]) },
              },
              { component: MeshRenderer, data: { materials: [material] } },
            )
            .unwrap(),
        );
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          {
            component: Camera,
            data: {
              aspect: 1,
              fov: Math.PI / 4,
              antialias: 0,
              bloom: 0,
              tonemap: 7,
              near: 0.1,
              far: 100,
            },
          },
        )
        .unwrap();
      world
        .spawn({
          component: DirectionalLight,
          data: { direction: [-0.5, -0.8, -1], intensity: 2, castShadow: false },
        })
        .unwrap();
      const lease = renderValue(renderer.attach(world));
      const windows = [];
      for (const level of [0, 2, 2, 0]) {
        const mesh = meshes[level];
        if (!mesh) throw new Error('missing generated level');
        const handle = world.allocSharedRef('MeshAsset', mesh);
        for (const object of objects)
          world.set(object, MeshFilter, { assetHandle: handle }).unwrap();
        const samples = [];
        for (let frame = 0; frame < 120; frame++) {
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          const started = performance.now();
          const receipt = renderValue(
            renderer.draw({
              geometryLane: 'direct',
              leases: [lease],
              camera: { lease },
              environment: { lease },
            }),
          );
          const cpuMs = performance.now() - started;
          renderValue(await receipt.completed);
          const timing = renderValue(
            await renderer.observe(receipt, { include: ['timings'] }),
          ).timings;
          if (timing?.status !== 'complete')
            throw new Error(`missing GPU timing: ${JSON.stringify(timing)}`);
          expect(timing.frame.droppedPassCount).toBe(0);
          const intervals = summarizeGpuPassTimingIntervals(
            timing.frame.passes,
            timing.frame.timestampPeriodNanoseconds,
          ).unwrap();
          if (frame >= 60) samples.push({ cpuMs, ...intervals });
        }
        windows.push({
          level,
          submittedTriangles: ((mesh.indices?.length ?? 0) / 3) * 64,
          samples,
          cpuMedianMs: quantile(
            samples.map((s) => s.cpuMs),
            0.5,
          ),
          gpuEnvelopeMedianMs:
            (quantile(
              samples.map((s) => s.envelopeNanoseconds),
              0.5,
            ) ?? NaN) / 1e6,
          gpuEnvelopeP95Ms:
            (quantile(
              samples.map((s) => s.envelopeNanoseconds),
              0.95,
            ) ?? NaN) / 1e6,
        });
      }
      const adapter = await navigator.gpu.requestAdapter();
      mkdirSync('artifacts/generated-lod/dawn', { recursive: true });
      writeFileSync(
        'artifacts/generated-lod/dawn/performance.json',
        JSON.stringify(
          {
            host: { cpu: cpus()[0]?.model, platform: platform(), node: process.version },
            adapter:
              adapter === null
                ? null
                : {
                    vendor: adapter.info.vendor,
                    architecture: adapter.info.architecture,
                    device: adapter.info.device,
                    description: adapter.info.description,
                  },
            resolution: [128, 128],
            instances: 64,
            protocol:
              'ABBA; 60 warmup + 60 measured frames per window; no recorder; whole-frame envelope rather than pass sum',
            windows,
          },
          null,
          2,
        ),
      );
    } finally {
      await fixture?.renderer.dispose();
      fixture?.renderTarget.destroy();
      await server.close();
    }
  },
  240_000,
);
