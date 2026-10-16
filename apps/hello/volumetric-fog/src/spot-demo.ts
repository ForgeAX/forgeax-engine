import type { World } from '@forgeax/engine-ecs';
import { PointLight, PointLightShadow, SpotLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { Handle } from '@forgeax/engine-types';
import type { OfficialScenePose } from './scene-pose';

/** Spawn the exact official Point+Spot pair used by the fog demo. */
export function spawnVolumetricSpot(
  world: World,
  castShadow: boolean,
  projector?: Handle<'TextureAsset', 'shared'>,
  options: { readonly pointEnabled?: boolean; readonly spotEnabled?: boolean } = {},
  scenePose?: OfficialScenePose,
) {
  const pointEnabled = options.pointEnabled ?? true;
  const spotEnabled = options.spotEnabled ?? true;
  const pointPosition = scenePose?.pointPosition ?? [0, 1.4, 0];
  const spotPosition = scenePose?.spotPosition ?? [2.5, 5, 2.5];
  const spotDirection = scenePose?.spotDirection ?? [-2.5, -5, -2.5];
  const point = world
    .spawn(
      { component: Transform, data: { pos: pointPosition, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: PointLight,
        data: {
          // Three's #f9bb50 becomes this linear RGB value under its color
          // management. Light component colors are already linear in ForgeaX.
          color: [0.9473065367, 0.4969329951, 0.0802198203],
          intensity: pointEnabled ? 3 : 0,
          range: 100,
        },
      },
      ...(castShadow ? [{ component: PointLightShadow, data: {} }] : []),
    )
    .unwrap();
  const spot = world
    .spawn(
      {
        component: Transform,
        data: { pos: spotPosition, quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      {
        component: SpotLight,
        data: {
          direction: spotDirection,
          color: [1, 1, 1],
          intensity: spotEnabled ? 100 : 0,
          // Three.js uses distance=0 for an unbounded spot. The Engine's
          // zero range is an explicit finite safety sentinel, so preserve
          // the source meaning with +Infinity at the authoring boundary.
          range: Number.POSITIVE_INFINITY,
          innerConeDeg: 0,
          outerConeDeg: 30,
          castShadow,
          // Three r184 sets shadow.intensity = 0.98: retain the same 2%
          // residual light in the occluder footprint instead of making the
          // receiver mathematically black.
          shadowIntensity: 0.98,
          mapSize: 1024,
          // The pinned Three.js WebGPU fixture uses its five-tap Vogel PCF
          // path. Keep the authored scene on the closest quality tier so the
          // receiver footprint is not artificially hard/dark.
          pcfKernelSize: 5,
          depthBias: 0.005,
          normalBias: 0.05,
          nearPlane: 1,
          farPlane: 15,
          ...(projector === undefined ? {} : { projector }),
        },
      },
    )
    .unwrap();
  return { point, spot };
}
