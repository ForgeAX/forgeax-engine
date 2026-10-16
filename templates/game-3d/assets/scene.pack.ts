import { quat } from '@forgeax/engine/math';
import { definePack } from '@forgeax/engine/pack/source';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import {
  ANTIALIAS_FXAA,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import type { AssetGuid, SceneAsset, SceneEntity } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS, SUN_OUTGOING_DIRECTION } from './shared/asset-refs.ts';
import { PLAYER_RIG } from './player/player-rig.ts';

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

function staticSphere(radius: number) {
  return {
    RigidBody: { type: RigidBodyTypeValue.static },
    Collider: {
      shape: ColliderShapeValue.sphere,
      radius,
      friction: 0.8,
      restitution: 0,
    },
  };
}

function showcaseScene(): SceneAsset {
  const playerPosition = [0, 0.95, 7.4] as const;
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
        'pedestal',
        'Warm Stone Pedestal',
        assetGuid(PACKAGE_IDS.geometry, 'mesh/pedestal'),
        [-4, 0.5, 1],
        [1, 1, 1],
        [0, 0, 0, 1],
        staticCuboid([0.75, 0.5, 0.75]),
      ),
      meshEntity(
        'mirror-sphere',
        'Mirror Sphere',
        assetGuid(PACKAGE_IDS.geometry, 'mesh/sphere'),
        [-4, 1.75, 1],
        [1, 1, 1],
        [0, 0, 0, 1],
        staticSphere(0.9),
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
        'mirror-torus',
        'Mirror Torus',
        assetGuid(PACKAGE_IDS.geometry, 'mesh/torus'),
        [4, 1.2, 1],
        [1, 1, 1],
        [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)],
        staticSphere(1.12),
      ),
      meshEntity('point-light-marker', 'Warm Point Light Marker', assetGuid(PACKAGE_IDS.geometry, 'mesh/light'), [0, 4.6, 0]),
      meshEntity(
        'step',
        'Sandstone Step',
        assetGuid(PACKAGE_IDS.geometry, 'mesh/step'),
        [5.3, 0.225, 6],
        [1, 1, 1],
        [0, 0, 0, 1],
        staticCuboid([1.2, 0.225, 1.2]),
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
      meshEntity(
        'klein-bottle',
        'Klein Bottle',
        assetGuid(PACKAGE_IDS.fantasyMeshes, 'mesh/klein-bottle'),
        [-4.4, 2.15, -4.2],
        [0.72, 0.72, 0.72],
        [0, 0, 0, 1],
        staticSphere(1.55),
      ),
      meshEntity(
        'trefoil-knot',
        'Trefoil Knot',
        assetGuid(PACKAGE_IDS.fantasyMeshes, 'mesh/trefoil-knot'),
        [4.4, 2.05, -4],
        [1.02, 1.02, 1.02],
        [Math.sin(-Math.PI / 12), 0, 0, Math.cos(-Math.PI / 12)],
        staticSphere(1.5),
      ),
      meshEntity(
        'astral-bloom',
        'Astral Bloom',
        assetGuid(PACKAGE_IDS.fantasyMeshes, 'mesh/astral-bloom'),
        [0, 2.05, -0.9],
        [1.08, 1.08, 1.08],
        [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)],
        staticSphere(1.45),
      ),
      keyed('sun', {
        components: {
          Name: { value: 'Sun' },
          DirectionalLight: {
            direction: SUN_OUTGOING_DIRECTION,
            color: [1, 0.98, 0.93],
            intensity: 3.2,
            castShadow: true,
            cascadeCount: 3,
            splitLambda: 0.72,
            cascadeBlend: 0.18,
            mapSize: 1024,
            depthBias: 0.005,
            normalBias: 0.06,
            shadowDistance: 56,
          },
        },
      }),
      keyed('point-light', {
        components: {
          Name: { value: 'Warm Point Light' },
          Transform: { pos: [0, 4.6, 0] },
          PointLight: { color: [1, 0.32, 0.08], intensity: 52, range: 12 },
        },
      }),
      keyed('skylight', {
        components: {
          Name: { value: 'Skylight' },
          Skylight: {
            equirect: guidText(assetGuid(PACKAGE_IDS.environment, 'environment/daylight')),
            color: [1, 1, 1],
            intensity: 0.82,
          },
        },
      }),
      keyed('sky-background', {
        components: {
          Name: { value: 'Sky Background' },
          SkyboxBackground: {
            equirect: guidText(assetGuid(PACKAGE_IDS.environment, 'environment/daylight')),
            mode: SKYBOX_MODE_CUBEMAP,
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
            ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 120 }),
            tonemap: TONEMAP_ACES_FILMIC,
            exposure: 0.92,
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
            radius: 0.38,
            halfHeight: 0.55,
            friction: 0.7,
            restitution: 0,
          },
          CharacterController: {
            offset: 0.03,
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
  packageId: PACKAGE_IDS.scene,
  name: 'Game 3D / Scene',
  sceneComponents: [
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
    SkyboxBackground,
    Skylight,
    Transform,
  ],
  build: () => ok({ 'scene/showcase': showcaseScene() }),
});
