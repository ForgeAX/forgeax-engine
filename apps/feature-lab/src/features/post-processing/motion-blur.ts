import { defineComponent, defineSystem, Time, Update } from '@forgeax/engine/ecs';
import { ANTIALIAS_TAA, MotionBlur } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, unlit } from '../../lab/stage';

const BLUR = { shutterAngle: 360, maxRadiusPixels: 48, sampleCount: 16, targetFps: 60 } as const;
const Spin = defineComponent('FeatureLabMotionBlurSpin', { speed: { type: 'f32', default: 6 } });

export default defineFeature({
  title: 'Motion Blur',
  catalog: 'Motion Blur',
  kind: 'visual',
  summary:
    'A MotionBlur companion on a TAA camera smears moving pixels along their velocity in one pass after the TAA resolve; it writes no TAA history.',
  expect:
    'ON: the fast-spinning yellow and cyan bars become soft fan-shaped streaks. OFF: each bar is a crisp, sharp-edged rectangle frozen in place.',
  setup({ app, world, frames }) {
    world
      .addSystem(
        Update,
        defineSystem({
          name: 'feature-lab-motion-blur-spin',
          queries: [{ write: [Transform], read: [Spin] }],
          fn: (world, [rows]) => {
            const t = world.getResource(Time).elapsed;
            for (const row of rows) {
              const angle = t * row.get(Spin).speed;
              row.mut(Transform).quat.set([0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]);
            }
          },
        }),
      )
      .unwrap();
    spawnMesh(
      world,
      MESH.cube,
      unlit(world, [1, 0.85, 0.1, 1]),
      { pos: [-1.6, 0, 0], scale: [2.6, 0.35, 0.35] },
      { component: Spin, data: { speed: 7 } },
    );
    spawnMesh(
      world,
      MESH.cube,
      unlit(world, [0.1, 0.9, 1, 1]),
      { pos: [1.6, 0, 0], scale: [2.6, 0.35, 0.35] },
      { component: Spin, data: { speed: -9 } },
    );
    const camera = spawnCamera(world, {
      eye: [0, 0, 6],
      target: [0, 0, 0],
      data: { antialias: ANTIALIAS_TAA, clearColor: [0.03, 0.03, 0.05, 1] },
    });
    world.addComponent(camera, { component: MotionBlur, data: BLUR }).unwrap();
    return {
      toggle(on) {
        if (on) world.addComponent(camera, { component: MotionBlur, data: BLUR }).unwrap();
        else world.removeComponent(camera, MotionBlur).unwrap();
      },
      async checks() {
        // Frames slower than 100 ms legitimately reset the blur interval
        // (resetReason 'time-discontinuity'), so sample a window for an active frame.
        let blur = app.renderer.inspect().motionBlur;
        for (let i = 0; i < 60 && blur?.status !== 'active'; i++) {
          await frames(1);
          blur = app.renderer.inspect().motionBlur;
        }
        const passes = app.renderer.inspect().perFramePassNames;
        return new CheckList()
          .ok('motion blur enabled', blur?.enabled === true, JSON.stringify(blur))
          .ok(
            'motion blur active, or reset only by slow frames',
            blur?.status === 'active' ||
              (blur?.status === 'reset' && blur.resetReason === 'time-discontinuity'),
            JSON.stringify({ status: blur?.status, resetReason: blur?.resetReason }),
          )
          .equal('motion blur lane', blur?.lane, 'compute')
          .equal('motion blur writes no history', blur?.historyWrites, 0)
          .ok('motion-blur pass scheduled', passes.includes('motion-blur'), passes.join(',')).items;
      },
    };
  },
});
