import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import * as drawPreparation from '../record/fold-buckets';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('keeps shared GPU material edits free of per-entity validation and selector allocation', async () => {
  const source = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(',') + 1)));
  for (const entry of manifest.materialShaders) {
    if (entry.identifier !== 'forgeax::default-standard-pbr') continue;
    entry.receipt = createStandardPbrArtifactReceipt(false, false);
    for (const variant of entry.variants) {
      variant.receipt = createStandardPbrArtifactReceipt(
        false,
        variant.defines.VERTEX_COLOR_AVAILABLE === true,
      );
    }
  }
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    undefined,
    { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` },
    {
      rhi,
      createShaderModule: async (device, descriptor) => rhi.createShaderModule(device, descriptor),
    },
  );
  const initialized = await renderer.initialization;
  if (!initialized.ok) throw initialized.error;
  const assets = renderer.assetRegistry;
  const world = new World({ assets });
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const attached = attachment.value;
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: 0 } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: DirectionalLight,
        data: { castShadow: true, direction: [0, -1, -1], color: [1, 1, 1], intensity: 1 },
      },
    )
    .unwrap();
  const material = assets
    .create(Materials.standard({ baseColor: [1, 1, 1, 1], transmission: 0 }))
    .unwrap();
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  for (let index = 0; index < 128; index++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const validate = vi.spyOn(drawPreparation, 'validateRenderables');
  let selectorEntries = 0;
  const entries = Object.entries;
  const spy = vi.spyOn(Object, 'entries').mockImplementation((value) => {
    // Count selector enumeration, not material/tag object enumeration.
    if (Array.isArray(Object.getOwnPropertyDescriptor(value, 'LightMode')?.value))
      selectorEntries++;
    return entries(value);
  });
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  try {
    for (let frame = 0; frame < 3; frame++) {
      if (frame === 2) assets.update(material, { values: { roughness: 0.2 } }).unwrap();
      world.update().unwrap();
      const drawn = renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
      });
      if (!drawn.ok) throw drawn.error;
    }
    expect(errors).toEqual([]);
    expect(renderer.inspect().frame.frameId).toBeGreaterThanOrEqual(3);
    expect(selectorEntries).toBe(0);
    expect(validate.mock.calls.reduce((count, args) => count + args[5].length, 0)).toBe(0);
    expect(renderer.inspect().renderScene.projectionRecords).toBe(128);
    for (const [transmission, roughness, rough] of [
      [0.8, 0.4, true],
      [0.8, 0, false],
      [0, 0, false],
    ] as const) {
      assets.update(material, { values: { transmission, roughness } }).unwrap();
      world.update().unwrap();
      const drawn = renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
      });
      if (!drawn.ok) throw drawn.error;
      if (drawn.value !== undefined) {
        const completed = await drawn.value.completed;
        if (!completed.ok) throw completed.error;
      }
      expect(errors).toEqual([]);
      const demand = renderer.inspect().transmission;
      if (transmission === 0) expect(demand).toBeUndefined();
      else expect(demand).toMatchObject({ activeCount: 128, needsRoughMips: rough });
      expect(renderer.inspect().renderScene.projectionRecords).toBe(128);
    }
  } finally {
    spy.mockRestore();
    validate.mockRestore();
    await renderer.dispose();
  }
});
