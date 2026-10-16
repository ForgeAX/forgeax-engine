import type { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { Camera, Materials, MeshFilter, MeshRenderer, Skylight, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { withFoliageMaterialModule } from './material-contract.ts';

/**
 * `split` is the shipped model: the factor moves energy from reflection to
 * transmission. `additive` restores the full front diffuse on top of the same
 * transmission lobe (the Unreal raster two-sided foliage composite); the
 * furnace gate must then fail (falsifier).
 */
export type FurnaceMode = 'split' | 'additive';

export interface FurnaceOptions {
  readonly aspect: number;
  readonly mode?: FurnaceMode;
}

/** Uniform environment radiance; 1x maps to mid-grey and 2x stays below sRGB white. */
export const FURNACE_RADIANCE = 0.35;
/** Panel order: opaque canonical Standard control, then the alias at each factor. */
export const FURNACE_FACTORS = [null, 0, 0.5, 1] as const;
export const FURNACE_PANEL_X = [-2.85, -0.95, 0.95, 2.85] as const;

const WHITE = { baseColor: [1, 1, 1, 1] as const, metallic: 0, roughness: 0.65 };

/**
 * White furnace: white panels under a uniform solid-colour Skylight and no
 * other light. Front reflection sees the environment over the front
 * hemisphere and transmission sees it over the back hemisphere, so an
 * energy-splitting layer keeps every panel at the opaque control's radiance
 * for any factor. An additive layer reaches about `1 + factor` times it.
 */
export function buildWhiteFurnaceWorld(world: World, options: FurnaceOptions): void {
  const plane = createPlaneGeometry(1.6, 2.2);
  if (!plane.ok) throw new Error(`furnace plane failed: ${plane.error.code}`);
  const mesh = world.allocSharedRef('MeshAsset', plane.value);
  const panelMaterial = (factor: number | null): MaterialAsset => {
    if (factor === null) return Materials.standard(WHITE);
    // Emission equal to the diffuse energy the split removed from the front lobe.
    const restored = options.mode === 'additive' ? factor * FURNACE_RADIANCE : 0;
    return withFoliageMaterialModule(
      Materials.standard({ staticSwitches: { diffuseTransmission: true },
        ...WHITE,
        diffuseTransmission: factor,
        diffuseTransmissionColor: [1, 1, 1],
        emissive: [restored, restored, restored],
        emissiveIntensity: 1,
      }),
    );
  };
  for (const [index, factor] of FURNACE_FACTORS.entries())
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [FURNACE_PANEL_X[index] ?? 0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        {
          component: MeshRenderer,
          data: { materials: [world.allocSharedRef('MaterialAsset', panelMaterial(factor))] },
        },
      )
      .unwrap();

  world.spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: FURNACE_RADIANCE } }).unwrap();

  const eye: [number, number, number] = [0, 0, 7];
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 4, aspect: options.aspect, near: 0.1, far: 50 }),
      },
    )
    .unwrap();
}
