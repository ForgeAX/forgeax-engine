import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('the stock Renderer matches its fixed selectors without allocating entry tuples', async () => {
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
  const world = new World();
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
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
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
  } finally {
    spy.mockRestore();
    await renderer.dispose();
  }
});
