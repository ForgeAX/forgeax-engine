import { AnimationPlayer } from '@forgeax/engine/animation';
import {
  bindSkeletalMotion,
  skeletalMotionPlugin,
} from '@forgeax/engine/animation/skeletal-motion';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { skeletalMotionRig } from './support/skeletal-motion-world';

export default defineFeature({
  title: 'Spring bone secondary motion',
  catalog: 'Spring bone secondary motion',
  kind: 'visual',
  appOptions: {
    animation: { cadence: 'fixed' },
    time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 },
    plugins: [skeletalMotionPlugin()],
  },
  summary:
    'Cyan is an ordinary three-joint Skin driven by fixed animation plus a saved JSON spring chain. Green shows the same animated base with the spring weight held at zero.',
  expect:
    'ON: cyan bends and trails the animated root under gravity. OFF: both ribbons show the base animation. Length and cone checks read the committed pose.',
  setup({ world, hud }) {
    spawnStage(world, { eye: [0, 2, 8], target: [0, 1, 0] });
    const rigs = [
      skeletalMotionRig(world, -1.4, [0.1, 0.8, 1, 1]),
      skeletalMotionRig(world, 1.4, [0.5, 1, 0.2, 1]),
    ];
    const bindings = rigs.map((rig) => ({
      rig,
      binding: bindSkeletalMotion(
        world,
        rig.player,
        JSON.parse(
          JSON.stringify({
            springs: [
              {
                targets: rig.targets,
                stiffness: 20,
                damping: 5,
                gravity: [4, -9.81, 0],
                radius: 0.03,
                maxAngle: 1.5,
              },
            ],
          }),
        ),
      ).unwrap(),
    }));
    const active = bindings[0],
      reference = bindings[1];
    if (!active || !reference) throw new Error('authored spring pair missing');
    reference.binding.setSpringWeight(0, 0).unwrap();
    hud.status('Cyan: fixed spring overlay · Green: animation base');
    return {
      toggle(on) {
        active.binding.setSpringWeight(0, on ? 1 : 0).unwrap();
      },
      checks() {
        const checks = new CheckList();
        for (const [i, { rig, binding }] of bindings.entries()) {
          checks.equal(`rig ${i} active`, binding.status, 'active');
          checks.ok(`rig ${i} completed fixed steps`, binding.fixedSteps >= 1);
          checks.ok(
            `rig ${i} committed length`,
            binding.springEvidence.every((item) => item.lengthError < 1e-4),
          );
          const time = (world.get(rig.player, AnimationPlayer).unwrap().times[0] as number) % 2;
          const key = Math.min(3, Math.floor(time / 0.5)),
            alpha = (time - key * 0.5) / 0.5;
          const angles = [0, 0.6, 0, -0.6, 0];
          const baseAngle =
            (angles[key] as number) +
            ((angles[key + 1] as number) - (angles[key] as number)) * alpha;
          const root = world.get(rig.joints[0], Transform).unwrap().quat;
          const middle = world.get(rig.joints[1], Transform).unwrap().quat;
          const rootAngle =
            2 *
            Math.acos(
              Math.min(
                1,
                Math.abs(
                  (root[2] as number) * Math.sin(baseAngle / 2) +
                    (root[3] as number) * Math.cos(baseAngle / 2),
                ),
              ),
            );
          const middleAngle = 2 * Math.acos(Math.min(1, Math.abs(middle[3] as number)));
          checks.ok(`rig ${i} committed cone`, Math.max(rootAngle, middleAngle) <= 1.5001);
        }
        return checks.items;
      },
    };
  },
});
