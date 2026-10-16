import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  Camera,
  Fog,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
} from '@forgeax/engine-render';
import { quat } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import fogSceneJson from './fog-scene.json';

type Vec3 = readonly [number, number, number];
type Color4 = readonly [number, number, number, number];
type FogParameters = {
  readonly color: Vec3;
  readonly density: number;
  readonly heightFalloff: number;
  readonly maxOpacity: number;
};
type FogScene = {
  readonly fogColor: Vec3;
  readonly fog: {
    readonly uniform: FogParameters;
    readonly change: FogParameters;
    readonly height: FogParameters;
  };
  readonly camera: {
    readonly position: Vec3;
    readonly target: Vec3;
    readonly fovDegrees: number;
    readonly near: number;
    readonly far: number;
  };
  readonly lighting: {
    readonly position: Vec3;
    readonly color: Vec3;
    readonly intensity: number;
    readonly range: number;
  };
  readonly materials: {
    readonly ground: Color4;
    readonly tick: Color4;
    readonly gate: Color4;
    readonly marker: Color4;
    readonly structure: Color4;
  };
  readonly geometry: {
    readonly ground: { readonly position: Vec3; readonly scale: Vec3 };
    readonly ticks: {
      readonly start: number;
      readonly end: number;
      readonly step: number;
      readonly positionY: number;
      readonly scale: Vec3;
    };
    readonly sidePosts: { readonly x: readonly number[]; readonly positionY: number; readonly scale: Vec3 };
    readonly gates: {
      readonly depths: readonly number[];
      readonly sideX: readonly number[];
      readonly sidePositionY: number;
      readonly sideScale: Vec3;
      readonly topPositionY: number;
      readonly topScale: Vec3;
    };
    readonly markers: {
      readonly depth: number;
      readonly sphereScale: Vec3;
      readonly low: { readonly x: number; readonly sphereY: number; readonly baseY: number; readonly baseScale: Vec3 };
      readonly high: { readonly x: number; readonly sphereY: number; readonly baseY: number; readonly baseScale: Vec3 };
    };
    readonly endWall: { readonly position: Vec3; readonly scale: Vec3 };
  };
};

const fogScene = fogSceneJson as unknown as FogScene;

export type FogDemoPhase = 'disabled' | 'uniform' | 'height';

export type FogPhase =
  | 'disabled'
  | 'uniform'
  | 'change'
  | 'height'
  | 'owner-switch'
  | 'camera-switch'
  | 'detach-reattach'
  | 'resize'
  | 'recovery';

export interface FogPhaseResult {
  readonly changedFrom: FogPhase | undefined;
  readonly revision: number;
  readonly ownerChanged: boolean;
}

export interface FogWorldController {
  applyPhase(phase: FogPhase, resourceWorld?: World): FogPhaseResult;
  setPhase(phase: FogDemoPhase): FogPhaseResult;
  currentPhase(): FogPhase;
  resize(aspect: number): void;
}

const fogColor = fogScene.fogColor;
const fogParameters = fogScene.fog;

export function buildFogWorld(world: World, aspect = 16 / 9): FogWorldController {
  let fogWorld = world;
  let activeFogData: (typeof fogParameters)[keyof typeof fogParameters] | undefined =
    fogParameters.height;
  let fogEntity: EntityHandle | undefined = world.spawn({
    component: Fog,
    data: fogParameters.height,
  }).unwrap();
  let revision = 1;
  let previousPhase: FogPhase = 'height';

  const attachFog = (data: (typeof fogParameters)[keyof typeof fogParameters]): void => {
    fogEntity = fogWorld.spawn({
      component: Fog,
      data,
    }).unwrap();
    revision += 1;
  };
  const updateFog = (data: (typeof fogParameters)[keyof typeof fogParameters]): void => {
    activeFogData = data;
    if (fogEntity === undefined) {
      attachFog(data);
      return;
    }
    fogWorld.set(fogEntity, Fog, data).unwrap();
    revision += 1;
  };
  const detachFog = (): void => {
    if (fogEntity === undefined) return;
    fogWorld.despawn(fogEntity).unwrap();
    fogEntity = undefined;
    revision += 1;
  };
  const switchResourceWorld = (next: World): boolean => {
    if (next === fogWorld) return false;
    if (fogEntity !== undefined) {
      fogWorld.despawn(fogEntity).unwrap();
      fogEntity = undefined;
    }
    fogWorld = next;
    if (activeFogData !== undefined) {
      fogEntity = fogWorld.spawn({
        component: Fog,
        data: activeFogData,
      }).unwrap();
    }
    revision += 1;
    return true;
  };

  const ground = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: fogScene.materials.ground, roughness: 0.92 }),
  );
  const tick = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: fogScene.materials.tick, roughness: 0.88 }),
  );
  const gate = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: fogScene.materials.gate, roughness: 0.72 }),
  );
  const marker = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: fogScene.materials.marker, metallic: 0.1, roughness: 0.28 }),
  );
  const structure = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: fogScene.materials.structure, roughness: 0.86 }),
  );
  const cubeMesh = world.internSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
  const sphereMesh = world.internSharedRef('MeshAsset', createSphereGeometry(1).unwrap());

  world.spawn(
    { component: Transform, data: { pos: fogScene.lighting.position } },
    {
      component: PointLight,
      data: {
        color: fogScene.lighting.color,
        intensity: fogScene.lighting.intensity,
        range: fogScene.lighting.range,
      },
    },
  ).unwrap();

  const spawnCube = (
    pos: readonly [number, number, number],
    scale: readonly [number, number, number],
    material: typeof ground,
  ): void => {
    world.spawn(
      { component: Transform, data: { pos, scale } },
      { component: MeshFilter, data: { assetHandle: cubeMesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
  };
  const spawnSphere = (
    pos: readonly [number, number, number],
    scale: readonly [number, number, number],
  ): void => {
    world.spawn(
      { component: Transform, data: { pos, scale } },
      { component: MeshFilter, data: { assetHandle: sphereMesh } },
      { component: MeshRenderer, data: { materials: [marker] } },
    ).unwrap();
  };

  // A fixed runway makes distance the only changing variable between gates.
  const { ground: groundGeometry, ticks, sidePosts, gates, markers, endWall } = fogScene.geometry;
  spawnCube(groundGeometry.position, groundGeometry.scale, ground);
  for (let z = ticks.start; z >= ticks.end; z += ticks.step) {
    spawnCube([0, ticks.positionY, z], ticks.scale, tick);
    for (const x of sidePosts.x) {
      spawnCube([x, sidePosts.positionY, z], sidePosts.scale, structure);
    }
  }

  for (const z of gates.depths) {
    for (const x of gates.sideX) {
      spawnCube([x, gates.sidePositionY, z], gates.sideScale, gate);
    }
    spawnCube([0, gates.topPositionY, z], gates.topScale, gate);
  }

  // Both spheres share a material and size; only their height changes.
  // Keep the equal-distance markers outside the gate opening in screen space;
  // the shared material/size remains the only variable between the two.
  spawnCube([markers.low.x, markers.low.baseY, markers.depth], markers.low.baseScale, structure);
  spawnSphere([markers.low.x, markers.low.sphereY, markers.depth], markers.sphereScale);
  spawnCube([markers.high.x, markers.high.baseY, markers.depth], markers.high.baseScale, structure);
  spawnSphere([markers.high.x, markers.high.sphereY, markers.depth], markers.sphereScale);
  spawnCube(endWall.position, endWall.scale, structure);

  const cameraPosition = fogScene.camera.position;
  const cameraTarget = fogScene.camera.target;
  const camera = world.spawn(
    {
      component: Transform,
      data: { pos: cameraPosition, quat: quat.fromLookAt(quat.create(), cameraPosition, cameraTarget, [0, 1, 0]) },
    },
    {
      component: Camera,
      data: {
        ...perspective({
          fov: (fogScene.camera.fovDegrees * Math.PI) / 180,
          aspect,
          near: fogScene.camera.near,
          far: fogScene.camera.far,
        }),
        clearColor: [...fogColor, 1],
      },
    },
  ).unwrap();

  return {
    applyPhase(phase, resourceWorld): FogPhaseResult {
      if (phase === previousPhase) return { changedFrom: undefined, revision, ownerChanged: false };
      const changedFrom = previousPhase;
      previousPhase = phase;
      let ownerChanged = false;
      switch (phase) {
        case 'disabled':
          activeFogData = undefined;
          detachFog();
          break;
        case 'uniform':
          updateFog(fogParameters.uniform);
          break;
        case 'change':
          updateFog(fogParameters.change);
          break;
        case 'height':
          updateFog(fogParameters.height);
          break;
        case 'detach-reattach':
          activeFogData = fogParameters.height;
          detachFog();
          attachFog(fogParameters.height);
          break;
        case 'camera-switch':
          world.set(camera, Transform, { pos: [7, 7, 1] }).unwrap();
          revision += 1;
          break;
        case 'owner-switch':
          ownerChanged = resourceWorld === undefined ? false : switchResourceWorld(resourceWorld);
          if (!ownerChanged) revision += 1;
          break;
        case 'resize':
        case 'recovery':
          revision += 1;
          break;
      }
      return { changedFrom, revision, ownerChanged };
    },
    setPhase(phase): FogPhaseResult {
      return this.applyPhase(phase);
    },
    currentPhase(): FogPhase {
      return previousPhase;
    },
    resize(nextAspect): void {
      world.set(camera, Camera, { aspect: nextAspect }).unwrap();
    },
  };
}
