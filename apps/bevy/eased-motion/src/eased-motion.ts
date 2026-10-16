import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
  defineAnimationGraph,
  deriveAnimationTargetId,
} from '@forgeax/engine-animation';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import type { AnimationTransformChannel, AnimationClip, AnimationTargetIdValue, MaterialAsset } from '@forgeax/engine-types';
import { easing, quat } from '@forgeax/engine-math';

const START_X = -6;
const END_X = 6;
const TRANSLATION_DURATION = 3;
const CLIP_DURATION = 6;
const ROTATION_DURATION = 4;
const SAMPLE_COUNT = 24;
const CUBE_ID: AnimationTargetIdValue = deriveAnimationTargetId(['Cube']);
export const EASED_MOTION_CLIP_GUID = 'demo/eased-motion/clip';

const channel = (
  targetId: AnimationTargetIdValue,
  property: AnimationTransformChannel['property'],
  input: number[],
  output: number[],
): AnimationTransformChannel => ({
  targetId,
  property,
  sampler: { input: new Float32Array(input), output: new Float32Array(output), interpolation: 'LINEAR' },
});

function easedTranslation(t: number): [number, number, number] {
  const phase = t <= TRANSLATION_DURATION ? t / TRANSLATION_DURATION : (CLIP_DURATION - t) / TRANSLATION_DURATION;
  return [START_X + (END_X - START_X) * easing.cubicInOut(phase), 2, 0];
}

function easedRotation(t: number): [number, number, number, number] {
  const phase = Math.min(t / ROTATION_DURATION, 1);
  return Array.from(quat.fromAxisAngle(quat.create(), [0, 1, 0], (Math.PI / 2) * easing.elasticInOut(phase))) as [
    number,
    number,
    number,
    number,
  ];
}

function sampledCurve(sampleTimes: number[], sample: (t: number) => number[]): number[] {
  return sampleTimes.flatMap(sample);
}

export interface EasedMotionState {
  readonly cube: EntityHandle;
}

export function createEasedMotionClip(): AnimationClip {
  const times = Array.from({ length: SAMPLE_COUNT + 1 }, (_, i) => (CLIP_DURATION * i) / SAMPLE_COUNT);
  return {
    kind: 'animation-clip',
    duration: CLIP_DURATION,
    channels: [
      channel(CUBE_ID, 'translation', times, sampledCurve(times, (t) => easedTranslation(t))),
      channel(
        CUBE_ID,
        'rotation',
        [0, ROTATION_DURATION, CLIP_DURATION],
        sampledCurve([0, ROTATION_DURATION, CLIP_DURATION], (t) => easedRotation(t)),
      ),
    ],
  };
}

export function buildEasedMotionWorld(
  world: World,
  clip: AnimationClip = createEasedMotionClip(),
): EasedMotionState {
  const cubeMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 0.35, 0.08, 1] }),
  );
  const cube = world
    .spawn(
      { component: Transform, data: { pos: [START_X, 2, 0], scale: [1, 1, 1] } },
      { component: Name, data: { value: 'Cube' } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMaterial] } },
      { component: AnimationTargetId, data: { value: CUBE_ID } },
    )
    .unwrap() as EntityHandle;

  world.internSharedRef('AnimationClip', clip);
  const graphResult = defineAnimationGraph((builder) => builder.clip(EASED_MOTION_CLIP_GUID));
  if (!graphResult.ok) throw new Error(`[eased-motion] graph build failed: ${graphResult.error.code}`);
  const graphHandle = world.allocSharedRef('AnimationGraph', graphResult.value);
  world
    .addComponent(cube, {
      component: AnimationPlayer,
      data: { graph: graphHandle, nodeSpeeds: [1], looping: true },
    })
    .unwrap();
  const bound = bindAnimationTargets(world, cube, [cube]);
  if (!bound.ok) throw new Error(`[eased-motion] bind failed: ${bound.error.code}`);

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.8, -0.5], color: [1, 1, 1], intensity: 3, castShadow: false },
  });
  const eye: [number, number, number] = [0, 5, 16];
  world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 1.5, 0], [0, 1, 0]) },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }) },
  );
  return { cube };
}

export function readEasedMotionState(world: World, state: EasedMotionState) {
  const transform = world.get(state.cube, Transform).unwrap();
  return { pos: new Float32Array(transform.pos), quat: new Float32Array(transform.quat) };
}
