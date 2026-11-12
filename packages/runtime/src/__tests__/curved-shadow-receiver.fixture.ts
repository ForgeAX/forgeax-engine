import { World } from '@forgeax/engine-ecs';
import { createMeshBuilder, createPlaneGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminanceRgba16f } from './contact-shadow.fixture';

export const CURVED_SHADOW_SIZE = 256;
type Surface = 'wave' | 'fold';
interface ReceiverCase {
  readonly kind: Surface;
  readonly mapSize: number;
  readonly filter: number;
  readonly renderPath: 'forward' | 'deferred';
}
export const CURVED_SHADOW_CASES: readonly ReceiverCase[] = (['wave', 'fold'] as const).flatMap(
  (kind) =>
    [512, 2048].flatMap((mapSize) =>
      [1, 2, 3, 4, 5, 6, 7, 8].flatMap((filter) =>
        (['forward', 'deferred'] as const).map((renderPath) => ({
          kind,
          mapSize,
          filter,
          renderPath,
        })),
      ),
    ),
);

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function surface(kind: Surface) {
  const grid = createPlaneGeometry(20, 20, 128, 128).unwrap();
  const original = grid.attributes.position;
  if (!(original instanceof Float32Array)) throw new Error('Missing plane positions');
  const position = new Float32Array(original.length);
  const normal = new Float32Array(original.length);
  for (let i = 0; i < original.length; i += 3) {
    const x = original[i] ?? 0,
      z = -(original[i + 1] ?? 0);
    const wave = kind === 'wave';
    const h = wave ? 0.02 * Math.sin(8 * x) * Math.sin(8 * z) : 0.15 * Math.abs(x);
    const hx = wave ? 0.16 * Math.cos(8 * x) * Math.sin(8 * z) : x < 0 ? -0.15 : 0.15;
    const hz = wave ? 0.16 * Math.sin(8 * x) * Math.cos(8 * z) : 0;
    position.set([x, h, z], i);
    const length = Math.hypot(hx, 1, hz);
    normal.set([-hx / length, 1 / length, -hz / length], i);
  }
  const uv = grid.attributes.uv,
    indices = grid.indices;
  if (uv === undefined || indices === undefined) throw new Error('Missing indexed plane UVs');
  return createMeshBuilder({
    attributes: { position, normal, uv },
    indices,
    submeshes: grid.submeshes,
    materialSlots: grid.materialSlots,
  })
    .build()
    .unwrap();
}

/** Every triangle has |grad h| <= 0.227 < tan(20 degrees): sunlight cannot be occluded. */
function ratios(off: Float32Array, on: Float32Array) {
  const values: number[] = [];
  for (let i = 0; i < off.length; i++) {
    const reference = off[i] ?? 0;
    if (reference > 0.01) values.push((on[i] ?? 0) / reference);
  }
  values.sort((a, b) => a - b);
  return {
    samples: values.length,
    min: values[0] ?? 0,
    p01: values[Math.floor(values.length * 0.01)] ?? 0,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

export async function createCurvedShadowReceiverFixture(
  canvas: { readonly width: number; readonly height: number },
  manifestUrl: string,
) {
  const host = value(
    await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl }),
  );
  const world = new World({ assets: host.assets });
  const renderer = host.renderer,
    errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const meshes = {
    wave: host.assets.create(surface('wave')).unwrap(),
    fold: host.assets.create(surface('fold')).unwrap(),
  };
  const material = host.assets
    .create(Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1], roughness: 1 }))
    .unwrap();
  return {
    async verify(scene: ReceiverCase) {
      value(
        renderer.setProfile({
          ...renderer.inspect().profile,
          renderPath: scene.renderPath,
          ssao: false,
        }),
      );
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: meshes[scene.kind] } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      const eye = [0, 4, 7];
      world
        .spawn(
          {
            component: Transform,
            data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0.1, 0], [0, 1, 0]) },
          },
          {
            component: Camera,
            data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 160, antialias: 0, bloom: 0 },
          },
        )
        .unwrap();
      const elevation = Math.PI / 9,
        yaw = (Math.PI * 35) / 180;
      const sun = world
        .spawn({
          component: DirectionalLight,
          data: {
            direction: [
              Math.cos(elevation) * Math.sin(yaw),
              -Math.sin(elevation),
              Math.cos(elevation) * Math.cos(yaw),
            ],
            intensity: 3,
            mapSize: scene.mapSize,
            shadowFilter: scene.filter,
            shadowDistance: 160,
          },
        })
        .unwrap();
      expect(world.get(sun, DirectionalLight).unwrap().contactShadowLength).toBe(0);
      const lease = value(renderer.attach(world));
      const capture = async (castShadow: boolean) => {
        world.set(sun, DirectionalLight, { castShadow }).unwrap();
        let image: Float32Array | undefined;
        for (let frame = 0; frame < 3; frame++) {
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          const receipt = await drawReadyFrame(
            renderer,
            { leases: [lease], camera: { lease }, environment: { lease } },
            frame === 2 ? ['linear-hdr'] : undefined,
          );
          if (frame !== 2) continue;
          const hdr = value(
            await renderer.observe(receipt, { include: ['linear-hdr'] }),
          ).observations?.find((item) => item.domain === 'linear-hdr');
          if (hdr === undefined) throw new Error('Missing curved receiver HDR observation');
          image = luminanceRgba16f(
            hdr.bytes,
            canvas.width,
            canvas.height,
            hdr.metadata.bytesPerRow,
          );
        }
        if (image === undefined) throw new Error('Missing complete curved receiver frame');
        return image;
      };
      try {
        const off = await capture(false),
          on = await capture(true);
        const metrics = { ...scene, ...ratios(off, on) },
          detail = JSON.stringify(metrics);
        expect(errors, detail).toEqual([]);
        expect(metrics.samples, detail).toBeGreaterThan(10000);
        expect(metrics.min, detail).toBeGreaterThanOrEqual(1 - 2 / 255);
        return { metrics, off, on };
      } finally {
        lease.dispose();
        world.despawnAll().unwrap();
      }
    },
    async dispose() {
      world.despawnAll().unwrap();
      unsubscribe();
      await renderer.dispose();
    },
  };
}
