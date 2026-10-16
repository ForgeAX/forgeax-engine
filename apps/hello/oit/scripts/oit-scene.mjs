// Shared scene for hello-oit: the browser demo and the dawn smoke spawn the
// same World, and the smoke derives its probe reference from the same layers.
//
// Three translucent planes cross at the origin, each tilted about +Y: red is in
// front on the left, green in front on the right, blue lies between them. No
// object order composes both halves correctly, so the sorted transparent pass
// is wrong on at least one side while weighted blended OIT is order independent.
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_REINHARD_EXTENDED,
  TRANSPARENCY_SORTED,
  TRANSPARENCY_WEIGHTED_BLENDED,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const CAMERA_Z = 5;
const TILT = (35 * Math.PI) / 180;
export const BACKGROUND = [0.25, 0.25, 0.25];
export const OCCLUDER = [0.9, 0.9, 0.1];

export const OIT_LAYERS = [
  { name: 'red', color: [1, 0, 0], alpha: 0.6, tilt: TILT },
  { name: 'green', color: [0, 1, 0], alpha: 0.5, tilt: -TILT },
  { name: 'blue', color: [0, 0, 1], alpha: 0.4, tilt: 0 },
];

const STRAIGHT_OVER = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/** Probe sites in normalized device coordinates of the square orthographic view. */
export const OIT_PROBES = [
  { name: 'left', x: -0.55, y: 0 },
  { name: 'right', x: 0.25, y: 0.08 },
  { name: 'background', x: -0.35, y: 0.8 },
  { name: 'occluded', x: 0.75, y: 0 },
];

/** Pixel of a probe on a `size` x `size` target and the NDC of that pixel's center. */
export function probePixel(probe, size) {
  const px = Math.min(size - 1, Math.floor(((probe.x + 1) / 2) * size));
  const py = Math.min(size - 1, Math.floor(((1 - probe.y) / 2) * size));
  return { px, py, x: ((px + 0.5) / size) * 2 - 1, y: 1 - ((py + 0.5) / size) * 2 };
}

// The render package's documented McGuire-Bavoil weight on camera distance:
// clamp(10 / (1e-5 + (d/5)^2 + (d/200)^6), 0.01, 500).
function oitWeight(d) {
  const near = d / 5;
  const far = d / 200;
  return Math.min(Math.max(10 / (1e-5 + near * near + far ** 6), 0.01), 500);
}

/** Expected linear color at a probe: the WBOIT model and exact back-to-front over. */
export function probeReference(probe, size) {
  if (probe.name === 'occluded') return { weighted: [...OCCLUDER], exact: [...OCCLUDER] };
  if (probe.name === 'background') return { weighted: [...BACKGROUND], exact: [...BACKGROUND] };
  const { x, y } = probePixel(probe, size);
  const fragments = OIT_LAYERS.map((layer) => ({
    color: layer.color,
    alpha: layer.alpha,
    distance: Math.hypot(x, y, CAMERA_Z + x * Math.tan(layer.tilt)),
  }));
  const sum = [0, 0, 0];
  let weight = 0;
  let revealage = 1;
  for (const fragment of fragments) {
    const w = fragment.alpha * oitWeight(fragment.distance);
    for (let c = 0; c < 3; c++) sum[c] += fragment.color[c] * w;
    weight += w;
    revealage *= 1 - fragment.alpha;
  }
  const weighted = sum.map(
    (value, c) => (value / Math.max(weight, 1e-5)) * (1 - revealage) + BACKGROUND[c] * revealage,
  );
  const exact = [...BACKGROUND];
  for (const fragment of [...fragments].sort((a, b) => b.distance - a.distance))
    for (let c = 0; c < 3; c++)
      exact[c] = fragment.color[c] * fragment.alpha + exact[c] * (1 - fragment.alpha);
  return { weighted, exact };
}

/** Spawn the backdrop, occluder, camera and the three layers in `order`. */
export function spawnOitScene(world, { order = [0, 1, 2] } = {}) {
  const quad = (w, h) => world.allocSharedRef('MeshAsset', createPlaneGeometry(w, h).unwrap());
  const opaque = (color) =>
    world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([...color, 1], { renderState: { cullMode: 'none' } }),
    );
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3] } },
      { component: MeshFilter, data: { assetHandle: quad(4, 4) } },
      { component: MeshRenderer, data: { materials: [opaque(BACKGROUND)] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0.75, 0, 2] } },
      { component: MeshFilter, data: { assetHandle: quad(0.4, 3) } },
      { component: MeshRenderer, data: { materials: [opaque(OCCLUDER)] } },
    )
    .unwrap();
  const layerMesh = quad(3, 1.2);
  const layerMaterials = OIT_LAYERS.map((layer) =>
    world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([...layer.color, layer.alpha], {
        renderState: { cullMode: 'none', blend: STRAIGHT_OVER },
      }),
    ),
  );
  let layers = [];
  const spawnLayers = (nextOrder) => {
    for (const entity of layers) world.despawn(entity).unwrap();
    layers = nextOrder.map((index) => {
      const layer = OIT_LAYERS[index];
      return world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [0, 0, 0],
              quat: [0, Math.sin(layer.tilt / 2), 0, Math.cos(layer.tilt / 2)],
            },
          },
          { component: MeshFilter, data: { assetHandle: layerMesh } },
          { component: MeshRenderer, data: { materials: [layerMaterials[index]] } },
        )
        .unwrap();
    });
  };
  spawnLayers(order);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, CAMERA_Z] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          near: 0.1,
          far: 10,
          aspect: 1,
          tonemap: TONEMAP_REINHARD_EXTENDED,
          clearColor: [0, 0, 0, 1],
          transparency: TRANSPARENCY_WEIGHTED_BLENDED,
        },
      },
    )
    .unwrap();
  const setTransparency = (mode) =>
    world
      .set(camera, Camera, {
        transparency: mode === 'sorted' ? TRANSPARENCY_SORTED : TRANSPARENCY_WEIGHTED_BLENDED,
      })
      .unwrap();
  return { camera, spawnLayers, setTransparency };
}
