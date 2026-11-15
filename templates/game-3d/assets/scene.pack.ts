import { quat } from '@forgeax/engine/math';
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
  Camera,
  DirectionalLight,
  Fog,
  MeshFilter,
  MeshRenderer,
  perspective,
  ReflectionProbe,
  REFLECTION_PROBE_UPDATE_ON_CHANGE,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import type { AssetGuid, SceneAsset, SceneEntity } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS, SUN_OUTGOING_DIRECTION } from './shared/asset-refs.ts';
import { PLAYER_COLLIDER, PLAYER_RIG } from './shared/player-rig.ts';
import { CAMERA_DISTANCE, CAMERA_TARGET_HEIGHT, INITIAL_CAMERA_PITCH, orbitPosition } from './shared/third-person.ts';

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
  const target = [playerPosition[0], playerPosition[1] + CAMERA_TARGET_HEIGHT, playerPosition[2]] as const;
  const cameraPosition = orbitPosition(target, 0, INITIAL_CAMERA_PITCH, CAMERA_DISTANCE);
  const cameraRotation = quat.fromLookAt(quat.create(), cameraPosition, target, [0, 1, 0]);
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
        staticCuboid([1000, 0.2, 1000]),
      ),
      meshEntity(
        'iron-sphere',
        'Rusted Iron Sphere',
        assetGuid(PACKAGE_IDS.geometry, 'mesh/iron-sphere'),
        [0, 1, 2.4],
        [1, 1, 1],
        [0, 0, 0, 1],
        {
          RigidBody: { type: RigidBodyTypeValue.static },
          Collider: { shape: ColliderShapeValue.sphere, radius: 1, friction: 0.86, restitution: 0 },
        },
      ),
      keyed('sun', {
        components: {
          Name: { value: 'Sun' },
          DirectionalLight: {
            direction: SUN_OUTGOING_DIRECTION,
            // Bare lights default off; this game explicitly requests sun shadows.
            castShadow: true,
            // Keep centimeter-scale shadow texels around the nearby props.
            shadowDistance: 56,
          },
        },
      }),
      keyed('skylight', {
        components: {
          Name: { value: 'Skylight' },
          Skylight: {},
        },
      }),
      keyed('atmosphere', {
        components: {
          Name: { value: 'Analytic Sky' },
          Atmosphere: { mieScattering: 1.998e-6, mieAbsorption: 0.222e-6 },
        },
      }),
      keyed('height-fog', {
        components: {
          Name: { value: 'Height Fog' },
          Fog: { density: 0.00008 },
        },
      }),
      keyed('sphere-reflection', {
        components: {
          Name: { value: 'Iron Sphere Reflection' },
          Transform: { pos: [0, 1, 2.4] },
          ReflectionProbe: {
            halfExtents: [3, 3, 3],
            resolution: 128,
            boxProjection: true,
            updateIntent: REFLECTION_PROBE_UPDATE_ON_CHANGE,
          },
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
            // Auto exposure meters the frame; no compensation bias. The fallback
            // applies until the first adaptation and on devices without compute.
            ...perspective({
              fov: Math.PI / 4,
              aspect: 16 / 9,
              exposure: { kind: 'auto', fallback: 0.95, compensationEv: 0, rangeEv: [-12, 4], rates: [3, 1] },
            }),
            // Explicit presentation style; generic Camera defaults remain neutral.
            tonemap: TONEMAP_ACES_FILMIC,
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
      // A slightly warm key light. Parameter defaults must be literals so the
      // editor can rewrite them; entity colors use color.linearRgb(0xRRGGBB).
      default: [1, 0.95, 0.87],
      apply: {
        asset: 'scene/showcase',
        path: ['entities', 'sun', 'components', 'DirectionalLight', 'color'],
      },
    },
    {
      name: 'sunIntensity',
      type: 'f32',
      default: 12,
      minimum: 0,
      maximum: 100,
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
    Fog,
    MeshFilter,
    MeshRenderer,
    Name,
    ReflectionProbe,
    RigidBody,
    Skin,
    Skylight,
    Transform,
  ],
  build: () => ok({ 'scene/showcase': showcaseScene() }),
});
