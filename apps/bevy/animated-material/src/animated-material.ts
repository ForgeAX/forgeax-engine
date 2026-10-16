import { RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import type { Handle } from '@forgeax/engine-types';

const GOLDEN_ANGLE = 137.50777;
const HUE_SPEED = 100;

export interface AnimatedMaterialScene {
  readonly materials: readonly { handle: Handle<'MaterialAsset', 'shared'>; content: EntityHandle; baseHue: number }[];
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

export function buildAnimatedMaterialWorld(world: World, aspect: number): AnimatedMaterialScene {
  const materials: Array<{ handle: Handle<'MaterialAsset', 'shared'>; content: EntityHandle; baseHue: number }> = [];
  let hue = 0;
  for (let x = -1; x <= 1; x += 1) {
    for (let z = -1; z <= 1; z += 1) {
      const handle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
        'MaterialAsset',
        Materials.standard({ baseColor: [...hslToRgb(hue), 1], roughness: 0.45 }),
      );
      const content = world.spawn({ component: RuntimeMaterialValue, data: { asset: handle, parameter: 'baseColor', kind: 2, value: [...hslToRgb(hue), 1] } }).unwrap();
      materials.push({ handle, content, baseHue: hue });
      world.spawn(
        { component: Transform, data: { pos: [x, 0, z], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
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

export function stepAnimatedMaterials(world: World, scene: AnimatedMaterialScene, elapsed: number): number {
  const hueDelta = elapsed * HUE_SPEED;
  for (const material of scene.materials) {
    world.set(material.content, RuntimeMaterialValue, { value: [...hslToRgb(material.baseHue + hueDelta), 1] }).unwrap();
  }
  return hueDelta;
}
