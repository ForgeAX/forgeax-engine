import { AudioListener, listenerPoseFromWorldMatrix } from '@forgeax/engine/audio';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { createIntentWorld } from './support/intents';

export default defineFeature({
  title: 'AudioListener',
  catalog: 'AudioListener',
  kind: 'headless',
  summary:
    'AudioListener is a marker component. After transform propagation, audioPlugin converts the first listener GlobalTransform into a set-listener-pose intent (position, forward = -Z, up = +Y).',
  expect:
    'All checks pass: a listener at (3, 1, -2) produces a pose with that position and forward (0, 0, -1), moving it updates the pose, and only one pose is emitted per frame even with two listeners.',
  async run(checks) {
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    const pure = listenerPoseFromWorldMatrix(identity);
    checks.equal(
      'pure pose from an identity matrix',
      [pure.positionX, pure.positionY, pure.positionZ, pure.forwardZ, pure.upY],
      [5, 6, 7, -1, 1],
    );

    const lab = await createIntentWorld();
    const { world } = lab;
    const listener = world
      .spawn(
        { component: Transform, data: { pos: [3, 1, -2] } },
        { component: AudioListener, data: {} },
      )
      .unwrap();
    const poses = lab.step().filter((intent) => intent.kind === 'set-listener-pose');
    const pose = poses[0]?.kind === 'set-listener-pose' ? poses[0].pose : undefined;
    checks.equal(
      'listener pose follows GlobalTransform',
      pose === undefined
        ? null
        : [
            pose.positionX,
            pose.positionY,
            pose.positionZ,
            pose.forwardX,
            pose.forwardY,
            pose.forwardZ,
          ],
      [3, 1, -2, -0, -0, -1],
    );
    world.set(listener, Transform, { pos: [0, 0, 10] }).unwrap();
    const moved = lab.step().find((intent) => intent.kind === 'set-listener-pose');
    checks.ok(
      'moving the listener updates the pose',
      moved?.kind === 'set-listener-pose' && moved.pose.positionZ === 10,
    );
    world
      .spawn(
        { component: Transform, data: { pos: [9, 9, 9] } },
        { component: AudioListener, data: {} },
      )
      .unwrap();
    const both = lab.step().filter((intent) => intent.kind === 'set-listener-pose');
    checks.equal('only the first listener is synced per frame', both.length, 1);
    await lab.dispose();
  },
});
