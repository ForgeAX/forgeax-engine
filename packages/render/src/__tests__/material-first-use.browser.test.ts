import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { loadRhiPack } from '../assembly/backend-contract';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';

it('reports a malformed first-use Standard variant through the renderer error channel', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  let rejectedSource: string | undefined;
  const renderer = await createRenderer(
    canvas,
    undefined,
    {
      shaderManifestUrl: '/shaders/manifest.json',
    },
    {
      ...loadRhiPack(webgpu),
      createShaderModuleImmediate: (device, descriptor) => {
        rejectedSource = descriptor.code;
        return webgpu.createShaderModuleImmediate(device, {
          ...descriptor,
          code: `${descriptor.code}\nfn first_use_invalid_variant() { let rejected: f32 = vec3<f32>(0.0); }`,
        });
      },
    },
  );
  try {
    expect((await renderer.initialization).ok).toBe(true);
    expect(rejectedSource).toBeUndefined();
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
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
          data: {
            castShadow: true,
            mapSize: testQuality.shadowMapSize,
            cascadeCount: testQuality.cascadeCount,
            direction: [0, -1, -1],
            color: [1, 1, 1],
            intensity: 1,
          },
        },
      )
      .unwrap();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 0.5, 0.25, 1],
        renderState: { blend: { color: {}, alpha: {} } },
      }),
    );
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world.update().unwrap();
    const drawn = renderer.draw({
      leases: [attached],
      camera: { lease: attached },
      environment: { lease: attached },
    });
    expect(rejectedSource).toBeDefined();
    await renderer.device.queue.onSubmittedWorkDone();
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain('first_use_invalid_variant');
    expect(errors).toContainEqual(expect.objectContaining({ code: 'shader-compile-failed' }));
    // Preserve native validation evidence in the CI log.
    console.warn(
      '[material-first-use-validation]',
      JSON.stringify({ drawAccepted: drawn.ok, errors }),
    );
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
}, 60_000);
