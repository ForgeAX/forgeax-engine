import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  type FrameReceipt,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';

it.each([
  'forward',
  'deferred',
] as const)('renders authored emission without an intensity override in %s', {
  timeout: 120_000,
}, async (renderPath) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const host = await constructRuntimeRendererHost(canvas);
  if (!host.ok) throw host.error;
  const { renderer } = host.value;
  const errors: unknown[] = [];
  const stop = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: { ...perspective({ fov: Math.PI / 3, aspect: 1 }), clearColor: [0, 0, 0, 1] },
      },
    )
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  try {
    const profile = renderer.setProfile({ ...renderer.inspect().profile, renderPath, ssao: false });
    if (!profile.ok) throw profile.error;
    for (const intensity of [undefined, 0]) {
      const material = assets
        .create(
          Materials.standard({
            baseColor: [0, 0, 0, 1],
            emissive: [0.25, 0.5, 0.75],
            ...(intensity === undefined ? {} : { emissiveIntensity: intensity }),
          }),
        )
        .unwrap();
      world.set(entity, MeshRenderer, { materials: [material] }).unwrap();
      assets.release(material).unwrap();
      let receipt: FrameReceipt | undefined;
      for (let frame = 0; frame < 60; frame++) {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        receipt = await drawReadyFrame(
          renderer,
          {
            leases: [lease],
            camera: { lease },
            environment: { lease },
          },
          frame === 59 ? ['linear-hdr'] : undefined,
        );
      }
      if (receipt === undefined) throw new Error('Emission frame did not complete');
      const observed = await renderer.observe(receipt, { include: ['linear-hdr'] });
      if (!observed.ok) throw observed.error;
      const observation = observed.value.observations?.find(
        (value) => value.domain === 'linear-hdr',
      );
      if (observation === undefined) throw new Error('Emission readback is missing');
      const bytes = observation.bytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const offset = 32 * observation.metadata.bytesPerRow + 32 * 8;
      const rgb = [0, 1, 2].map((channel) =>
        halfFloat.f16ToF32(view.getUint16(offset + channel * 2, true)),
      );
      const expected = intensity === 0 ? [0, 0, 0] : [0.25, 0.5, 0.75];
      for (let channel = 0; channel < 3; channel++)
        expect(rgb[channel]).toBeCloseTo(expected[channel] ?? 0, 2);
    }
    expect(errors).toEqual([]);
  } finally {
    stop();
    lease.dispose();
    await renderer.dispose();
    assets.dispose();
    canvas.remove();
  }
});
