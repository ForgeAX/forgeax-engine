import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  VolumetricCloudLayer,
} from '@forgeax/engine-render';
import { cloudMaterialKind } from '@forgeax/engine-render/authoring';
import { renderGraphCompileCount, renderOrderedViewBindCount } from '@forgeax/engine-render-graph';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import {
  countRgbDifferences,
  createBarrelRendererFixture,
  readBarrelPixels,
} from './barrel-distortion-gpu-fixture';
import { testAssets } from './helpers/runtime-assets';

it('submits current cloud transport and history through ordered Forward and Deferred views', {
  timeout: 90_000,
}, async () => {
  const width = 64;
  const height = 48;
  const fixture = await createBarrelRendererFixture({ width, height });
  const { renderer, device } = fixture;
  const world = new World();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const source = renderer.attach(world).unwrap();
    const assets = testAssets(world);
    const material = assets
      .create(cloudMaterialKind, {
        kind: 'cloud-material',
        model: 'uniform',
        version: 1,
        sample: {
          extinctionPerMeter: 0.0006,
          albedo: [1, 1, 1],
          emissivePerMeter: [0.0008, 0.0004, 0.0002],
          materialAO: 1,
        },
        parameters: {},
        variants: [],
        cookIdentity: 'ordered-cloud-uniform',
      })
      .unwrap();
    const cloud = world
      .spawn({
        component: VolumetricCloudLayer,
        data: { material, bottomMeters: 25, thicknessMeters: 2500, diagnosticMode: 3 },
      })
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -0.48, -0.87], intensity: 0.15, castShadow: false },
      })
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 100, 0], quat: [0.382683, 0, 0, 0.92388] } },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: width / height, near: 1, far: 20000 },
        },
      )
      .unwrap();
    const mesh = assets.create(createBoxGeometry(80, 80, 80).unwrap()).unwrap();
    const surface = assets.create(Materials.standard({ baseColor: [0.1, 0.6, 0.3, 1] })).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 200, -100] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [surface] } },
      )
      .unwrap();

    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = await drawReadyFrame(renderer, { source, geometryLane: 'direct' });
      expect(receipt.presentation).toBe('ready');
      expect(errors).toEqual([]);
      return receipt;
    };
    const history = () =>
      Object.values(renderer.inspect({ fields: ['cloudLayer'] }).cloudLayer ?? {})[0]?.mode0;
    const pixels = () => readBarrelPixels(device, fixture.renderTarget, width, height);
    const original = renderer.inspect().profile;

    for (const renderPath of ['forward', 'deferred'] as const) {
      renderer
        .setProfile({ ...original, renderPath, ambientOcclusion: { enabled: false } })
        .unwrap();
      world.set(cloud, VolumetricCloudLayer, { enabled: true, thicknessMeters: 2500 }).unwrap();
      const compile = renderGraphCompileCount();
      const bind = renderOrderedViewBindCount();
      await draw();
      await draw();
      const start = await draw();
      expect(history()?.historyValid).toBe(true);
      expect(history()?.acceptedFrame).toBeDefined();
      expect(renderOrderedViewBindCount() - bind).toBeGreaterThan(0);
      expect(renderGraphCompileCount() - compile).toBe(renderOrderedViewBindCount() - bind);
      const steadyBind = renderOrderedViewBindCount();
      const phase = history()?.preparedPhase;
      const withCloud = await pixels();

      for (const x of [2, 5, 8]) {
        world.set(camera, Transform, { pos: [x, 100, 0] }).unwrap();
        world.set(cloud, VolumetricCloudLayer, { windOffsetMeters: [x * 10, 0, 0] }).unwrap();
        const receipt = await draw();
        expect(
          receipt.graphGeneration,
          JSON.stringify(renderer.inspect({ fields: ['featureGraph'] }).featureGraph),
        ).toBe(start.graphGeneration);
        expect(history()?.historyValid).toBe(true);
      }
      expect(history()?.preparedPhase).not.toBe(phase);

      world
        .set(cloud, VolumetricCloudLayer, {
          initializationRevision: renderPath === 'forward' ? 1 : 2,
        })
        .unwrap();
      const restarted = await draw();
      expect(restarted.graphGeneration).toBe(start.graphGeneration);
      expect(history()?.resetReasons).toContain('initialization');
      expect(history()?.acceptedPhase).toBe(0);
      await draw();
      expect(history()?.resetReasons).toEqual([]);
      expect(history()?.historyValid).toBe(true);
      const beforeEdit = await pixels();
      world.set(cloud, VolumetricCloudLayer, { thicknessMeters: 100 }).unwrap();
      expect((await draw()).graphGeneration).toBe(start.graphGeneration);
      const afterEdit = await pixels();
      expect(
        countRgbDifferences(beforeEdit, afterEdit),
        `${renderPath} cloud thickness, first pixel ${beforeEdit.slice(0, 4)} to ${afterEdit.slice(0, 4)}`,
      ).toBeGreaterThan((width * height) / 4);
      expect(renderOrderedViewBindCount()).toBe(steadyBind);

      world.set(cloud, VolumetricCloudLayer, { enabled: false }).unwrap();
      await draw();
      expect(history()).toBeUndefined();
      expect(countRgbDifferences(withCloud, await pixels())).toBeGreaterThan((width * height) / 4);
      expect(renderGraphCompileCount() - compile).toBe(renderOrderedViewBindCount() - bind);
    }
  } finally {
    unsubscribe();
    renderer.dispose();
    device.destroy();
  }
});
