import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { World } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { decodeImage, toRgba8 } from '@forgeax/engine/rhi-debug';
import { createRenderer, defaultAssetDecoderContributions } from '@forgeax/engine/runtime';
import { propagateTransforms, Transform } from '@forgeax/engine/scene';
import * as THREE from '@forgeax/engine/three';
import type { AssetKind } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Three.js native interoperation',
  catalog: 'Three.js native interoperation',
  kind: 'probe',
  summary:
    'Three objects and native entities share one authoring World, asset owner and native renderer. The probe owns its independent canvas and retires only its own resources.',
  expect:
    'Sixty ready GPU frames complete. A red Three cube and a blue native cube occlude each other as their depth changes; unmount preserves the native entity.',
  setup() {
    return {
      async checks() {
        const checks = new CheckList();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        const assets = new AssetRegistry();
        for (const contribution of defaultAssetDecoderContributions)
          assets.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
        const world = new World({ assets });
        const assembled = await createRenderer(canvas, { pipeline: THREE.createThreePipeline() });
        if (!assembled.ok) throw assembled.error;
        const renderer = assembled.value;
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
        camera.position.z = 5;
        const source = new THREE.Mesh(
          new THREE.BoxGeometry(1.5, 1.5, 1.5),
          new THREE.MeshBasicMaterial({ color: 0xff0000 }),
        );
        source.position.z = 0.5;
        scene.add(source);
        const geometry = assets.create(createBoxGeometry(1.5, 1.5, 1.5).unwrap()).unwrap();
        const material = assets.create(Materials.unlit([0, 0, 1, 1])).unwrap();
        const entity = world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: geometry } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
        let mount: THREE.ThreeSceneMount | undefined;
        let cleanupError: unknown;
        try {
          mount = (await THREE.mountThreeScene({ world, renderer, scene, camera })).unwrap();
          checks.equal('one shared World identity', mount.source.worldIdentity, world.identity);
          const current = mount;
          const frame = () => {
            current.sync().unwrap();
            propagateTransforms(world).unwrap();
            const result = renderer.draw({
              source: current.source,
              camera: { entityKey: current.entityFor(camera).unwrap() },
              geometryLane: 'direct',
            });
            if (!result.ok) throw result.error;
            return result.value;
          };
          const deadline = performance.now() + 120000;
          let completed = 0;
          while (completed < 60) {
            const receipt = frame();
            const done = await receipt.completed;
            if (!done.ok) throw done.error;
            if (receipt.presentation === 'ready') completed++;
            else if (receipt.preparationCompleted !== undefined) {
              const prepared = await receipt.preparationCompleted;
              if (!prepared.ok) throw prepared.error;
            }
            if (performance.now() > deadline) throw new Error('Mixed scene readiness deadline');
          }
          checks.equal('ready GPU frames completed', completed, 60);
          const center = async () => {
            const requested = renderer.requestObservation?.(['final-display']);
            if (requested === undefined || !requested.ok)
              throw new Error('Missing display observation');
            const receipt = frame();
            const done = await receipt.completed;
            if (!done.ok) throw done.error;
            const observed = await renderer.observe(receipt, { include: ['final-display'] });
            if (!observed.ok) throw observed.error;
            const display = observed.value.observations?.find(
              (entry) => entry.domain === 'final-display',
            );
            if (display === undefined) throw new Error('Missing display bytes');
            const pixels = toRgba8(decodeImage(display.bytes, display.metadata).unwrap());
            return pixels.subarray((128 * 64 + 64) * 4, (128 * 64 + 64) * 4 + 4);
          };
          const red = await center();
          checks.ok('Three cube occludes native cube', (red[0] ?? 0) > 240 && (red[2] ?? 0) < 5);
          world.set(entity, Transform, { pos: [0, 0, 1.5] }).unwrap();
          const blue = await center();
          checks.ok('native cube occludes Three cube', (blue[2] ?? 0) > 240 && (blue[0] ?? 0) < 5);
          current.dispose().unwrap();
          checks.ok('unmount preserves native entity', world.hasComponent(entity, MeshFilter));
        } finally {
          mount?.dispose().unwrap();
          world.despawn(entity).unwrap();
          const disposed = await renderer.dispose();
          if (!disposed.ok) cleanupError = disposed.error;
          assets.dispose();
          source.geometry.dispose();
          source.material.dispose();
        }
        if (cleanupError !== undefined) throw cleanupError;
        return checks.items;
      },
    };
  },
});
