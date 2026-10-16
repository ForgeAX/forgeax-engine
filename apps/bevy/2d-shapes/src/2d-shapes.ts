import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { create2dGeometry, create2dRingGeometry, type Shape2d } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';

const X_EXTENT = 1000;
const Y_EXTENT = 150;
const RING_THICKNESS = 5;

const FILLED_SHAPES: readonly Shape2d[] = [
  { kind: 'circle', radius: 50 },
  { kind: 'circular-sector', radius: 50, angle: 1 },
  { kind: 'circular-segment', radius: 50, angle: 1.25 },
  { kind: 'ellipse', halfWidth: 25, halfHeight: 50 },
  { kind: 'annulus', innerRadius: 25, outerRadius: 50 },
  { kind: 'capsule', radius: 25, halfLength: 50 },
  { kind: 'rhombus', halfWidth: 75, halfHeight: 100 },
  { kind: 'rectangle', width: 50, height: 100 },
  { kind: 'regular-polygon', radius: 50, sides: 6 },
  { kind: 'triangle', vertices: [[0, 50], [-50, -50], [50, -50]] },
  { kind: 'segment', vertices: [[-50, 50], [50, -50]] },
  { kind: 'polyline', vertices: [[-50, 50], [0, -50], [50, 50]] },
];

const RING_SHAPES: readonly Shape2d[] = [
  { kind: 'circle', radius: 50 },
  { kind: 'circular-sector', radius: 50, angle: 1 },
  { kind: 'circular-segment', radius: 50, angle: 1.25 },
  { kind: 'ellipse', halfWidth: 25, halfHeight: 50 },
  { kind: 'annulus', innerRadius: 25, outerRadius: 50 },
  { kind: 'capsule', radius: 25, halfLength: 50 },
  { kind: 'rhombus', halfWidth: 75, halfHeight: 100 },
  { kind: 'rectangle', width: 50, height: 100 },
  { kind: 'regular-polygon', radius: 50, sides: 6 },
  { kind: 'triangle', vertices: [[0, 50], [-50, -50], [50, -50]] },
];

const COLORS: readonly (readonly [number, number, number, number])[] = [
  [1, 0.34, 0.34, 1],
  [1, 0.67, 0.2, 1],
  [0.9, 0.9, 0.2, 1],
  [0.35, 0.9, 0.35, 1],
  [0.2, 0.9, 0.85, 1],
  [0.2, 0.55, 1, 1],
  [0.45, 0.35, 1, 1],
  [0.8, 0.3, 1, 1],
  [1, 0.3, 0.72, 1],
  [1, 0.5, 0.5, 1],
  [0.7, 0.8, 1, 1],
  [0.8, 0.95, 0.5, 1],
];

export const Shape2dMotion = defineComponent('Bevy2dShapesMotion', {
  phase: { type: 'f32', default: 0 },
});

export interface Shapes2dScene {
  readonly handles: readonly EntityHandle[];
}

function meshResult(result: ReturnType<typeof create2dGeometry>, label: string): MeshAsset {
  if (result.ok) return result.value;
  const detail = result.error.detail ? ` (${JSON.stringify(result.error.detail)})` : '';
  throw new Error(`[bevy-2d-shapes] ${label} failed: ${result.error.code}${detail}`);
}

function spawnMesh(
  world: World,
  mesh: MeshAsset,
  position: readonly [number, number, number],
  color: readonly [number, number, number, number],
): EntityHandle {
  const asset = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  return world.spawn(
    { component: Transform, data: { pos: position, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: asset } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: Shape2dMotion, data: {} },
  ).unwrap();
}

export function build2dShapesWorld(world: World): Shapes2dScene {
  const handles: EntityHandle[] = [];
  for (let i = 0; i < FILLED_SHAPES.length; i++) {
    const shape = FILLED_SHAPES[i]!;
    const mesh = meshResult(create2dGeometry(shape), `filled ${shape.kind}`);
    const x = -X_EXTENT / 2 + (i / (FILLED_SHAPES.length - 1)) * X_EXTENT;
    handles.push(spawnMesh(world, mesh, [x, Y_EXTENT / 2, 1], COLORS[i]!));
  }

  const ringCount = RING_SHAPES.length + 2;
  for (let i = 0; i < RING_SHAPES.length; i++) {
    const shape = RING_SHAPES[i]!;
    const mesh = shape.kind === 'annulus'
      ? meshResult(create2dGeometry(shape), `annulus ring`)
      : meshResult(create2dRingGeometry(shape, RING_THICKNESS), `${shape.kind} ring`);
    const x = -X_EXTENT / 2 + (i / (ringCount - 1)) * X_EXTENT;
    handles.push(spawnMesh(world, mesh, [x, -Y_EXTENT / 2, 1], COLORS[i]!));
  }

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 999.9], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -600, right: 600, bottom: -220, top: 220, near: 0.1, far: 2000 }) },
  ).unwrap();
  return { handles };
}

export function step2dShapes(world: World, scene: Shapes2dScene, deltaSeconds: number): void {
  for (const handle of scene.handles) {
    const motion = world.get(handle, Shape2dMotion);
    if (!motion.ok) continue;
    const phase = motion.value.phase + deltaSeconds;
    world.set(handle, Shape2dMotion, { phase });
    world.set(handle, Transform, {
      quat: quat.fromAxisAngle(quat.create(), [0, 0, 1], phase * 0.5),
    });
  }
}
