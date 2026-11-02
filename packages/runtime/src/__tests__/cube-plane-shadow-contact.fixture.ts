import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createPlaneGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  DirectionalShadowFilterValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  type RendererOptions,
  type RenderResult,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminanceRgba16f } from './contact-shadow.fixture';

interface SceneCase {
  readonly name: string;
  readonly eyeY?: number;
  readonly eyeZ?: number;
  readonly elevation?: number;
  readonly yaw?: number;
  readonly tilt?: number;
  readonly doubleSided?: boolean;
  readonly scale?: number;
  readonly normalBias?: number;
  readonly depthBias?: number;
  readonly casterDistance?: number;
  readonly shadowFilter?: number;
}

export const CUBE_CONTACT_SIZE = 640;
export const CUBE_CONTACT_CASES: readonly SceneCase[] = [
  { name: 'contact' },
  { name: 'near camera', eyeZ: 3.8 },
  { name: 'far camera', eyeZ: 4.2 },
  { name: 'low camera', eyeY: 0.8 },
  { name: 'high camera', eyeY: 1.8 },
  { name: '45 degree sun', elevation: 45 },
  { name: '70 degree sun', elevation: 70 },
  { name: 'positive sun yaw', yaw: 20 },
  { name: 'negative sun yaw', yaw: -20 },
  { name: 'double-sided', doubleSided: true },
  { name: 'tilted double-sided', tilt: 30, doubleSided: true },
  { name: 'opposite tilt', tilt: -20, doubleSided: true },
  { name: 'centimeter scene', scale: 0.01 },
  { name: 'decimeter scene', scale: 0.1 },
  { name: 'ten-meter scene', scale: 10 },
  { name: 'hundred-meter scene', scale: 100 },
  { name: 'grazing sun', elevation: 3 },
  { name: 'high sun', elevation: 75 },
  { name: 'upstream caster', casterDistance: 2000 },
  { name: 'near-plane crossing caster', casterDistance: 248.64 },
  { name: 'authored normal offset', normalBias: 0.05 },
  { name: 'authored zero depth floor', depthBias: 0 },
  ...Object.entries(DirectionalShadowFilterValue)
    .filter(([, value]) => value !== DirectionalShadowFilterValue.pcfVogel)
    .flatMap(([name, shadowFilter]) => [
      { name: `${name} filter`, shadowFilter },
      { name: `${name} filter grazing`, shadowFilter, elevation: 3 },
    ]),
];

function value<T>(result: RenderResult<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Independent ray/box classification excludes the actual soft-shadow boundary. */
function intersectsExpandedCaster(x: number, z: number, light: readonly number[]): boolean {
  const origin = [x, 0, z];
  const minimum = [-0.65, -0.15, -0.65];
  const maximum = [0.65, 1.15, 0.65];
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const direction = -(light[axis] ?? 0);
    const point = origin[axis] ?? 0;
    const low = minimum[axis] ?? 0;
    const high = maximum[axis] ?? 0;
    if (Math.abs(direction) < 1e-8) {
      if (point < low || point > high) return false;
      continue;
    }
    const a = (low - point) / direction;
    const b = (high - point) / direction;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  return far >= near;
}

/** Central contact band and exposed controls use independent camera rays. */
function measureShadowRatios(
  off: Float32Array,
  on: Float32Array,
  size: number,
  camera: { eyeY: number; eyeZ: number; fov: number; direction: readonly number[] },
) {
  const { eyeY, eyeZ, fov, direction } = camera;
  const height = eyeY - 0.15;
  const distance = Math.hypot(height, eyeZ);
  const forwardY = -height / distance;
  const forwardZ = -eyeZ / distance;
  const focal = Math.tan(fov / 2);
  let contactSamples = 0,
    clearSamples = 0,
    topSamples = 0;
  let contactMax = 0,
    clearMin = 1,
    topMin = 1;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const sx = ((2 * (px + 0.5)) / size - 1) * focal;
      const sy = (1 - (2 * (py + 0.5)) / size) * focal;
      const dy = forwardY - forwardZ * sy;
      const dz = forwardZ + forwardY * sy;
      if (dy >= 0) continue;
      const t = -eyeY / dy;
      const x = sx * t;
      const z = eyeZ + dz * t;
      const index = py * size + px;
      const reference = off[index] ?? NaN;
      if (!(reference > 0.01)) continue;
      const ratio = (on[index] ?? NaN) / reference;
      if (z > 0.5 && z < 0.6 && Math.abs(x) < 0.4) {
        contactMax = Math.max(contactMax, ratio);
        contactSamples++;
      }
      if (
        Math.abs(x) > 0.7 &&
        Math.abs(x) < 2.5 &&
        z > 0.55 &&
        z < 2 &&
        !intersectsExpandedCaster(x, z, direction)
      ) {
        clearMin = Math.min(clearMin, ratio);
        clearSamples++;
      }
      const topT = (1 - eyeY) / dy;
      if (topT > 0 && Math.abs(sx * topT) < 0.4 && Math.abs(eyeZ + dz * topT) < 0.4) {
        topMin = Math.min(topMin, ratio);
        topSamples++;
      }
    }
  return { contactSamples, clearSamples, topSamples, contactMax, clearMin, topMin };
}

/** One renderer and World own the matrix; every case resets its scene entities. */
export async function createCubePlaneShadowContactFixture(
  canvas: { readonly width: number; readonly height: number },
  manifestUrl: string,
  options: RendererOptions = {},
) {
  const host = value(
    await constructRuntimeRendererHost(canvas, options, { shaderManifestUrl: manifestUrl }),
  );
  const renderer = host.renderer;
  const world = new World({ assets: host.assets });
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  return {
    async verify(renderPath: 'forward' | 'deferred', scene: SceneCase) {
      value(renderer.setProfile({ ...renderer.inspect().profile, renderPath, ssao: false }));
      const material = host.assets
        .create(
          Materials.standard({
            baseColor: [0.7, 0.7, 0.7, 1],
            roughness: 1,
            ...(scene.doubleSided ? { renderState: { cullMode: 'none' } } : {}),
          }),
        )
        .unwrap();
      // Scale geometry and camera coverage together to preserve shadow-texel density.
      const scale = scene.scale ?? 1;
      const spawn = (mesh: MeshAsset, position: number[], rotation: number[]) =>
        world
          .spawn(
            {
              component: Transform,
              data: {
                pos: position.map((v) => v * scale),
                quat: rotation,
                scale: [scale, scale, scale],
              },
            },
            { component: MeshFilter, data: { assetHandle: host.assets.create(mesh).unwrap() } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
      const elevation = ((scene.elevation ?? 20) * Math.PI) / 180;
      const yaw = ((scene.yaw ?? 0) * Math.PI) / 180;
      const direction = [
        Math.cos(elevation) * Math.sin(yaw),
        -Math.sin(elevation),
        Math.cos(elevation) * Math.cos(yaw),
      ];
      const tilt = ((scene.tilt ?? 0) * Math.PI) / 180;
      const rotate = ([x = 0, y = 0, z = 0]: readonly number[]) => [
        x,
        y * Math.cos(tilt) - z * Math.sin(tilt),
        y * Math.sin(tilt) + z * Math.cos(tilt),
      ];
      const flatAngle = (-Math.PI / 2 + tilt) / 2;
      spawn(
        createPlaneGeometry(20, 20).unwrap(),
        [0, 0, 0],
        [Math.sin(flatAngle), 0, 0, Math.cos(flatAngle)],
      );
      spawn(
        createBoxGeometry(1, 1, 1).unwrap(),
        rotate(
          direction.map((v, axis) => (axis === 1 ? 0.5 : 0) - v * (scene.casterDistance ?? 0)),
        ),
        [Math.sin(tilt / 2), 0, 0, Math.cos(tilt / 2)],
      );
      const eyeY = scene.eyeY ?? 1.2;
      const eyeZ = scene.eyeZ ?? 4;
      const eye = rotate([0, eyeY, eyeZ]);
      const fov = Math.PI / 4;
      world
        .spawn(
          {
            component: Transform,
            data: {
              pos: eye.map((v) => v * scale),
              quat: quat.fromLookAt(quat.create(), eye, rotate([0, 0.15, 0]), rotate([0, 1, 0])),
            },
          },
          {
            component: Camera,
            data: { fov, aspect: 1, near: 0.1 * scale, far: 160 * scale, antialias: 0, bloom: 0 },
          },
        )
        .unwrap();
      const sun = world
        .spawn({
          component: DirectionalLight,
          data: {
            direction: rotate(direction),
            intensity: 3,
            ...(scene.scale === undefined ? {} : { shadowDistance: 200 * scale }),
            ...(scene.normalBias === undefined ? {} : { normalBias: scene.normalBias }),
            ...(scene.depthBias === undefined ? {} : { depthBias: scene.depthBias }),
            ...(scene.shadowFilter === undefined ? {} : { shadowFilter: scene.shadowFilter }),
          },
        })
        .unwrap();
      expect(world.get(sun, DirectionalLight).unwrap().contactShadowLength).toBe(0);
      const lease = value(renderer.attach(world));
      try {
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
            const observed = value(await renderer.observe(receipt, { include: ['linear-hdr'] }));
            const hdr = observed.observations?.find((item) => item.domain === 'linear-hdr');
            if (hdr === undefined) throw new Error('Missing contact-shadow HDR observation');
            image = luminanceRgba16f(
              hdr.bytes,
              canvas.width,
              canvas.height,
              hdr.metadata.bytesPerRow,
            );
          }
          if (image === undefined) throw new Error('Missing complete contact-shadow frame');
          return image;
        };
        const off = await capture(false);
        const on = await capture(true);
        const metrics = {
          renderPath,
          scene: scene.name,
          ...measureShadowRatios(off, on, canvas.width, { eyeY, eyeZ, fov, direction }),
        };
        const { contactSamples, clearSamples, topSamples, contactMax, clearMin, topMin } = metrics;
        const detail = JSON.stringify(metrics);
        expect(errors, detail).toEqual([]);
        expect(contactSamples, detail).toBeGreaterThan(100);
        expect(clearSamples, detail).toBeGreaterThan(10000);
        expect(contactMax, detail).toBeLessThanOrEqual(0.001);
        expect(clearMin, detail).toBeGreaterThanOrEqual(0.99);
        if (scene.casterDistance === undefined && eyeY > 1)
          expect(topSamples, detail).toBeGreaterThan(100);
        if (scene.casterDistance === undefined) expect(topMin, detail).toBeGreaterThanOrEqual(0.99);
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

/** Standalone diagnostic captures use the same case and lifetime authority. */
export async function verifyCubePlaneShadowContact(
  canvas: { readonly width: number; readonly height: number },
  manifestUrl: string,
  renderPath: 'forward' | 'deferred',
  scene: SceneCase,
) {
  const fixture = await createCubePlaneShadowContactFixture(canvas, manifestUrl);
  try {
    return await fixture.verify(renderPath, scene);
  } finally {
    await fixture.dispose();
  }
}
