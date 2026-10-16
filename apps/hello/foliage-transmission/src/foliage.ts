import type { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { withFoliageMaterialModule } from './material-contract.ts';

/**
 * `no-transmission` builds the same scene with every diffuse-transmission
 * factor at zero; the pixel gates must then fail (falsifier).
 */
export type FoliageMode = 'transmission' | 'no-transmission';

export interface FoliageOptions {
  readonly aspect: number;
  readonly mode?: FoliageMode;
  /** Leaves per side of an extra square grid behind the panels (performance probe). */
  readonly grid?: number;
  /** Additional case for the bounded no-storage point-light transport. */
  readonly pointLightCount?: 1 | 4;
  /**
   * Grid leaf root: the cooked diffuse-transmission alias (default) or the
   * canonical layer-free Standard entry, the performance baseline.
   */
  readonly gridMaterial?: 'diffuse-transmission' | 'standard';
}

const LEAF_BASE = { baseColor: [0.18, 0.42, 0.08, 1] as const, metallic: 0, roughness: 0.65 };
const LEAF_TINT = [0.55, 0.95, 0.2] as const;
export const PANEL_X = [-2.1, 0, 2.1] as const;

/**
 * 64x1 alpha mask: the left half blocks transmission, the right half passes
 * it. The width keeps the filtered edge near one pixel at the smoke resolution.
 */
function transmissionMask(): TextureAsset {
  const alphas = Array.from({ length: 64 }, (_, texel) => (texel < 32 ? 0 : 255));
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: alphas.length, height: 1 } },
    format: 'rgba8unorm',
    data: new Uint8Array(alphas.flatMap((alpha) => [255, 255, 255, alpha])),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

/**
 * Three back-lit leaf panels facing the camera: an opaque control, a uniform
 * diffuse-transmission leaf, and a leaf whose transmission is masked by a
 * texture. Both lights sit behind the panels, so any visible leaf radiance
 * comes from the transmission lobe.
 */
export function buildFoliageWorld(world: World, options: FoliageOptions): void {
  const factor = options.mode === 'no-transmission' ? 0 : 1;
  const plane = createPlaneGeometry(1.6, 2.2);
  if (!plane.ok) throw new Error(`foliage plane failed: ${plane.error.code}`);
  const leafMesh = world.allocSharedRef('MeshAsset', plane.value);
  const material = (asset: MaterialAsset) =>
    world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', asset);
  const opaque = material(Materials.standard(LEAF_BASE));
  const transmissive = material(
    withFoliageMaterialModule(
      Materials.standard({ staticSwitches: { diffuseTransmission: true },
        ...LEAF_BASE,
        diffuseTransmission: factor,
        diffuseTransmissionColor: LEAF_TINT,
      }),
    ),
  );
  const masked = material(
    withFoliageMaterialModule(
      Materials.standard({ staticSwitches: { diffuseTransmission: true },
        ...LEAF_BASE,
        diffuseTransmission: factor,
        diffuseTransmissionColor: LEAF_TINT,
        diffuseTransmissionTexture: world.allocSharedRef('TextureAsset', transmissionMask()),
      }),
    ),
  );
  const spawnLeaf = (pos: [number, number, number], leafMaterial: typeof opaque, scale = 1) =>
    world
      .spawn(
        { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [scale, scale, scale] } },
        { component: MeshFilter, data: { assetHandle: leafMesh } },
        { component: MeshRenderer, data: { materials: [leafMaterial] } },
      )
      .unwrap();
  for (const [index, leafMaterial] of [opaque, transmissive, masked].entries())
    spawnLeaf([PANEL_X[index] ?? 0, 0, 0], leafMaterial);

  const grid = options.grid ?? 0;
  for (let row = 0; row < grid; row += 1)
    for (let column = 0; column < grid; column += 1)
      spawnLeaf(
        [(column / Math.max(grid - 1, 1) - 0.5) * 9, (row / Math.max(grid - 1, 1) - 0.5) * 5, -1.5],
        options.gridMaterial === 'standard' ? opaque : transmissive,
        0.12,
      );

  // Sun behind the leaves (outgoing direction points toward the camera).
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0.15, -0.3, 1], color: [1, 0.96, 0.88], intensity: 1.5 },
    })
    .unwrap();
  // One and four point cases exercise the same punctual BRDF on both backends.
  const pointPositions: readonly [number, number, number][] = [
    [0, 0.4, -1.2], [-2, 0.2, -1.1], [2, -0.2, -1.1], [0, -1.2, -1.1],
  ];
  for (const pos of pointPositions.slice(0, options.pointLightCount ?? 1)) {
    world
      .spawn(
        { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: PointLight, data: { color: [1, 0.7, 0.4], intensity: 2, range: 6 } },
      )
      .unwrap();
  }

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
