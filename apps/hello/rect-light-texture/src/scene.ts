// apps/hello/rect-light-texture - one scene shared by the browser demo and the
// Dawn smoke. A 45-degree tilted RectAreaLight faces the floor and the camera;
// its sourceTexture paints the floor diffuse and the metal spheres' reflections.

import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  RectAreaLight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, TextureAsset } from '@forgeax/engine-types';
import { createGalleryTextures, GALLERY, type GalleryImage } from './images.ts';

export const PANEL_TEXTURE_WIDTH = 64;
export const PANEL_TEXTURE_HEIGHT = 32;
const LEFT_SRGB = [230, 40, 30] as const;
const RIGHT_SRGB = [40, 210, 60] as const;
const TOP_BAND_ROWS = 4;

const TILT = Math.PI / 4;
export const CAMERA = {
  position: [0, 3.2, 6.4] as const,
  // Pitch down by 0.38 rad about +X: q = (sin(-0.19), 0, 0, cos(-0.19)).
  rotation: [Math.sin(-0.19), 0, 0, Math.cos(-0.19)] as const,
  fovY: Math.PI / 4,
};
export const LIGHT = {
  position: [0, 1.6, -1] as const,
  // Rotation about +X by 45 degrees: front (+Z) points down toward the camera.
  rotation: [Math.sin(TILT / 2), 0, 0, Math.cos(TILT / 2)] as const,
  width: 3,
  height: 1.2,
  intensity: 8,
  range: 12,
};
/** Floor points under the panel's left (-X) and right (+X) halves. */
export const FLOOR_PROBES = {
  left: [-1, 0, -0.2] as const,
  right: [1, 0, -0.2] as const,
};

/**
 * Build the demo image: the left half is red, the right half is green and a
 * thin white band marks the top row. `mirrored` swaps the halves so the smoke
 * can prove that u follows the light's local +X.
 */
export function createPanelTexture(mirrored = false): TextureAsset {
  const data = new Uint8Array(PANEL_TEXTURE_WIDTH * PANEL_TEXTURE_HEIGHT * 4);
  for (let y = 0; y < PANEL_TEXTURE_HEIGHT; y += 1) {
    for (let x = 0; x < PANEL_TEXTURE_WIDTH; x += 1) {
      const left = x < PANEL_TEXTURE_WIDTH / 2 !== mirrored;
      const rgb = y < TOP_BAND_ROWS ? ([255, 255, 255] as const) : left ? LEFT_SRGB : RIGHT_SRGB;
      const offset = (y * PANEL_TEXTURE_WIDTH + x) * 4;
      data.set([rgb[0], rgb[1], rgb[2], 255], offset);
    }
  }
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: PANEL_TEXTURE_WIDTH, height: PANEL_TEXTURE_HEIGHT },
    },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    mips: { kind: 'none' },
    data,
  };
}

/**
 * `textured`/`mirrored` are the smoke's orientation falsifiers; the gallery
 * images (see ./images) cover every accepted storage format and size.
 * `<image>.bc7` names a block-compressed KTX2 copy of a gallery image,
 * supplied by the caller because encoding needs the build-time codec.
 */
export type CompressedSource = `${GalleryImage}.bc7`;
export type PanelSource = 'uniform' | 'textured' | 'mirrored' | GalleryImage | CompressedSource;
export const GALLERY_IMAGES = Object.keys(GALLERY) as GalleryImage[];

export interface RectLightTextureScene {
  readonly light: EntityHandle;
  /**
   * Rebind the light to one source image; the visible emitter quad follows
   * unless `emitter` is false (perf isolation of the light's own cost).
   */
  setSource(source: PanelSource, emitter?: boolean): void;
}

function rotateByQuat(
  q: readonly [number, number, number, number],
  v: readonly [number, number, number],
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function populateRectLightTextureWorld(
  world: World,
  aspect: number,
  initial: PanelSource = 'textured',
  compressed: ReadonlyMap<CompressedSource, TextureAsset> = new Map(),
): RectLightTextureScene {
  world
    .spawn(
      { component: Transform, data: { pos: CAMERA.position, quat: CAMERA.rotation } },
      {
        component: Camera,
        data: {
          fov: CAMERA.fovY,
          aspect,
          near: 0.1,
          far: 60,
          antialias: ANTIALIAS_NONE,
          clearColor: [0.004, 0.005, 0.008, 1],
          tonemap: TONEMAP_ACES_FILMIC,
        },
      },
    )
    .unwrap();

  const floorMesh = world.allocSharedRef('MeshAsset', createPlaneGeometry(12, 12).unwrap());
  const floor = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1], metallic: 0, roughness: 0.45 }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 0], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
      },
      { component: MeshFilter, data: { assetHandle: floorMesh } },
      { component: MeshRenderer, data: { materials: [floor] } },
    )
    .unwrap();

  for (const [x, roughness] of [
    [-2.4, 0.06],
    [2.4, 0.45],
  ] as const) {
    const metal = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.95, 0.95, 0.95, 1], metallic: 1, roughness }),
    );
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0.7, 0.4], scale: [0.7, 0.7, 0.7] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
        { component: MeshRenderer, data: { materials: [metal] } },
      )
      .unwrap();
  }

  const textures = new Map<PanelSource, Handle<'TextureAsset', 'shared'>>();
  const emitterMaterials = new Map<PanelSource, Handle<'MaterialAsset', 'shared'>>();
  const addSource = (source: PanelSource, light: TextureAsset | null, display: TextureAsset | null) => {
    if (light) textures.set(source, world.allocSharedRef('TextureAsset', light));
    const displayHandle = display ? world.allocSharedRef('TextureAsset', display) : textures.get(source);
    emitterMaterials.set(
      source,
      world.allocSharedRef(
        'MaterialAsset',
        Materials.unlit([1, 1, 1, 1], displayHandle ? { baseColorTexture: displayHandle } : {}),
      ),
    );
  };
  addSource('uniform', null, null);
  addSource('textured', createPanelTexture(false), null);
  addSource('mirrored', createPanelTexture(true), null);
  for (const image of GALLERY_IMAGES) {
    const { source, display } = createGalleryTextures(image);
    // An RGBA8 sRGB source can be shown directly; other encodings get a copy.
    addSource(image, source, source.format === 'rgba8unorm-srgb' ? null : display);
  }
  // The emitter quad samples the same block-compressed texture as the light.
  for (const [name, texture] of compressed) addSource(name, texture, null);
  const sourceTexture = (source: PanelSource) => textures.get(source) ?? (0 as never);
  const emitterMaterial = (source: PanelSource) =>
    emitterMaterials.get(source) as Handle<'MaterialAsset', 'shared'>;

  const lightData = {
    color: [1, 1, 1] as [number, number, number],
    intensity: LIGHT.intensity,
    width: LIGHT.width,
    height: LIGHT.height,
    range: LIGHT.range,
  };
  const light = world
    .spawn(
      { component: Transform, data: { pos: LIGHT.position, quat: LIGHT.rotation } },
      {
        component: RectAreaLight,
        data: initial === 'uniform' ? lightData : { ...lightData, sourceTexture: sourceTexture(initial) },
      },
    )
    .unwrap();

  // The emitter quad sits a hair behind the light plane so it never occludes
  // the receiver side it illuminates.
  const back = rotateByQuat(LIGHT.rotation, [0, 0, -0.01]);
  const emitterMesh = world.allocSharedRef(
    'MeshAsset',
    createPlaneGeometry(LIGHT.width, LIGHT.height).unwrap(),
  );
  const emitterEntity = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [LIGHT.position[0] + back[0], LIGHT.position[1] + back[1], LIGHT.position[2] + back[2]],
          quat: LIGHT.rotation,
        },
      },
      { component: MeshFilter, data: { assetHandle: emitterMesh } },
      { component: MeshRenderer, data: { materials: [emitterMaterial(initial)] } },
    )
    .unwrap();

  return {
    light,
    setSource(source, emitter = true) {
      const untextured = world.get(light, RectAreaLight).unwrap();
      world
        .set(light, RectAreaLight, {
          ...untextured,
          sourceTexture: sourceTexture(source),
        })
        .unwrap();
      if (!emitter) return;
      world.set(emitterEntity, MeshRenderer, { materials: [emitterMaterial(source)] } as never).unwrap();
    },
  };
}

/** Project a world point to pixel coordinates through the demo camera. */
export function projectToPixel(
  point: readonly [number, number, number],
  width: number,
  height: number,
): readonly [number, number] {
  const [qx, qy, qz, qw] = CAMERA.rotation;
  const relative: [number, number, number] = [
    point[0] - CAMERA.position[0],
    point[1] - CAMERA.position[1],
    point[2] - CAMERA.position[2],
  ];
  const view = rotateByQuat([-qx, -qy, -qz, qw], relative);
  const f = 1 / Math.tan(CAMERA.fovY / 2);
  const ndcX = (view[0] / -view[2]) * (f / (width / height));
  const ndcY = (view[1] / -view[2]) * f;
  return [Math.round(((ndcX + 1) / 2) * width), Math.round(((1 - ndcY) / 2) * height)];
}
