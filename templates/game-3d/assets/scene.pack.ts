import { color, quat } from '@forgeax/engine/math';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import {
  ANTIALIAS_FXAA,
  Atmosphere,
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import type { AssetGuid, SceneAsset, SceneEntity } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS, SUN_OUTGOING_DIRECTION } from './shared/asset-refs.ts';
import { PLAYER_COLLIDER, PLAYER_RIG } from './shared/player-rig.ts';

function meshEntity(
  key: string,
  name: string,
  mesh: AssetGuid,
  position: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
  rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
  extra: Record<string, Record<string, unknown>> = {},
): readonly [string, SceneEntity] {
  return [key, {
    components: {
      Name: { value: name },
      Transform: { pos: position, scale, quat: rotation },
      MeshFilter: { assetHandle: guidText(mesh) },
      MeshRenderer: { materials: [] },
      ...extra,
    },
  }];
}

function namedTransform(
  key: string,
  name: string,
  position: readonly [number, number, number],
  parent: string,
): readonly [string, SceneEntity] {
  return [key, {
    components: {
      Name: { value: name },
      Transform: { pos: position },
      ChildOf: { parent },
    },
  }];
}

function keyed(key: string, entity: SceneEntity): readonly [string, SceneEntity] {
  return [key, entity];
}

function staticCuboid(halfExtents: readonly [number, number, number]) {
  return {
    RigidBody: { type: RigidBodyTypeValue.static },
    Collider: {
      shape: ColliderShapeValue.cuboid,
      halfExtents,
      friction: 0.86,
      restitution: 0,
    },
  };
}

function showcaseScene(): SceneAsset {
  const playerPosition = [0, PLAYER_COLLIDER.radius + PLAYER_COLLIDER.halfHeight + 0.02, 7.4] as const;
  const cameraPosition = [0, 3.35, 13.5] as const;
  const target = [0, 1.42, 7.4] as const;
  const cameraRotation = quat.fromLookAt(quat.create(), cameraPosition, target, [0, 1, 0]);
  const rampRotation = [Math.sin(-Math.PI / 24), 0, 0, Math.cos(-Math.PI / 24)] as const;
  return {
    kind: 'scene',
    skinGuids: [guidText(assetGuid(PACKAGE_IDS.character, 'rig/player-skin'))],
    entities: Object.fromEntries([
      meshEntity(
        'ground',
        'Ground',
        assetGuid(PACKAGE_IDS.geometry, 'mesh/ground'),
        [0, -0.2, 0],
        [1, 1, 1],
        [0, 0, 0, 1],
        staticCuboid([14, 0.2, 14]),
      ),
      meshEntity(
        'collision-cube',
        'Lacquer Collision Cube',
        assetGuid(PACKAGE_IDS.geometry, 'mesh/cube'),
        [0, 0.75, -4.5],
        [1, 1, 1],
        [0, 0, 0, 1],
        staticCuboid([0.75, 0.75, 0.75]),
      ),
      meshEntity(
        'ramp',
        'Rusted Iron Ramp',
        assetGuid(PACKAGE_IDS.geometry, 'mesh/ramp'),
        [-2.2, 0.42, 7.4],
        [1, 1, 1],
        rampRotation,
        staticCuboid([1.6, 0.15, 2.2]),
      ),
      keyed('sun', {
        components: {
          Name: { value: 'Sun' },
          DirectionalLight: {
            direction: SUN_OUTGOING_DIRECTION,
            // Bare lights default off; this game explicitly requests sun shadows.
            castShadow: true,
            // Keep centimeter-scale shadow texels across the 28 m showcase.
            shadowDistance: 56,
          },
        },
      }),
      keyed('cool-light', {
        components: {
          Name: { value: 'Cool Directional Light' },
          // The sun is the first castShadow DirectionalLight; this one has no shadow
          // request, so it renders as an unshadowed cluster light.
          DirectionalLight: {
            direction: [0.62, -0.5, -0.6],
            color: color.linearRgb(0xa8c8ff),
            intensity: 1.0,
          },
        },
      }),
      keyed('point-light', {
        components: {
          Name: { value: 'Warm Point Light' },
          Transform: { pos: [0, 4.6, 0] },
          PointLight: { color: color.linearRgb(0xff9950), intensity: 52, range: 12 },
        },
      }),
      keyed('skylight', {
        components: {
          Name: { value: 'Skylight' },
          // Sky radiance, not irradiance (Three.js ambient intensity / pi).
          // groundColor adds a warm bounce from below, like HemisphereLight.
          Skylight: {
            color: color.linearRgb(0xffffff),
            groundColor: color.linearRgb(0x8a7560),
            intensity: 1.6,
          },
        },
      }),
      keyed('atmosphere', {
        components: {
          Name: { value: 'Analytic Sky' },
          // Display sky only: it runs on baseline WebGPU and WebGL2 limits, while full
          // Atmosphere (aerial perspective) needs 32 sampled textures per stage.
          Atmosphere: { backgroundOnly: true },
        },
      }),
      keyed('camera', {
        components: {
          Name: { value: 'Main Camera' },
          Transform: {
            pos: cameraPosition,
            quat: [
              cameraRotation[0] ?? 0,
              cameraRotation[1] ?? 0,
              cameraRotation[2] ?? 0,
              cameraRotation[3] ?? 1,
            ],
          },
          Camera: {
            ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
            // Explicit presentation style; generic Camera defaults remain neutral.
            tonemap: TONEMAP_ACES_FILMIC,
            exposure: 0.95,
            // Bloom glows only above-white HDR highlights; the default -1 blooms the whole frame.
            bloom: BLOOM_ENABLED,
            bloomThreshold: 1,
            bloomIntensity: 0.4,
            antialias: ANTIALIAS_FXAA,
            clearColor: [0.08, 0.12, 0.2, 1],
          },
        },
      }),
      keyed('player', {
        components: {
          Name: { value: 'Player' },
          Transform: { pos: playerPosition },
          RigidBody: { type: RigidBodyTypeValue.kinematic },
          Collider: {
            shape: ColliderShapeValue.capsule,
            ...PLAYER_COLLIDER,
            friction: 0.7,
            restitution: 0,
          },
          CharacterController: {
            offset: 0.01,
            maxSlopeClimbDeg: 48,
            minSlopeSlideDeg: 55,
            autoStepMaxHeight: 0.32,
            autoStepMinWidth: 0.15,
            snapToGroundDist: 0.24,
          },
        },
      }),
      meshEntity('player-body', 'Player Body', assetGuid(PACKAGE_IDS.character, 'mesh/player'), [0, 0, 0], [1, 1, 1], [0, 0, 0, 1], {
        ChildOf: { parent: 'player' },
        Skin: { skeleton: guidText(assetGuid(PACKAGE_IDS.character, 'rig/player-skeleton')), joints: [] },
      }),
      ...PLAYER_RIG.map((joint, index) =>
        namedTransform(
          `player/joint/${joint.name}`,
          joint.name,
          joint.local,
          joint.parent < 0 ? 'player' : `player/joint/${PLAYER_RIG.at(joint.parent)?.name ?? 'root'}`,
        ),
      ),
    ]),
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('019fb7ce-3400-7000-8000-000000000000'),
  name: 'Game 3D / Scene',
  parameters: [
    {
      name: 'sunColor',
      type: 'vec3',
      // Linear RGB of sRGB 0xfff4e5. Parameter defaults must be literals so the
      // editor can rewrite them; entity colors use color.linearRgb(0xRRGGBB).
      default: [1, 0.905, 0.784],
      apply: {
        asset: 'scene/showcase',
        path: ['entities', 'sun', 'components', 'DirectionalLight', 'color'],
      },
    },
    {
      name: 'sunIntensity',
      type: 'f32',
      default: 4.2,
      minimum: 0,
      maximum: 10,
      apply: {
        asset: 'scene/showcase',
        path: ['entities', 'sun', 'components', 'DirectionalLight', 'intensity'],
      },
    },
  ],
  sceneComponents: [
    Atmosphere,
    Camera,
    CharacterController,
    ChildOf,
    Collider,
    DirectionalLight,
    MeshFilter,
    MeshRenderer,
    Name,
    PointLight,
    RigidBody,
    Skin,
    Skylight,
    Transform,
  ],
  build: () => ok({ 'scene/showcase': showcaseScene() }),
});
