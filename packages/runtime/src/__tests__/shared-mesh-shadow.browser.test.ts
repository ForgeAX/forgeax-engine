import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';

it.each([
  { vertexColor: false, lod: true },
  { vertexColor: true, lod: true },
  { vertexColor: false, lod: false },
  { vertexColor: true, lod: false },
])('preserves shared-mesh shadows with vertexColor=$vertexColor lod=$lod', async ({
  vertexColor,
  lod,
}) => {
  const size = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 256 : 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  document.body.append(canvas);
  const host = await constructRuntimeRendererHost(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!host.ok) throw host.error;
  const { renderer, assets } = host.value;
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.message);
  });
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1], roughness: 1 }),
  );
  const lowerGuid = assets.parseGuid('00000000-0000-7000-8000-000000000021');
  const base = createBoxGeometry(1, 3, 1).unwrap();
  const positions = base.attributes.position;
  if (!(positions instanceof Float32Array) || base.indices === undefined) {
    throw new Error('indexed box positions missing');
  }
  const colored = createMeshBuilder({
    attributes: {
      ...base.attributes,
      ...(vertexColor ? { color: new Float32Array((positions.length / 3) * 4).fill(1) } : {}),
    },
    indices: base.indices,
  })
    .build()
    .unwrap();
  assets.catalog(lowerGuid, colored).unwrap();
  const box = lod ? { ...colored, lods: [{ mesh: lowerGuid, screenCoverage: 0.25 }] } : colored;
  const shared = world.allocSharedRef('MeshAsset', box);
  const floor = world.allocSharedRef('MeshAsset', createBoxGeometry(24, 0.2, 24).unwrap());
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.1, 0] } },
      { component: MeshFilter, data: { assetHandle: floor } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const casters = [-50, -3, 0, 3].map((x) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 1.5, 0] } },
        { component: MeshFilter, data: { assetHandle: shared } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap(),
  );
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, -1, 1],
        intensity: 4,
        castShadow: true,
        cascadeCount: 4,
        shadowDistance: 35,
        mapSize: import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 256 : 1024,
        normalBias: 0.01,
        depthBias: 0.00001,
      },
    })
    .unwrap();
  world.spawn({ component: Skylight, data: { intensity: 0.1, color: [1, 1, 1] } }).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 5, 14] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 160,
          antialias: ANTIALIAS_NONE,
        },
      },
    )
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const capture = async () => {
    let presentation = 'pending';
    for (let frame = 0; frame < 5; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = await drawReadyFrame(renderer, {
        leases: [lease],
        camera: { lease },
        environment: { lease },
        fixedStep: world.getResource(FixedTime).tick,
      });
      presentation = receipt.presentation;
    }
    expect(presentation, 'settled GPU shadow receivers must present their retained depth').toBe(
      'ready',
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const encoded = canvas.toDataURL('image/png').split(',')[1] ?? '';
    const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const output = new OffscreenCanvas(size, size);
    const draw = output.getContext('2d');
    if (draw === null) throw new Error('pixel readback unavailable');
    draw.drawImage(bitmap, 0, 0);
    bitmap.close();
    return draw.getImageData(0, 0, size, size).data;
  };
  const receiverLuma = (pixels: Uint8ClampedArray, x: number) => {
    const focal = 1 / Math.tan(Math.PI / 6);
    const z = 2;
    const px = Math.round((0.5 + ((x * focal) / (14 - z)) * 0.5) * size);
    const py = Math.round((0.5 + ((5 * focal) / (14 - z)) * 0.5) * size);
    let sum = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const index = ((py + dy) * size + px + dx) * 4;
        sum += ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0)) / 3;
      }
    return sum / 25;
  };
  try {
    const batched = await capture();
    // Retained GPU shadow views must keep the ordinary presentation receipt ready.
    // The first capture proves fresh depth; this interval exercises reuse.
    for (let frame = 0; frame < 60; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const drawn = renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
        fixedStep: world.getResource(FixedTime).tick,
      });
      if (!drawn.ok) throw drawn.error;
      const completed = await drawn.value.completed;
      if (!completed.ok) throw completed.error;
      expect(drawn.value.presentation, `retained shadow frame ${frame}`).toBe('ready');
    }
    const ownership = renderer.inspect().renderScene.gpuDriven;
    expect(ownership.gpuOwnedEntityCount).toBeGreaterThan(0);
    if (!lod) expect(ownership.cpuFallbackDrawItems, 'GPU-only retained shadow workload').toBe(0);
    for (const entity of casters) {
      const independent = world.allocSharedRef('MeshAsset', { ...box });
      world.set(entity, MeshFilter, { assetHandle: independent }).unwrap();
      world.sharedRefs.release(independent).unwrap();
    }
    const separate = await capture();
    world.set(sun, DirectionalLight, { castShadow: false }).unwrap();
    const lit = await capture();
    expect(
      renderer
        .inspect()
        .renderScene.gpuDriven.channels.filter((channel) => channel.viewPass !== 'main'),
    ).toEqual([]);
    world.set(sun, DirectionalLight, { castShadow: true }).unwrap();
    const resumed = await capture();
    for (const x of [-3, 0, 3]) {
      const baseline = receiverLuma(lit, x);
      expect(baseline).toBeGreaterThan(30);
      expect(receiverLuma(separate, x) / baseline, `independent shadow at x=${x}`).toBeLessThan(
        0.8,
      );
      expect(receiverLuma(batched, x) / baseline, `shared shadow at x=${x}`).toBeLessThan(0.8);
      expect(Math.abs(receiverLuma(batched, x) - receiverLuma(separate, x))).toBeLessThan(3);
      expect(Math.abs(receiverLuma(resumed, x) - receiverLuma(separate, x))).toBeLessThan(3);
    }
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    lease.dispose();
    await context.fiber.dispose();
    await renderer.dispose();
    canvas.remove();
  }
}, 120_000);
