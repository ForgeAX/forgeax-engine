import { Materials } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { type AreaBox, boxFormFactor, type Point3 } from './gi-scene-area.fixture';
import { sceneValue } from './gi-scene-value.fixture';
import {
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type SceneHarness,
  sceneGi,
  sceneRotation,
} from './gi-scenes.fixture';

export const DIRECTIONAL_SOURCES: readonly AreaBox[] = [
  { min: [-2.625, -1, -0.45], max: [-2.375, 1, 1.05], radiance: [4, 0.4, 0.1] },
  { min: [2.375, -1, -0.45], max: [2.625, 1, 1.05], radiance: [0.1, 0.6, 4] },
];
export const DIRECTIONAL_ALBEDO: Point3 = [0.3, 0.65, 0.12];
export const ELLIPSOID_ROTATION = { name: 'anisotropic', yaw: -0.4, roll: 0.6 };

export async function directionalSources(h: SceneHarness) {
  for (const source of DIRECTIONAL_SOURCES) {
    const material = await h.publish(
      Materials.standard({
        baseColor: [0, 0, 0, 1],
        specular: 0,
        roughness: 1,
        emissive: [...source.radiance],
        emissiveIntensity: 1,
      }),
    );
    const size = source.max.map((v, i) => v - sceneValue(source.min[i])) as [
      number,
      number,
      number,
    ];
    const center = source.min.map((v, i) => (v + sceneValue(source.max[i])) / 2) as [
      number,
      number,
      number,
    ];
    h.spawn(await h.slab(...size), material, center);
  }
}

export function directionalGi(mode: 'field' | 'screen') {
  const gi = sceneGi(mode, {
    environment: [0, 0, 0],
    raysPerProbe: 256,
    probeSpacing: 0.5,
    probeBudget: 4096,
  });
  return {
    ...gi,
    field: {
      ...gi.field,
      region: {
        ...gi.field.region,
        maxFieldBytes: 4 * 1024 * 1024,
        grid: {
          ...gi.field.region.grid,
          origin: [-3.5, -2, -4.5] as const,
          dimensions: [29, 17, 25] as const,
          spacing: 0.25,
        },
      },
    },
  };
}

/** Independent inverse R_y(yaw) R_z(roll), without Engine matrices. */
function inverseRotation(p: Point3, yaw: number, roll: number): Point3 {
  const x = Math.cos(yaw) * p[0] - Math.sin(yaw) * p[2];
  const z = Math.sin(yaw) * p[0] + Math.cos(yaw) * p[2];
  return [
    Math.cos(roll) * x + Math.sin(roll) * p[1],
    -Math.sin(roll) * x + Math.cos(roll) * p[1],
    z,
  ];
}

export function ellipsoidReference(shape: 'sphere' | 'ellipsoid') {
  const scale: Point3 = shape === 'sphere' ? [1, 1, 1] : [1.25, 0.7, 0.8];
  const rotation = shape === 'sphere' ? { name: 'axis', yaw: 0, roll: 0 } : ELLIPSOID_ROTATION;
  const transform = sceneRotation(rotation);
  const origin = inverseRotation([0, 0, 3], rotation.yaw, rotation.roll).map(
    (v, i) => v / sceneValue(scale[i]),
  ) as [number, number, number];
  const rgb = new Float32Array(SCENE_WIDTH * SCENE_HEIGHT * 3).fill(NaN);
  const receivers: { pixel: number; point: Point3; normal: Point3 }[] = [];
  for (let y = 0; y < SCENE_HEIGHT; y++)
    for (let x = 0; x < SCENE_WIDTH; x++) {
      const ray: Point3 = [
        ((((x + 0.5) / SCENE_WIDTH) * 2 - 1) * Math.tan(Math.PI / 6) * SCENE_WIDTH) / SCENE_HEIGHT,
        (1 - ((y + 0.5) / SCENE_HEIGHT) * 2) * Math.tan(Math.PI / 6),
        -1,
      ];
      const direction = inverseRotation(ray, rotation.yaw, rotation.roll).map(
        (v, i) => v / sceneValue(scale[i]),
      );
      const a = direction.reduce((sum, v) => sum + v * v, 0),
        b = 2 * direction.reduce((sum, v, i) => sum + v * sceneValue(origin[i]), 0),
        c = origin.reduce((sum, v) => sum + v * v, -1);
      const discriminant = b * b - 4 * a * c;
      if (discriminant <= 0) continue;
      const t = (-b - Math.sqrt(discriminant)) / (2 * a);
      const point: Point3 = [t * ray[0], t * ray[1], t * ray[2]];
      const local = direction.map((v, i) => (sceneValue(origin[i]) + t * v) / sceneValue(scale[i]));
      const n = transform.point(local),
        length = Math.hypot(...n);
      const normal: Point3 = [
        sceneValue(n[0]) / length,
        sceneValue(n[1]) / length,
        sceneValue(n[2]) / length,
      ];
      // Exclude tessellation silhouettes and grazing normals. At 32x24 segments,
      // the unit sphere's maximum angular chord sagitta is below 0.005 radius.
      const cosine =
        -(normal[0] * ray[0] + normal[1] * ray[1] + normal[2] * ray[2]) / Math.hypot(...ray);
      if (cosine < 0.8) continue;
      const pixel = y * SCENE_WIDTH + x;
      for (const source of DIRECTIONAL_SOURCES) {
        const factor = boxFormFactor(point, normal, source);
        for (let channel = 0; channel < 3; channel++) {
          const index = pixel * 3 + channel;
          rgb[index] =
            (Number.isNaN(rgb[index]) ? 0 : sceneValue(rgb[index])) +
            sceneValue(DIRECTIONAL_ALBEDO[channel]) * sceneValue(source.radiance[channel]) * factor;
        }
      }
      receivers.push({ pixel, point, normal });
    }
  return { rgb, receivers, scale, rotation };
}

export function poseDirectionalReceiver(
  h: SceneHarness,
  entity: Parameters<typeof h.world.set>[0],
  shape: 'sphere' | 'ellipsoid',
) {
  if (shape === 'ellipsoid')
    h.world
      .set(entity, Transform, {
        scale: [1.25, 0.7, 0.8],
        quat: sceneRotation(ELLIPSOID_ROTATION).quat,
      })
      .unwrap();
}
