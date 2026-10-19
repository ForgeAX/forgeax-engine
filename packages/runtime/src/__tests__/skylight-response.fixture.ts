import { World } from '@forgeax/engine-ecs';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { unwrap } from './specular-aa.fixture';

export const RESPONSE_SIZE = 256;
export const RESPONSE_FOV = Math.PI / 3;
export const RESPONSE_RADIUS = 0.9;
export const RESPONSE_SURFACES = [
  { name: 'white-metal', color: [1, 1, 1, 1] as const, metallic: 1 },
  { name: 'copper', color: [0.55, 0.18, 0.06, 1] as const, metallic: 1 },
  { name: 'dielectric', color: [0.08, 0.3, 0.6, 1] as const, metallic: 0 },
];
export const RESPONSE_SPHERES = RESPONSE_SURFACES.flatMap((surface, row) =>
  [0.1, 0.5, 1].map((roughness, column) => ({
    ...surface,
    roughness,
    center: [(column - 1) * 2.2, (1 - row) * 2.2, -8] as const,
  })),
);
export type EnvironmentSource = 'solid' | 'panorama' | 'studio' | 'none';

/** Identical top-to-bottom HDR texels feed native and Three HDRLoader conventions. */
export function responsePanorama(source: 'panorama' | 'studio') {
  const width = source === 'studio' ? 512 : 256;
  const height = width / 2;
  const data = new Uint8Array(width * height * 8);
  const view = new DataView(data.buffer);
  const lobes = [
    { direction: [0.6, 0.5, 0.6], sharpness: 14, color: [5, 2, 0.6] },
    { direction: [-0.5, 0.65, 0.58], sharpness: 120, color: [12, 11, 10] },
    { direction: [0.3, -0.4, -0.7], sharpness: 8, color: [0.3, 1.5, 4] },
  ].map((lobe) => ({
    ...lobe,
    direction: lobe.direction.map((v) => v / Math.hypot(...lobe.direction)),
  }));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const longitude = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
      const direction = [
        Math.cos(latitude) * Math.cos(longitude),
        Math.sin(latitude),
        Math.cos(latitude) * Math.sin(longitude),
      ];
      const rgb = source === 'panorama' ? [1, 1, 1] : [0.04, 0.06, 0.09];
      if (source === 'studio')
        for (const lobe of lobes) {
          const cosine = direction.reduce((sum, v, i) => sum + v * (lobe.direction[i] ?? 0), 0);
          const weight = Math.exp(lobe.sharpness * (cosine - 1));
          for (let c = 0; c < 3; c++) rgb[c] = (rgb[c] ?? 0) + weight * (lobe.color[c] ?? 0);
        }
      for (let c = 0; c < 4; c++)
        view.setUint16(
          ((y * width + x) * 4 + c) * 2,
          halfFloat.f32ToF16(c === 3 ? 1 : (rgb[c] ?? 0)),
          true,
        );
    }
  return { width, height, data };
}

export function responseWorld(source: EnvironmentSource, rotation = 0) {
  const world = new World();
  const sphere = world.allocSharedRef(
    'MeshAsset',
    createSphereGeometry(RESPONSE_RADIUS, 96, 64).unwrap(),
  );
  for (const { color, metallic, roughness, center } of RESPONSE_SPHERES) {
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: color, metallic, roughness }),
    );
    world
      .spawn(
        { component: Transform, data: { pos: center } },
        { component: MeshFilter, data: { assetHandle: sphere } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  if (source !== 'none') {
    world
      .spawn({
        component: Skylight,
        data: {
          intensity: 1,
          rotation: [0, Math.sin(rotation / 2), 0, Math.cos(rotation / 2)],
          ...(source === 'panorama' || source === 'studio'
            ? {
                equirect: world.allocSharedRef('EquirectAsset', {
                  kind: 'equirect',
                  ...responsePanorama(source),
                  format: 'rgba16float',
                  colorSpace: 'linear',
                }),
              }
            : {}),
        },
      })
      .unwrap();
  }
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: RESPONSE_FOV,
          aspect: 1,
          near: 0.1,
          far: 30,
          clearColor: [0, 0, 0, 1],
          antialias: 0,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
        },
      },
    )
    .unwrap();
  return world;
}

export function responseRgb(bytes: Uint8Array, bytesPerRow = RESPONSE_SIZE * 8) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rgb = new Float32Array(RESPONSE_SIZE * RESPONSE_SIZE * 3);
  for (let y = 0; y < RESPONSE_SIZE; y++)
    for (let x = 0; x < RESPONSE_SIZE; x++)
      for (let c = 0; c < 3; c++)
        rgb[(y * RESPONSE_SIZE + x) * 3 + c] = halfFloat.f16ToF32(
          view.getUint16(y * bytesPerRow + x * 8 + c * 2, true),
        );
  return rgb;
}

// Analytic ray/sphere distance excludes silhouette coverage while retaining
// a separate grazing region; a whole-canvas mean would hide this response.
const regions = RESPONSE_SPHERES.map(() => ({ core: [] as number[], rim: [] as number[] }));
for (let y = 0; y < RESPONSE_SIZE; y++)
  for (let x = 0; x < RESPONSE_SIZE; x++) {
    const ray = [
      (((x + 0.5) / RESPONSE_SIZE) * 2 - 1) * Math.tan(RESPONSE_FOV / 2),
      (1 - ((y + 0.5) / RESPONSE_SIZE) * 2) * Math.tan(RESPONSE_FOV / 2),
      -1,
    ];
    const length = Math.hypot(...ray);
    RESPONSE_SPHERES.forEach(({ center }, i) => {
      const along = center.reduce((sum, v, c) => sum + (v * (ray[c] ?? 0)) / length, 0);
      const distance =
        Math.hypot(...center.map((v, c) => v - (along * (ray[c] ?? 0)) / length)) / RESPONSE_RADIUS;
      if (distance < 0.5) regions[i]?.core.push(y * RESPONSE_SIZE + x);
      if (distance > 0.8 && distance < 0.94) regions[i]?.rim.push(y * RESPONSE_SIZE + x);
    });
  }

export function responseSamples(rgb: Float32Array) {
  return RESPONSE_SPHERES.flatMap(({ name, roughness }, i) =>
    (['core', 'rim'] as const).map((region) => {
      const pixels = regions[i]?.[region] ?? [];
      if (pixels.length === 0) throw new Error('empty response region');
      return {
        name,
        roughness,
        region,
        rgb: [0, 1, 2].map(
          (c) => pixels.reduce((sum, p) => sum + (rgb[p * 3 + c] ?? Number.NaN), 0) / pixels.length,
        ),
      };
    }),
  );
}

/** A spatial error complements region means, which can hide displaced highlights. */
export function responsePixelErrors(actual: Float32Array, reference: Float32Array) {
  return RESPONSE_SPHERES.map(({ name, roughness }, i) => {
    const pixels = [...(regions[i]?.core ?? []), ...(regions[i]?.rim ?? [])];
    let absolute = 0;
    let energy = 0;
    for (const pixel of pixels)
      for (let c = 0; c < 3; c++) {
        const expected = reference[pixel * 3 + c] ?? Number.NaN;
        absolute += Math.abs((actual[pixel * 3 + c] ?? Number.NaN) - expected);
        energy += Math.abs(expected);
      }
    return {
      name,
      roughness,
      meanAbsoluteError: absolute / (pixels.length * 3),
      relativeError: absolute / Math.max(energy, pixels.length * 3 * 0.01),
    };
  });
}

export async function renderResponse(
  renderer: Renderer,
  source: EnvironmentSource,
  renderPath: 'forward' | 'deferred',
  rotation = 0,
  onReady?: (draw: () => Promise<void>) => Promise<void>,
) {
  return renderWorldResponse(renderer, responseWorld(source, rotation), renderPath, onReady);
}

export async function renderWorldResponse(
  renderer: Renderer,
  world: World,
  renderPath: 'forward' | 'deferred',
  onReady?: (draw: () => Promise<void>) => Promise<void>,
) {
  const lease = unwrap(renderer.attach(world));
  unwrap(renderer.setProfile({ ...renderer.inspect().profile, renderPath }));
  try {
    for (let frame = 0; frame < 300; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      // Presentation readiness includes completed image-based Skylight publication.
      unwrap(renderer.requestObservation?.(['linear-hdr']));
      const receipt = unwrap(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      unwrap(await receipt.completed);
      if (receipt.presentation === 'ready') {
        const hdr = unwrap(
          await renderer.observe(receipt, { include: ['linear-hdr'] }),
        ).observations?.find((item) => item.domain === 'linear-hdr');
        if (hdr === undefined) throw new Error('missing linear HDR observation');
        await onReady?.(async () => {
          const next = unwrap(
            renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
          );
          unwrap(await next.completed);
        });
        return responseRgb(hdr.bytes, hdr.metadata.bytesPerRow);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Skylight scene did not become ready within 300 frames');
  } finally {
    lease.dispose();
  }
}
