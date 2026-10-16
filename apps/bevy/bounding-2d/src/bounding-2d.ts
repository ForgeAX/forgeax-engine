import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import type { World } from '@forgeax/engine-ecs';
import { box2, circle2, ray2, vec3 } from '@forgeax/engine-math';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

export const BOUNDING_2D_TESTS = [
  'aabb',
  'circle',
  'ray',
  'aabbCast',
  'circleCast',
] as const;

export type Bounding2dTest = (typeof BOUNDING_2D_TESTS)[number];

type Volume = {
  readonly box: box2.Box2;
  readonly circle: circle2.Circle2;
  readonly meshPosition: readonly [number, number];
};

export type Bounding2dState = {
  readonly mode: Bounding2dTest;
  readonly ray: ray2.Ray2;
  readonly targetBox: box2.Box2;
  readonly targetCircle: circle2.Circle2;
  readonly movingBox: box2.Box2;
  readonly movingCircle: circle2.Circle2;
  readonly boxHits: readonly boolean[];
  readonly circleHits: readonly boolean[];
};

const VOLUMES: readonly Volume[] = [
  { box: box2.create(-270, 40, -190, 120), circle: circle2.create(-230, 80, 40), meshPosition: [-230, 80] },
  { box: box2.create(-120, 35, -40, 125), circle: circle2.create(-80, 80, 45), meshPosition: [-80, 80] },
  { box: box2.create(30, 40, 110, 120), circle: circle2.create(70, 80, 40), meshPosition: [70, 80] },
  { box: box2.create(-265, -135, -195, -55), circle: circle2.create(-230, -95, 40), meshPosition: [-230, -95] },
  { box: box2.create(-110, -135, -30, -55), circle: circle2.create(-70, -95, 42), meshPosition: [-70, -95] },
  { box: box2.create(40, -130, 120, -50), circle: circle2.create(80, -90, 40), meshPosition: [80, -90] },
];

const RENDER_COLORS = [
  [0.1, 0.35, 0.6, 1],
  [0.15, 0.45, 0.7, 1],
  [0.2, 0.55, 0.75, 1],
  [0.2, 0.4, 0.65, 1],
  [0.3, 0.5, 0.75, 1],
  [0.25, 0.35, 0.6, 1],
] as const;

const WHITE = [0.95, 0.97, 1, 1] as const;
const YELLOW = [1, 0.8, 0.1, 1] as const;
const AQUA = [0.1, 1, 0.85, 1] as const;
const ORANGE = [1, 0.25, 0.05, 1] as const;
const FUCHSIA = [1, 0.1, 0.75, 1] as const;
const LIME = [0.25, 1, 0.2, 1] as const;

export function buildBounding2dWorld(world: World): void {
  for (let i = 0; i < VOLUMES.length; i++) {
    const volume = VOLUMES[i] as Volume;
    const color = RENDER_COLORS[i] as readonly [number, number, number, number];
    const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
    const [x, y] = volume.meshPosition;
    world.spawn(
      { component: Transform, data: { pos: [x, y, 0], quat: [0, 0, 0, 1], scale: [45, 42, 0.5] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    );
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 400], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -320, right: 320, bottom: -180, top: 180, near: 0.1, far: 1000 }) },
  );
}

export function computeBounding2dState(time: number, mode: Bounding2dTest): Bounding2dState {
  const centerX = Math.cos(time * 0.8) * 170;
  const centerY = Math.sin(time * 0.4) * 55;
  const targetBox = box2.fromCenter(box2.create(), [centerX, centerY], [48, 48]);
  const targetCircle = circle2.create(centerX, centerY, 48);
  const movingBox = box2.fromCenter(box2.create(), [0, 0], [15, 15]);
  const movingCircle = circle2.create(0, 0, 15);
  const angle = time;
  const direction: [number, number] = [-Math.cos(angle), -Math.sin(angle)];
  const origin: [number, number] = [Math.cos(angle) * 280, Math.sin(angle) * 280];
  const ray = ray2.create(undefined, origin, direction, 620);
  const boxHits: boolean[] = [];
  const circleHits: boolean[] = [];
  for (const volume of VOLUMES) {
    const boxResult =
      mode === 'aabb'
        ? { hit: box2.intersectsBox(targetBox, volume.box) }
        : mode === 'aabbCast'
          ? ray2.aabbCastIntersects(ray, movingBox, volume.box)
          : ray2.rayAabbIntersects(ray, volume.box);
    const circleResult =
      mode === 'circle'
        ? { hit: circle2.intersectsCircle(targetCircle, volume.circle) }
        : mode === 'circleCast'
          ? ray2.circleCastIntersects(ray, movingCircle, volume.circle)
          : ray2.rayCircleIntersects(ray, volume.circle);
    boxHits.push(boxResult.hit);
    circleHits.push(circleResult.hit);
  }
  return { mode, ray, targetBox, targetCircle, movingBox, movingCircle, boxHits, circleHits };
}

function drawBox(debugDraw: DebugDraw, box: box2.Box2Like, color: readonly [number, number, number, number]): void {
  const min = vec3.create(box[0] as number, box[1] as number, 2);
  const max = vec3.create(box[2] as number, box[3] as number, 2);
  debugDraw.aabb(min, max, color);
}

function drawCircle(debugDraw: DebugDraw, circle: circle2.Circle2Like, color: readonly [number, number, number, number]): void {
  debugDraw.sphere(vec3.create(circle[0] as number, circle[1] as number, 2), circle[2] as number, color, 24);
}

function drawRay(debugDraw: DebugDraw, ray: ray2.Ray2Like): void {
  const origin = vec3.create(ray[0] as number, ray[1] as number, 2);
  const end = vec3.create(
    (ray[0] as number) + (ray[2] as number) * (ray[4] as number),
    (ray[1] as number) + (ray[3] as number) * (ray[4] as number),
    2,
  );
  debugDraw.arrow(origin, end, WHITE, 10);
  debugDraw.sphere(origin, 5, FUCHSIA, 12);
}

export function drawBounding2d(debugDraw: DebugDraw, state: Bounding2dState): void {
  for (let i = 0; i < VOLUMES.length; i++) {
    const volume = VOLUMES[i] as Volume;
    const color = state.boxHits[i] || state.circleHits[i] ? AQUA : ORANGE;
    if (i % 2 === 0) drawBox(debugDraw, volume.box, color);
    else drawCircle(debugDraw, volume.circle, color);
  }

  if (state.mode === 'circle' || state.mode === 'circleCast') drawCircle(debugDraw, state.targetCircle, YELLOW);
  else drawBox(debugDraw, state.targetBox, YELLOW);

  if (state.mode === 'ray' || state.mode === 'aabbCast' || state.mode === 'circleCast') {
    drawRay(debugDraw, state.ray);
  }
  if (state.mode === 'aabbCast') drawBox(debugDraw, state.movingBox, LIME);
  if (state.mode === 'circleCast') drawCircle(debugDraw, state.movingCircle, LIME);
}

export function volumeCount(): number {
  return VOLUMES.length;
}
