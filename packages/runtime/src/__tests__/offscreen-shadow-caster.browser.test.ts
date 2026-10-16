import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
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
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';

it('retains the same ground shadow when its caster moves behind the camera', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  document.body.append(canvas);
  const host = await constructRuntimeRendererHost(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!host.ok) throw host.error;
  const { renderer } = host.value;
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1], roughness: 1 }),
  );
  for (const [geometry, pos] of [
    [createBoxGeometry(40, 0.2, 40).unwrap(), [0, -0.1, 0]],
    [createBoxGeometry(2, 3, 1).unwrap(), [0, 1.5, 0]],
  ] as const) {
    const mesh = world.allocSharedRef('MeshAsset', geometry);
    world
      .spawn(
        { component: Transform, data: { pos } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, -1, 1],
        intensity: 4,
        castShadow: true,
        cascadeCount: 4,
        shadowDistance: 35,
        mapSize: 1024,
        depthBias: 0.00001,
        normalBias: 0.01,
      },
    })
    .unwrap();
  world.spawn({ component: Skylight, data: { intensity: 0.1, color: [1, 1, 1] } }).unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: { fov: Math.PI / 3, aspect: 1, near: 0.05, far: 160, antialias: ANTIALIAS_NONE },
      },
    )
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.message);
  });
  const draw = async () => {
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
  };
  const snapshot = async (name: string) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const base64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
    await commands.writeFile(`artifacts/offscreen-shadow/${name}.png`, base64, 'base64');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const output = new OffscreenCanvas(512, 512);
    const ctx = output.getContext('2d');
    if (ctx === null) throw new Error('pixel readback unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(252, 252, 9, 9).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4)
      sum +=
        ((pixels[i] ?? Number.NaN) +
          (pixels[i + 1] ?? Number.NaN) +
          (pixels[i + 2] ?? Number.NaN)) /
        3;
    return sum / 81;
  };
  const evidence: unknown[] = [];
  const ratios: number[] = [];
  try {
    for (const [name, z] of [
      ['facing', 5],
      ['away', 1],
      ['returned', 5],
    ] as const) {
      const eye = [0, 1, z] as const;
      const rotation = quat.fromLookAt(quat.create(), eye, [0, 0, 2], [0, 1, 0]);
      world.set(camera, Transform, { pos: eye, quat: rotation }).unwrap();
      world.set(sun, DirectionalLight, { castShadow: true }).unwrap();
      for (let i = 0; i < 5; i++) await draw();
      // The center pixel observes the same world-space receiver [0, 0, 2].
      // Passing the caster moves it behind the camera without moving the light.
      const shadow = await snapshot(name);
      world.set(sun, DirectionalLight, { castShadow: false }).unwrap();
      for (let i = 0; i < 3; i++) await draw();
      const lit = await snapshot(`${name}-disabled`);
      ratios.push(shadow / lit);
      evidence.push({ name, eye, shadow, lit, ratio: shadow / lit });
      expect(lit).toBeGreaterThan(30);
    }
    await commands.writeFile(
      'artifacts/offscreen-shadow/result.json',
      JSON.stringify(evidence, null, 2),
    );
    for (const ratio of ratios) expect(ratio).toBeLessThan(0.8);
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    lease.dispose();
    await context.fiber.dispose();
    await renderer.dispose();
    canvas.remove();
  }
}, 120_000);
