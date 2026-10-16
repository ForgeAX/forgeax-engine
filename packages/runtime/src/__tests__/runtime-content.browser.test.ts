import { RuntimeMaterialValue, RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createRenderer } from '../createRenderer';

// Includes two cold devices and seven compositor captures; this is a correctness
// journey, not a frame-time benchmark. Keep the outer browser group deadline.
it('projects managed shared material and mesh writes into two independent browser renderers', async () => {
  const startedAt = performance.now();
  const progress = (stage: string) => {
    // biome-ignore lint/suspicious/noConsole: bounded progress distinguishes GPU completion from compositor timeouts.
    console.log(
      JSON.stringify({
        kind: 'runtime-content-progress',
        stage,
        elapsedMs: Math.round(performance.now() - startedAt),
      }),
    );
  };
  progress('viewport');
  await page.viewport(800, 600);
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const mesh = createBoxGeometry(2, 2, 0.5).unwrap();
  const meshHandle = world.allocSharedRef('MeshAsset', mesh);
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  const unused = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      { component: Camera, data: { aspect: 1, fov: Math.PI / 4, near: 0.1, far: 20 } },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        mapSize: testQuality.shadowMapSize,
        cascadeCount: testQuality.cascadeCount,
        direction: [0, 0, -1],
        intensity: 3,
      },
    })
    .unwrap();
  const input = [1, 0, 0, 1];
  const color = world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: material, parameter: 'baseColor', kind: 2, value: input },
    })
    .unwrap();
  input.fill(0); // Mutating the source array must not change either renderer.
  const consumers = [];
  const surface = document.createElement('div');
  surface.style.display = 'flex';
  surface.style.width = '384px';
  document.body.append(surface);
  try {
    for (let index = 0; index < 2; index++) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 192;
      canvas.style.width = canvas.style.height = '192px';
      surface.append(canvas);
      progress(`renderer-${index}-create`);
      const renderer = (
        await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' })
      ).unwrap();
      const lease = renderer.attach(world).unwrap();
      consumers.push({ canvas, renderer, lease });
      progress(`renderer-${index}-ready`);
    }
    const capture = async (name: string) => {
      world.update(1 / 60).unwrap();
      const counts = [];
      for (const { renderer, lease } of consumers) {
        for (let frame = 0; frame < 3; frame++) {
          const receipt = renderer
            .draw({ leases: [lease], camera: { lease }, environment: { lease } })
            .unwrap();
          (await receipt.completed).unwrap();
        }
      }
      progress(`${name}-submitted`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const shot = await page.elementLocator(surface).screenshot({
        path: `__screenshots__/runtime-content-${name}.png`,
        base64: true,
      });
      const base64 = typeof shot === 'string' ? shot : shot.base64;
      if (base64 === undefined) throw new Error('missing screenshot');
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      expect([bitmap.width, bitmap.height]).toEqual([384, 192]);
      const decoder = document.createElement('canvas');
      decoder.width = 384;
      decoder.height = 192;
      const context = decoder.getContext('2d');
      if (context === null) throw new Error('missing PNG decoder');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      for (let index = 0; index < consumers.length; index++) {
        const pixels = context.getImageData(index * 192, 0, 192, 192).data;
        let red = 0;
        let blue = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const r = pixels[offset] ?? 0;
          const g = pixels[offset + 1] ?? 0;
          const b = pixels[offset + 2] ?? 0;
          if (r > 80 && r > g * 1.5 && r > b * 1.5) red++;
          if (b > 80 && b > g * 1.5 && b > r * 1.5) blue++;
        }
        counts.push({ red, blue });
      }
      progress(`${name}-captured`);
      return counts;
    };
    const red = await capture('red');
    for (const count of red) expect(count.red).toBeGreaterThan(1_000);
    world.set(color, RuntimeMaterialValue, { value: [0, 0, 1, 1] }).unwrap();
    const blue = await capture('blue');
    for (const count of blue) {
      expect(count.blue).toBeGreaterThan(1_000);
      expect(count.red).toBeLessThan(10);
    }
    const vertices = mesh.vertices.slice();
    const stride = deriveVertexLayoutProjection(mesh.attributes).arrayStride / 4;
    for (let offset = 0; offset < vertices.length; offset += stride)
      vertices[offset] = (vertices[offset] ?? 0) * 0.4;
    const content = world
      .spawn({ component: RuntimeMeshVertices, data: { asset: meshHandle, vertices } })
      .unwrap();
    vertices.fill(0);
    const narrow = await capture('narrow');
    for (const [index, count] of narrow.entries()) {
      expect(count.blue).toBeGreaterThan(400);
      expect(count.blue).toBeLessThan((blue[index]?.blue ?? 0) * 0.6);
    }
    world.despawn(content).unwrap();
    const restored = await capture('restored');
    for (const [index, count] of restored.entries())
      expect(count.blue).toBeGreaterThan((blue[index]?.blue ?? 0) * 0.95);
    world.set(color, RuntimeMaterialValue, { asset: unused }).unwrap();
    for (const count of await capture('rebound')) expect(count.blue).toBeLessThan(10);
    world.set(color, RuntimeMaterialValue, { asset: material }).unwrap();
    for (const count of await capture('returned')) expect(count.blue).toBeGreaterThan(1_000);
    world.despawn(color).unwrap();
    for (const count of await capture('deleted')) expect(count.blue).toBeLessThan(10);
  } finally {
    progress('cleanup');
    for (const { canvas, lease, renderer } of consumers) {
      lease.dispose();
      renderer.dispose();
      canvas.remove();
    }
    surface.remove();
    await scene.fiber.dispose();
  }
}, 120_000);
