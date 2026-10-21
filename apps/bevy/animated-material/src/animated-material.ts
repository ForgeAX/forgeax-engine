import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import type { AssetHandle } from '@forgeax/engine-types';

const GOLDEN_ANGLE = 137.50777;
const HUE_SPEED = 100;

export interface AnimatedMaterialScene {
  readonly materials: readonly { handle: AssetHandle<'material'>; baseHue: number }[];
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

export function hslToRgb(hue: number, saturation = 1, lightness = 0.5): readonly [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 360;
  if (saturation === 0) return [lightness, lightness, lightness];
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

export function buildAnimatedMaterialWorld(world: World, assets: AssetRegistry, aspect: number): AnimatedMaterialScene {
  const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const materials: Array<{ handle: AssetHandle<'material'>; baseHue: number }> = [];
  let hue = 0;
  for (let x = -1; x <= 1; x += 1) {
    for (let z = -1; z <= 1; z += 1) {
      const handle = assets.create<MaterialAsset>(Materials.standard({ baseColor: [...hslToRgb(hue), 1], roughness: 0.45 })).unwrap();
      materials.push({ handle, baseHue: hue });
      world.spawn(
        { component: Transform, data: { pos: [x, 0, z], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [handle] } },
      );
      hue += GOLDEN_ANGLE;
    }
  }

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.6, -0.6], color: [1, 1, 1], intensity: 3, castShadow: false },
  });
  const eye: [number, number, number] = [3, 1, 3];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, -0.5, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect }) },
  );
  return { materials };
}

export function stepAnimatedMaterials(assets: AssetRegistry, scene: AnimatedMaterialScene, elapsed: number): number {
  const hueDelta = elapsed * HUE_SPEED;
  for (const material of scene.materials) {
    assets.update(material.handle, { values: { baseColor: [...hslToRgb(material.baseHue + hueDelta), 1] } }).unwrap();
  }
  return hueDelta;
}
