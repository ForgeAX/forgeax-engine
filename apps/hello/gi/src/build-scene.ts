import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  buildMeshCardLayout,
  buildVisibilityDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
} from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
import type { GiCamera, GiLight, GiMaterialName, ProceduralGiScene, Vec3 } from './scenes.ts';

type Entity = EntityHandle;
type MaterialHandle = Handle<'MaterialAsset', 'shared'>;

export interface GiSceneControls {
  readonly camera: Entity;
  readonly light: Entity;
  /** Light on/off and moved/home are independent toggles. */
  setLight(on: boolean, moved?: boolean): void;
  setEmissive(on: boolean): void;
  /**
   * Moves the camera. `cut` also bumps `Camera.historyVersion`, the engine's explicit
   * cut signal; without it the write is continuous motion and history reprojects.
   */
  setCamera(pose: GiCamera, cut?: boolean): void;
}

export function cameraTransform(pose: GiCamera) {
  return {
    pos: [...pose.origin] as [number, number, number],
    quat: quat.fromLookAt(
      quat.create(),
      pose.origin as [number, number, number],
      pose.target as [number, number, number],
      pose.up as [number, number, number],
    ),
  };
}

/** Linear interpolation between two poses for the deterministic camera path. */
export function cameraOnPath(a: GiCamera, b: GiCamera, t: number): GiCamera {
  const mix = (p: Vec3, q: Vec3): Vec3 => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
  ];
  return {
    origin: mix(a.origin, b.origin),
    target: mix(a.target, b.target),
    up: a.up,
    verticalFov: a.verticalFov + (b.verticalFov - a.verticalFov) * t,
  };
}

/** Column-major instance transform matching the unit (2 m) box mesh, shared with the reference. */
export function boxMatrix(center: Vec3, half: Vec3, yaw = 0): number[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const [x, y, z] = half;
  return [c * x, 0, -s * x, 0, 0, y, 0, 0, s * z, 0, c * z, 0, center[0], center[1], center[2], 1];
}

export function spawnLight(world: World, light: GiLight): Entity {
  if (light.kind === 'point')
    return world
      .spawn(
        { component: Transform, data: { pos: [...light.position] } },
        {
          component: PointLight,
          data: { color: [...light.color], intensity: light.intensity, range: light.range },
        },
        { component: PointLightShadow, data: { mapSize: 512, farPlane: light.range } },
      )
      .unwrap();
  return world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [...light.direction],
        color: [...light.color],
        intensity: light.intensity,
        castShadow: true,
        mapSize: 1024,
        cascadeCount: 4,
        shadowDistance: 40,
      },
    })
    .unwrap();
}

export function setLightState(
  world: World,
  entity: Entity,
  light: GiLight,
  on: boolean,
  moved: boolean,
) {
  const intensity = on ? light.intensity : 0;
  if (light.kind === 'point') {
    world.set(entity, PointLight, { intensity }).unwrap();
    world.set(entity, Transform, { pos: [...(moved ? light.moved : light.position)] }).unwrap();
    return;
  }
  world
    .set(entity, DirectionalLight, {
      intensity,
      direction: [...(moved ? light.moved : light.direction)],
    })
    .unwrap();
}

export function setCameraPose(world: World, camera: Entity, pose: GiCamera, cut: boolean): void {
  world.set(camera, Transform, cameraTransform(pose)).unwrap();
  if (!cut) return;
  const historyVersion = world.get(camera, Camera).unwrap().historyVersion + 1;
  world.set(camera, Camera, { historyVersion }).unwrap();
}

export function spawnCamera(world: World, pose: GiCamera, aspect: number): Entity {
  return world
    .spawn(
      { component: Transform, data: cameraTransform(pose) },
      {
        component: Camera,
        data: {
          fov: pose.verticalFov,
          aspect,
          near: 0.05,
          far: 120,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
          exposure: 1,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
}

/** The unit (2 m) box the procedural scenes draw, with its traced representations. */
export async function createGiBoxMesh(): Promise<MeshAsset> {
  return withTracedRepresentations(createBoxGeometry(2, 2, 2).unwrap(), 0.25);
}

/**
 * Attach the mesh distance field and Card layout the irradiance-field and
 * screen-probe lanes trace to a closed, single-sided indexed mesh; the exact
 * lane ignores both.
 */
export async function withTracedRepresentations(
  mesh: MeshAsset,
  voxelSize: number,
): Promise<MeshAsset> {
  const positions = mesh.attributes.position as Float32Array;
  const indices = mesh.indices;
  if (indices === undefined) throw new Error('hello-gi: indexed geometry required');
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize,
      triangleSidedness: new Uint8Array(indices.length / 3),
    })
  ).unwrap();
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  );
  return {
    ...mesh,
    cardLayout: (await buildMeshCardLayout(positions, indices)).unwrap(),
    distanceField: {
      ...field,
      sectionSidedness: mesh.submeshes.map(() => 0),
      artifact: {
        integrity: {
          algorithm: 'sha256',
          digest: `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`,
        },
        assetCodec: { ...MESH_VISIBILITY_DISTANCE_FIELD_CODEC },
      },
    },
  };
}

/** Spawns a procedural scene; materials come from the caller's cooked publications. */
export function spawnProceduralScene(
  world: World,
  scene: ProceduralGiScene,
  materials: (name: GiMaterialName) => MaterialHandle,
  aspect: number,
  boxMesh: MeshAsset,
): GiSceneControls {
  const mesh = world.allocSharedRef('MeshAsset', boxMesh);
  const panels: Entity[] = [];
  for (const box of scene.boxes) {
    const entity = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [...box.center],
            quat: quat.fromAxisAngle(quat.create(), [0, 1, 0], box.yaw ?? 0),
            scale: [...box.half],
          },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [materials(box.material)] } },
      )
      .unwrap();
    if (box.emissive) panels.push(entity);
  }
  const light = spawnLight(world, scene.light);
  const camera = spawnCamera(world, scene.camera, aspect);
  let lightOn = true;
  return {
    camera,
    light,
    setLight(on, moved = false) {
      lightOn = on;
      setLightState(world, light, scene.light, lightOn, moved);
    },
    setEmissive(on) {
      for (const panel of panels)
        world
          .set(panel, MeshRenderer, { materials: [materials(on ? 'panel' : 'panel-off')] })
          .unwrap();
    },
    setCamera(pose, cut = false) {
      setCameraPose(world, camera, pose, cut);
    },
  };
}
