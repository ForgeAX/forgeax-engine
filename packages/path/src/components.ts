import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';

export const PathParameterization = { uniform: 0, centripetal: 1, chordal: 2 } as const;
export const PathAxis = {
  positiveX: 0,
  negativeX: 1,
  positiveY: 2,
  negativeY: 3,
  positiveZ: 4,
  negativeZ: 5,
} as const;
export const PathMotion = { scene: 0, desired: 1 } as const;

/** Authored through an ordinary SceneAsset; points are local XYZ triples. */
export const Path = defineComponent(
  'Path',
  {
    points: { type: 'array<f32>', default: new Float32Array(0) },
    closed: { type: 'bool', default: false },
    parameterization: {
      type: 'enum',
      default: PathParameterization.centripetal,
      labels: PathParameterization,
    },
    subdivisions: { type: 'u32', default: 2048 },
    up: { type: 'array<f32, 3>', default: new Float32Array([0, 1, 0]) },
  },
  { requires: [Transform] },
);
export type PathDefinition = ShapeOf<SchemaOf<typeof Path>>;

/** Distance and signed speed are world units and world units/second. */
export const PathFollower = defineComponent(
  'PathFollower',
  {
    path: 'entity',
    distance: { type: 'f64', default: 0 },
    speed: { type: 'f64', default: 1 },
    paused: { type: 'bool', default: false },
    loop: { type: 'bool', default: false },
    followTangent: { type: 'bool', default: true },
    forwardAxis: { type: 'enum', default: PathAxis.positiveZ, labels: PathAxis },
    upAxis: { type: 'enum', default: PathAxis.positiveY, labels: PathAxis },
    roll: { type: 'f64', default: 0 },
    motion: { type: 'enum', default: PathMotion.scene, labels: PathMotion },
  },
  { requires: [Transform] },
);

/** World-space desired pose; a motor owns actual movement. Never writes Transform. */
export const DesiredPathPose = defineComponent(
  'DesiredPathPose',
  {
    position: { type: 'array<f32, 3>', default: new Float32Array(3) },
    rotation: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
    valid: { type: 'bool', default: false },
  },
  { transient: true },
);
